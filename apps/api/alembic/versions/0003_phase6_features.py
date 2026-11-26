"""Phase 6: incidents, skill mapping and community publications.

Revision ID: 0003
Revises: 0002
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    json_type = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
    op.add_column(
        "exercise_versions",
        sa.Column("kind", sa.String(length=16), nullable=False, server_default="exercise"),
    )
    op.add_column(
        "exercise_versions",
        sa.Column("skill_map", json_type, nullable=False, server_default=sa.text("'{}'")),
    )
    op.create_table(
        "community_publications",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("exercise_version_id", sa.String(length=32), nullable=False),
        sa.Column("author_id", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="pending"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reviewed_by", sa.String(length=32), nullable=True),
        sa.ForeignKeyConstraint(["author_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["exercise_version_id"], ["exercise_versions.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["reviewed_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("exercise_version_id"),
    )
    op.create_index("ix_community_publications_exercise_version_id", "community_publications", ["exercise_version_id"])
    op.create_index("ix_community_publications_author_id", "community_publications", ["author_id"])
    op.create_index("ix_community_publications_status", "community_publications", ["status"])


def downgrade() -> None:
    op.drop_index("ix_community_publications_status", table_name="community_publications")
    op.drop_index("ix_community_publications_author_id", table_name="community_publications")
    op.drop_index("ix_community_publications_exercise_version_id", table_name="community_publications")
    op.drop_table("community_publications")
    op.drop_column("exercise_versions", "skill_map")
    op.drop_column("exercise_versions", "kind")
