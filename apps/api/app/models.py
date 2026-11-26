"""Relational model (Phase 1 + grading core). See ARCHITECTURE.md for the full target schema."""

import enum
import uuid
from datetime import UTC, datetime

from sqlalchemy import JSON, Boolean, DateTime, Enum, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint, event, false
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base

JsonType = JSON().with_variant(JSONB(), "postgresql")


def new_id() -> str:
    return uuid.uuid4().hex


def now() -> datetime:
    return datetime.now(UTC)


class Role(str, enum.Enum):
    student = "student"
    teacher = "teacher"
    org_admin = "org_admin"


class Organization(Base):
    __tablename__ = "organizations"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200))
    slug: Mapped[str] = mapped_column(String(64), unique=True)
    # Reporting of exam session events (tab changes…) must be explicitly enabled by the school.
    exam_monitoring: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class User(Base):
    __tablename__ = "users"
    campus_color: Mapped[int | None] = mapped_column(Integer, nullable=True)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    email: Mapped[str] = mapped_column(String(320), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    display_name: Mapped[str] = mapped_column(String(120))
    locale: Mapped[str] = mapped_column(String(8), default="fr")
    is_superadmin: Mapped[bool] = mapped_column(Boolean, default=False)
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    memberships: Mapped[list["OrganizationMember"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class OrganizationMember(Base):
    __tablename__ = "organization_members"
    __table_args__ = (UniqueConstraint("org_id", "user_id"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    org_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    role: Mapped[Role] = mapped_column(Enum(Role, name="member_role"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    user: Mapped[User] = relationship(back_populates="memberships")
    org: Mapped[Organization] = relationship()


class OrgInvite(Base):
    __tablename__ = "org_invites"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    org_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    # Class join codes also enrol the student in this class.
    class_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    code_hash: Mapped[str] = mapped_column(String(64), unique=True)
    role: Mapped[Role] = mapped_column(Enum(Role, name="member_role"))
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    max_uses: Mapped[int] = mapped_column(Integer, default=50)
    uses: Mapped[int] = mapped_column(Integer, default=0)


class UserSession(Base):
    __tablename__ = "sessions"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    csrf_token: Mapped[str] = mapped_column(String(64))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    user_agent: Mapped[str] = mapped_column(String(300), default="")


class Project(Base):
    __tablename__ = "projects"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    data: Mapped[dict] = mapped_column(JsonType)
    version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class ProjectVersion(Base):
    __tablename__ = "project_versions"
    __table_args__ = (UniqueConstraint("project_id", "version"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    data: Mapped[dict] = mapped_column(JsonType)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Course(Base):
    __tablename__ = "courses"
    __table_args__ = (Index("ix_courses_org_created", "org_id", "created_at"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    org_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    author_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    title: Mapped[str] = mapped_column(String(200))
    summary: Mapped[str] = mapped_column(Text)
    duration_minutes: Mapped[int] = mapped_column(Integer)
    objectives: Mapped[list] = mapped_column(JsonType)
    lessons: Mapped[list] = mapped_column(JsonType)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Exercise(Base):
    __tablename__ = "exercises"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    org_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    author_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    title: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class ExerciseVersion(Base):
    """Immutable once published: submissions point to an exact version (and engine version)."""

    __tablename__ = "exercise_versions"
    __table_args__ = (UniqueConstraint("exercise_id", "version"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    exercise_id: Mapped[str] = mapped_column(ForeignKey("exercises.id", ondelete="CASCADE"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    statement: Mapped[str] = mapped_column(Text)
    initial_project: Mapped[dict] = mapped_column(JsonType)
    kind: Mapped[str] = mapped_column(String(16), default="exercise")  # exercise | incident
    # Never sent to students (contains hidden tests).
    rubric: Mapped[dict] = mapped_column(JsonType)
    skill_map: Mapped[dict] = mapped_column(JsonType, default=dict)
    show_hidden_after_grading: Mapped[bool] = mapped_column(Boolean, default=False)
    published: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Submission(Base):
    __tablename__ = "submissions"
    __table_args__ = (Index("ix_submissions_student_version", "student_id", "exercise_version_id"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    org_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    exercise_version_id: Mapped[str] = mapped_column(ForeignKey("exercise_versions.id"), index=True)
    student_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    justification: Mapped[str] = mapped_column(Text, default="")
    assignment_id: Mapped[str | None] = mapped_column(ForeignKey("assignments.id", ondelete="SET NULL"), nullable=True, index=True)
    attempt: Mapped[int] = mapped_column(Integer, default=1)


class SubmissionSnapshot(Base):
    """Immutable copy of the submitted project. Updates are refused by the ORM and by a DB trigger."""

    __tablename__ = "submission_snapshots"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    submission_id: Mapped[str] = mapped_column(ForeignKey("submissions.id", ondelete="CASCADE"), unique=True)
    data: Mapped[dict] = mapped_column(JsonType)
    sha256: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


@event.listens_for(SubmissionSnapshot, "before_update")
def _snapshot_immutable(*_):
    raise PermissionError("submission snapshots are immutable")


class GradingJob(Base):
    __tablename__ = "grading_jobs"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    submission_id: Mapped[str] = mapped_column(ForeignKey("submissions.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(16), default="pending")  # pending | running | done | error
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class GradingResult(Base):
    __tablename__ = "grading_results"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    submission_id: Mapped[str] = mapped_column(ForeignKey("submissions.id", ondelete="CASCADE"), index=True)
    engine_version: Mapped[str] = mapped_column(String(32))
    score: Mapped[float] = mapped_column(Float)
    max_score: Mapped[float] = mapped_column(Float)
    report: Mapped[dict] = mapped_column(JsonType)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class AuditLog(Base):
    __tablename__ = "audit_logs"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    org_id: Mapped[str | None] = mapped_column(ForeignKey("organizations.id", ondelete="SET NULL"), nullable=True, index=True)
    actor_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    action: Mapped[str] = mapped_column(String(64))
    target: Mapped[str] = mapped_column(String(64), default="")
    data: Mapped[dict] = mapped_column(JsonType, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


# ---------------------------------------------------------------------------------------------
# Phase 4/6 — classes, assignments, exams, grade history, sharing
# ---------------------------------------------------------------------------------------------


class SchoolClass(Base):
    __tablename__ = "classes"
    campus_rules: Mapped[dict | None] = mapped_column(JsonType, nullable=True)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    org_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    academic_year: Mapped[str] = mapped_column(String(9))  # "2026-2027"
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class ClassMember(Base):
    __tablename__ = "class_members"
    __table_args__ = (UniqueConstraint("class_id", "user_id"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    class_id: Mapped[str] = mapped_column(ForeignKey("classes.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(16))  # student | teacher
    user: Mapped[User] = relationship()


class Assignment(Base):
    __tablename__ = "assignments"
    __table_args__ = (Index("uq_assignment_campus_template", "class_id", "campus_template", unique=True),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    class_id: Mapped[str] = mapped_column(ForeignKey("classes.id", ondelete="CASCADE"), index=True)
    exercise_version_id: Mapped[str] = mapped_column(ForeignKey("exercise_versions.id"))
    title: Mapped[str] = mapped_column(String(200))
    campus_room: Mapped[str | None] = mapped_column(String(24), nullable=True)
    campus_template: Mapped[str | None] = mapped_column(String(24), nullable=True)
    campus_rewardable: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    opens_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    exam: Mapped[bool] = mapped_column(Boolean, default=False)
    duration_min: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_attempts: Mapped[int] = mapped_column(Integer, default=0)  # 0 = unlimited
    allow_checks: Mapped[bool] = mapped_column(Boolean, default=True)
    allow_tutor: Mapped[bool] = mapped_column(Boolean, default=True)
    allow_courses: Mapped[bool] = mapped_column(Boolean, default=True)
    results: Mapped[str] = mapped_column(String(16), default="immediate")  # immediate | after_due | never
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class AssignmentExtension(Base):
    __tablename__ = "assignment_extensions"
    __table_args__ = (UniqueConstraint("assignment_id", "student_id"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    assignment_id: Mapped[str] = mapped_column(ForeignKey("assignments.id", ondelete="CASCADE"), index=True)
    student_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    extra_minutes: Mapped[int] = mapped_column(Integer)


class AssignmentStart(Base):
    __tablename__ = "assignment_starts"
    __table_args__ = (UniqueConstraint("assignment_id", "student_id"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    assignment_id: Mapped[str] = mapped_column(ForeignKey("assignments.id", ondelete="CASCADE"), index=True)
    student_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class ExamEvent(Base):
    """Session events (e.g. tab hidden). Informative only — never treated as proof of cheating."""

    __tablename__ = "exam_events"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    assignment_id: Mapped[str] = mapped_column(ForeignKey("assignments.id", ondelete="CASCADE"), index=True)
    student_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class GradeHistory(Base):
    __tablename__ = "grade_history"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    submission_id: Mapped[str] = mapped_column(ForeignKey("submissions.id", ondelete="CASCADE"), index=True)
    score: Mapped[float] = mapped_column(Float)
    reason: Mapped[str] = mapped_column(Text)
    feedback: Mapped[str] = mapped_column(Text, default="")
    author_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Announcement(Base):
    __tablename__ = "announcements"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    class_id: Mapped[str] = mapped_column(ForeignKey("classes.id", ondelete="CASCADE"), index=True)
    author_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    text: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class ProjectShare(Base):
    """Share link: members of `org_id` holding the token may join the live session with `role`."""

    __tablename__ = "project_shares"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    org_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    role: Mapped[str] = mapped_column(String(8))  # read | write
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class CommunityPublication(Base):
    __tablename__ = "community_publications"
    __table_args__ = (UniqueConstraint("exercise_version_id"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    exercise_version_id: Mapped[str] = mapped_column(ForeignKey("exercise_versions.id", ondelete="CASCADE"), index=True)
    author_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)  # pending | approved | rejected
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reviewed_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
