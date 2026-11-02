"""
Seed unique load-test accounts into the DEV database.

Inserts rows into `users` under the existing "LoadTest Diagnostics Co"
company (created via the public signup flow). Idempotent — re-running
skips existing emails (ON CONFLICT DO NOTHING) and still emits the full
credentials file.

All accounts share one password (documented limitation — each login still
performs a real argon2 verify, DB lookup, and token issuance, which is
what the capacity test measures).

    python seed_accounts.py --count 500
    python seed_accounts.py --count 500 --password '<existing-pw>' \
        --credentials-out credentials.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import secrets
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND))

EMAIL_DOMAIN = "loadtest.dev"
EMAIL_PREFIX = "loadtest+"
COMPANY_NAME = "LoadTest Diagnostics Co"
USERNAME_PREFIX = "loadtest."


async def seed(count: int, password: str, creds_out: Path) -> None:
    from sqlalchemy import select
    from app.core.database import AsyncSessionLocal
    from app.core.security import hash_password
    from app.models.company import Company
    from app.models.user import User, UserRole

    pw_hash = hash_password(password)  # one argon2 hash reused for all rows

    async with AsyncSessionLocal() as session:
        company_id = (await session.execute(
            select(Company.id).where(Company.company_name == COMPANY_NAME)
        )).scalar_one_or_none()
        if company_id is None:
            raise SystemExit(
                f"company '{COMPANY_NAME}' not found — create it via "
                "POST /api/v1/auth/signup first")

        existing = set((await session.execute(
            select(User.email).where(User.email.like(f"{EMAIL_PREFIX}%@{EMAIL_DOMAIN}"))
        )).scalars())

        to_insert = []
        creds = []
        for i in range(1, count + 1):
            email = f"{EMAIL_PREFIX}{i:03d}@{EMAIL_DOMAIN}"
            creds.append({"identifier": email, "password": password})
            if email in existing:
                continue
            to_insert.append(User(
                company_id=company_id,
                name=f"Load Tester {i:03d}",
                email=email,
                username=f"{USERNAME_PREFIX}{i:03d}",
                password_hash=pw_hash,
                phone_number="+911234567890",
                role=UserRole.SUPER_ADMIN,
                job_title="Load Test",
            ))
        session.add_all(to_insert)
        await session.commit()
        print(f"seeded {len(to_insert)} new users "
              f"({len(existing)} already present); company={company_id}")

    creds_out.write_text(json.dumps(creds))
    print(f"wrote {len(creds)} credentials -> {creds_out} (gitignored)")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=500)
    ap.add_argument("--password", default=None,
                    help="shared test password (default: random — printed "
                         "only inside the gitignored credentials file)")
    ap.add_argument("--credentials-out",
                    default=str(Path(__file__).parent / "credentials.json"))
    args = ap.parse_args()
    password = args.password or secrets.token_urlsafe(16)
    asyncio.run(seed(args.count, password, Path(args.credentials_out)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
