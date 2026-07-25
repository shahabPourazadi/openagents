"""Demo workspace seed for open-auth user."""

from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from openagents_api.config import Settings, get_settings
from openagents_api.models import Base, Document, Thread, Workspace
from openagents_api.seed_demo import DEMO_OWNER_ID, seed_demo_workspaces_if_empty


@pytest.fixture
def demo_settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Settings:
    db_path = tmp_path / "demo.db"
    settings = Settings(
        auth_bypass=True,
        database_url=f"sqlite+aiosqlite:///{db_path}",
        database_url_local=f"sqlite+aiosqlite:///{db_path}",
        workspace_tmp_root=str(tmp_path / "ws"),
    )
    get_settings.cache_clear()
    monkeypatch.setattr("openagents_api.config.get_settings", lambda: settings)
    yield settings
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_seed_demo_creates_one_workspace_per_builtin_pack(
    demo_settings: Settings,
) -> None:
    engine = create_async_engine(demo_settings.database_url, echo=False)
    factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async with factory() as session:
        created = await seed_demo_workspaces_if_empty(session, settings=demo_settings)
        assert created >= 3

        rows = (
            await session.execute(
                select(Workspace).where(Workspace.owner_id == DEMO_OWNER_ID)
            )
        ).scalars().all()
        slugs = {ws.agent_slug for ws in rows}
        assert "research-assistant" in slugs
        assert "coding-assistant" in slugs
        assert "agent-builder" in slugs

        research = next(ws for ws in rows if ws.agent_slug == "research-assistant")
        docs = (
            await session.execute(
                select(Document).where(Document.workspace_id == research.id)
            )
        ).scalars().all()
        assert len(docs) == 1

        coding = next(ws for ws in rows if ws.agent_slug == "coding-assistant")
        coding_docs = (
            await session.execute(
                select(func.count()).select_from(Document).where(
                    Document.workspace_id == coding.id
                )
            )
        ).scalar_one()
        assert int(coding_docs) == 0

        threads = (
            await session.execute(
                select(func.count()).select_from(Thread).where(
                    Thread.workspace_id == research.id
                )
            )
        ).scalar_one()
        assert int(threads) == 1

    # Idempotent second call
    async with factory() as session:
        created_again = await seed_demo_workspaces_if_empty(session, settings=demo_settings)
        assert created_again == 0
        count = await session.scalar(
            select(func.count()).select_from(Workspace).where(
                Workspace.owner_id == DEMO_OWNER_ID
            )
        )
        assert int(count or 0) == created

    await engine.dispose()
