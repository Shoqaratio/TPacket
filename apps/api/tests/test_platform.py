import json
import subprocess
from pathlib import Path

import pytest

from .conftest import join, make_user, new_org

ENGINE = Path(__file__).resolve().parents[3] / "packages" / "engine"
EMPTY = {"format": "netlab", "schemaVersion": 1, "name": "x", "devices": [], "links": []}


def test_project_crud_and_optimistic_concurrency():
    c = make_user("p@example.com")
    p = c.post("/api/projects", json={"name": "Lab", "data": EMPTY}).json()
    assert c.put(f"/api/projects/{p['id']}", json={"data": EMPTY, "base_version": 1}).json()["version"] == 2
    assert c.put(f"/api/projects/{p['id']}", json={"data": EMPTY, "base_version": 1}).status_code == 409
    assert [x["name"] for x in c.get("/api/projects").json()] == ["Lab"]
    other = make_user("intruder@example.com")
    assert other.get(f"/api/projects/{p['id']}").status_code == 404  # IDOR protection
    assert other.delete(f"/api/projects/{p['id']}").status_code == 404
    assert c.post("/api/projects", json={"name": "Bad", "data": {"format": "pkt"}}).status_code == 422


def test_org_isolation_and_roles(admin):
    a = new_org(admin, "lycee-a")
    b = new_org(admin, "lycee-b")
    teacher_a = make_user("prof.a@example.com")
    student_b = make_user("eleve.b@example.com")
    join(teacher_a, admin, a, "teacher")
    join(student_b, admin, b, "student")
    ex = teacher_a.post(f"/api/orgs/{a}/exercises", json={"title": "TP1"}).json()
    assert student_b.get(f"/api/orgs/{a}/exercises").status_code == 404
    assert student_b.post(f"/api/orgs/{a}/exercises", json={"title": "x"}).status_code == 404
    student_a = make_user("eleve.a@example.com")
    join(student_a, admin, a, "student")
    assert student_a.post(f"/api/orgs/{a}/exercises", json={"title": "x"}).status_code == 403
    # Teachers cannot mint staff invites.
    assert teacher_a.post(f"/api/orgs/{a}/invites", json={"role": "org_admin"}).status_code == 403
    assert ex["id"]


@pytest.fixture(scope="module")
def grader_bundle():
    if not (ENGINE / "dist" / "grader.mjs").exists():
        subprocess.run(["node", "build-grader.mjs"], cwd=ENGINE, check=True)


def _two_pc_project(ip2: str) -> dict:
    """Builds a real project with the engine (PC0 - Switch0 - PC1)."""
    script = f"""
    import {{ Network, createProject }} from './src/index.ts';
    const n = new Network(createProject('t'));
    const s = n.addDevice('2960-24TT', 0, 0); const a = n.addDevice('PC', 0, 0); const b = n.addDevice('PC', 0, 0);
    n.addLink('straight', {{device: a.id, port: 'FastEthernet0'}}, {{device: s.id, port: 'FastEthernet0/1'}});
    n.addLink('straight', {{device: b.id, port: 'FastEthernet0'}}, {{device: s.id, port: 'FastEthernet0/2'}});
    n.setHostConfig(a.id, {{ip: '192.168.1.10', mask: '255.255.255.0'}});
    n.setHostConfig(b.id, {{ip: '{ip2}', mask: '255.255.255.0'}});
    console.log(JSON.stringify(n.serialize()));
    """
    out = subprocess.run(["npx", "--yes", "tsx", "-e", script], cwd=ENGINE, capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


RUBRIC = {
    "maxScore": 10,
    "criteria": [
        {"id": "ip", "type": "host_config", "device": "PC1", "field": "ip", "expected": "192.168.1.11", "points": 4},
        {"id": "ping", "type": "connectivity_test", "source": "PC0", "destination": "PC1", "expected": "success", "points": 4},
        {"id": "secret", "type": "device_count", "kind": "router", "max": 0, "points": 2, "hidden": True},
    ],
}


def test_submission_is_graded_server_side_and_hidden_tests_stay_hidden(admin, grader_bundle):
    org = new_org(admin, "lycee-g")
    teacher = make_user("prof@example.com")
    student = make_user("eleve@example.com")
    join(teacher, admin, org, "teacher")
    join(student, admin, org, "student")
    ex = teacher.post(f"/api/orgs/{org}/exercises", json={"title": "LAN"}).json()
    v = teacher.post(f"/api/exercises/{ex['id']}/versions", json={"statement": "Relier deux PC", "initial_project": EMPTY, "rubric": RUBRIC, "publish": True}).json()

    view = student.get(f"/api/exercise-versions/{v['id']}").json()
    assert "rubric" not in view and all(c["id"] != "secret" for c in view["criteria"])
    assert "192.168.1.11" not in json.dumps(view)

    # A forged client score in the payload is ignored: only the snapshot is graded.
    good = _two_pc_project("192.168.1.11")
    sub = student.post(f"/api/exercise-versions/{v['id']}/submissions", json={"project": good, "justification": "fait"}).json()
    res = student.get(f"/api/submissions/{sub['id']}").json()
    assert res["status"] == "done", res
    assert res["report"]["score"] == 10
    assert all(r["id"] != "secret" for r in res["report"]["results"])
    assert res["report"]["hidden_summary"] == {"count": 1, "passed": 1}
    assert "snapshot" not in res

    bad = _two_pc_project("192.168.2.11")
    sub2 = student.post(f"/api/exercise-versions/{v['id']}/submissions", json={"project": bad}).json()
    r2 = student.get(f"/api/submissions/{sub2['id']}").json()
    assert r2["report"]["score"] == 2  # only the hidden structural criterion

    full = teacher.get(f"/api/submissions/{sub['id']}").json()
    assert any(r["id"] == "secret" for r in full["report"]["results"]) and full["snapshot"]["devices"]

    outsider = make_user("autre@example.com")
    assert outsider.get(f"/api/submissions/{sub['id']}").status_code == 404


def test_snapshot_is_immutable(admin, grader_bundle):
    from app.db import SessionLocal
    from app.models import SubmissionSnapshot

    org = new_org(admin, "lycee-i")
    teacher = make_user("t@example.com")
    join(teacher, admin, org, "teacher")
    ex = teacher.post(f"/api/orgs/{org}/exercises", json={"title": "x"}).json()
    v = teacher.post(f"/api/exercises/{ex['id']}/versions", json={"statement": "", "initial_project": EMPTY, "rubric": {"maxScore": 1, "criteria": []}, "publish": True}).json()
    teacher.post(f"/api/exercise-versions/{v['id']}/submissions", json={"project": EMPTY})
    with SessionLocal() as db:
        snap = db.query(SubmissionSnapshot).one()
        snap.data = {"tampered": True}
        with pytest.raises(PermissionError):
            db.commit()


def test_invalid_rubric_rejected(admin):
    org = new_org(admin, "lycee-r")
    ex = admin.post(f"/api/orgs/{org}/exercises", json={"title": "x"}).json()
    r = admin.post(f"/api/exercises/{ex['id']}/versions", json={"statement": "", "initial_project": EMPTY, "rubric": {"maxScore": 10, "criteria": [{"id": "a", "type": "shell", "points": 1}]}})
    assert r.status_code == 422
