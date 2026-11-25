import json
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..deps import current_user
from ..models import Project, ProjectVersion, User
from ..schemas import ProjectIn, ProjectOut, ProjectUpdate

router = APIRouter(prefix="/api/projects", tags=["projects"])
KEEP_VERSIONS = 30


def _size_check(data: dict) -> None:
    if len(json.dumps(data)) > get_settings().max_project_bytes:
        raise HTTPException(413, "project_too_large")


def _own(db: Session, u: User, pid: str) -> Project:
    p = db.get(Project, pid)
    if not p or p.owner_id != u.id:
        raise HTTPException(404, "not_found")
    return p


def _out(p: Project, with_data: bool) -> ProjectOut:
    return ProjectOut(id=p.id, name=p.name, version=p.version, updated_at=p.updated_at, data=p.data if with_data else None)


@router.get("", response_model=list[ProjectOut])
def list_projects(u: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.scalars(select(Project).where(Project.owner_id == u.id).order_by(Project.updated_at.desc())).all()
    return [_out(p, False) for p in rows]


@router.post("", response_model=ProjectOut, status_code=201)
def create_project(body: ProjectIn, u: User = Depends(current_user), db: Session = Depends(get_db)):
    _size_check(body.data)
    p = Project(owner_id=u.id, name=body.name, data=body.data)
    db.add(p)
    db.flush()
    db.add(ProjectVersion(project_id=p.id, version=1, data=body.data))
    db.commit()
    return _out(p, True)


@router.get("/{pid}", response_model=ProjectOut)
def get_project(pid: str, u: User = Depends(current_user), db: Session = Depends(get_db)):
    return _out(_own(db, u, pid), True)


@router.put("/{pid}", response_model=ProjectOut)
def update_project(pid: str, body: ProjectUpdate, u: User = Depends(current_user), db: Session = Depends(get_db)):
    p = _own(db, u, pid)
    # Optimistic concurrency: two tabs / devices cannot silently overwrite each other.
    if body.base_version != p.version:
        raise HTTPException(409, "version_conflict")
    if body.name is not None:
        p.name = body.name
    if body.data is not None:
        _size_check(body.data)
        p.data = body.data
        p.version += 1
        db.add(ProjectVersion(project_id=p.id, version=p.version, data=body.data))
        db.execute(delete(ProjectVersion).where(ProjectVersion.project_id == p.id, ProjectVersion.version <= p.version - KEEP_VERSIONS))
    p.updated_at = datetime.now(UTC)
    db.commit()
    return _out(p, False)


@router.delete("/{pid}", status_code=204)
def delete_project(pid: str, u: User = Depends(current_user), db: Session = Depends(get_db)):
    db.delete(_own(db, u, pid))
    db.commit()
