"""Grant airos_sa_app full privileges on the dev schema (runs as postgres)."""
import asyncio
import shutil
import subprocess

INSTANCE = "final-airos-os:asia-south1:airos-postgres-dev"
DATABASE = "airos_dev"
SECRET = "airos-dev-postgres-password"
PROJECT = "final-airos-os"

GRANTS = [
    "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO airos_sa_app",
    "GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO airos_sa_app",
    "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO airos_sa_app",
    "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO airos_sa_app",
]


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
            INSTANCE, "asyncpg", user="postgres", password=password,
            db=DATABASE, ip_type=IPTypes.PUBLIC)
        try:
            for stmt in GRANTS:
                await conn.execute(stmt)
                print(f"[ok] {stmt.split(' TO ')[0]}…")
            print("grants applied")
        finally:
            await conn.close()
    finally:
        await connector.close_async()


if __name__ == "__main__":
    asyncio.run(main())
