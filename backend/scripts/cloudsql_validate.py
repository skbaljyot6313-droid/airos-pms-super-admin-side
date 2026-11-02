"""Validate the dev Cloud SQL schema — tables, constraints, indexes,
extension, transaction behavior. Connects as airos_sa_app via connector.
"""
import asyncio
import shutil
import subprocess

INSTANCE = "final-airos-os:asia-south1:airos-postgres-dev"
DATABASE = "airos_dev"
SECRET = "airos-dev-app-db-password"
PROJECT = "final-airos-os"

EXPECTED = {
    "allocation_events", "area_allocation_state", "areas", "attendance_breaks",
    "attendance_days", "attendance_requests", "audit_events", "beds", "companies",
    "device_registrations", "dorms", "employee_shift_assignments", "employees",
    "location_events", "location_tracking_sessions", "maintenance_ticket_attachments",
    "maintenance_ticket_events", "maintenance_tickets", "mobile_releases",
    "notifications", "occupancies", "properties", "refresh_tokens",
    "resource_state_events", "rooms", "shifts", "task_completion_images",
    "task_completion_submissions", "task_history_events", "tasks",
    "template_generations", "users", "washroom_fixtures", "washrooms",
    "work_allocation_batches", "work_allocation_history", "work_template_versions",
    "work_templates", "zone_allocation_state", "zones",
}


def gcloud(*a):
    exe = shutil.which("gcloud") or "gcloud"
    out = subprocess.run([exe, *a], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr[:200]
    return out.stdout.strip()


async def main():
    from google.cloud.sql.connector import Connector, IPTypes
    from google.oauth2.credentials import Credentials

    creds = Credentials(token=gcloud("auth", "print-access-token"))
    password = gcloud("secrets", "versions", "access", "latest",
                      f"--secret={SECRET}", f"--project={PROJECT}")
    loop = asyncio.get_running_loop()
    connector = Connector(credentials=creds, loop=loop)
    try:
        conn = await connector.connect_async(
            INSTANCE, "asyncpg", user="airos_sa_app", password=password,
            db=DATABASE, ip_type=IPTypes.PUBLIC)
        try:
            checks = []
            ver = await conn.fetchval("SELECT version_num FROM alembic_version")
            checks.append(("alembic head v9f2b5c8d1e4", ver == "v9f2b5c8d1e4", ver))

            tables = {r["table_name"] for r in await conn.fetch(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema='public'")}
            app_tables = tables - {"alembic_version"}
            checks.append(("40 app tables", app_tables == EXPECTED,
                           f"got {len(app_tables)} missing={EXPECTED-app_tables} extra={app_tables-EXPECTED}"))

            exts = {r["extname"] for r in await conn.fetch("SELECT extname FROM pg_extension")}
            checks.append(("btree_gist extension", "btree_gist" in exts, str(exts)))

            n_idx = await conn.fetchval(
                "SELECT count(*) FROM pg_indexes WHERE schemaname='public'")
            n_fk = await conn.fetchval(
                "SELECT count(*) FROM information_schema.table_constraints "
                "WHERE constraint_type='FOREIGN KEY' AND table_schema='public'")
            n_uc = await conn.fetchval(
                "SELECT count(*) FROM information_schema.table_constraints "
                "WHERE constraint_type='UNIQUE' AND table_schema='public'")
            n_ck = await conn.fetchval(
                "SELECT count(*) FROM information_schema.table_constraints "
                "WHERE constraint_type='CHECK' AND table_schema='public'")
            print(f"[info] indexes={n_idx} fks={n_fk} uniques={n_uc} checks={n_ck}")

            seqs = {r[0] for r in await conn.fetch(
                "SELECT sequence_name FROM information_schema.sequences "
                "WHERE sequence_schema='public'")}
            checks.append(("3 ticket sequences", {"maintenance_ticket_seq", "task_ticket_seq",
                           "work_batch_seq"} <= seqs, str(seqs)))

            # EXCLUDE constraint on attendance_requests
            excl = await conn.fetchval(
                "SELECT count(*) FROM pg_constraint WHERE contype='x'")
            checks.append(("EXCLUDE constraint present", excl >= 1, f"count={excl}"))

            # commit + rollback smoke test
            await conn.execute("CREATE TEMP TABLE _v (i int)")
            async with conn.transaction():
                await conn.execute("INSERT INTO _v VALUES (1)")
                n1 = await conn.fetchval("SELECT count(*) FROM _v")
            async with conn.transaction():
                await conn.execute("INSERT INTO _v VALUES (2)")
                raise RuntimeError("forced-rollback")
            checks.append(("commit visible", n1 == 1, f"n={n1}"))
        except RuntimeError:
            # rollback path reached — verify count unchanged inside new tx
            async with conn.transaction():
                n2 = await conn.fetchval("SELECT count(*) FROM _v")
            checks.append(("rollback discards insert", n2 == 1, f"n={n2}"))

        ok = all(c[1] for c in checks)
        for name, passed, detail in checks:
            print(f"[{'PASS' if passed else 'FAIL'}] {name} — {detail}")
        print(f"\nVALIDATION {'PASSED' if ok else 'FAILED'}")
    finally:
        await connector.close_async()


if __name__ == "__main__":
    asyncio.run(main())
