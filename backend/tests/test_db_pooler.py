"""Pooler-mode detection + connection-error-path resilience.

Regression coverage for the session-pool exhaustion incident:
``pooler_mode()`` must classify the Supabase pooler ports correctly
(:6543 transaction / :5432 session) so ``DB_POOLER_MODE=auto`` keeps the
prepared-statement workaround applied exactly where pgbouncer needs it,
and the ``handle_error`` timing listener must not raise when a
connection-acquisition failure (e.g. EMAXCONNSESSION) arrives with
``ctx.connection`` unset — previously that raised
``AttributeError: 'NoneType' object has no attribute 'info'`` and
escaped as an unhandled 500 instead of the sanitized 503.
"""

import pytest
from sqlalchemy.ext.asyncio import create_async_engine

from app.core import database, timing
from app.core.config import settings

POOLER = "postgresql+asyncpg://u:p@aws-0-ap-south-1.pooler.supabase.com:{port}/postgres"


@pytest.fixture
def _env(monkeypatch):
    def set_env(url: str, mode: str = "auto"):
        monkeypatch.setattr(settings, "DATABASE_URL", url)
        monkeypatch.setattr(settings, "DB_POOLER_MODE", mode)
    return set_env


class TestPoolerModeDetection:
    def test_6543_is_transaction(self, _env):
        _env(POOLER.format(port=6543))
        assert database.pooler_mode() == "transaction"

    def test_5432_is_session(self, _env):
        _env(POOLER.format(port=5432))
        assert database.pooler_mode() == "session"

    def test_non_pooler_host_is_direct(self, _env):
        _env("postgresql+asyncpg://u:p@db.example.supabase.co:5432/postgres")
        assert database.pooler_mode() == "direct"

    def test_explicit_override_wins(self, _env):
        _env(POOLER.format(port=6543), mode="session")
        assert database.pooler_mode() == "session"


class TestPgbouncerConnectArgs:
    def test_transaction_mode_disables_both_caches(self, _env):
        _env(POOLER.format(port=6543))
        args = database._pgbouncer_connect_args()
        assert args["prepared_statement_cache_size"] == 0
        assert "prepared_statement_name_func" in args
        assert args["prepared_statement_name_func"]().startswith("__asyncpg_")

    def test_session_mode_keeps_caches(self, _env):
        _env(POOLER.format(port=5432))
        assert database._pgbouncer_connect_args() == {}

    def test_direct_keeps_caches(self, _env):
        _env("postgresql+asyncpg://u:p@db.example.supabase.co:5432/postgres")
        assert database._pgbouncer_connect_args() == {}


class TestHandleErrorResilience:
    async def test_connect_failure_propagates_original_error(self):
        """Connect-time failures (EMAXCONNSESSION, DNS, refused) fire
        handle_error with ctx.connection=None — the timing listener must
        not mask the real error with AttributeError
        ('NoneType' has no attribute 'info' → unhandled 500)."""
        engine = create_async_engine(
            "postgresql+asyncpg://u:p@nonexistent.invalid:5432/db",
            pool_pre_ping=False,
        )
        timing.install_engine_listeners(engine)
        try:
            bag = timing.TimingBag()
            token = timing.request_timing.set(bag)
            try:
                with pytest.raises(Exception) as exc_info:
                    await engine.connect()
            finally:
                timing.request_timing.reset(token)
            # The original connectivity error surfaces — never an
            # AttributeError synthesized by the error-path listener.
            assert not isinstance(exc_info.value, AttributeError)
            assert bag.db_queries == 0
        finally:
            await engine.dispose()

    async def test_statement_failure_counts_and_propagates(self):
        """A failed statement still counts into the bag and the original
        DBAPI error propagates unmasked."""
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        timing.install_engine_listeners(engine)
        try:
            bag = timing.TimingBag()
            token = timing.request_timing.set(bag)
            try:
                with pytest.raises(Exception) as exc_info:
                    async with engine.connect() as conn:
                        await conn.exec_driver_sql("SELECT * FROM missing_table_xyz")
            finally:
                timing.request_timing.reset(token)
            assert not isinstance(exc_info.value, AttributeError)
            assert bag.db_queries == 1
            assert bag.db_ms >= 0
        finally:
            await engine.dispose()
