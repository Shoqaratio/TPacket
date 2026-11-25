import secrets
from datetime import UTC, datetime

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import get_db
from .models import OrganizationMember, Role, User, UserSession
from .security import token_hash

SESSION_COOKIE = "nl_session"
CSRF_COOKIE = "nl_csrf"
CSRF_HEADER = "x-csrf-token"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def _session(request: Request, db: Session) -> UserSession | None:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    s = db.scalar(select(UserSession).where(UserSession.token_hash == token_hash(token)))
    if not s:
        return None
    exp = s.expires_at if s.expires_at.tzinfo else s.expires_at.replace(tzinfo=UTC)
    if exp < datetime.now(UTC):
        db.delete(s)
        db.commit()
        return None
    return s


def current_session(request: Request, db: Session = Depends(get_db)) -> UserSession:
    s = _session(request, db)
    if not s:
        raise HTTPException(401, "not_authenticated")
    # CSRF: double-submit token required on every state-changing request.
    if request.method not in SAFE_METHODS:
        sent = request.headers.get(CSRF_HEADER, "")
        if not sent or not secrets.compare_digest(sent, s.csrf_token):
            raise HTTPException(403, "csrf_failed")
    return s


def current_user(s: UserSession = Depends(current_session), db: Session = Depends(get_db)) -> User:
    u = db.get(User, s.user_id)
    if not u:
        raise HTTPException(401, "not_authenticated")
    return u


def membership(db: Session, user: User, org_id: str) -> OrganizationMember | None:
    return db.scalar(select(OrganizationMember).where(OrganizationMember.org_id == org_id, OrganizationMember.user_id == user.id))


def require_role(db: Session, user: User, org_id: str, *roles: Role) -> OrganizationMember | None:
    """Raises 404 (not 403) for non-members so that resource existence never leaks across organisations."""
    if user.is_superadmin:
        return membership(db, user, org_id)
    m = membership(db, user, org_id)
    if not m:
        raise HTTPException(404, "not_found")
    if roles and m.role not in roles:
        raise HTTPException(403, "forbidden")
    return m


STAFF = (Role.teacher, Role.org_admin)
