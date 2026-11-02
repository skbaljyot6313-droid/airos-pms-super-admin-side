"""Run Alembic migrations against the dev Cloud SQL instance via the
Cloud SQL Python connector (IAM-mediated, no authorized networks).

Usage (from backend/):
    py -3.12 scripts/cloudsql_migrate.py

Auth: reads an OAuth token from `gcloud auth print-access-token` and the
postgres password from Secret Manager — nothing is printed or stored.
"""
import asyncio
import os
import subprocess
import sys

INSTANCE = "final-airos-os:asia-south1:airos-postgres-dev"
DATABASE = "airos_dev"
USER = "postgres"
SECRET = "airos-dev-postgres-password"
PROJECT = "final-airos-os"


def gcloud(*args: str) -> str:
    import shutil
    exe = shutil.which("gcloud") or shutil.which("gcloud.cmd") or "gcloud"
    out = subprocess.run([exe, *args], capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"gcloud {args[0]} failed: {out.stderr.strip()[:200]}")
    return out.stdout.strip()


async def main() -> None:
    from google.cloud.sql.connector import Connector, IPTypes
    from google.oauth2.credentials import Credentials

    creds = Credentials(token=gcloud("auth", "print-access-token"))
    password = gcloud("secrets", "versions", "access", "latest",
                      f"--secret={SECRET}", f"--project={PROJECT}")

    connectors: dict = {}

    async def _connect():
        loop = asyncio.get_running_loop()
        c = connectors.get(loop)
        if c is None:
            c = Connector(credentials=creds, loop=loop)
            connectors[loop] = c
        return await c.connect_async(
            INSTANCE, "asyncpg", user=USER, password=password,
            db=DATABASE, ip_type=IPTypes.PUBLIC)

    connector = None
    try:
        # 1. Pre-create btree_gist (required by q9e2f5a8c3d7 EXCLUDE constraint)
        conn = await _connect()
        try:
            await conn.execute("CREATE EXTENSION IF NOT EXISTS btree_gist")
            print("[migrate] btree_gist ensured")
        finally:
            await conn.close()

        # 2. Alembic upgrade head — patch env.py's engine factory so every
        #    connection it makes goes through the connector.
        import sqlalchemy.ext.asyncio as sa_async
        from sqlalchemy.ext.asyncio import create_async_engine
        from sqlalchemy import pool as sa_pool

        async def _creator():
            return await _connect()

        def _engine_from_config(configuration, prefix, **kw):
            return create_async_engine(
                "postgresql+asyncpg://", async_creator=_creator,
                poolclass=kw.get("poolclass", sa_pool.NullPool))

        sa_async.async_engine_from_config = _engine_from_config

        os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        sys.path.insert(0, os.getcwd())

        from alembic.config import Config
        from alembic import command

        await asyncio.to_thread(command.upgrade, Config("alembic.ini"), "head")
        print("[migrate] alembic upgrade head complete")

        # 3. Report stamp + table count
        conn = await _connect()
        try:
            ver = await conn.fetchval("SELECT version_num FROM alembic_version")
            n = await conn.fetchval(
                "SELECT count(*) FROM information_schema.tables "
                "WHERE table_schema='public'")
            print(f"[migrate] alembic_version={ver}  public tables={n}")
        finally:
            await conn.close()
    finally:
        for c in connectors.values():
            await c.close_async()


if __name__ == "__main__":
    asyncio.run(main())
