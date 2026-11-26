from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import STAFF, current_user, require_role
from ..models import AuditLog, Course, User
from ..schemas import CourseIn

router = APIRouter(prefix="/api", tags=["courses"])


def _course_out(course: Course) -> dict:
    return {
        "id": course.id,
        "org_id": course.org_id,
        "title": course.title,
        "summary": course.summary,
        "duration_minutes": course.duration_minutes,
        "objectives": course.objectives,
        "lessons": course.lessons,
        "created_at": course.created_at,
    }


@router.get("/orgs/{org_id}/courses")
def list_courses(org_id: str, u: User = Depends(current_user), db: Session = Depends(get_db)):
    require_role(db, u, org_id)
    courses = db.scalars(
        select(Course).where(Course.org_id == org_id).order_by(Course.created_at.desc())
    ).all()
    return [_course_out(course) for course in courses]


@router.post("/orgs/{org_id}/courses", status_code=201)
def create_course(org_id: str, body: CourseIn, u: User = Depends(current_user), db: Session = Depends(get_db)):
    require_role(db, u, org_id, *STAFF)
    course = Course(
        org_id=org_id,
        author_id=u.id,
        title=body.title,
        summary=body.summary,
        duration_minutes=body.duration_minutes,
        objectives=body.objectives,
        lessons=[lesson.model_dump() for lesson in body.lessons],
    )
    db.add(course)
    db.flush()
    db.add(AuditLog(org_id=org_id, actor_id=u.id, action="course.create", target=course.id))
    db.commit()
    db.refresh(course)
    return _course_out(course)
