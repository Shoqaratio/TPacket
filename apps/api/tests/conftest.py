import os
import tempfile

_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
os.environ["NETLAB_DATABASE_URL"] = f"sqlite:///{_db.name}"
os.environ["NETLAB_RECOVER_JOBS_ON_STARTUP"] = "false"  # tests call recover_jobs() explicitly

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.cli import promote  # noqa: E402
from app.db import Base, engine  # noqa: E402
from app.grading.runner import check_limiter, submit_limiter  # noqa: E402
from app.main import app  # noqa: E402
from app.routers.auth import login_limiter  # noqa: E402

PASSWORD = "correct horse battery"


@pytest.fixture(autouse=True)
def fresh_db():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    login_limiter.reset()
    check_limiter.reset()
    submit_limiter.reset()
    yield


class Client(TestClient):
    """Test client that echoes the CSRF cookie like the SPA does."""

    def request(self, method, url, **kw):
        headers = dict(kw.pop("headers", None) or {})
        csrf = self.cookies.get("nl_csrf")
        if csrf and "x-csrf-token" not in {k.lower() for k in headers}:
            headers["x-csrf-token"] = csrf
        return super().request(method, url, headers=headers, **kw)


def make_user(email: str, name: str = "User") -> Client:
    c = Client(app)
    r = c.post("/api/auth/register", json={"email": email, "password": PASSWORD, "display_name": name})
    assert r.status_code == 201, r.text
    return c


@pytest.fixture
def admin() -> Client:
    c = make_user("admin@example.com", "Admin")
    promote("admin@example.com")  # super-admin is granted by the server CLI only
    return c


def new_org(admin: Client, slug: str) -> str:
    r = admin.post("/api/orgs", json={"name": f"Lycée {slug}", "slug": slug})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def join(client: Client, admin: Client, org_id: str, role: str) -> None:
    code = admin.post(f"/api/orgs/{org_id}/invites", json={"role": role}).json()["code"]
    r = client.post("/api/auth/invites/redeem", json={"code": code})
    assert r.status_code == 200, r.text
