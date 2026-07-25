"""Agent attach: persist mcp_server_ids and resolve for runs."""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from openagents_api.auth import AuthUser, get_current_user
from openagents_api.config import Settings, get_settings
from openagents_api.db import get_session
from openagents_api.mcp_library import resolve_user_mcp_configs
from openagents_api.mcp_probe import McpProbeResult
from openagents_api.models import Base


@pytest_asyncio.fixture
async def api_client(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> AsyncGenerator[tuple[AsyncClient, AsyncSession, AuthUser, Settings], None]:
    ws_root = tmp_path / "openagents-workspaces"
    ws_root.mkdir()
    db_path = tmp_path / "test.db"
    settings = Settings(
        workspace_tmp_root=str(ws_root),
        auth_bypass=True,
        database_url=f"sqlite+aiosqlite:///{db_path}",
        database_url_local=f"sqlite+aiosqlite:///{db_path}",
        openagents_s3_endpoint="",
        openagents_s3_bucket="",
        openagents_s3_access_key_id="",
        openagents_s3_secret_access_key="",
        mcp_secrets_key="test-mcp-secrets-key-32bytes-long!!",
    )
    monkeypatch.setattr("openagents_api.config.get_settings", lambda: settings)
    monkeypatch.setattr("openagents_api.db.settings", settings)
    monkeypatch.setattr(
        "openagents_api.mcp_library.probe_mcp_server",
        AsyncMock(
            return_value=McpProbeResult(ok=True, tool_names=["ping"], error=None)
        ),
    )

    engine = create_async_engine(settings.database_url)
    session_factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    user = AuthUser(id="test-user", email="test@localhost", role="admin", status="active")

    async def _session() -> AsyncGenerator[AsyncSession, None]:
        async with session_factory() as session:
            yield session

    async def _user() -> AuthUser:
        return user

    from openagents_api.main import app

    app.dependency_overrides[get_session] = _session
    app.dependency_overrides[get_current_user] = _user
    app.dependency_overrides[get_settings] = lambda: settings

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        async with session_factory() as session:
            yield client, session, user, settings

    app.dependency_overrides.clear()
    await engine.dispose()


@pytest.mark.asyncio
async def test_agent_persists_mcp_server_ids_and_resolve_filters(
    api_client: tuple[AsyncClient, AsyncSession, AuthUser, Settings],
) -> None:
    client, session, user, settings = api_client
    mcp = (
        await client.post(
            "/api/mcp-servers",
            json={
                "name": "Docs",
                "url": "https://mcp.example.com/mcp",
                "token": "tok-1",
            },
        )
    ).json()
    mcp_id = mcp["id"]

    created = (
        await client.post(
            "/api/agents",
            json={
                "name": "Researcher",
                "agent_md": "# Researcher\n\nHelp research.\n",
                "mcp_server_ids": [mcp_id],
            },
        )
    ).json()
    assert created["mcp_server_ids"] == [mcp_id]

    detail = (await client.get(f"/api/agents/{created['slug']}")).json()
    assert detail["mcp_server_ids"] == [mcp_id]

    configs = await resolve_user_mcp_configs(
        session, settings, user.id, [uuid.UUID(mcp_id)]
    )
    assert len(configs) == 1
    assert configs[0].name == "docs"
    assert configs[0].headers["Authorization"] == "Bearer tok-1"

    # Unrelated id is ignored
    configs_empty = await resolve_user_mcp_configs(
        session, settings, user.id, [uuid.uuid4()]
    )
    assert configs_empty == []


@pytest.mark.asyncio
async def test_auto_agent_detail_includes_all_mcp_and_skills(
    api_client: tuple[AsyncClient, AsyncSession, AuthUser, Settings],
) -> None:
    """Built-in Auto Agent exposes every library MCP + attachable skill."""
    from openagents_api.mcp_library import resolve_all_user_mcp_configs

    client, session, user, settings = api_client
    mcp = (
        await client.post(
            "/api/mcp-servers",
            json={
                "name": "Docs",
                "url": "https://mcp.example.com/mcp",
                "token": "tok-auto",
            },
        )
    ).json()
    mcp_id = mcp["id"]

    detail = (await client.get("/api/agents/agent")).json()
    assert detail["name"] == "Auto Agent"
    assert detail["source"] == "builtin"
    assert mcp_id in detail["mcp_server_ids"]
    assert "create-skill" in detail["predefined_skill_slugs"]
    assert "triage" in detail["predefined_skill_slugs"]

    configs = await resolve_all_user_mcp_configs(session, settings, user.id)
    assert any(c.name == "docs" for c in configs)
