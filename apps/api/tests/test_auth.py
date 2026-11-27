from app.main import app

from .conftest import PASSWORD, Client, make_user


def test_register_login_me_logout():
    c = make_user("eleve@example.com", "Élève")
    me = c.get("/api/auth/me").json()
    assert me["email"] == "eleve@example.com" and me["is_superadmin"] is False
    assert c.post("/api/auth/logout").status_code == 204
    assert c.get("/api/auth/me").status_code == 401
    r = c.post("/api/auth/login", json={"email": "ELEVE@example.com", "password": PASSWORD})
    assert r.status_code == 200
    assert c.get("/api/auth/me").status_code == 200


def test_anonymous_cannot_access_projects():
    assert Client(app).get("/api/projects").status_code == 401


def test_session_cookie_is_httponly_and_password_hashed_with_argon2id():
    c = Client(app)
    r = c.post("/api/auth/register", json={"email": "a@example.org", "password": PASSWORD, "display_name": "A"})
    cookie = r.headers.get_list("set-cookie")
    assert any("nl_session=" in h and "HttpOnly" in h for h in cookie)
    from app.db import SessionLocal
    from app.models import User

    with SessionLocal() as db:
        assert db.query(User).one().password_hash.startswith("$argon2id$")


def test_weak_password_and_duplicate_email_rejected():
    c = Client(app)
    assert c.post("/api/auth/register", json={"email": "x@example.net", "password": "short", "display_name": "X"}).status_code == 422
    make_user("dup@example.net")
    assert Client(app).post("/api/auth/register", json={"email": "DUP@example.net", "password": PASSWORD, "display_name": "D"}).status_code == 409


def test_wrong_password_and_brute_force_lockout():
    make_user("victim@example.com")
    c = Client(app)
    codes = [c.post("/api/auth/login", json={"email": "victim@example.com", "password": "wrong-password"}).status_code for _ in range(12)]
    assert codes[0] == 401
    assert codes[-1] == 429


def test_csrf_required_for_state_changes():
    c = make_user("csrf@example.com")
    r = c.post("/api/projects", json={"name": "p", "data": {"format": "netlab", "schemaVersion": 1, "devices": [], "links": []}},
               headers={"x-csrf-token": "forged"})
    assert r.status_code == 403
    assert c.post("/api/projects", json={"name": "p", "data": {"format": "netlab", "schemaVersion": 1, "devices": [], "links": []}}).status_code == 201


def test_register_never_grants_superadmin():
    c = make_user("admin@example.com", "Admin")
    assert c.get("/api/auth/me").json()["is_superadmin"] is False
    assert c.post("/api/orgs", json={"name": "Lycée test", "slug": "lycee-test"}).status_code == 403


def test_cli_create_promote_demote(monkeypatch, capsys):
    from app.cli import main

    monkeypatch.setenv("TPACKET_ADMIN_PASSWORD", "short")
    assert main(["create-admin", "boss@example.com"]) == 1  # password policy enforced
    monkeypatch.setenv("TPACKET_ADMIN_PASSWORD", PASSWORD)
    assert main(["create-admin", "Boss@Example.com", "--name", "Boss"]) == 0
    c = Client(app)
    assert c.post("/api/auth/login", json={"email": "boss@example.com", "password": PASSWORD}).status_code == 200
    assert c.get("/api/auth/me").json()["is_superadmin"] is True
    assert main(["demote-admin", "boss@example.com"]) == 0
    assert c.get("/api/auth/me").json()["is_superadmin"] is False
    assert main(["promote-admin", "boss@example.com"]) == 0
    assert c.get("/api/auth/me").json()["is_superadmin"] is True
    assert main(["promote-admin", "nobody@example.com"]) == 1
    u = make_user("teacher@example.com")
    assert main(["create-admin", "teacher@example.com"]) == 0  # existing account: promoted, password untouched
    assert u.get("/api/auth/me").json()["is_superadmin"] is True
