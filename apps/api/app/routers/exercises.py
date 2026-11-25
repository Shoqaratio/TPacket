import hashlib
import json
from datetime import UTC, datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import SessionLocal, get_db
from ..deps import STAFF, current_user, membership, require_role
from ..grading.runner import run_grader, student_view
from ..models import AuditLog, Exercise, ExerciseVersion, GradingJob, GradingResult, Role, Submission, SubmissionSnapshot, User
from ..schemas import ExerciseIn, ExerciseVersionIn, SubmissionIn

router = APIRouter(prefix="/api", tags=["exercises"])

CRITERION_TYPES = {
    "device_exists", "device_count", "link_exists", "hostname", "interface_address", "interface_up", "host_config", "route_exists",
    "connectivity_test", "configuration_saved", "vlan_exists", "switchport_access", "switchport_trunk", "enable_secret",
    "line_password", "password_encryption", "acl_applied", "dhcp_client", "service_access", "dns_resolution", "ipv6_connectivity",
}


def _validate_rubric(r: dict) -> None:
    ms = r.get("maxScore")
    crit = r.get("criteria")
    if not isinstance(ms, (int, float)) or not 0 < ms <= 1000 or not isinstance(crit, list) or len(crit) > 200:
        raise HTTPException(422, "invalid_rubric")
    ids = set()
    for c in crit:
        if not isinstance(c, dict) or c.get("type") not in CRITERION_TYPES or not isinstance(c.get("id"), str) or c["id"] in ids:
            raise HTTPException(422, "invalid_rubric")
        if not isinstance(c.get("points"), (int, float)) or not 0 <= c["points"] <= 1000:
            raise HTTPException(422, "invalid_rubric")
        ids.add(c["id"])


@router.post("/orgs/{org_id}/exercises", status_code=201)
def create_exercise(org_id: str, body: ExerciseIn, u: User = Depends(current_user), db: Session = Depends(get_db)):
    require_role(db, u, org_id, *STAFF)
    e = Exercise(org_id=org_id, author_id=u.id, title=body.title)
    db.add(e)
    db.commit()
    return {"id": e.id, "title": e.title}


@router.get("/orgs/{org_id}/exercises")
def list_exercises(org_id: str, u: User = Depends(current_user), db: Session = Depends(get_db)):
    m = require_role(db, u, org_id)
    staff = u.is_superadmin or (m is not None and m.role in STAFF)
    out = []
    for e in db.scalars(select(Exercise).where(Exercise.org_id == org_id).order_by(Exercise.created_at.desc())).all():
        q = select(ExerciseVersion).where(ExerciseVersion.exercise_id == e.id)
        if not staff:
            q = q.where(ExerciseVersion.published.is_(True))
        latest = db.scalars(q.order_by(ExerciseVersion.version.desc())).first()
        if latest or staff:
            out.append({"id": e.id, "title": e.title, "latest_version_id": latest.id if latest else None, "version": latest.version if latest else None, "published": latest.published if latest else False})
    return out


@router.post("/exercises/{eid}/versions", status_code=201)
def add_version(eid: str, body: ExerciseVersionIn, u: User = Depends(current_user), db: Session = Depends(get_db)):
    e = db.get(Exercise, eid)
    if not e:
        raise HTTPException(404, "not_found")
    require_role(db, u, e.org_id, *STAFF)
    _validate_rubric(body.rubric)
    n = (db.scalar(select(func.max(ExerciseVersion.version)).where(ExerciseVersion.exercise_id == eid)) or 0) + 1
    v = ExerciseVersion(exercise_id=eid, version=n, statement=body.statement, initial_project=body.initial_project, rubric=body.rubric,
                        show_hidden_after_grading=body.show_hidden_after_grading, published=body.publish)
    db.add(v)
    db.add(AuditLog(org_id=e.org_id, actor_id=u.id, action="exercise.version", target=eid, data={"version": n}))
    db.commit()
    return {"id": v.id, "version": n}


def _version_for(db: Session, u: User, vid: str) -> tuple[ExerciseVersion, Exercise, bool]:
    v = db.get(ExerciseVersion, vid)
    if not v:
        raise HTTPException(404, "not_found")
    e = db.get(Exercise, v.exercise_id)
    m = require_role(db, u, e.org_id)
    staff = u.is_superadmin or (m is not None and m.role in STAFF)
    if not v.published and not staff:
        raise HTTPException(404, "not_found")
    return v, e, staff


@router.get("/exercise-versions/{vid}")
def get_version(vid: str, u: User = Depends(current_user), db: Session = Depends(get_db)):
    v, e, staff = _version_for(db, u, vid)
    out = {"id": v.id, "exercise_id": e.id, "title": e.title, "version": v.version, "statement": v.statement,
           "initial_project": v.initial_project, "published": v.published}
    if staff:
        out["rubric"] = v.rubric
    else:
        # Students see the public criteria only, without expected values.
        out["criteria"] = [{"id": c["id"], "type": c["type"], "points": c["points"]} for c in v.rubric["criteria"] if not c.get("hidden")]
        out["max_score"] = v.rubric["maxScore"]
    return out


def grade_submission(submission_id: str) -> None:
    """Background grading job. Reads the immutable snapshot, never client-provided scores."""
    db = SessionLocal()
    try:
        job = db.scalar(select(GradingJob).where(GradingJob.submission_id == submission_id, GradingJob.status == "pending"))
        if not job:
            return
        job.status = "running"
        db.commit()
        sub = db.get(Submission, submission_id)
        snap = db.scalar(select(SubmissionSnapshot).where(SubmissionSnapshot.submission_id == submission_id))
        v = db.get(ExerciseVersion, sub.exercise_version_id)
        res = run_grader(snap.data, v.rubric)
        if res.ok:
            r = res.report
            db.add(GradingResult(submission_id=submission_id, engine_version=r["engineVersion"], score=r["score"], max_score=r["maxScore"], report=r))
            job.status = "done"
        else:
            job.status = "error"
            job.error = res.error
        job.finished_at = datetime.now(UTC)
        db.commit()
    finally:
        db.close()


@router.post("/exercise-versions/{vid}/submissions", status_code=202)
def submit(vid: str, body: SubmissionIn, tasks: BackgroundTasks, u: User = Depends(current_user), db: Session = Depends(get_db)):
    v, e, _ = _version_for(db, u, vid)
    if not v.published:
        raise HTTPException(409, "not_published")
    raw = json.dumps(body.project, sort_keys=True)
    if len(raw) > get_settings().max_project_bytes:
        raise HTTPException(413, "project_too_large")
    sub = Submission(org_id=e.org_id, exercise_version_id=v.id, student_id=u.id, justification=body.justification)
    db.add(sub)
    db.flush()
    db.add(SubmissionSnapshot(submission_id=sub.id, data=body.project, sha256=hashlib.sha256(raw.encode()).hexdigest()))
    db.add(GradingJob(submission_id=sub.id))
    db.add(AuditLog(org_id=e.org_id, actor_id=u.id, action="submission.create", target=sub.id))
    db.commit()
    tasks.add_task(grade_submission, sub.id)
    return {"id": sub.id, "status": "pending"}


@router.get("/submissions/{sid}")
def get_submission(sid: str, u: User = Depends(current_user), db: Session = Depends(get_db)):
    sub = db.get(Submission, sid)
    if not sub:
        raise HTTPException(404, "not_found")
    m = membership(db, u, sub.org_id)
    staff = u.is_superadmin or (m is not None and m.role in (Role.teacher, Role.org_admin))
    if not staff and sub.student_id != u.id:
        raise HTTPException(404, "not_found")
    job = db.scalar(select(GradingJob).where(GradingJob.submission_id == sid).order_by(GradingJob.created_at.desc()))
    result = db.scalar(select(GradingResult).where(GradingResult.submission_id == sid).order_by(GradingResult.created_at.desc()))
    v = db.get(ExerciseVersion, sub.exercise_version_id)
    snap = db.scalar(select(SubmissionSnapshot).where(SubmissionSnapshot.submission_id == sid))
    out = {"id": sub.id, "exercise_version_id": sub.exercise_version_id, "student_id": sub.student_id, "created_at": sub.created_at,
           "status": job.status if job else "none", "snapshot_sha256": snap.sha256}
    if job and job.status == "error":
        out["error"] = job.error if staff else "grading_failed"
    if result:
        out["report"] = result.report if staff else student_view(result.report, v.show_hidden_after_grading)
    if staff:
        out["snapshot"] = snap.data
    return out
