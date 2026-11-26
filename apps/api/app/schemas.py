from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, EmailStr, Field, field_validator

from .models import Role


class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)
    display_name: str = Field(min_length=1, max_length=120)
    locale: str = Field(default="fr", pattern="^(fr|en)$")


class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(max_length=256)


class MembershipOut(BaseModel):
    org_id: str
    org_name: str
    role: Role


class UserOut(BaseModel):
    id: str
    email: str
    display_name: str
    locale: str
    is_superadmin: bool
    memberships: list[MembershipOut] = []


class OrgIn(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    slug: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{1,62}$")


class OrgOut(BaseModel):
    id: str
    name: str
    slug: str


class InviteIn(BaseModel):
    role: Role = Role.student
    days: int = Field(default=14, ge=1, le=365)
    max_uses: int = Field(default=50, ge=1, le=2000)


class InviteOut(BaseModel):
    code: str
    role: Role
    expires_at: datetime


class RedeemIn(BaseModel):
    code: str = Field(min_length=6, max_length=64)


def _check_project(v: dict[str, Any]) -> dict[str, Any]:
    if v.get("format") != "netlab" or v.get("schemaVersion") != 1:
        raise ValueError("not a netlab project (schemaVersion 1)")
    if not isinstance(v.get("devices"), list) or not isinstance(v.get("links"), list):
        raise ValueError("invalid project structure")
    return v


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    data: dict[str, Any]
    _v = field_validator("data")(_check_project)


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    data: dict[str, Any] | None = None
    base_version: int

    @field_validator("data")
    @classmethod
    def _d(cls, v):
        return None if v is None else _check_project(v)


class ProjectOut(BaseModel):
    id: str
    name: str
    version: int
    updated_at: datetime
    data: dict[str, Any] | None = None


class ExerciseIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)


class ExerciseVersionIn(BaseModel):
    statement: str = Field(max_length=100_000)
    initial_project: dict[str, Any]
    rubric: dict[str, Any]
    kind: Literal["exercise", "incident"] = "exercise"
    skill_map: dict[str, str] = Field(default_factory=dict)
    show_hidden_after_grading: bool = False
    publish: bool = False
    _v = field_validator("initial_project")(_check_project)


class SubmissionIn(BaseModel):
    project: dict[str, Any]
    justification: str = Field(default="", max_length=20_000)
    _v = field_validator("project")(_check_project)
