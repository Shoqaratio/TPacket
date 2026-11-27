"""Restarts grading jobs interrupted by a crash or a restart of the API."""

import logging
import threading
from datetime import UTC, datetime, timedelta

from sqlalchemy import or_, select, update

from ..config import get_settings
from ..db import SessionLocal
from ..models import GradingJob

log = logging.getLogger("tpacket.grading")


def requeue_interrupted_jobs(now: datetime | None = None) -> list[str]:
    """Puts stale "running" jobs back to "pending"; returns the submission ids to grade."""
    cutoff = (now or datetime.now(UTC)) - timedelta(seconds=get_settings().grading_stale_after_s)
    with SessionLocal() as db:
        db.execute(
            update(GradingJob).where(GradingJob.status == "running", or_(GradingJob.created_at < cutoff, GradingJob.created_at.is_(None)))
            .values(status="pending", error=None)
        )
        db.commit()
        ids = db.scalars(select(GradingJob.submission_id).where(GradingJob.status == "pending").order_by(GradingJob.created_at)).all()
    return list(dict.fromkeys(ids))


def recover_jobs() -> int:
    """Grades every interrupted job (sequentially; run_grader also bounds concurrency)."""
    from ..routers.exercises import grade_submission  # late import: avoids an import cycle

    ids = requeue_interrupted_jobs()
    for sid in ids:
        grade_submission(sid)  # never raises: failures are stored on the job
    if ids:
        log.info("recovered %d grading job(s)", len(ids))
    return len(ids)


def start_recovery() -> threading.Thread | None:
    """Called at startup: runs in the background so the API is available immediately."""
    if not get_settings().recover_jobs_on_startup:
        return None

    def run() -> None:
        try:
            recover_jobs()
        except Exception:  # noqa: BLE001 - must never take the API down
            log.exception("grading job recovery failed")

    t = threading.Thread(target=run, name="grading-recovery", daemon=True)
    t.start()
    return t
