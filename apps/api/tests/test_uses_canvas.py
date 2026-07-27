"""Seam 3: uses_canvas wiring — manifest, user agents API, tool registration."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from openagents_api.agents import load_agent
from openagents_api.auth import AuthUser, get_current_user
from openagents_api.config import Settings, get_settings
from openagents_api.db import get_session
from openagents_api.models import Base


def test_builtin_agents_uses_canvas_flags() -> None:
    agent = load_agent("agent")
    assert agent.manifest.uses_canvas is True
    research = load_agent("research-assistant")
    assert research.manifest.uses_canvas is True
    coding = load_agent("coding-assistant")
    assert coding.manifest.uses_canvas is False
    builder = load_agent("agent-builder")
    assert builder.manifest.uses_canvas is False


def test_openagents_run_tools_registers_canvas_only_when_enabled() -> None:
    from openagents_api.deep_agent_builder import openagents_run_tools

    with_names = {getattr(t, "__name__", str(t)) for t in openagents_run_tools(uses_canvas=True)}
    without_names = {
        getattr(t, "__name__", str(t)) for t in openagents_run_tools(uses_canvas=False)
    }
    assert "canvas_batch_create_elements" in with_names
    assert "suggest_edit" in with_names
    assert "canvas_batch_create_elements" not in without_names
    assert "suggest_edit" in without_names


@pytest_asyncio.fixture
async def api_client(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> AsyncGenerator[AsyncClient, None]:
    ws_root = tmp_path / "openagents-workspaces"
    ws_root.mkdir()
    db_path = tmp_path / "test.db"
    settings = Settings(
        workspace_tmp_root=str(ws_root),
        auth_bypass=True,
        database_url=f"sqlite+aiosqlite:///{db_path}",
        database_url_local=f"sqlite+aiosqlite:///{db_path}",
    )
    get_settings.cache_clear()
    monkeypatch.setattr("openagents_api.config.get_settings", lambda: settings)
    monkeypatch.setattr("openagents_api.routers_api.get_settings", lambda: settings)

    engine = create_async_engine(settings.database_url, echo=False)
    session_factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    user = AuthUser(id="test-user", email="test@localhost")

    async def override_session() -> AsyncGenerator[AsyncSession, None]:
        async with session_factory() as session:
            yield session

    async def override_user() -> AuthUser:
        return user

    from fastapi import FastAPI
    from openagents_api.routers_api import router

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_current_user] = override_user

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client

    app.dependency_overrides.clear()
    await engine.dispose()
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_user_agent_uses_canvas_create_and_update(api_client: AsyncClient) -> None:
    created = await api_client.post(
        "/api/agents",
        json={
            "name": "Canvas Agent",
            "description": "test",
            "uses_document": True,
            "uses_canvas": True,
            "agent_md": "# Canvas Agent\n\nDraw diagrams.",
        },
    )
    assert created.status_code == 200, created.text
    body = created.json()
    assert body["uses_canvas"] is True
    slug = body["slug"]

    got = await api_client.get(f"/api/agents/{slug}")
    assert got.status_code == 200
    assert got.json()["uses_canvas"] is True

    patched = await api_client.patch(
        f"/api/agents/{slug}",
        json={"uses_canvas": False},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["uses_canvas"] is False
