import asyncio
import json
import os
from contextlib import AsyncExitStack
from copy import deepcopy
from datetime import UTC, datetime, timedelta

import pytest
from websockets.exceptions import InvalidStatus

from app.campus_map import MAP, SPAWN, walkable
from app.campus_missions import TEMPLATES
from app.grading.runner import run_grader
from app.routers.campus import Player, project_invitation, receive_event

from .conftest import join, make_user
from .test_classes import _next, _setup, _ws, live_server, live_server_url  # noqa: F401
from .test_platform import grader_bundle  # noqa: F401
from .test_platform import EMPTY


def test_map_rooms_are_reachable_and_staff_room_is_private():
    def visit(staff):
        points = {SPAWN}
        to_check = [SPAWN]
        while to_check:
            x, y = to_check.pop()
            for p in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if p not in points and walkable(*p, staff):
                    points.add(p)
                    to_check.append(p)
        return points

    student, staff = visit(False), visit(True)
    for room in MAP["rooms"]:
        x, y = room["station"]
        assert (x, y + 1) in staff
        assert ((x, y + 1) in student) == (room["id"] != "staff")


@pytest.mark.parametrize("key", list(TEMPLATES))
def test_template_is_broken_initially_and_solvable(key, grader_bundle):
    template = TEMPLATES[key]
    project = deepcopy(template["project"])
    criteria = template["criteria"]
    rubric = {"maxScore": sum(x["points"] for x in criteria), "criteria": criteria}
    before = run_grader(project, rubric)
    assert before.ok, before.error
    assert before.report["score"] < rubric["maxScore"], before.report
    if key == "ipv4-support":
        project["devices"][2]["host"]["ip"] = "192.168.10.43"
    elif key == "ipv6-pilot":
        project["devices"][2]["host"]["ipv6"] = "2001:db8:10::43/64"
    elif key == "vlan-office":
        config = ["vlan 10", "exit", "vlan 20", "exit"]
        for index in range(1, 5):
            config.extend([f"interface FastEthernet0/{index}", "switchport mode access",
                           f"switchport access vlan {10 if index < 3 else 20}", "exit"])
        project["devices"][0]["running"] = "\n".join(config)
    elif key == "routing-buildings":
        project["devices"][0]["running"] += "\nip route 192.168.20.0 255.255.255.0 10.0.0.2"
        project["devices"][3]["running"] += "\nip route 0.0.0.0 0.0.0.0 10.0.0.1"
    elif key == "dns-catalog":
        project["devices"][2]["services"]["dns"]["records"][0]["ip"] = "192.168.50.20"
    elif key == "dhcp-classroom":
        project["devices"][2]["services"]["dhcp"]["enabled"] = True
    after = run_grader(project, rubric)
    assert after.ok, after.error
    assert after.report["score"] == rubric["maxScore"], after.report


def test_install_place_and_reward_only_verified_work(admin, grader_bundle):
    org, teacher, student, cls, a = _setup(admin)
    cid = cls["id"]
    endpoint = f"/api/campus/classes/{cid}"
    install = f"{endpoint}/templates/ipv4-support"
    place = f"/api/campus/assignments/{a['id']}/room"
    outsider = make_user("outside@example.com")
    join(outsider, admin, org, "student")
    assert outsider.get(endpoint).status_code == 404
    assert outsider.get("/api/campus").json()["classes"] == []
    assert student.post(install).status_code == 403
    assert student.put(place, json={"room": "network"}).status_code == 403
    assert teacher.put(place, json={"room": "staff"}).status_code == 422
    assert teacher.put(place, json={"room": "network"}).status_code == 200
    response = teacher.post(install)
    assert response.status_code == 201, response.text
    aid = response.json()["id"]
    assert teacher.post(install).json()["id"] == aid
    assert student.post(f"{endpoint}/missions/{aid}/start").json()["detail"] == "station_out_of_reach"
    assert student.put("/api/campus/avatar", json={"color": 3}).status_code == 403
    close = f"{endpoint}/rooms/network/closed"
    assert student.put(close, json={"enabled": True}).status_code == 403
    assert teacher.put(close, json={"enabled": True}).json()["closed"] == ["network"]
    assert student.post(f"{endpoint}/missions/{aid}/start").json()["detail"] == "room_closed"
    assert teacher.put(close, json={"enabled": False}).json()["closed"] == []
    state = student.get(endpoint).json()
    assert not state["completed"]
    assert [m["room"] for m in state["missions"]] == ["network", "network"]
    assert all("rubric" not in m and "initial_project" not in m for m in state["missions"])
    project = deepcopy(TEMPLATES["ipv4-support"]["project"])
    sub = f"/api/assignments/{aid}/submissions"
    assert student.post(sub, json={"project": project, "score": 1000, "xp": 500}).status_code == 202
    assert student.get(endpoint).json()["completed"] == []
    project["devices"][2]["host"]["ip"] = "192.168.10.43"
    for _ in range(2):
        assert student.post(sub, json={"project": project}).status_code == 202
    assert student.get(endpoint).json()["completed"] == [aid]
    assert student.get("/api/me/assignments").json()["average_20"] is None
    assert teacher.get(f"/api/orgs/{org}/dashboard").json()["graded_submissions"] == 0
    assert student.put("/api/campus/avatar", json={"color": 3}).status_code == 200
    assert student.get("/api/campus").json()["profile"]["color"] == 3


def test_socket_presence_collision_reconnect_and_permissions(admin, live_server):
    org, teacher, student, cls, _ = _setup(admin)
    cid = cls["id"]
    url = f"{live_server}/api/ws/campus/{cid}"
    sid = student.get("/api/auth/me").json()["id"]
    outsider = make_user("other-campus@example.com")
    join(outsider, admin, org, "student")
    with pytest.raises(InvalidStatus):
        _ws(url, outsider)

    def sees(message, x):
        return message["type"] == "state" and any(p["id"] == sid and p["x"] == x for p in message["players"])

    x, y = SPAWN
    with _ws(url, teacher) as observer:
        with _ws(url, student) as player:
            _next(observer, lambda m: sees(m, x))
            player.send(json.dumps({"type": "step", "x": x + 10, "y": y}))
            _next(player, lambda m: m["type"] == "state")
            player.send(json.dumps({"type": "step", "x": x + 1, "y": y}))
            _next(observer, lambda m: sees(m, x + 1))
            observer.send(json.dumps({"type": "chat", "channel": "announcement", "value": "Bienvenue"}))
            assert _next(player, lambda m: m["type"] == "chat")["text"] == "Bienvenue"
        _next(observer, lambda m: m["type"] == "state" and not any(p["id"] == sid for p in m["players"]))
        with _ws(url, student) as reconnected:
            _next(reconnected, lambda m: sees(m, x + 1))


def test_class_dispatch_preserves_exam_timing_and_respects_roles(admin):
    _, teacher, student, cls, exam = _setup(admin, exam=True, duration_min=30)
    cid = cls["id"]
    endpoint = f"/api/campus/classes/{cid}"
    installed = teacher.post(f"{endpoint}/templates/ipv4-support").json()["id"]
    exercise = next(m for m in teacher.get(endpoint).json()["missions"] if m["id"] == installed)
    future = (datetime.now(UTC) + timedelta(days=1)).isoformat()
    scheduled = teacher.post(f"/api/classes/{cid}/assignments", json={
        "exercise_version_id": exercise["exercise_version_id"], "title": "Incident programmé",
        "opens_at": future,
    }).json()
    aid = scheduled["id"]
    assert teacher.put(f"/api/campus/assignments/{aid}/room", json={"room": "network"}).status_code == 200
    start = f"{endpoint}/missions/{exam['id']}/start"
    assert student.post(start).json()["detail"] == "station_out_of_reach"
    assert student.get(f"/api/assignments/{exam['id']}").json()["started_at"] is None
    assert [m["room"] for m in student.get(endpoint).json()["missions"] if m["id"] == exam["id"]] == ["exam"]
    assert not any(m["id"] == aid for m in student.get(endpoint).json()["missions"])
    dispatch = f"{endpoint}/missions/{aid}/dispatch"
    assert student.post(dispatch).status_code == 403
    assert teacher.post(dispatch).status_code == 200
    assert teacher.post(dispatch).status_code == 200
    released = student.get(endpoint).json()
    assert any(m["id"] == aid for m in released["missions"])
    assert released["announcements"] == ["Incident à traiter : Incident programmé"]


def test_invitation_reuses_project_share_and_is_visible_only_to_recipient(admin):
    org, teacher, student, cls, _ = _setup(admin)
    sender_id = teacher.get("/api/auth/me").json()["id"]
    student_id = student.get("/api/auth/me").json()["id"]
    project = teacher.post("/api/projects", json={"name": "Atelier partagé", "data": EMPTY}).json()["id"]
    token = teacher.post(f"/api/projects/{project}/share", json={"org_id": org, "role": "write"}).json()["token"]
    sender = Player(sender_id, "Prof", True)
    recipient = Player(student_id, "Élève", False)
    payload = {"project": project, "target": student_id, "token": token}
    assert project_invitation(sender, payload, cls["id"]) is None
    sender.x, sender.y = [next(r for r in MAP["rooms"] if r["id"] == "collaboration")[k] + 2 for k in ("x", "y")]
    assert project_invitation(sender, {**payload, "token": "invalid"}, cls["id"]) is None
    event = project_invitation(sender, payload, cls["id"])
    assert event and receive_event(sender, event) is None
    assert receive_event(recipient, event)["token"] == token


def test_collective_presentation_reuses_academy_course(admin):
    org, teacher, student, cls, _ = _setup(admin)
    course = teacher.post(f"/api/orgs/{org}/courses", json={
        "title": "Bases du LAN", "summary": "Étude du LAN", "duration_minutes": 20,
        "objectives": ["Identifier les équipements"],
        "lessons": [{"title": "Câblage", "body": "Relier deux postes au commutateur."},
                    {"title": "Vérification", "body": "Comparer les réponses aux pings."}],
    }).json()
    url = f"/api/campus/classes/{cls['id']}/presentation"
    assert student.get(url).json() is None
    selection = {"course_id": course["id"], "lesson": 0}
    assert student.put(url, json=selection).status_code == 403
    assert teacher.put(url, json={**selection, "lesson": 9}).status_code == 422
    assert teacher.put(url, json=selection).status_code == 200
    assert student.get(url).json()["lesson"]["title"] == "Câblage"
    assert teacher.put(url, json={**selection, "lesson": 1}).status_code == 200
    assert student.get(url).json()["lesson"]["title"] == "Vérification"
    assert teacher.put(url, json={"course_id": None}).json() is None
    assert student.get(url).json() is None


@pytest.mark.parametrize("shared", [False, True], ids=["single-instance", "two-instances-redis"])
def test_thirty_five_students_exchange_movement_and_chat(admin, monkeypatch, shared):
    from websockets.asyncio.client import connect

    from app.config import get_settings
    from app.main import create_app

    redis_url = os.environ.get("TPACKET_TEST_CAMPUS_REDIS_URL")
    if shared and not redis_url:
        pytest.skip("Set TPACKET_TEST_CAMPUS_REDIS_URL to exercise Redis")
    monkeypatch.setattr(get_settings(), "campus_redis_url", redis_url if shared else None)
    _, teacher, first, cls, _ = _setup(admin)
    cid = cls["id"]
    code = teacher.post(f"/api/classes/{cid}/join-code").json()["code"]
    students = [first]
    for i in range(34):
        student = make_user(f"campus-load-{i}@example.com", name=f"Élève {i + 2}")
        assert student.post("/api/auth/invites/redeem", json={"code": code}).is_success
        students.append(student)

    async def exercise(urls):
        async def receive(socket, predicate):
            async with asyncio.timeout(8):
                async for message in socket:
                    data = json.loads(message)
                    if predicate(data):
                        return data
            raise AssertionError("socket closed before expected message")

        async with AsyncExitStack() as stack:
            connections = []
            for i, student in enumerate(students):
                cookie = f"nl_session={student.cookies.get('nl_session')}"
                url = f"{urls[i % len(urls)]}/api/ws/campus/{cid}"
                socket = await stack.enter_async_context(connect(url, additional_headers={"Cookie": cookie}, max_queue=None))
                connections.append(socket)
            await asyncio.gather(*(receive(socket, lambda m: m["type"] == "state" and len(m["players"]) == 35)
                                   for socket in connections))
            x, y = SPAWN
            for step in range(12):
                goal = x + 1 if step % 2 == 0 else x
                await asyncio.gather(*(socket.send(json.dumps({"type": "step", "x": goal, "y": y})) for socket in connections))
                await asyncio.gather(*(receive(socket, lambda m: m["type"] == "state" and len(m["players"]) == 35
                                               and all(p["x"] == goal for p in m["players"])) for socket in connections))
                await asyncio.sleep(0.15)
            await connections[0].send(json.dumps({"type": "chat", "channel": "class", "value": "Présents"}))
            await asyncio.gather(*(receive(socket, lambda m: m["type"] == "chat" and m["text"] == "Présents") for socket in connections))

    with live_server_url(create_app()) as first_url:
        if shared:
            with live_server_url(create_app()) as second_url:
                asyncio.run(exercise([first_url, second_url]))
        else:
            asyncio.run(exercise([first_url]))
