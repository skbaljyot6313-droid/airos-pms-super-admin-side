"""Copy all data from the source Postgres (read-only) into airos_dev.

- Source URL comes from env SOURCE_DB_URL (never stored).
- Copies only tables+columns present in BOTH schemas (intersection).
- Skips alembic_version (dev keeps its own head stamp).
- Truncates dest tables first (dev DB), inserts in FK-safe order,
  then resets ticket sequences to copied maxima.
"""
import asyncio
import os
import shutil
import subprocess

INSTANCE = "final-airos-os:asia-south1:airos-postgres-dev"
DATABASE = "airos_dev"
SECRET = "airos-dev-postgres-password"
PROJECT = "final-airos-os"

# FK dependency order — computed from the live FK graph at runtime,
# with this stable tie-break for unordered siblings.
ORDER_HINT = [
    "companies", "properties", "users", "refresh_tokens",
    "areas", "zones", "rooms", "dorms", "beds",
    "washrooms", "washroom_fixtures", "employees",
    "work_allocation_batches", "work_templates", "work_template_versions",
    "tasks", "task_history_events", "task_completion_submissions",
    "task_completion_images", "maintenance_tickets",
    "maintenance_ticket_events", "maintenance_ticket_attachments",
    "occupancies", "resource_state_events", "template_generations",
    "zone_allocation_state",
    "work_allocation_history", "allocation_events", "audit_events",
    "attendance_days", "attendance_breaks", "attendance_requests",
    "shifts", "employee_shift_assignments", "notifications",
    "device_registrations", "location_events",
    "location_tracking_sessions", "mobile_releases",
    "area_allocation_state",
]
SEQS = {
    "maintenance_ticket_seq": ("maintenance_tickets", "ticket_number"),
    "task_ticket_seq": ("tasks", "ticket_number"),
    "work_batch_seq": ("work_allocation_batches", "batch_number"),
}


def gcloud(*a):
    exe = shutil.which("gcloud") or "gcloud"
    out = subprocess.run([exe, *a], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr[:200]
    return out.stdout.strip()


async def main():
    import asyncpg
    from google.cloud.sql.connector import Connector, IPTypes
    from google.oauth2.credentials import Credentials

    src_url = os.environ["SOURCE_DB_URL"]
    creds = Credentials(token=gcloud("auth", "print-access-token"))
    pw = gcloud("secrets", "versions", "access", "latest",
                f"--secret={SECRET}", f"--project={PROJECT}")
    loop = asyncio.get_running_loop()
    connector = Connector(credentials=creds, loop=loop)

    src = await asyncpg.connect(src_url, statement_cache_size=0)
    dst = await connector.connect_async(
        INSTANCE, "asyncpg", user="postgres", password=pw,
        db=DATABASE, ip_type=IPTypes.PUBLIC)
    try:
        # table/column inventory of both sides
        async def cols(conn):
            out = {}
            for r in await conn.fetch(
                    "SELECT table_name, column_name FROM information_schema.columns "
                    "WHERE table_schema='public' AND is_generated='NEVER'"):
                out.setdefault(r[0], []).append(r[1])
            return out
        sc, dc = await cols(src), await cols(dst)
        tables = [t for t in sc if t in dc and t != "alembic_version"]
        skipped_src = sorted(set(sc) - set(dc) - {"alembic_version"})
        if skipped_src:
            print(f"SKIPPED source-only tables: {skipped_src}")

        # topo-sort by dest FK edges (child -> parent)
        edges = await dst.fetch("""
            SELECT kcu.table_name, ccu.table_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema
            JOIN information_schema.constraint_column_usage ccu
              ON tc.constraint_name=ccu.constraint_name AND tc.table_schema=ccu.table_schema
            WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='public'""")
        parents = {}
        for child, parent in edges:
            if child in tables and parent in tables and child != parent:
                parents.setdefault(child, set()).add(parent)
        hint = {t: i for i, t in enumerate(ORDER_HINT)}
        remaining = set(tables)
        done = set()
        common = []
        while remaining:
            ready = sorted((t for t in remaining
                            if parents.get(t, set()) <= done),
                           key=lambda t: hint.get(t, 999))
            if not ready:  # cycle — append rest by hint order
                ready = sorted(remaining, key=lambda t: hint.get(t, 999))
            for t in ready:
                common.append(t)
                done.add(t)
                remaining.discard(t)
                break

        # truncate dest (dev only) — leaves alembic_version alone
        await dst.execute(
            "TRUNCATE " + ", ".join(common) + " RESTART IDENTITY CASCADE")

        for t in common:
            shared = [c for c in sc[t] if c in dc[t]]
            if not shared:
                continue
            rows = await src.fetch(f'SELECT {",".join(f"\"{c}\"" for c in shared)} FROM "{t}"')
            if rows:
                await dst.copy_records_to_table(
                    t, records=[tuple(r) for r in rows], columns=shared)
            print(f"{t}: {len(rows)} rows")

        # reset sequences past copied maxima (parse trailing number)
        for seq, (t, col) in SEQS.items():
            n = await dst.fetchval(
                f"SELECT COALESCE(MAX(NULLIF(regexp_replace({col}, '[^0-9]', '', 'g'), '')::int), 0) FROM {t}")
            await dst.execute(f"SELECT setval('{seq}', {n}, {n > 0})")
            print(f"{seq} -> {n}")

        n = await dst.fetchval("SELECT count(*) FROM users")
        print(f"done. users={n}")
    finally:
        await src.close()
        await dst.close()
        await connector.close_async()


if __name__ == "__main__":
    asyncio.run(main())
