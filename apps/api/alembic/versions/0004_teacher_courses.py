"""Teacher-authored courses.

Revision ID: 0004
Revises: 0003
"""
from alembic import op
import sqlalchemy as sa


revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    json_type = sa.JSON()
    op.create_table(
        "courses",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("org_id", sa.String(length=32), nullable=False),
        sa.Column("author_id", sa.String(length=32), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("duration_minutes", sa.Integer(), nullable=False),
        sa.Column("objectives", json_type, nullable=False),
        sa.Column("lessons", json_type, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["author_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_courses_org_id", "courses", ["org_id"])
    op.create_index("ix_courses_org_created", "courses", ["org_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_courses_org_created", table_name="courses")
    op.drop_index("ix_courses_org_id", table_name="courses")
    op.drop_table("courses")
