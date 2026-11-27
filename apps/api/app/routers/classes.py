"""Classes, assignments, exam mode, intermediate checks, grade overrides and dashboards."""

import hashlib
import json
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..deps import STAFF, current_user, membership, require_role
from ..grading.runner import GRADER_BUSY, limit_checks, limit_submissions, run_grader, student_view
from ..models import (
    Announcement, Assignment, AssignmentExtension, AssignmentStart, AuditLog, ClassMember, ExamEvent, Exercise, ExerciseVersion,
    GradeHistory, GradingJob, GradingResult, Organization, OrganizationMember, OrgInvite, Role, SchoolClass, Submission,
    SubmissionSnapshot, User,
)
from ..schemas import _check_project
from ..security import token_hash
from .exercises import grade_submission
from .orgs import ALPHABET

router = APIRouter(prefix="/api", tags=["classes"])
GRACE = timedelta(minutes=2)  # network latency for automatic submission at the end of an exam


def utc(d: datetime | None) -> datetime | None:
    return None if d is None else (d if d.tzinfo else d.replace(tzinfo=UTC))


def now() -> datetime:
    return datetime.now(UTC)


# ------------------------------------------------------------------------------ schemas


class ClassIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    academic_year: str = Field(pattern=r"^\d{4}-\d{4}$")


class MemberIn(BaseModel):
    email: str = Field(max_length=320)
    role: str = Field(pattern="^(student|teacher)$")


class AssignmentIn(BaseModel):
    exercise_version_id: str
    title: str = Field(min_length=1, max_length=200)
    opens_at: datetime | None = None
    due_at: datetime | None = None
    exam: bool = False
    duration_min: int | None = Field(default=None, ge=1, le=600)
    max_attempts: int = Field(default=0, ge=0, le=100)
    allow_checks: bool = True
    allow_tutor: bool = True
    allow_courses: bool = True
    results: str = Field(default="immediate", pattern="^(immediate|after_due|never)$")


class ExtensionIn(BaseModel):
    student_id: str
    extra_minutes: int = Field(ge=0, le=600)


class ProjectBody(BaseModel):
    project: dict[str, Any]
    justification: str = Field(default="", max_length=20_000)
    _v = field_validator("project")(_check_project)


class OverrideIn(BaseModel):
    score: float = Field(ge=0, le=1000)
    reason: str = Field(min_length=3, max_length=2000)
    feedback: str = Field(default="", max_length=5000)


class EventIn(BaseModel):
    kind: str = Field(pattern="^(tab_hidden|tab_visible|offline|online)$")


class AnnouncementIn(BaseModel):
    text: str = Field(min_length=1, max_length=5000)


# ------------------------------------------------------------------------------ helpers


def _class(db: Session, u: User, cid: str, staff: bool = False) -> tuple[SchoolClass, bool]:
    c = db.get(SchoolClass, cid)
    if not c:
        raise HTTPException(404, "not_found")
    m = require_role(db, u, c.org_id)
    is_staff = u.is_superadmin or (m is not None and m.role in STAFF)
    if not is_staff and not db.scalar(select(ClassMember).where(ClassMember.class_id == cid, ClassMember.user_id == u.id)):
        raise HTTPException(404, "not_found")
    if staff and not is_staff:
        raise HTTPException(403, "forbidden")
    return c, is_staff


def _assignment(db: Session, u: User, aid: str, staff: bool = False) -> tuple[Assignment, SchoolClass, bool]:
    a = db.get(Assignment, aid)
    if not a:
        raise HTTPException(404, "not_found")
    c, is_staff = _class(db, u, a.class_id, staff)
    return a, c, is_staff


def deadline_for(db: Session, a: Assignment, student_id: str) -> datetime | None:
    ext = db.scalar(select(AssignmentExtension.extra_minutes).where(AssignmentExtension.assignment_id == a.id, AssignmentExtension.student_id == student_id)) or 0
    deadlines = []
    if a.due_at:
        deadlines.append(utc(a.due_at) + timedelta(minutes=ext))
    if a.exam and a.duration_min:
        st = db.scalar(select(AssignmentStart).where(AssignmentStart.assignment_id == a.id, AssignmentStart.student_id == student_id))
        if st:
            deadlines.append(utc(st.started_at) + timedelta(minutes=a.duration_min + ext))
    return min(deadlines) if deadlines else None


def current_score(db: Session, sub: Submission) -> tuple[float | None, float | None, dict | None]:
    res = db.scalar(select(GradingResult).where(GradingResult.submission_id == sub.id).order_by(GradingResult.created_at.desc()))
    over = db.scalar(select(GradeHistory).where(GradeHistory.submission_id == sub.id).order_by(GradeHistory.created_at.desc()))
    if not res:
        return None, None, None
    return (over.score if over else res.score), res.max_score, res.report


def results_visible(a: Assignment) -> bool:
    if a.results == "immediate":
        return True
    if a.results == "after_due":
        return bool(a.due_at and now() > utc(a.due_at))
    return False


def assignment_out(db: Session, a: Assignment, student_id: str | None) -> dict:
    v = db.get(ExerciseVersion, a.exercise_version_id)
    out = {
        "id": a.id, "class_id": a.class_id, "title": a.title, "exercise_version_id": a.exercise_version_id,
        "opens_at": a.opens_at, "due_at": a.due_at, "exam": a.exam, "duration_min": a.duration_min, "max_attempts": a.max_attempts,
        "practice": a.campus_template is not None,
        "allow_checks": a.allow_checks, "allow_tutor": a.allow_tutor, "allow_courses": a.allow_courses, "results": a.results,
        "max_score": v.rubric.get("maxScore") if v else None, "kind": v.kind if v else "exercise",
    }
    if student_id:
        subs = db.scalars(select(Submission).where(Submission.assignment_id == a.id, Submission.student_id == student_id).order_by(Submission.created_at)).all()
        started = db.scalar(select(AssignmentStart).where(AssignmentStart.assignment_id == a.id, AssignmentStart.student_id == student_id))
        out.update({"attempts": len(subs), "started_at": started.started_at if started else None, "deadline": deadline_for(db, a, student_id)})
        if subs and results_visible(a):
            score, mx, _ = current_score(db, subs[-1])
            out["score"] = score
        out["submissions"] = [s.id for s in subs]
    return out


# ------------------------------------------------------------------------------ classes


@router.post("/orgs/{org_id}/classes", status_code=201)
def create_class(org_id: str, body: ClassIn, u: User = Depends(current_user), db: Session = Depends(get_db)):
    require_role(db, u, org_id, *STAFF)
    c = SchoolClass(org_id=org_id, name=body.name, academic_year=body.academic_year)
    db.add(c)
    db.flush()
    db.add(ClassMember(class_id=c.id, user_id=u.id, role="teacher"))
    db.add(AuditLog(org_id=org_id, actor_id=u.id, action="class.create", target=c.id))
    db.commit()
    return {"id": c.id, "name": c.name, "academic_year": c.academic_year}


@router.get("/orgs/{org_id}/classes")
def list_classes(org_id: str, u: User = Depends(current_user), db: Session = Depends(get_db)):
    m = require_role(db, u, org_id)
    q = select(SchoolClass).where(SchoolClass.org_id == org_id)
    if not (u.is_superadmin or (m and m.role in STAFF)):
        q = q.join(ClassMember, ClassMember.class_id == SchoolClass.id).where(ClassMember.user_id == u.id)
    return [{"id": c.id, "name": c.name, "academic_year": c.academic_year, "archived": c.archived} for c in db.scalars(q.order_by(SchoolClass.name)).all()]


@router.get("/classes/{cid}")
def get_class(cid: str, u: User = Depends(current_user), db: Session = Depends(get_db)):
    c, staff = _class(db, u, cid)
    members = db.scalars(select(ClassMember).where(ClassMember.class_id == cid)).all()
    assignments = db.scalars(select(Assignment).where(Assignment.class_id == cid).order_by(Assignment.created_at.desc())).all()
    anns = db.scalars(select(Announcement).where(Announcement.class_id == cid).order_by(Announcement.created_at.desc()).limit(20)).all()
    return {
        "id": c.id, "org_id": c.org_id, "name": c.name, "academic_year": c.academic_year, "archived": c.archived, "staff": staff,
        "members": [{"user_id": m.user_id, "display_name": m.user.display_name, "role": m.role, **({"email": m.user.email} if staff else {})} for m in members if staff or m.role == "teacher"],
        "assignments": [assignment_out(db, a, None if staff else u.id) for a in assignments],
        "announcements": [{"id": a.id, "text": a.text, "created_at": a.created_at} for a in anns],
    }


@router.post("/classes/{cid}/archive")
def archive_class(cid: str, u: User = Depends(current_user), db: Session = Depends(get_db)):
    c, _ = _class(db, u, cid, staff=True)
    c.archived = True
    db.commit()
    return {"ok": True}


@router.post("/classes/{cid}/members", status_code=201)
def add_member(cid: str, body: MemberIn, u: User = Depends(current_user), db: Session = Depends(get_db)):
    c, _ = _class(db, u, cid, staff=True)
    target = db.scalar(select(User).where(func.lower(User.email) == body.email.lower()))
    # The user must already belong to the school: no cross-organisation enrolment.
    if not target or not membership(db, target, c.org_id):
        raise HTTPException(404, "user_not_in_org")
    if not db.scalar(select(ClassMember).where(ClassMember.class_id == cid, ClassMember.user_id == target.id)):
        db.add(ClassMember(class_id=cid, user_id=target.id, role=body.role))
        db.commit()
    return {"ok": True}


@router.post("/classes/{cid}/join-code", status_code=201)
def class_code(cid: str, u: User = Depends(current_user), db: Session = Depends(get_db)):
    c, _ = _class(db, u, cid, staff=True)
    code = "".join(secrets.choice(ALPHABET) for _ in range(10))
    db.add(OrgInvite(org_id=c.org_id, class_id=c.id, code_hash=token_hash(code), role=Role.student, created_by=u.id, expires_at=now() + timedelta(days=30), max_uses=200))
    db.commit()
    return {"code": code}


@router.post("/classes/{cid}/announcements", status_code=201)
def announce(cid: str, body: AnnouncementIn, u: User = Depends(current_user), db: Session = Depends(get_db)):
    _class(db, u, cid, staff=True)
    a = Announcement(class_id=cid, author_id=u.id, text=body.text)
    db.add(a)
    db.commit()
    return {"id": a.id}


# ------------------------------------------------------------------------------ assignments


@router.post("/classes/{cid}/assignments", status_code=201)
def create_assignment(cid: str, body: AssignmentIn, u: User = Depends(current_user), db: Session = Depends(get_db)):
    c, _ = _class(db, u, cid, staff=True)
    v = db.get(ExerciseVersion, body.exercise_version_id)
    ex = db.get(Exercise, v.exercise_id) if v else None
    if not v or not ex or ex.org_id != c.org_id or not v.published:
        raise HTTPException(404, "exercise_not_found")
    if body.exam and not body.duration_min and not body.due_at:
        raise HTTPException(422, "exam_needs_duration_or_due")
    a = Assignment(class_id=cid, created_by=u.id, **body.model_dump())
    db.add(a)
    db.add(AuditLog(org_id=c.org_id, actor_id=u.id, action="assignment.create", target=cid))
    db.commit()
    return assignment_out(db, a, None)


@router.post("/assignments/{aid}/extensions")
def set_extension(aid: str, body: ExtensionIn, u: User = Depends(current_user), db: Session = Depends(get_db)):
    a, _, _ = _assignment(db, u, aid, staff=True)
    e = db.scalar(select(AssignmentExtension).where(AssignmentExtension.assignment_id == aid, AssignmentExtension.student_id == body.student_id))
    if e:
        e.extra_minutes = body.extra_minutes
    else:
        db.add(AssignmentExtension(assignment_id=aid, student_id=body.student_id, extra_minutes=body.extra_minutes))
    db.commit()
    return {"ok": True}


@router.get("/assignments/{aid}")
def get_assignment(aid: str, u: User = Depends(current_user), db: Session = Depends(get_db)):
    a, _, staff = _assignment(db, u, aid)
    v = db.get(ExerciseVersion, a.exercise_version_id)
    out = assignment_out(db, a, None if staff else u.id)
    out["statement"] = v.statement
    out["initial_project"] = v.initial_project
    out["skill_map"] = v.skill_map
    out["criteria"] = [{"id": c["id"], "type": c["type"], "points": c["points"]} for c in v.rubric["criteria"] if not c.get("hidden")]
    out["server_time"] = now()
    return out


@router.post("/assignments/{aid}/start")
def start(aid: str, u: User = Depends(current_user), db: Session = Depends(get_db)):
    a, _, _ = _assignment(db, u, aid)
    if a.opens_at and now() < utc(a.opens_at):
        raise HTTPException(409, "not_open")
    db.execute(select(User.id).where(User.id == u.id).with_for_update())
    if not db.scalar(select(AssignmentStart).where(AssignmentStart.assignment_id == aid, AssignmentStart.student_id == u.id)):
        db.add(AssignmentStart(assignment_id=aid, student_id=u.id))
        db.commit()
    return {"deadline": deadline_for(db, a, u.id), "server_time": now()}


@router.post("/assignments/{aid}/check")
def check(aid: str, body: ProjectBody, u: User = Depends(current_user), db: Session = Depends(get_db)):
    """Intermediate verification: public criteria only, nothing stored."""
    a, _, _ = _assignment(db, u, aid)
    if not a.allow_checks:
        raise HTTPException(403, "checks_disabled")
    limit_checks(u.id)
    v = db.get(ExerciseVersion, a.exercise_version_id)
    public = {**v.rubric, "criteria": [{**c, "dependsOn": [d for d in c.get("dependsOn", []) if not any(x["id"] == d and x.get("hidden") for x in v.rubric["criteria"])]} for c in v.rubric["criteria"] if not c.get("hidden")]}
    # Interactive: wait briefly for a grader slot, then ask the client to retry rather than pile up.
    res = run_grader(body.project, public, wait_s=get_settings().grader_queue_wait_s)
    if res.error == GRADER_BUSY:
        raise HTTPException(503, "grader_busy", headers={"Retry-After": "5"})
    if not res.ok:
        raise HTTPException(422, "invalid_project")
    return {"results": [{"id": r["id"], "type": r["type"], "passed": r["passed"], "message": r["message"], "feedback": r.get("feedback")} for r in res.report["results"]]}


@router.post("/assignments/{aid}/submissions", status_code=202)
def submit(aid: str, body: ProjectBody, tasks: BackgroundTasks, u: User = Depends(current_user), db: Session = Depends(get_db)):
    a, c, _ = _assignment(db, u, aid)
    limit_submissions(u.id)
    # Serialize a student's attempts without blocking the rest of the class.
    db.execute(select(User.id).where(User.id == u.id).with_for_update())
    t = now()
    if a.opens_at and t < utc(a.opens_at):
        raise HTTPException(409, "not_open")
    if a.exam and a.duration_min and not db.scalar(select(AssignmentStart).where(AssignmentStart.assignment_id == aid, AssignmentStart.student_id == u.id)):
        raise HTTPException(409, "not_started")
    dl = deadline_for(db, a, u.id)
    if dl and t > dl + GRACE:
        raise HTTPException(409, "deadline_passed")
    n = db.scalar(select(func.count()).select_from(Submission).where(Submission.assignment_id == aid, Submission.student_id == u.id)) or 0
    if a.max_attempts and n >= a.max_attempts:
        raise HTTPException(409, "no_attempts_left")
    raw = json.dumps(body.project, sort_keys=True)
    if len(raw) > get_settings().max_project_bytes:
        raise HTTPException(413, "project_too_large")
    sub = Submission(org_id=c.org_id, exercise_version_id=a.exercise_version_id, student_id=u.id, justification=body.justification, assignment_id=aid, attempt=n + 1)
    db.add(sub)
    db.flush()
    db.add(SubmissionSnapshot(submission_id=sub.id, data=body.project, sha256=hashlib.sha256(raw.encode()).hexdigest()))
    db.add(GradingJob(submission_id=sub.id))
    db.add(AuditLog(org_id=c.org_id, actor_id=u.id, action="submission.create", target=sub.id, data={"assignment": aid, "attempt": n + 1}))
    db.commit()
    tasks.add_task(grade_submission, sub.id)
    return {"id": sub.id, "attempt": n + 1, "status": "pending"}


@router.get("/assignments/{aid}/my-submissions")
def my_submissions(aid: str, u: User = Depends(current_user), db: Session = Depends(get_db)):
    a, _, _ = _assignment(db, u, aid)
    v = db.get(ExerciseVersion, a.exercise_version_id)
    out = []
    for s in db.scalars(select(Submission).where(Submission.assignment_id == aid, Submission.student_id == u.id).order_by(Submission.created_at)).all():
        job = db.scalar(select(GradingJob).where(GradingJob.submission_id == s.id))
        item: dict = {"id": s.id, "attempt": s.attempt, "created_at": s.created_at, "status": job.status if job else "none"}
        if results_visible(a):
            score, mx, report = current_score(db, s)
            fb = db.scalar(select(GradeHistory).where(GradeHistory.submission_id == s.id).order_by(GradeHistory.created_at.desc()))
            item.update({"score": score, "max_score": mx, **({"report": student_view(report, v.show_hidden_after_grading)} if report else {}), **({"feedback": fb.feedback} if fb and fb.feedback else {})})
        out.append(item)
    return out


@router.get("/assignments/{aid}/submissions")
def all_submissions(aid: str, u: User = Depends(current_user), db: Session = Depends(get_db)):
    a, c, _ = _assignment(db, u, aid, staff=True)
    students = db.scalars(select(ClassMember).where(ClassMember.class_id == c.id, ClassMember.role == "student")).all()
    rows = []
    for m in students:
        subs = db.scalars(select(Submission).where(Submission.assignment_id == aid, Submission.student_id == m.user_id).order_by(Submission.created_at)).all()
        last = subs[-1] if subs else None
        score, mx, report = current_score(db, last) if last else (None, None, None)
        events = db.scalar(select(func.count()).select_from(ExamEvent).where(ExamEvent.assignment_id == aid, ExamEvent.student_id == m.user_id)) or 0
        dl = deadline_for(db, a, m.user_id)
        rows.append({
            "student_id": m.user_id, "display_name": m.user.display_name, "attempts": len(subs), "submission_id": last.id if last else None,
            "submitted_at": last.created_at if last else None, "score": score, "max_score": mx, "session_events": events,
            "late": bool(last and dl and utc(last.created_at) > dl), "failed": [r["id"] for r in (report or {}).get("results", []) if not r["passed"]],
        })
    return rows


@router.post("/submissions/{sid}/override")
def override(sid: str, body: OverrideIn, u: User = Depends(current_user), db: Session = Depends(get_db)):
    sub = db.get(Submission, sid)
    if not sub:
        raise HTTPException(404, "not_found")
    require_role(db, u, sub.org_id, *STAFF)
    db.add(GradeHistory(submission_id=sid, score=body.score, reason=body.reason, feedback=body.feedback, author_id=u.id))
    db.add(AuditLog(org_id=sub.org_id, actor_id=u.id, action="grade.override", target=sid, data={"score": body.score}))
    db.commit()
    return {"ok": True}


@router.get("/submissions/{sid}/history")
def grade_history(sid: str, u: User = Depends(current_user), db: Session = Depends(get_db)):
    sub = db.get(Submission, sid)
    if not sub:
        raise HTTPException(404, "not_found")
    require_role(db, u, sub.org_id, *STAFF)
    res = db.scalar(select(GradingResult).where(GradingResult.submission_id == sid))
    hist = [{"score": h.score, "reason": h.reason, "feedback": h.feedback, "author_id": h.author_id, "at": h.created_at} for h in db.scalars(select(GradeHistory).where(GradeHistory.submission_id == sid).order_by(GradeHistory.created_at)).all()]
    return {"automatic": res.score if res else None, "engine_version": res.engine_version if res else None, "history": hist}


@router.post("/assignments/{aid}/events", status_code=202)
def exam_event(aid: str, body: EventIn, u: User = Depends(current_user), db: Session = Depends(get_db)):
    a, c, _ = _assignment(db, u, aid)
    org = db.get(Organization, c.org_id)
    if a.exam and org.exam_monitoring:
        db.add(ExamEvent(assignment_id=aid, student_id=u.id, kind=body.kind))
        db.commit()
        return {"recorded": True}
    return {"recorded": False}


# ------------------------------------------------------------------------------ dashboards


@router.get("/me/assignments")
def my_assignments(u: User = Depends(current_user), db: Session = Depends(get_db)):
    classes = db.scalars(select(SchoolClass).join(ClassMember, ClassMember.class_id == SchoolClass.id).where(ClassMember.user_id == u.id, ClassMember.role == "student", SchoolClass.archived.is_(False))).all()
    out = []
    scores = []
    for c in classes:
        for a in db.scalars(select(Assignment).where(Assignment.class_id == c.id).order_by(Assignment.due_at)).all():
            item = assignment_out(db, a, u.id)
            item["class_name"] = c.name
            out.append(item)
            if not item["practice"] and item.get("score") is not None and item.get("max_score"):
                scores.append(20 * item["score"] / item["max_score"])
    anns = db.scalars(select(Announcement).where(Announcement.class_id.in_([c.id for c in classes])).order_by(Announcement.created_at.desc()).limit(10)).all() if classes else []
    return {
        "assignments": out,
        "average_20": round(sum(scores) / len(scores), 2) if scores else None,
        "announcements": [{"class_id": a.class_id, "text": a.text, "created_at": a.created_at} for a in anns],
    }


@router.get("/orgs/{org_id}/dashboard")
def teacher_dashboard(org_id: str, u: User = Depends(current_user), db: Session = Depends(get_db)):
    require_role(db, u, org_id, *STAFF)
    classes = db.scalars(select(SchoolClass).where(SchoolClass.org_id == org_id, SchoolClass.archived.is_(False))).all()
    students = db.scalar(select(func.count()).select_from(OrganizationMember).where(OrganizationMember.org_id == org_id, OrganizationMember.role == Role.student)) or 0
    per_class = []
    failed: dict[str, int] = {}
    total_graded = 0
    total_success = 0
    for c in classes:
        sc = []
        for a in db.scalars(select(Assignment).where(Assignment.class_id == c.id, Assignment.campus_template.is_(None))).all():
            for s in db.scalars(select(Submission).where(Submission.assignment_id == a.id)).all():
                score, mx, report = current_score(db, s)
                if score is None or not mx:
                    continue
                sc.append(20 * score / mx)
                total_graded += 1
                total_success += 1 if score / mx >= 0.5 else 0
                for r in (report or {}).get("results", []):
                    if not r["passed"]:
                        key = f"{a.title} — {r['type']}"
                        failed[key] = failed.get(key, 0) + 1
        per_class.append({"class_id": c.id, "name": c.name, "average_20": round(sum(sc) / len(sc), 2) if sc else None, "graded": len(sc)})
    pending = db.scalar(select(func.count()).select_from(GradingJob).join(Submission, Submission.id == GradingJob.submission_id).where(Submission.org_id == org_id, GradingJob.status.in_(["pending", "running", "error"]))) or 0
    recent = db.scalars(select(AuditLog).where(AuditLog.org_id == org_id).order_by(AuditLog.created_at.desc()).limit(15)).all()
    return {
        "students": students,
        "classes": len(classes),
        "graded_submissions": total_graded,
        "to_review": pending,
        "success_rate": round(100 * total_success / total_graded, 1) if total_graded else None,
        "per_class": per_class,
        "hardest": sorted(({"criterion": k, "failures": v} for k, v in failed.items()), key=lambda x: -x["failures"])[:8],
        "recent": [{"action": r.action, "at": r.created_at} for r in recent],
    }
