"""
Real-time collaboration.

Because the simulation engine is deterministic, the server does not need to run it: it only
orders operations. Every participant applies the same ordered log (topology edits, CLI input,
simulation steps and clock ticks emitted by the server once per second) to its own engine, so all
copies stay identical. Writers periodically persist the resulting document with `save`.

Messages (JSON):
  client -> server: {type:'op', op}, {type:'cursor', x, y}, {type:'chat', text}, {type:'save', doc}
  server -> client: {type:'init', base, ops, you, peers, chat}, {type:'op', seq, actor, op},
                    {type:'cursor', actor, x, y}, {type:'chat', actor, name, text, at},
                    {type:'presence', peers}, {type:'saved', version}, {type:'error', code}
"""

import asyncio
import json
import secrets
from dataclasses import dataclass, field
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import SessionLocal, get_db
from ..deps import SESSION_COOKIE, current_user, membership
from ..models import Project, ProjectShare, ProjectVersion, User, UserSession
from ..schemas import _check_project
from ..security import token_hash

router = APIRouter(prefix="/api", tags=["collaboration"])
MAX_OPS = 50_000
MAX_MSG = 256 * 1024


class ShareIn(BaseModel):
    org_id: str
    role: str = Field(pattern="^(read|write)$")


@router.post("/projects/{pid}/share", status_code=201)
def share(pid: str, body: ShareIn, u: User = Depends(current_user), db: Session = Depends(get_db)):
    p = db.get(Project, pid)
    if not p or p.owner_id != u.id:
        raise HTTPException(404, "not_found")
    if not membership(db, u, body.org_id):
        raise HTTPException(404, "not_found")
    token = secrets.token_urlsafe(18)
    db.add(ProjectShare(project_id=pid, org_id=body.org_id, token_hash=token_hash(token), role=body.role))
    db.commit()
    return {"token": token, "role": body.role}


@dataclass
class Client:
    ws: WebSocket
    user_id: str
    name: str
    role: str


@dataclass
class Room:
    project_id: str
    base: dict
    ops: list = field(default_factory=list)
    clients: list[Client] = field(default_factory=list)
    chat: list = field(default_factory=list)
    ticker: asyncio.Task | None = None

    def peers(self) -> list[dict]:
        seen = {}
        for c in self.clients:
            seen[c.user_id] = {"id": c.user_id, "name": c.name, "role": c.role}
        return list(seen.values())

    async def broadcast(self, msg: dict, exclude: Client | None = None) -> None:
        data = json.dumps(msg, default=str)
        for c in list(self.clients):
            if c is exclude:
                continue
            try:
                await c.ws.send_text(data)
            except Exception:  # noqa: BLE001 - a dead socket is removed by its own handler
                pass

    async def append(self, actor: str, op: dict) -> None:
        if len(self.ops) >= MAX_OPS:
            await self.broadcast({"type": "error", "code": "session_too_long"})
            return
        entry = {"seq": len(self.ops) + 1, "actor": actor, "op": op}
        self.ops.append(entry)
        await self.broadcast({"type": "op", **entry})


rooms: dict[str, Room] = {}


async def _tick(room: Room) -> None:
    while True:
        await asyncio.sleep(1)
        await room.append("server", {"kind": "tick", "ms": 1000})


def _authenticate(ws: WebSocket, db: Session) -> User | None:
    token = ws.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    s = db.scalar(select(UserSession).where(UserSession.token_hash == token_hash(token)))
    if not s:
        return None
    exp = s.expires_at if s.expires_at.tzinfo else s.expires_at.replace(tzinfo=UTC)
    if exp < datetime.now(UTC):
        return None
    return db.get(User, s.user_id)


def _origin_ok(ws: WebSocket) -> bool:
    """Blocks cross-site WebSocket hijacking: the page must come from this site or an allowed origin."""
    origin = ws.headers.get("origin")
    if not origin:
        return True  # non-browser clients cannot carry a victim's cookies cross-site
    host = ws.headers.get("host", "")
    return origin.split("://", 1)[-1] == host or origin in get_settings().cors_origins


@router.websocket("/ws/projects/{pid}")
async def collab(ws: WebSocket, pid: str, token: str | None = None):
    if not _origin_ok(ws):
        await ws.close(code=4403)
        return
    with SessionLocal() as db:
        u = _authenticate(ws, db)
        p = db.get(Project, pid)
        role = None
        if u and p:
            if p.owner_id == u.id:
                role = "write"
            elif token:
                sh = db.scalar(select(ProjectShare).where(ProjectShare.project_id == pid, ProjectShare.token_hash == token_hash(token)))
                if sh and membership(db, u, sh.org_id):
                    role = sh.role
        if not u or not p or not role:
            await ws.close(code=4404)
            return
        base = p.data
        name = u.display_name
        uid = u.id
    await ws.accept()
    room = rooms.get(pid)
    if not room:
        room = Room(project_id=pid, base=base)
        rooms[pid] = room
    me = Client(ws, uid, name, role)
    room.clients.append(me)
    if room.ticker is None:
        room.ticker = asyncio.create_task(_tick(room))
    await ws.send_text(json.dumps({"type": "init", "base": room.base, "ops": room.ops, "you": {"id": uid, "name": name, "role": role}, "peers": room.peers(), "chat": room.chat[-50:]}, default=str))
    await room.broadcast({"type": "presence", "peers": room.peers()}, exclude=me)
    try:
        while True:
            raw = await ws.receive_text()
            if len(raw) > MAX_MSG:
                await ws.send_text(json.dumps({"type": "error", "code": "message_too_large"}))
                continue
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            kind = msg.get("type")
            if kind == "op" and isinstance(msg.get("op"), dict):
                if role != "write" or msg["op"].get("kind") == "tick":
                    await ws.send_text(json.dumps({"type": "error", "code": "read_only"}))
                    continue
                await room.append(uid, msg["op"])
            elif kind == "cursor":
                x, y = msg.get("x"), msg.get("y")
                if isinstance(x, (int, float)) and isinstance(y, (int, float)):
                    await room.broadcast({"type": "cursor", "actor": uid, "name": name, "x": x, "y": y}, exclude=me)
            elif kind == "chat" and isinstance(msg.get("text"), str) and msg["text"].strip():
                entry = {"type": "chat", "actor": uid, "name": name, "text": msg["text"][:2000], "at": datetime.now(UTC).isoformat()}
                room.chat.append(entry)
                room.chat = room.chat[-200:]
                await room.broadcast(entry)
            elif kind == "save" and role == "write" and isinstance(msg.get("doc"), dict):
                try:
                    doc = _check_project(msg["doc"])
                except ValueError:
                    continue
                if len(json.dumps(doc)) > get_settings().max_project_bytes:
                    continue
                with SessionLocal() as db:
                    p = db.get(Project, pid)
                    p.data = doc
                    p.version += 1
                    p.updated_at = datetime.now(UTC)
                    db.add(ProjectVersion(project_id=pid, version=p.version, data=doc))
                    db.commit()
                    await room.broadcast({"type": "saved", "version": p.version})
    except WebSocketDisconnect:
        pass
    finally:
        room.clients.remove(me)
        if not room.clients:
            if room.ticker:
                room.ticker.cancel()
            rooms.pop(pid, None)
        else:
            await room.broadcast({"type": "presence", "peers": room.peers()})
