from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import STAFF, current_user, require_role
from ..models import (
    Assignment,
    AuditLog,
    CommunityPublication,
    Exercise,
    ExerciseVersion,
    GradeHistory,
    GradingResult,
    Submission,
    User,
)
from ..skills import SKILL_CATALOG, SKILL_CODES

router = APIRouter(prefix="/api", tags=["phase6"])


class CommunitySubmission(BaseModel):
    exercise_version_id: str = Field(min_length=1, max_length=32)


class ModerationDecision(BaseModel):
    status: Literal["approved", "rejected"]


def _result_visible(db: Session, submission: Submission) -> bool:
    if not submission.assignment_id:
        return True
    assignment = db.get(Assignment, submission.assignment_id)
    if not assignment:
        return False
    if assignment.results == "immediate":
        return True
    if assignment.results == "after_due":
        due = assignment.due_at
        if not due:
            return False
        if due.tzinfo is None:
            due = due.replace(tzinfo=UTC)
        return datetime.now(UTC) > due
    return False


@router.get("/skills")
def skill_catalog(_: User = Depends(current_user)):
    return list(SKILL_CATALOG)


@router.get("/me/skills")
def my_skills(u: User = Depends(current_user), db: Session = Depends(get_db)):
    best: dict[tuple[str, str], tuple[str, float, float]] = {}
    submissions = db.scalars(
        select(Submission).where(Submission.student_id == u.id).order_by(Submission.created_at)
    ).all()
    for submission in submissions:
        if not _result_visible(db, submission):
            continue
        result = db.scalar(
            select(GradingResult)
            .where(GradingResult.submission_id == submission.id)
            .order_by(GradingResult.created_at.desc())
        )
        if not result:
            continue
        version = db.get(ExerciseVersion, submission.exercise_version_id)
        if not version:
            continue
        by_id = {row.get("id"): row for row in result.report.get("results", []) if isinstance(row, dict)}
        visible_criteria = {c["id"]: c for c in version.rubric.get("criteria", []) if not c.get("hidden")}
        for criterion_id, skill_id in version.skill_map.items():
            criterion = visible_criteria.get(criterion_id)
            row = by_id.get(criterion_id)
            if not criterion or not row or skill_id not in SKILL_CODES:
                continue
            possible = max(float(criterion.get("points", 0)), 0.0)
            if possible <= 0:
                continue
            earned = min(max(float(row.get("earned", 0)), 0.0), possible)
            key = (version.id, criterion_id)
            prior = best.get(key)
            if not prior or earned / possible > prior[2] / prior[1]:
                best[key] = (skill_id, possible, earned)

    totals = {skill_id: [0.0, 0.0, 0] for skill_id in SKILL_CODES}
    for skill_id, possible, earned in best.values():
        totals[skill_id][0] += earned
        totals[skill_id][1] += possible
        totals[skill_id][2] += int(earned >= possible)
    return [
        {
            **skill,
            "earned_points": round(totals[skill["id"]][0], 2),
            "possible_points": round(totals[skill["id"]][1], 2),
            "mastered_criteria": totals[skill["id"]][2],
            "measured_criteria": sum(1 for code, _, _ in best.values() if code == skill["id"]),
            "progress": round(100 * totals[skill["id"]][0] / totals[skill["id"]][1]) if totals[skill["id"]][1] else None,
        }
        for skill in SKILL_CATALOG
    ]


@router.get("/me/achievements")
def my_achievements(u: User = Depends(current_user), db: Session = Depends(get_db)):
    best: dict[str, tuple[float, bool]] = {}
    submissions = db.scalars(
        select(Submission).where(Submission.student_id == u.id).order_by(Submission.created_at)
    ).all()
    for submission in submissions:
        if not _result_visible(db, submission):
            continue
        result = db.scalar(
            select(GradingResult)
            .where(GradingResult.submission_id == submission.id)
            .order_by(GradingResult.created_at.desc())
        )
        if not result or result.max_score <= 0:
            continue
        version = db.get(ExerciseVersion, submission.exercise_version_id)
        if not version:
            continue
        override = db.scalar(
            select(GradeHistory)
            .where(GradeHistory.submission_id == submission.id)
            .order_by(GradeHistory.created_at.desc())
        )
        score = override.score if override else result.score
        ratio = min(max(score / result.max_score, 0.0), 1.0)
        activity_id = submission.assignment_id or version.id
        prior = best.get(activity_id)
        if not prior or ratio > prior[0]:
            best[activity_id] = (ratio, version.kind == "incident")

    completed = len(best)
    ratios = [ratio for ratio, _ in best.values()]
    incident_mastered = any(ratio >= 1 and incident for ratio, incident in best.values())
    badge_ids = []
    if completed:
        badge_ids.append("first_steps")
    if any(ratio >= 1 for ratio in ratios):
        badge_ids.append("perfect_score")
    if completed >= 5:
        badge_ids.append("consistent_practice")
    if incident_mastered:
        badge_ids.append("incident_resolver")
    return {
        "points": sum(round(ratio * 100) for ratio in ratios),
        "completed_activities": completed,
        "badges": badge_ids,
    }


def _community_item(publication: CommunityPublication, version: ExerciseVersion, exercise: Exercise) -> dict:
    skill_codes = sorted(set(version.skill_map.values()) & SKILL_CODES)
    return {
        "id": publication.id,
        "title": exercise.title,
        "kind": version.kind,
        "summary": version.statement[:240],
        "skill_codes": skill_codes,
        "created_at": publication.created_at,
        "status": publication.status,
    }


@router.get("/community")
def community_library(
    q: str = Query(default="", max_length=100),
    _: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    query = (
        select(CommunityPublication, ExerciseVersion, Exercise)
        .join(ExerciseVersion, CommunityPublication.exercise_version_id == ExerciseVersion.id)
        .join(Exercise, ExerciseVersion.exercise_id == Exercise.id)
        .where(CommunityPublication.status == "approved")
    )
    if q.strip():
        pattern = f"%{q.strip()}%"
        query = query.where(Exercise.title.ilike(pattern) | ExerciseVersion.statement.ilike(pattern))
    rows = db.execute(query.order_by(CommunityPublication.created_at.desc()).limit(100)).all()
    return [_community_item(publication, version, exercise) for publication, version, exercise in rows]


@router.get("/community/moderation/pending")
def pending_publications(u: User = Depends(current_user), db: Session = Depends(get_db)):
    if not u.is_superadmin:
        raise HTTPException(403, "forbidden")
    rows = db.execute(
        select(CommunityPublication, ExerciseVersion, Exercise)
        .join(ExerciseVersion, CommunityPublication.exercise_version_id == ExerciseVersion.id)
        .join(Exercise, ExerciseVersion.exercise_id == Exercise.id)
        .where(CommunityPublication.status == "pending")
        .order_by(CommunityPublication.created_at)
        .limit(100)
    ).all()
    return [_community_item(publication, version, exercise) for publication, version, exercise in rows]


@router.get("/community/{publication_id}")
def community_detail(publication_id: str, u: User = Depends(current_user), db: Session = Depends(get_db)):
    row = db.execute(
        select(CommunityPublication, ExerciseVersion, Exercise)
        .join(ExerciseVersion, CommunityPublication.exercise_version_id == ExerciseVersion.id)
        .join(Exercise, ExerciseVersion.exercise_id == Exercise.id)
        .where(CommunityPublication.id == publication_id)
    ).first()
    if not row:
        raise HTTPException(404, "not_found")
    publication, version, exercise = row
    if publication.status != "approved" and not u.is_superadmin:
        raise HTTPException(404, "not_found")
    return {
        **_community_item(publication, version, exercise),
        "statement": version.statement,
        "initial_project": version.initial_project,
        "skill_map": version.skill_map,
    }


@router.post("/community", status_code=201)
def publish_to_community(body: CommunitySubmission, u: User = Depends(current_user), db: Session = Depends(get_db)):
    version = db.get(ExerciseVersion, body.exercise_version_id)
    exercise = db.get(Exercise, version.exercise_id) if version else None
    if not version or not exercise or not version.published:
        raise HTTPException(404, "exercise_not_found")
    require_role(db, u, exercise.org_id, *STAFF)
    if db.scalar(select(CommunityPublication.id).where(CommunityPublication.exercise_version_id == version.id)):
        raise HTTPException(409, "already_submitted")
    publication = CommunityPublication(exercise_version_id=version.id, author_id=u.id)
    db.add(publication)
    db.add(AuditLog(org_id=exercise.org_id, actor_id=u.id, action="community.submit", target=version.id))
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        if db.scalar(select(CommunityPublication.id).where(CommunityPublication.exercise_version_id == version.id)):
            raise HTTPException(409, "already_submitted") from exc
        raise
    return {"id": publication.id, "status": publication.status}


@router.post("/community/{publication_id}/moderate")
def moderate_publication(
    publication_id: str,
    body: ModerationDecision,
    u: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    if not u.is_superadmin:
        raise HTTPException(403, "forbidden")
    publication = db.get(CommunityPublication, publication_id)
    if not publication:
        raise HTTPException(404, "not_found")
    publication.status = body.status
    publication.reviewed_at = datetime.now(UTC)
    publication.reviewed_by = u.id
    version = db.get(ExerciseVersion, publication.exercise_version_id)
    exercise = db.get(Exercise, version.exercise_id) if version else None
    db.add(
        AuditLog(
            org_id=exercise.org_id if exercise else None,
            actor_id=u.id,
            action="community.moderate",
            target=publication.id,
            data={"status": publication.status},
        )
    )
    db.commit()
    return {"id": publication.id, "status": publication.status}
