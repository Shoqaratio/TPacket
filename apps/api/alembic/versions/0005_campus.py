"""Place existing assignments in campus rooms."""
import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("assignments", sa.Column("campus_room", sa.String(24), nullable=True))
    op.add_column("assignments", sa.Column("campus_template", sa.String(24), nullable=True))
    op.add_column("assignments", sa.Column("campus_rewardable", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column("users", sa.Column("campus_color", sa.Integer(), nullable=True))
    op.add_column("classes", sa.Column("campus_rules", sa.JSON(), nullable=True))
    op.create_index("uq_assignment_campus_template", "assignments", ["class_id", "campus_template"], unique=True)


def downgrade() -> None:
    op.drop_column("classes", "campus_rules")
    op.drop_column("users", "campus_color")
    op.drop_index("uq_assignment_campus_template", table_name="assignments")
    op.drop_column("assignments", "campus_template")
    op.drop_column("assignments", "campus_room")
    op.drop_column("assignments", "campus_rewardable")
