from __future__ import annotations

import logging
from collections.abc import AsyncGenerator
from pathlib import Path
from urllib.parse import unquote

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from openagents_api.config import get_settings
from openagents_api.models import Base

_log = logging.getLogger(__name__)


def _migrate_legacy_sqlite_file(url: str) -> None:
    """Rename packwright.db → openagents.db when only the legacy file exists.

    Preserves Docker/local SQLite data after the product rename.
    """
    if not url.startswith("sqlite"):
        return
    raw = url.split(":///", 1)[-1] if ":///" in url else ""
    if not raw:
        return
    path = Path(unquote(raw))
    if path.name != "openagents.db" or path.exists():
        return
    legacy = path.with_name("packwright.db")
    if not legacy.is_file():
        return
    try:
        legacy.rename(path)
        _log.info("Renamed legacy SQLite DB %s → %s", legacy, path)
    except OSError:
        _log.exception("Failed to rename legacy SQLite DB %s → %s", legacy, path)


settings = get_settings()

# Local → SSH tunnel; production (Coolify) → supabase-db Docker DNS.
_database_url = settings.resolved_database_url
_migrate_legacy_sqlite_file(_database_url)

engine = create_async_engine(_database_url, echo=False)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def init_db() -> None:
    """Create/alter tables and seed company config.

    Soft-fails on connection errors so a down local Postgres tunnel does not
    prevent uvicorn from binding (health still answers; DB routes will 500).
    """
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            # Dev DBs created before newer columns existed need lightweight alters.
            await conn.run_sync(_ensure_column, "threads", "usage", "JSON")
            await conn.run_sync(_ensure_column, "threads", "todos", "JSON")
            await conn.run_sync(
                _ensure_column, "threads", "agent_kind", "VARCHAR(32) DEFAULT 'classic'"
            )
            await conn.run_sync(
                _ensure_column, "threads", "agent_slug", "VARCHAR(128) DEFAULT 'agent'"
            )
            await conn.run_sync(_ensure_column, "user_settings", "spend_totals", "JSON")
            await conn.run_sync(
                _ensure_column,
                "user_settings",
                "spend_budget_usd",
                "DOUBLE PRECISION DEFAULT 5.0",
            )
            await conn.run_sync(_ensure_column, "profiles", "role", "VARCHAR(32) DEFAULT 'user'")
            await conn.run_sync(
                _ensure_column, "profiles", "status", "VARCHAR(32) DEFAULT 'active'"
            )
            await conn.run_sync(
                _ensure_column, "profiles", "approved_at", "TIMESTAMP WITH TIME ZONE"
            )
            await conn.run_sync(_ensure_column, "profiles", "approved_by", "TEXT")
            await conn.run_sync(
                _ensure_column, "profiles", "rejected_at", "TIMESTAMP WITH TIME ZONE"
            )
            await conn.run_sync(
                _ensure_column, "profiles", "pending_notified_at", "TIMESTAMP WITH TIME ZONE"
            )
            await conn.run_sync(
                _ensure_column, "system_settings", "zdr_only", "BOOLEAN DEFAULT FALSE"
            )
            await conn.run_sync(_ensure_column, "system_settings", "model_tiers", "JSON")
            await conn.run_sync(_ensure_column, "system_settings", "agent_runtime", "JSON")
            # Legacy column for older DBs; migrated to agent_slug below.
            await conn.run_sync(
                _ensure_column,
                "workspaces",
                "pack_slug",
                "VARCHAR(128) DEFAULT 'agent'",
            )
            await conn.run_sync(_migrate_pack_to_agent_schema)
            await conn.run_sync(
                _ensure_column, "user_skills", "icon", "VARCHAR(64) DEFAULT ''"
            )
            await conn.run_sync(
                _ensure_column, "user_agents", "predefined_skill_slugs", "JSON"
            )
            await conn.run_sync(
                _ensure_column, "user_agents", "mcp_server_ids", "JSON"
            )
    except Exception:
        _log.exception(
            "Database unavailable during init_db (url=%s). "
            "For local Postgres via tunnel, run: ./scripts/supabase-db-tunnel.sh",
            _database_url.split("@")[-1] if "@" in _database_url else _database_url,
        )
        return

    # Seed company prompts/skills from templates when empty (Postgres or SQLite).
    from openagents_api.company_config import seed_company_config_if_empty
    from openagents_api.seed_demo import seed_demo_workspaces_if_empty

    async with SessionLocal() as session:
        try:
            await seed_company_config_if_empty(session)
        except Exception:
            _log.exception("company config seed failed")
        try:
            await seed_demo_workspaces_if_empty(session)
        except Exception:
            _log.exception("demo workspace seed failed")


def _ensure_column(sync_conn, table: str, column: str, sql_type: str) -> None:  # type: ignore[no-untyped-def]
    from sqlalchemy import inspect, text

    inspector = inspect(sync_conn)
    if table not in inspector.get_table_names():
        return
    cols = {c["name"] for c in inspector.get_columns(table)}
    if column in cols:
        return
    sync_conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {sql_type}"))


def _migrate_pack_to_agent_schema(sync_conn) -> None:  # type: ignore[no-untyped-def]
    """Rename pack_* schema leftovers to agent_* and rewrite builder slug."""
    from sqlalchemy import inspect, text

    inspector = inspect(sync_conn)
    tables = set(inspector.get_table_names())

    # workspaces.pack_slug → agent_slug
    if "workspaces" in tables:
        cols = {c["name"] for c in inspector.get_columns("workspaces")}
        if "pack_slug" in cols and "agent_slug" not in cols:
            try:
                sync_conn.execute(
                    text("ALTER TABLE workspaces RENAME COLUMN pack_slug TO agent_slug")
                )
            except Exception:
                # SQLite older / dialect quirks: copy then drop is heavier; log and continue.
                _log.exception("failed to rename workspaces.pack_slug → agent_slug")
        elif "pack_slug" in cols and "agent_slug" in cols:
            sync_conn.execute(
                text(
                    "UPDATE workspaces SET agent_slug = pack_slug "
                    "WHERE (agent_slug IS NULL OR agent_slug = '') "
                    "AND pack_slug IS NOT NULL AND pack_slug <> ''"
                )
            )

        # Refresh columns after possible rename.
        cols = {c["name"] for c in inspect(sync_conn).get_columns("workspaces")}
        slug_col = "agent_slug" if "agent_slug" in cols else "pack_slug"
        if slug_col in cols:
            sync_conn.execute(
                text(
                    f"UPDATE workspaces SET {slug_col} = 'agent-builder' "
                    f"WHERE {slug_col} = 'pack-builder'"
                )
            )

    # user_packs → user_agents
    tables = set(inspect(sync_conn).get_table_names())
    if "user_packs" in tables and "user_agents" not in tables:
        try:
            sync_conn.execute(text("ALTER TABLE user_packs RENAME TO user_agents"))
        except Exception:
            _log.exception("failed to rename user_packs → user_agents")


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with SessionLocal() as session:
        yield session
