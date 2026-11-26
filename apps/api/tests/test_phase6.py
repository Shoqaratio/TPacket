from .conftest import join, make_user, new_org
from .test_platform import EMPTY, RUBRIC


def _published_incident(admin, slug):
    from app.db import SessionLocal
    from app.models import GradingResult, Submission

    org = new_org(admin, slug)
    teacher = make_user(f"teacher@{slug}.example.com")
    student = make_user(f"student@{slug}.example.com")
    join(teacher, admin, org, "teacher")
    join(student, admin, org, "student")
    exercise = teacher.post(f"/api/orgs/{org}/exercises", json={"title": "Incident LAN"}).json()
    version_response = teacher.post(
        f"/api/exercises/{exercise['id']}/versions",
        json={
            "statement": "Rétablir la connectivité entre les deux postes.",
            "initial_project": EMPTY,
            "rubric": RUBRIC,
            "kind": "incident",
            "skill_map": {"ip": "addressing", "ping": "troubleshooting"},
            "publish": True,
        },
    )
    assert version_response.status_code == 201, version_response.text
    version_id = version_response.json()["id"]

    with SessionLocal() as db:
        submission = Submission(org_id=org, exercise_version_id=version_id, student_id=student.get("/api/auth/me").json()["id"])
        db.add(submission)
        db.flush()
        db.add(
            GradingResult(
                submission_id=submission.id,
                engine_version="test",
                score=10,
                max_score=10,
                report={"results": [{"id": "ip", "earned": 4}, {"id": "ping", "earned": 4}, {"id": "secret", "earned": 2}]},
            )
        )
        db.commit()

    return org, teacher, student, exercise, version_id


def test_incident_skills_and_private_achievements(admin):
    org, teacher, student, exercise, version_id = _published_incident(admin, "phase6-skills")
    visible = student.get(f"/api/exercise-versions/{version_id}").json()
    assert visible["kind"] == "incident"
    assert visible["skill_map"] == {"ip": "addressing", "ping": "troubleshooting"}
    assert "rubric" not in visible

    skills = student.get("/api/me/skills").json()
    by_id = {skill["id"]: skill for skill in skills}
    assert by_id["addressing"]["progress"] == 100
    assert by_id["troubleshooting"]["mastered_criteria"] == 1
    assert by_id["routing"]["progress"] is None

    achievements = student.get("/api/me/achievements").json()
    assert achievements == {
        "points": 100,
        "completed_activities": 1,
        "badges": ["first_steps", "perfect_score", "incident_resolver"],
    }

    invalid = teacher.post(
        f"/api/exercises/{exercise['id']}/versions",
        json={
            "statement": "",
            "initial_project": EMPTY,
            "rubric": RUBRIC,
            "skill_map": {"secret": "security"},
        },
    )
    assert invalid.status_code == 422


def test_community_publication_requires_moderation_and_hides_unapproved_content(admin):
    _, teacher, student, _, version_id = _published_incident(admin, "phase6-community")
    response = teacher.post("/api/community", json={"exercise_version_id": version_id})
    assert response.status_code == 201, response.text
    publication_id = response.json()["id"]

    assert student.get("/api/community").json() == []
    assert student.get(f"/api/community/{publication_id}").status_code == 404
    assert student.post("/api/community", json={"exercise_version_id": version_id}).status_code == 403
    assert teacher.get("/api/community/moderation/pending").status_code == 403
    assert teacher.post("/api/community", json={"exercise_version_id": version_id}).status_code == 409

    pending = admin.get("/api/community/moderation/pending").json()
    assert [item["id"] for item in pending] == [publication_id]
    decision = admin.post(f"/api/community/{publication_id}/moderate", json={"status": "approved"})
    assert decision.status_code == 200 and decision.json()["status"] == "approved"

    detail = student.get(f"/api/community/{publication_id}")
    assert detail.status_code == 200
    assert detail.json()["kind"] == "incident"
    assert detail.json()["statement"].startswith("Rétablir")
    assert "rubric" not in detail.json()
    assert [item["id"] for item in student.get("/api/community").json()] == [publication_id]


def test_skill_and_gamification_results_follow_assignment_visibility(admin):
    org = new_org(admin, "phase6-hidden")
    teacher = make_user("teacher@phase6-hidden.example.com")
    student = make_user("student@phase6-hidden.example.com")
    join(teacher, admin, org, "teacher")
    join(student, admin, org, "student")
    cls = teacher.post(f"/api/orgs/{org}/classes", json={"name": "SIO1", "academic_year": "2026-2027"}).json()
    code = teacher.post(f"/api/classes/{cls['id']}/join-code").json()["code"]
    assert student.post("/api/auth/invites/redeem", json={"code": code}).status_code == 200
    exercise = teacher.post(f"/api/orgs/{org}/exercises", json={"title": "Incident"}).json()
    version = teacher.post(
        f"/api/exercises/{exercise['id']}/versions",
        json={
            "statement": "Incident de test",
            "initial_project": EMPTY,
            "rubric": RUBRIC,
            "kind": "incident",
            "skill_map": {"ip": "addressing"},
            "publish": True,
        },
    ).json()
    assignment = teacher.post(
        f"/api/classes/{cls['id']}/assignments",
        json={"exercise_version_id": version["id"], "title": "Examen", "results": "never"},
    ).json()

    from app.db import SessionLocal
    from app.models import GradingResult, Submission

    with SessionLocal() as db:
        submission = Submission(
            org_id=org,
            exercise_version_id=version["id"],
            student_id=student.get("/api/auth/me").json()["id"],
            assignment_id=assignment["id"],
        )
        db.add(submission)
        db.flush()
        db.add(
            GradingResult(
                submission_id=submission.id,
                engine_version="test",
                score=10,
                max_score=10,
                report={"results": [{"id": "ip", "earned": 4}, {"id": "ping", "earned": 4}, {"id": "secret", "earned": 2}]},
            )
        )
        db.commit()

    assert student.get("/api/me/skills").json()[0]["progress"] is None
    assert student.get("/api/me/achievements").json() == {"points": 0, "completed_activities": 0, "badges": []}
