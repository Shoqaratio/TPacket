import secrets
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import STAFF, current_user, require_role
from ..models import AuditLog, Organization, OrganizationMember, OrgInvite, Role, User
from ..schemas import InviteIn, InviteOut, OrgIn, OrgOut
from ..security import token_hash

router = APIRouter(prefix="/api/orgs", tags=["organizations"])

ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I: codes are dictated in class


@router.post("", response_model=OrgOut, status_code=201)
def create_org(body: OrgIn, u: User = Depends(current_user), db: Session = Depends(get_db)):
    if not u.is_superadmin:
        raise HTTPException(403, "forbidden")
    if db.scalar(select(Organization).where(Organization.slug == body.slug)):
        raise HTTPException(409, "slug_taken")
    o = Organization(name=body.name, slug=body.slug)
    db.add(o)
    db.flush()
    db.add(AuditLog(org_id=o.id, actor_id=u.id, action="org.create", target=o.id))
    db.commit()
    return OrgOut(id=o.id, name=o.name, slug=o.slug)


@router.get("", response_model=list[OrgOut])
def list_orgs(u: User = Depends(current_user), db: Session = Depends(get_db)):
    if u.is_superadmin:
        orgs = db.scalars(select(Organization).order_by(Organization.name)).all()
    else:
        orgs = db.scalars(select(Organization).join(OrganizationMember).where(OrganizationMember.user_id == u.id)).all()
    return [OrgOut(id=o.id, name=o.name, slug=o.slug) for o in orgs]


@router.post("/{org_id}/invites", response_model=InviteOut, status_code=201)
def create_invite(org_id: str, body: InviteIn, u: User = Depends(current_user), db: Session = Depends(get_db)):
    m = require_role(db, u, org_id, *STAFF)
    if not db.get(Organization, org_id):
        raise HTTPException(404, "not_found")
    # Teachers may invite students only; staff roles need an organisation administrator.
    if body.role != Role.student and not u.is_superadmin and (m is None or m.role != Role.org_admin):
        raise HTTPException(403, "forbidden")
    code = "".join(secrets.choice(ALPHABET) for _ in range(10))
    inv = OrgInvite(org_id=org_id, code_hash=token_hash(code), role=body.role, created_by=u.id,
                    expires_at=datetime.now(UTC) + timedelta(days=body.days), max_uses=body.max_uses)
    db.add(inv)
    db.add(AuditLog(org_id=org_id, actor_id=u.id, action="invite.create", data={"role": body.role.value}))
    db.commit()
    return InviteOut(code=code, role=body.role, expires_at=inv.expires_at)


@router.get("/{org_id}/members")
def members(org_id: str, u: User = Depends(current_user), db: Session = Depends(get_db)):
    require_role(db, u, org_id, *STAFF)
    rows = db.scalars(select(OrganizationMember).where(OrganizationMember.org_id == org_id)).all()
    return [{"user_id": m.user_id, "display_name": m.user.display_name, "email": m.user.email, "role": m.role} for m in rows]


class OrgSettingsIn(BaseModel):
    exam_monitoring: bool


@router.put("/{org_id}/settings")
def org_settings(org_id: str, body: OrgSettingsIn, u: User = Depends(current_user), db: Session = Depends(get_db)):
    m = require_role(db, u, org_id, Role.org_admin)
    org = db.get(Organization, org_id)
    if not org or (m is None and not u.is_superadmin):
        raise HTTPException(404, "not_found")
    org.exam_monitoring = body.exam_monitoring
    db.add(AuditLog(org_id=org_id, actor_id=u.id, action="org.settings", data={"exam_monitoring": body.exam_monitoring}))
    db.commit()
    return {"exam_monitoring": org.exam_monitoring}
