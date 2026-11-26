"""Class-scoped campus presence and bridges to the teaching platform."""
import asyncio
import json
import time
from dataclasses import dataclass, field

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from redis.exceptions import RedisError
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from ..campus_map import MAP, ROOM_IDS, SPAWN, room_at, walkable
from ..campus_missions import TEMPLATES
from ..campus_presence import SharedPresence, remote_player
from ..config import get_settings
from ..db import SessionLocal, get_db
from ..deps import STAFF, current_user
from ..models import Announcement, Assignment, AuditLog, ClassMember, Course, Exercise, ExerciseVersion, GradingResult, OrganizationMember, Project, ProjectShare, SchoolClass, Submission, User
from ..security import token_hash
from .classes import _assignment, _class, assignment_out, now, results_visible, start, utc
from .collab import _authenticate, _origin_ok

router = APIRouter(prefix="/api")
ROSTER_PROFILE = (0, 0, 0, 1, 2, 3)


def completed_assignments(db: Session, uid: str, cid: str | None = None) -> list[str]:
    query = (
        select(Assignment).join(Submission, Submission.assignment_id == Assignment.id)
        .join(GradingResult, GradingResult.submission_id == Submission.id)
        .join(SchoolClass, SchoolClass.id == Assignment.class_id)
        .join(OrganizationMember, (OrganizationMember.org_id == SchoolClass.org_id) & (OrganizationMember.user_id == uid))
        .join(ClassMember, (ClassMember.class_id == Assignment.class_id) & (ClassMember.user_id == uid))
        .where(Assignment.campus_rewardable.is_(True), Assignment.exam.is_(False), Submission.student_id == uid,
               GradingResult.max_score > 0, GradingResult.score >= GradingResult.max_score)
    )
    if cid:
        query = query.where(Assignment.class_id == cid)
    return [a.id for a in db.scalars(query).unique() if results_visible(a)]


def profile(db: Session, u: User) -> dict:
    completed = len(completed_assignments(db, u.id))
    unlocked = [index for index, threshold in enumerate(ROSTER_PROFILE) if completed >= threshold]
    return {"color": u.campus_color if u.campus_color in unlocked else 0, "unlocked": unlocked}


class Avatar(BaseModel):
    color: int = Field(strict=True, ge=0, lt=len(ROSTER_PROFILE))


@router.put("/campus/avatar")
def choose_avatar(body: Avatar, u: User = Depends(current_user), db: Session = Depends(get_db)):
    if body.color not in profile(db, u)["unlocked"]:
        raise HTTPException(403, "cosmetic_locked")
    u.campus_color = body.color
    db.commit()
    return {"color": body.color}


@router.get("/campus")
def campus_info(u: User = Depends(current_user), db: Session = Depends(get_db)):
    enrolled = select(ClassMember.class_id).where(ClassMember.user_id == u.id)
    staff_orgs = select(OrganizationMember.org_id).where(OrganizationMember.user_id == u.id, OrganizationMember.role.in_(STAFF))
    query = select(SchoolClass).where(SchoolClass.archived.is_(False)).order_by(SchoolClass.name)
    if not u.is_superadmin:
        query = query.where(or_(SchoolClass.id.in_(enrolled), SchoolClass.org_id.in_(staff_orgs)))
    classes = []
    for c in db.scalars(query):
        try:
            _, staff = _class(db, u, c.id)
        except HTTPException:
            continue
        classes.append({"id": c.id, "name": c.name, "org_id": c.org_id, "staff": staff})
    return {"map": MAP, "classes": classes, "profile": profile(db, u)}


@router.get("/campus/classes/{cid}")
def campus_class(cid: str, u: User = Depends(current_user), db: Session = Depends(get_db)):
    c, staff = _class(db, u, cid)
    if c.archived:
        raise HTTPException(404, "not_found")
    missions = []
    for a in db.scalars(select(Assignment).where(Assignment.class_id == cid).order_by(Assignment.created_at.desc())):
        if not staff and ((not a.exam and not a.campus_room) or (a.opens_at and utc(a.opens_at) > now())):
            continue
        version = db.get(ExerciseVersion, a.exercise_version_id)
        summary = assignment_out(db, a, None if staff else u.id)
        summary["room"] = "exam" if a.exam else a.campus_room
        summary["template"] = a.campus_template
        summary["opens_at"] = utc(a.opens_at)
        summary["due_at"] = utc(a.due_at)
        summary["statement"] = version.statement if version and not a.exam else None
        missions.append(summary)
    announcements = db.scalars(select(Announcement).where(Announcement.class_id == cid).order_by(Announcement.created_at.desc()).limit(10))
    completed = [] if staff else completed_assignments(db, u.id, cid)
    return {"missions": missions, "announcements": [a.text for a in announcements], "completed": completed,
            "closed": (c.campus_rules or {}).get("closed", []),
            "muted": (c.campus_rules or {}).get("muted", []) if staff else [],
            "templates": [{"id": key, "title": item["title"]} for key, item in TEMPLATES.items()] if staff else []}


class Rule(BaseModel):
    enabled: bool = Field(strict=True)


class SlideSelection(BaseModel):
    course_id: str | None = Field(max_length=32)
    lesson: int = Field(default=0, strict=True, ge=0)


def slide(db: Session, c: SchoolClass) -> dict | None:
    current = (c.campus_rules or {}).get("presentation")
    if current:
        course = db.get(Course, current["course_id"])
        index = current["lesson"]
        if course and course.org_id == c.org_id and index < len(course.lessons):
            return {"course_id": course.id, "title": course.title, "index": index,
                    "total": len(course.lessons), "lesson": course.lessons[index]}
    return None


@router.get("/campus/classes/{cid}/presentation")
def get_presentation(cid: str, u: User = Depends(current_user), db: Session = Depends(get_db)):
    c, _ = _class(db, u, cid)
    if c.archived:
        raise HTTPException(404, "not_found")
    return slide(db, c)


@router.put("/campus/classes/{cid}/presentation")
def set_presentation(cid: str, body: SlideSelection, u: User = Depends(current_user), db: Session = Depends(get_db)):
    checked, _ = _class(db, u, cid, staff=True)
    if checked.archived:
        raise HTTPException(404, "not_found")
    if body.course_id:
        course = db.get(Course, body.course_id)
        if not course or course.org_id != checked.org_id:
            raise HTTPException(404, "not_found")
        if body.lesson >= len(course.lessons):
            raise HTTPException(422, "invalid_lesson")
    c = db.scalar(select(SchoolClass).where(SchoolClass.id == cid).execution_options(populate_existing=True).with_for_update())
    c.campus_rules = {**(c.campus_rules or {}), "presentation": body.model_dump() if body.course_id else None}
    db.commit()
    return slide(db, c)


@router.put("/campus/classes/{cid}/rooms/{room_id}/closed")
def room_visibility(cid: str, room_id: str, body: Rule, u: User = Depends(current_user), db: Session = Depends(get_db)):
    checked, _ = _class(db, u, cid, staff=True)
    if checked.archived or room_id not in ROOM_IDS - {"staff"}:
        raise HTTPException(404, "not_found")
    c = db.scalar(select(SchoolClass).where(SchoolClass.id == cid).execution_options(populate_existing=True).with_for_update())
    rules = c.campus_rules or {}
    rooms = set(rules.get("closed", []))
    (rooms.add if body.enabled else rooms.discard)(room_id)
    c.campus_rules = {**rules, "closed": sorted(rooms)}
    db.commit()
    return {"closed": sorted(rooms)}


@router.put("/campus/classes/{cid}/chat/{uid}/muted")
def mute_player(cid: str, uid: str, body: Rule, u: User = Depends(current_user), db: Session = Depends(get_db)):
    checked, _ = _class(db, u, cid, staff=True)
    member = db.scalar(select(ClassMember).where(ClassMember.class_id == cid, ClassMember.user_id == uid, ClassMember.role == "student"))
    if checked.archived or not member:
        raise HTTPException(404, "not_found")
    c = db.scalar(select(SchoolClass).where(SchoolClass.id == cid).execution_options(populate_existing=True).with_for_update())
    rules = c.campus_rules or {}
    muted = set(rules.get("muted", []))
    (muted.add if body.enabled else muted.discard)(uid)
    c.campus_rules = {**rules, "muted": sorted(muted)}
    db.add(AuditLog(org_id=c.org_id, actor_id=u.id, action="campus.chat.mute", target=uid, data={"class_id": cid, "muted": body.enabled}))
    db.commit()
    return {"muted": sorted(muted)}


@router.post("/campus/classes/{cid}/templates/{key}", status_code=201)
def install_template(cid: str, key: str, u: User = Depends(current_user), db: Session = Depends(get_db)):
    c, _ = _class(db, u, cid, staff=True)
    template = TEMPLATES.get(key)
    if c.archived or not template:
        raise HTTPException(404, "not_found")
    existing = select(Assignment.id).where(Assignment.class_id == cid, Assignment.campus_template == key)
    if installed := db.scalar(existing):
        return {"id": installed}
    exercise = Exercise(org_id=c.org_id, author_id=u.id, title=template["title"])
    db.add(exercise)
    db.flush()
    criteria = template["criteria"]
    version = ExerciseVersion(exercise_id=exercise.id, version=1, statement=template["statement"],
                              initial_project=template["project"], published=True, kind="incident",
                              rubric={"maxScore": sum(item["points"] for item in criteria), "criteria": criteria},
                              skill_map={item["id"]: template["skill"] for item in criteria})
    db.add(version)
    db.flush()
    assignment = Assignment(class_id=cid, exercise_version_id=version.id, created_by=u.id,
                            title=template["title"], campus_room=template["room"], campus_template=key, campus_rewardable=True)
    db.add(assignment)
    db.add(AuditLog(org_id=c.org_id, actor_id=u.id, action="campus.template.install", target=cid, data={"template": key}))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        if installed := db.scalar(existing):
            return {"id": installed}
        raise
    return {"id": assignment.id}


class Placement(BaseModel):
    room: str | None


@router.put("/campus/assignments/{aid}/room")
def place_assignment(aid: str, body: Placement, u: User = Depends(current_user), db: Session = Depends(get_db)):
    assignment, c, _ = _assignment(db, u, aid, staff=True)
    if c.archived:
        raise HTTPException(404, "not_found")
    if assignment.exam or (body.room is not None and body.room not in ROOM_IDS - {"exam", "staff"}):
        raise HTTPException(422, "invalid_room")
    assignment.campus_room = body.room
    if body.room:
        assignment.campus_rewardable = True
    db.commit()
    return {"room": body.room}


@router.post("/campus/classes/{cid}/missions/{aid}/start")
def start_mission(cid: str, aid: str, request: Request, u: User = Depends(current_user), db: Session = Depends(get_db)):
    assignment, c, staff = _assignment(db, u, aid)
    room_id = "exam" if assignment.exam else assignment.campus_room
    room = next((r for r in MAP["rooms"] if r["id"] == room_id), None)
    if c.id != cid or c.archived or staff or room is None:
        raise HTTPException(404, "not_found")
    if room_id in (c.campus_rules or {}).get("closed", []):
        raise HTTPException(403, "room_closed")
    url = get_settings().campus_redis_url
    try:
        if url:
            view = remote_player(url, cid, u.id)
        else:
            player = request.app.state.campus_rooms.get(cid, {}).get(u.id)
            view = player.view() if player else None
    except RedisError:
        raise HTTPException(503, "campus_unavailable") from None
    sx, sy = room["station"]
    if not view or abs(view["x"] - sx) + abs(view["y"] - sy) > 2 or view["y"] <= room["y"]:
        raise HTTPException(409, "station_out_of_reach")
    return start(aid, u, db)


@router.post("/campus/classes/{cid}/missions/{aid}/dispatch")
def dispatch_incident(cid: str, aid: str, u: User = Depends(current_user), db: Session = Depends(get_db)):
    _, c, _ = _assignment(db, u, aid, staff=True)
    a = db.scalar(select(Assignment).where(Assignment.id == aid).execution_options(populate_existing=True).with_for_update())
    if c.id != cid or c.archived or a is None or a.exam or a.campus_room is None:
        raise HTTPException(404, "not_found")
    version = db.get(ExerciseVersion, a.exercise_version_id)
    if version.kind != "incident":
        raise HTTPException(422, "not_an_incident")
    stamp = now()
    if a.due_at and utc(a.due_at) <= stamp:
        raise HTTPException(409, "deadline_passed")
    if a.opens_at and utc(a.opens_at) > stamp:
        a.opens_at = stamp
        db.add(Announcement(class_id=cid, author_id=u.id, text=f"Incident à traiter : {a.title}"))
        db.add(AuditLog(org_id=c.org_id, actor_id=u.id, action="campus.incident.dispatch", target=aid))
        db.commit()
    return {"opens_at": utc(a.opens_at)}


@dataclass
class Player:
    id: str
    name: str
    staff: bool
    x: int = SPAWN[0]
    y: int = SPAWN[1]
    moved: float = -100
    messaged: float = -100
    invited: float = -100
    color: int = 0
    direction: str = "down"
    status: str = ""
    emote: int = 0
    emote_until: float = 0
    closed: tuple[str, ...] = ()
    muted: bool = False
    events: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=32))

    def view(self) -> dict:
        return dict(id=self.id, name=self.name, staff=self.staff, x=self.x, y=self.y, direction=self.direction,
                    color=self.color, status=self.status, emote=self.emote if time.monotonic() < self.emote_until else 0)


def access(ws: WebSocket, cid: str) -> Player | None:
    with SessionLocal() as db:
        u = _authenticate(ws, db)
        if not u:
            return None
        try:
            c, staff = _class(db, u, cid)
        except HTTPException:
            return None
        if not c.archived:
            rules = c.campus_rules or {}
            return Player(u.id, u.display_name, staff, color=profile(db, u)["color"],
                          closed=tuple(rules.get("closed", [])), muted=not staff and u.id in rules.get("muted", []))
    return None


def apply_action(player: Player, payload: dict) -> dict | None:
    stamp = time.monotonic()
    kind = payload.get("type")
    if kind == "step":
        x, y = payload.get("x"), payload.get("y")
        if type(x) is not int or type(y) is not int or stamp - player.moved < 0.14:
            return
        if abs(x - player.x) + abs(y - player.y) == 1 and walkable(x, y, player.staff, player.closed):
            player.direction = "left" if x < player.x else "right" if x > player.x else "up" if y < player.y else "down"
            player.x, player.y = x, y
            player.moved = stamp
        return
    if stamp - player.messaged < 0.65:
        return
    player.messaged = stamp
    value = payload.get("value")
    if kind == "home":
        player.x, player.y = SPAWN
    elif kind == "emote" and type(value) is int and 1 <= value <= 6:
        player.emote, player.emote_until = value, stamp + 2.5
    elif kind == "status" and value in ("", "help", "done", "working"):
        player.status = value
    elif kind == "moderate" and player.staff and isinstance(value, str) and len(value) <= 32:
        return {"type": "clear_status", "target": value}
    elif kind == "chat":
        if player.muted:
            return {"type": "muted", "target": player.id}
        channel = payload.get("channel")
        if channel not in ("nearby", "room", "class", "announcement") or (channel == "announcement" and not player.staff):
            return
        if not isinstance(value, str) or not value.strip() or len(value) > 280:
            return
        return {"type": "chat", "name": player.name, "channel": channel, "text": value.strip(), "x": player.x, "y": player.y}
    return None


def receive_event(player: Player, event: dict) -> dict | None:
    if event["type"] == "invite":
        if event["target"] == player.id:
            return {key: event[key] for key in ("type", "name", "project", "token", "title")}
        return None
    if event["type"] == "muted":
        return {"type": "muted"} if event["target"] == player.id else None
    if event["type"] == "clear_status":
        if event["target"] == player.id:
            player.status = ""
        return None
    if event["channel"] == "nearby" and abs(event["x"] - player.x) + abs(event["y"] - player.y) > 10:
        return None
    if event["channel"] == "room" and room_at(event["x"], event["y"]) != room_at(player.x, player.y):
        return None
    return {key: event[key] for key in ("type", "name", "channel", "text")}


def restore(player: Player, old: dict | None):
    if old and walkable(old["x"], old["y"], player.staff, player.closed):
        player.x, player.y = old["x"], old["y"]
        player.direction, player.status = old["direction"], old["status"]
    if old:
        player.moved = player.messaged = time.monotonic()


def project_invitation(player: Player, payload: dict, cid: str) -> dict | None:
    if player.muted or room_at(player.x, player.y) != "collaboration":
        return None
    pid, target, token = (payload.get(key) for key in ("project", "target", "token"))
    if not all(isinstance(value, str) and 1 <= len(value) <= 40 for value in (pid, target, token)) or target == player.id:
        return None
    with SessionLocal() as db:
        c = db.get(SchoolClass, cid)
        recipient = db.get(User, target)
        project = db.get(Project, pid)
        if not c or c.archived or not recipient or not project or project.owner_id != player.id:
            return None
        if not player.staff and "collaboration" in (c.campus_rules or {}).get("closed", []):
            return None
        try:
            _class(db, recipient, cid)
        except HTTPException:
            return None
        share = db.scalar(select(ProjectShare.id).where(ProjectShare.project_id == pid, ProjectShare.org_id == c.org_id,
                                                       ProjectShare.token_hash == token_hash(token)))
        if share:
            return {"type": "invite", "target": target, "name": player.name, "project": pid, "title": project.name, "token": token}
    return None


@router.websocket("/ws/campus/{cid}")
async def campus_socket(ws: WebSocket, cid: str):
    player = await run_in_threadpool(access, ws, cid) if _origin_ok(ws) else None
    if player is None:
        await ws.close(code=4404)
        return
    rooms = ws.app.state.campus_rooms
    recent = ws.app.state.campus_recent
    peers = rooms.setdefault(cid, {})
    for key, entry in list(recent.items()):
        if entry[0] <= time.monotonic():
            recent.pop(key, None)
    previous = peers.get(player.id)
    previous_snapshot = recent.pop((cid, player.id), (0, None))[1]
    restore(player, previous.view() if previous else previous_snapshot)
    peers[player.id] = player
    await ws.accept()
    url = get_settings().campus_redis_url
    shared = SharedPresence(url, cid, player.id) if url else None
    last_check = time.monotonic()
    last_snapshot = 0.0
    last_update = 0.0
    last_sent = 0.0
    sent_view = None
    sent_state = None
    rate_window = last_check
    message_count = 0
    try:
        if shared:
            await shared.subscription.subscribe(shared.channel)
            saved = await shared.write("join", player.view())
            if saved:
                restore(player, json.loads(saved)["player"])
        while peers.get(player.id) is player:
            stamp = time.monotonic()
            if stamp - last_check >= 3:
                verified = await run_in_threadpool(access, ws, cid)
                if verified is None or verified.staff != player.staff:
                    await ws.close(code=4404)
                    return
                player.color = verified.color
                player.closed, player.muted = verified.closed, verified.muted
                if not walkable(player.x, player.y, player.staff, player.closed):
                    player.x, player.y = SPAWN
                last_check = stamp
            if stamp - last_snapshot >= 0.10:
                if shared:
                    view = player.view()
                    if view != sent_view or stamp - last_update >= 0.5:
                        if not await shared.write("update", view):
                            await ws.close(code=4409)
                            return
                        sent_view, last_update = view, stamp
                    snapshot = await shared.snapshot()
                    if not any(peer["id"] == player.id for peer in snapshot):
                        await ws.close(code=4409)
                        return
                    for event in await shared.events():
                        outgoing = receive_event(player, event)
                        if outgoing:
                            await ws.send_json(outgoing)
                else:
                    snapshot = [peer.view() for peer in peers.values()]
                state = {"type": "state", "players": snapshot, "closed": player.closed, "muted": player.muted}
                if state != sent_state or stamp - last_sent >= 2:
                    await ws.send_json(state)
                    sent_state, last_sent = state, stamp
                last_snapshot = stamp
            while not player.events.empty():
                outgoing = receive_event(player, player.events.get_nowait())
                if outgoing:
                    await ws.send_json(outgoing)
            try:
                packet = await asyncio.wait_for(ws.receive(), timeout=max(0.005, 0.10 - (time.monotonic() - last_snapshot)))
            except TimeoutError:
                continue
            if packet["type"] == "websocket.disconnect":
                return
            if stamp - rate_window >= 1:
                rate_window, message_count = stamp, 0
            message_count += 1
            raw = packet.get("text")
            if message_count > 35 or not raw or len(raw) > 2048:
                await ws.close(code=4408)
                return
            try:
                data = json.loads(raw)
            except (ValueError, RecursionError):
                continue
            if isinstance(data, dict):
                previous_message = player.messaged
                event = apply_action(player, data)
                if data.get("type") == "invite" and player.messaged > previous_message and player.messaged - player.invited >= 3:
                    player.invited = player.messaged
                    event = await run_in_threadpool(project_invitation, player, data, cid)
                if event and shared:
                    await shared.publish(event)
                elif event:
                    for peer in peers.values():
                        if not peer.events.full():
                            peer.events.put_nowait(event)
        await ws.close(code=4409)
    except (WebSocketDisconnect, OSError):
        pass
    except RedisError:
        await ws.close(code=1013)
    finally:
        if peers.get(player.id) is player:
            del peers[player.id]
            recent[cid, player.id] = (time.monotonic() + 12, player.view())
            if len(recent) > 2048:
                recent.pop(next(iter(recent)))
        if not peers:
            rooms.pop(cid, None)
        if shared:
            try:
                await shared.write("leave", player.view())
            except RedisError:
                pass
            finally:
                await shared.close()
