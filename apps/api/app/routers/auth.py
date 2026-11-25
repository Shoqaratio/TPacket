from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..deps import CSRF_COOKIE, SESSION_COOKIE, current_session, current_user
from ..models import AuditLog, ClassMember, OrgInvite, OrganizationMember, User, UserSession
from ..schemas import LoginIn, MembershipOut, RedeemIn, RegisterIn, UserOut
from ..security import RateLimiter, hash_password, new_token, password_policy_error, token_hash, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])
login_limiter = RateLimiter(get_settings().login_attempts_per_15min, 15 * 60)


def user_out(db: Session, u: User) -> UserOut:
    ms = db.scalars(select(OrganizationMember).where(OrganizationMember.user_id == u.id)).all()
    return UserOut(
        id=u.id, email=u.email, display_name=u.display_name, locale=u.locale, is_superadmin=u.is_superadmin,
        memberships=[MembershipOut(org_id=m.org_id, org_name=m.org.name, role=m.role) for m in ms],
    )


def _start_session(db: Session, response: Response, request: Request, user: User) -> None:
    s = get_settings()
    token = new_token()
    csrf = new_token()
    db.add(UserSession(
        token_hash=token_hash(token), csrf_token=csrf, user_id=user.id,
        expires_at=datetime.now(UTC) + timedelta(days=s.session_days),
        user_agent=request.headers.get("user-agent", "")[:300],
    ))
    db.commit()
    max_age = s.session_days * 86400
    response.set_cookie(SESSION_COOKIE, token, max_age=max_age, httponly=True, secure=s.cookie_secure, samesite="lax", path="/")
    # Readable by the SPA, echoed in the X-CSRF-Token header (double-submit).
    response.set_cookie(CSRF_COOKIE, csrf, max_age=max_age, httponly=False, secure=s.cookie_secure, samesite="lax", path="/")


@router.post("/register", response_model=UserOut, status_code=201)
def register(body: RegisterIn, request: Request, response: Response, db: Session = Depends(get_db)):
    err = password_policy_error(body.password)
    if err:
        raise HTTPException(422, err)
    email = body.email.lower()
    if db.scalar(select(User).where(func.lower(User.email) == email)):
        raise HTTPException(409, "email_taken")
    s = get_settings()
    u = User(email=email, password_hash=hash_password(body.password), display_name=body.display_name.strip(), locale=body.locale,
             is_superadmin=bool(s.bootstrap_admin_email and s.bootstrap_admin_email.lower() == email))
    db.add(u)
    db.commit()
    db.add(AuditLog(actor_id=u.id, action="user.register", target=u.id))
    _start_session(db, response, request, u)
    return user_out(db, u)


@router.post("/login", response_model=UserOut)
def login(body: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)):
    ip = request.client.host if request.client else "?"
    email = body.email.lower()
    if not login_limiter.hit(f"{ip}|{email}") or not login_limiter.hit(f"email|{email}"):
        raise HTTPException(429, "too_many_attempts")
    u = db.scalar(select(User).where(func.lower(User.email) == email))
    if not verify_password(u.password_hash if u else None, body.password) or not u:
        raise HTTPException(401, "invalid_credentials")
    _start_session(db, response, request, u)
    return user_out(db, u)


@router.post("/logout", status_code=204)
def logout(response: Response, s: UserSession = Depends(current_session), db: Session = Depends(get_db)):
    db.delete(s)
    db.commit()
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.delete_cookie(CSRF_COOKIE, path="/")


@router.get("/me", response_model=UserOut)
def me(u: User = Depends(current_user), db: Session = Depends(get_db)):
    return user_out(db, u)


@router.post("/invites/redeem", response_model=UserOut)
def redeem(body: RedeemIn, u: User = Depends(current_user), db: Session = Depends(get_db)):
    inv = db.scalar(select(OrgInvite).where(OrgInvite.code_hash == token_hash(body.code.strip().upper())))
    if not inv:
        raise HTTPException(404, "invalid_code")
    exp = inv.expires_at if inv.expires_at.tzinfo else inv.expires_at.replace(tzinfo=UTC)
    if exp < datetime.now(UTC) or inv.uses >= inv.max_uses:
        raise HTTPException(404, "invalid_code")
    changed = False
    if not db.scalar(select(OrganizationMember).where(OrganizationMember.org_id == inv.org_id, OrganizationMember.user_id == u.id)):
        db.add(OrganizationMember(org_id=inv.org_id, user_id=u.id, role=inv.role))
        db.add(AuditLog(org_id=inv.org_id, actor_id=u.id, action="member.join", target=u.id, data={"role": inv.role.value}))
        changed = True
    if inv.class_id and not db.scalar(select(ClassMember).where(ClassMember.class_id == inv.class_id, ClassMember.user_id == u.id)):
        db.add(ClassMember(class_id=inv.class_id, user_id=u.id, role="student"))
        changed = True
    if changed:
        inv.uses += 1
        db.commit()
    return user_out(db, u)
