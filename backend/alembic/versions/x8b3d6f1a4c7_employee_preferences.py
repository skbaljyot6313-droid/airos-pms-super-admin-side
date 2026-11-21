"""employee_preferences — per-employee UI text / TTS audio language.

Mirrors the Employee Backend's revision x8b3d6f1a4c7 verbatim — this
database is SHARED, and both services run their Alembic chains over the
same alembic_version row. Parent chain matches EB exactly:
w3b7d9f1a4c6 (notification push delivery) → this revision.

One row per employee (unique employee_id); defaults are 'en' and absence
of a row means defaults. Owned and written by the Employee Backend.

Do NOT "fix" divergent deployments by stamping over this revision — that
would misreport the shared schema state for the Employee Backend.

Revision ID: x8b3d6f1a4c7
Revises: w3b7d9f1a4c6
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "x8b3d6f1a4c7"
down_revision: Union[str, Sequence[str], None] = "w3b7d9f1a4c6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "employee_preferences",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("employee_id", sa.Uuid(), nullable=False),
        sa.Column(
            "text_language",
            sa.String(length=8),
            server_default=sa.text("'en'"),
            nullable=False,
        ),
        sa.Column(
            "audio_language",
            sa.String(length=8),
            server_default=sa.text("'en'"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["employee_id"], ["employees.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "employee_id", name="uq_employee_preferences_employee_id"
        ),
    )
    op.create_index(
        "ix_employee_preferences_employee_id",
        "employee_preferences",
        ["employee_id"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_employee_preferences_employee_id",
        table_name="employee_preferences",
    )
    op.drop_table("employee_preferences")
