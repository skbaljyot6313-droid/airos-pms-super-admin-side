# Cloud Run image — Super Admin API (mirrors railway.toml start contract)
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Migrations run before serve when this chain owns the alembic_version
# row. The DB is SHARED with the Employee Backend whose revisions extend
# the same row beyond our head — `alembic upgrade head` then cannot
# resolve the current revision and exits non-zero, which must not kill
# the release: boot's own check_schema_version validates the stamp.
CMD ["sh", "-c", "alembic upgrade head || echo 'alembic: shared schema stamp, boot check will verify'; exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080} --workers ${UVICORN_WORKERS:-1} --proxy-headers"]
