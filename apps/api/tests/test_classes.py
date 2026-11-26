from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

import pytest

from .conftest import join, make_user, new_org
from .test_platform import EMPTY, RUBRIC, _two_pc_project, grader_bundle  # noqa: F401


def _setup(admin, slug="lycee-c", **assignment):
    org = new_org(admin, slug)
    teacher = make_user(f"prof@{slug}.example.com")
    student = make_user(f"eleve@{slug}.example.com")
    join(teacher, admin, org, "teacher")
    cls = teacher.post(f"/api/orgs/{org}/classes", json={"name": "SIO1 A", "academic_year": "2026-2027"}).json()
    code = teacher.post(f"/api/classes/{cls['id']}/join-code").json()["code"]
    assert student.post("/api/auth/invites/redeem", json={"code": code}).status_code == 200
    ex = teacher.post(f"/api/orgs/{org}/exercises", json={"title": "LAN"}).json()
    v = teacher.post(f"/api/exercises/{ex['id']}/versions", json={"statement": "Relier deux PC", "initial_project": EMPTY, "rubric": RUBRIC, "publish": True}).json()
    a = teacher.post(f"/api/classes/{cls['id']}/assignments", json={"exercise_version_id": v["id"], "title": "TP1", **assignment})
    assert a.status_code == 201, a.text
    return org, teacher, student, cls, a.json()


def test_class_code_enrols_student_and_assignment_flow(admin, grader_bundle):  # noqa: F811
    org, teacher, student, cls, a = _setup(admin, max_attempts=2)
    mine = student.get("/api/me/assignments").json()
    assert [x["title"] for x in mine["assignments"]] == ["TP1"]
    view = student.get(f"/api/assignments/{a['id']}").json()
    assert "rubric" not in view and all(c["id"] != "secret" for c in view["criteria"])
    good = _two_pc_project("192.168.1.11")
    # Intermediate check: public criteria only.
    chk = student.post(f"/api/assignments/{a['id']}/check", json={"project": good}).json()
    assert {r["id"] for r in chk["results"]} == {"ip", "ping"}
    assert student.post(f"/api/assignments/{a['id']}/submissions", json={"project": good}).status_code == 202
    assert student.post(f"/api/assignments/{a['id']}/submissions", json={"project": good}).status_code == 202
    assert student.post(f"/api/assignments/{a['id']}/submissions", json={"project": good}).json()["detail"] == "no_attempts_left"
    subs = student.get(f"/api/assignments/{a['id']}/my-submissions").json()
    assert subs[-1]["score"] == 10 and subs[-1]["attempt"] == 2
    rows = teacher.get(f"/api/assignments/{a['id']}/submissions").json()
    assert rows[0]["score"] == 10 and rows[0]["attempts"] == 2
    # Manual override keeps the history.
    sid = rows[0]["submission_id"]
    assert teacher.post(f"/api/submissions/{sid}/override", json={"score": 8, "reason": "Compte rendu incomplet", "feedback": "Ajoutez le plan d'adressage"}).status_code == 200
    hist = teacher.get(f"/api/submissions/{sid}/history").json()
    assert hist["automatic"] == 10 and hist["history"][0]["score"] == 8
    assert student.get(f"/api/assignments/{a['id']}/my-submissions").json()[-1]["score"] == 8
    assert student.post(f"/api/submissions/{sid}/override", json={"score": 20, "reason": "triche"}).status_code == 403
    dash = teacher.get(f"/api/orgs/{org}/dashboard").json()
    assert dash["classes"] == 1 and dash["per_class"][0]["average_20"] is not None


def test_results_hidden_until_due(admin, grader_bundle):  # noqa: F811
    due = (datetime.now(UTC) + timedelta(days=1)).isoformat()
    _, _, student, _, a = _setup(admin, "lycee-h", results="after_due", due_at=due)
    student.post(f"/api/assignments/{a['id']}/submissions", json={"project": _two_pc_project("192.168.1.11")})
    sub = student.get(f"/api/assignments/{a['id']}/my-submissions").json()[0]
    assert "score" not in sub and "report" not in sub


def test_exam_timing_extension_and_monitoring(admin, grader_bundle):  # noqa: F811
    org, teacher, student, cls, a = _setup(admin, "lycee-e", exam=True, duration_min=30, allow_checks=False)
    assert student.post(f"/api/assignments/{a['id']}/submissions", json={"project": EMPTY}).json()["detail"] == "not_started"
    assert student.post(f"/api/assignments/{a['id']}/check", json={"project": EMPTY}).status_code == 403
    dl = datetime.fromisoformat(student.post(f"/api/assignments/{a['id']}/start").json()["deadline"])
    me = student.get("/api/auth/me").json()["id"]
    teacher.post(f"/api/assignments/{a['id']}/extensions", json={"student_id": me, "extra_minutes": 10})
    dl2 = datetime.fromisoformat(student.get(f"/api/assignments/{a['id']}").json()["deadline"])
    assert (dl2 - dl) == timedelta(minutes=10)
    # Session events are only stored when the school enabled monitoring.
    assert student.post(f"/api/assignments/{a['id']}/events", json={"kind": "tab_hidden"}).json() == {"recorded": False}
    admin.put(f"/api/orgs/{org}/settings", json={"exam_monitoring": True})
    assert student.post(f"/api/assignments/{a['id']}/events", json={"kind": "tab_hidden"}).json() == {"recorded": True}
    assert student.post(f"/api/assignments/{a['id']}/submissions", json={"project": EMPTY}).status_code == 202


def test_deadline_enforced_server_side(admin, grader_bundle):  # noqa: F811
    past = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    _, _, student, _, a = _setup(admin, "lycee-d", due_at=past)
    assert student.post(f"/api/assignments/{a['id']}/submissions", json={"project": EMPTY}).json()["detail"] == "deadline_passed"


def test_other_class_cannot_see_assignment(admin, grader_bundle):  # noqa: F811
    org, teacher, student, cls, a = _setup(admin, "lycee-x")
    outsider = make_user("autre@lycee-x.example.com")
    join(outsider, admin, org, "student")  # same school, other class
    assert outsider.get(f"/api/assignments/{a['id']}").status_code == 404
    assert outsider.post(f"/api/assignments/{a['id']}/submissions", json={"project": EMPTY}).status_code == 404


@contextmanager
def live_server_url(app=None):
    """Start a real Uvicorn instance with a dedicated event loop."""
    import socket
    import threading
    import time

    import uvicorn

    if app is None:
        from app.main import app

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", ws="websockets"))
    th = threading.Thread(target=server.run, daemon=True)
    th.start()
    while not server.started:
        time.sleep(0.05)
    try:
        yield f"ws://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        th.join(5)


@pytest.fixture
def live_server():
    with live_server_url() as url:
        yield url


def _ws(url, client):
    from websockets.sync.client import connect

    return connect(url, additional_headers={"Cookie": f"nl_session={client.cookies.get('nl_session')}"}, open_timeout=5)


def _next(ws, pred):
    import json

    while True:
        m = json.loads(ws.recv(timeout=5))
        if pred(m):
            return m


def test_collaboration_orders_ops_and_enforces_roles(admin, live_server):
    import json

    org = new_org(admin, "lycee-w")
    owner = make_user("owner@lycee-w.example.com")
    viewer = make_user("viewer@lycee-w.example.com")
    join(owner, admin, org, "teacher")
    join(viewer, admin, org, "student")
    pid = owner.post("/api/projects", json={"name": "Démo", "data": EMPTY}).json()["id"]
    token = owner.post(f"/api/projects/{pid}/share", json={"org_id": org, "role": "read"}).json()["token"]
    with _ws(f"{live_server}/api/ws/projects/{pid}", owner) as wo:
        init = _next(wo, lambda m: m["type"] == "init")
        assert init["you"]["role"] == "write"
        with _ws(f"{live_server}/api/ws/projects/{pid}?token={token}", viewer) as wv:
            assert _next(wv, lambda m: m["type"] == "init")["you"]["role"] == "read"
            wv.send(json.dumps({"type": "op", "op": {"kind": "op", "name": "addDevice", "args": ["PC", 0, 0]}}))
            assert _next(wv, lambda m: m["type"] == "error")["code"] == "read_only"
            wo.send(json.dumps({"type": "op", "op": {"kind": "op", "name": "addDevice", "args": ["PC", 0, 0]}}))
            seen = _next(wv, lambda m: m["type"] == "op" and m["op"].get("kind") != "tick")
            assert seen["op"]["name"] == "addDevice" and seen["actor"] == init["you"]["id"]
            tick = _next(wv, lambda m: m["type"] == "op" and m["op"].get("kind") == "tick")
            assert tick["actor"] == "server" and tick["seq"] > 0
            wo.send(json.dumps({"type": "chat", "text": "Regardez R1"}))
            assert _next(wv, lambda m: m["type"] == "chat")["text"] == "Regardez R1"
    stranger = make_user("x@elsewhere.example.com")
    with pytest.raises(Exception):
        with _ws(f"{live_server}/api/ws/projects/{pid}?token={token}", stranger) as ws:
            ws.recv(timeout=5)


def test_ai_tutor_is_optional_and_respects_assignment_policy(admin, grader_bundle, monkeypatch):  # noqa: F811
    from app.config import get_settings
    from app.routers import tutor

    assert admin.get("/api/tutor/ai/status").json() == {"enabled": False}
    assert admin.post("/api/tutor/ai", json={"question": "pourquoi ?"}).status_code == 404
    monkeypatch.setattr(get_settings(), "ai_url", "http://ai.invalid/v1")
    seen = {}

    def fake(url, key, model, messages):
        seen["system"] = messages[0]["content"]
        return "Vérifie la passerelle de PC0."

    monkeypatch.setattr(tutor, "_call", fake)
    _, _, student, _, a = _setup(admin, "lycee-ai", allow_tutor=True)
    r = student.post("/api/tutor/ai", json={"question": "pourquoi ?", "diagnosis": "no_gateway", "assignment_id": a["id"]})
    assert r.json()["answer"].startswith("Vérifie") and "JAMAIS" in seen["system"]
    _, _, s2, _, a2 = _setup(admin, "lycee-ai2", allow_tutor=False)
    assert s2.post("/api/tutor/ai", json={"question": "?", "assignment_id": a2["id"]}).status_code == 403
