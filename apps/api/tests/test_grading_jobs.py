from datetime import UTC, datetime, timedelta

from app.db import SessionLocal
from app.grading.recovery import recover_jobs
from app.grading.runner import student_view
from app.models import GradingJob, GradingResult
from app.routers.exercises import grade_submission

from .conftest import join, make_user, new_org
from .test_platform import EMPTY, grader_bundle  # noqa: F401 - fixture


def test_student_view_masks_hidden_dependencies_in_old_reports():
    report = {"score": 0, "maxScore": 2, "results": [
        {"id": "secret", "hidden": True, "passed": False, "code": "x", "message": "no"},
        {"id": "save", "hidden": False, "passed": False, "code": "dependency", "message": "Requires: secret"},
        {"id": "both", "hidden": False, "passed": False, "code": "dependency", "message": "Requires: save, secret"},
        {"id": "ok", "hidden": False, "passed": False, "code": "dependency", "message": "Requires: save"},
    ]}
    view = student_view(report, reveal_hidden=False)
    by = {r["id"]: r["message"] for r in view["results"]}
    assert by == {"save": "Requires: 1 hidden criterion", "both": "Requires: save (+1 hidden criterion)", "ok": "Requires: save"}
    assert "secret" not in str(view["results"])
    assert student_view(report, reveal_hidden=True)["results"][1]["message"] == "Requires: secret"  # staff keep details


def _two_submissions(admin):
    org = new_org(admin, "lycee-r")
    teacher = make_user("t@example.com")
    join(teacher, admin, org, "teacher")
    ex = teacher.post(f"/api/orgs/{org}/exercises", json={"title": "x"}).json()
    rubric = {"maxScore": 1, "criteria": []}
    v = teacher.post(f"/api/exercises/{ex['id']}/versions", json={"statement": "", "initial_project": EMPTY, "rubric": rubric, "publish": True}).json()
    ids = [teacher.post(f"/api/exercise-versions/{v['id']}/submissions", json={"project": EMPTY}).json()["id"] for _ in range(2)]
    return teacher, ids


def test_interrupted_jobs_are_recovered_at_startup(admin, grader_bundle):  # noqa: F811
    teacher, (stale, fresh) = _two_submissions(admin)
    with SessionLocal() as db:  # simulate a crash in the middle of both gradings
        db.query(GradingResult).delete()
        for sid, age in ((stale, timedelta(hours=2)), (fresh, timedelta(0))):
            job = db.query(GradingJob).filter_by(submission_id=sid).one()
            job.status, job.finished_at, job.created_at = "running", None, datetime.now(UTC) - age
        db.commit()
    assert recover_jobs() == 1  # the recent "running" job may still be graded by another worker
    assert teacher.get(f"/api/submissions/{stale}").json()["status"] == "done"
    with SessionLocal() as db:
        assert db.query(GradingJob).filter_by(submission_id=fresh).one().status == "running"
        assert db.query(GradingResult).filter_by(submission_id=stale).count() == 1


def test_a_job_is_graded_only_once(admin, grader_bundle):  # noqa: F811
    _, (sid, _) = _two_submissions(admin)
    with SessionLocal() as db:
        db.query(GradingResult).delete()
        db.query(GradingJob).filter_by(submission_id=sid).one().status = "pending"
        db.commit()
    grade_submission(sid)
    grade_submission(sid)  # second call (other instance) finds nothing to claim
    with SessionLocal() as db:
        assert db.query(GradingResult).filter_by(submission_id=sid).count() == 1
        assert db.query(GradingJob).filter_by(submission_id=sid).one().status == "done"
