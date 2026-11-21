"""employee extended coverage — secondary zone + property-wide flag.

Adds two optional coverage modes on top of the existing zone/area
assignment (mutually exclusive, unchanged):

* ``secondary_zone_id`` — a SECOND zone the employee is eligible for
  (max 2 zones total; only meaningful while ``zone_id`` is set).
* ``covers_property`` — the employee is eligible for work in EVERY zone
  of the property ("whole property" staff). Mutually exclusive with the
  zone/area columns.

Both columns are additive and nullable/backfilled — existing employees
keep exactly their current coverage. Owned by the Super Admin backend;
the Employee Backend shares this table and ignores the new columns (its
ORM does not map them), so this revision must be mirrored verbatim in
the employee repo's chain — do NOT stamp over it.

Revision ID: y5d8f2a6c4e1
Revises: x8b3d6f1a4c7
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'y5d8f2a6c4e1'
down_revision: Union[str, Sequence[str], None] = 'x8b3d6f1a4c7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'employees', sa.Column('secondary_zone_id', sa.Uuid(), nullable=True)
    )
    op.create_index(
        'ix_employees_secondary_zone_id', 'employees', ['secondary_zone_id']
    )
    op.create_foreign_key(
        'fk_employees_secondary_zone_id', 'employees', 'zones',
        ['secondary_zone_id'], ['id'], ondelete='SET NULL',
    )
    op.add_column(
        'employees',
        sa.Column(
            'covers_property', sa.Boolean(),
            server_default=sa.false(), nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column('employees', 'covers_property')
    op.drop_constraint(
        'fk_employees_secondary_zone_id', 'employees', type_='foreignkey'
    )
    op.drop_index('ix_employees_secondary_zone_id', table_name='employees')
    op.drop_column('employees', 'secondary_zone_id')
