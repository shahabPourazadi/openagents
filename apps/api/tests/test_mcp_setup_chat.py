"""AI MCP setup-chat — propose/test/save through public library helpers."""

from __future__ import annotations

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
from openagents_api.mcp_probe import McpProbeResult
from openagents_api.mcp_setup import run_mcp_setup_turn
from openagents_api.models import Base


@pytest.mark.asyncio
async def test_setup_turn_extracts_url_and_saves_after_probe(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "test.db"
    settings = Settings(
        auth_bypass=True,
        database_url=f"sqlite+aiosqlite:///{db_path}",
        database_url_local=f"sqlite+aiosqlite:///{db_path}",
        mcp_secrets_key="test-mcp-secrets-key-32bytes-long!!",
        openagents_s3_endpoint="",
        openagents_s3_bucket="",
        openagents_s3_access_key_id="",
        openagents_s3_secret_access_key="",
    )
    fake_probe = AsyncMock(
        return_value=McpProbeResult(ok=True, tool_names=["search"], error=None)
    )
    monkeypatch.setattr("openagents_api.mcp_probe.probe_mcp_server", fake_probe)
    monkeypatch.setattr("openagents_api.mcp_library.probe_mcp_server", fake_probe)
    monkeypatch.setattr("openagents_api.mcp_setup.probe_mcp_server", fake_probe)
    engine = create_async_engine(settings.database_url)
    session_factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        result = await run_mcp_setup_turn(
            session,
            settings,
            "test-user",
            message="Add DeepWiki at https://mcp.deepwiki.com/mcp with no auth",
            history=[],
            lookup_web=AsyncMock(return_value="docs ok"),
        )
        assert result.draft is not None
        assert result.draft.url == "https://mcp.deepwiki.com/mcp"
        assert result.saved is not None
        assert result.tool_names == ["search"]
        assert "saved" in result.reply.lower() or "connected" in result.reply.lower()

    await engine.dispose()


@pytest_asyncio.fixture
async def api_client(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> AsyncGenerator[tuple[AsyncClient, Settings], None]:
    ws_root = tmp_path / "ws"
    ws_root.mkdir()
    db_path = tmp_path / "test.db"
    settings = Settings(
        workspace_tmp_root=str(ws_root),
        auth_bypass=True,
        database_url=f"sqlite+aiosqlite:///{db_path}",
        database_url_local=f"sqlite+aiosqlite:///{db_path}",
        mcp_secrets_key="test-mcp-secrets-key-32bytes-long!!",
        openagents_s3_endpoint="",
        openagents_s3_bucket="",
        openagents_s3_access_key_id="",
        openagents_s3_secret_access_key="",
    )
    monkeypatch.setattr("openagents_api.config.get_settings", lambda: settings)
    monkeypatch.setattr("openagents_api.db.settings", settings)
    fake_probe = AsyncMock(
        return_value=McpProbeResult(ok=True, tool_names=["ping"], error=None)
    )
    monkeypatch.setattr("openagents_api.mcp_probe.probe_mcp_server", fake_probe)
    monkeypatch.setattr("openagents_api.mcp_library.probe_mcp_server", fake_probe)
    monkeypatch.setattr("openagents_api.mcp_setup.probe_mcp_server", fake_probe)

    engine = create_async_engine(settings.database_url)
    session_factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    user = AuthUser(id="test-user", email="t@localhost", role="admin", status="active")

    async def _session() -> AsyncGenerator[AsyncSession, None]:
        async with session_factory() as session:
            yield session

    from openagents_api.main import app

    app.dependency_overrides[get_session] = _session
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_settings] = lambda: settings

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, settings

    app.dependency_overrides.clear()
    await engine.dispose()


@pytest.mark.asyncio
async def test_setup_chat_endpoint(
    api_client: tuple[AsyncClient, Settings],
) -> None:
    client, _ = api_client
    resp = await client.post(
        "/api/mcp-servers/setup-chat",
        json={
            "message": "Connect https://mcp.example.com/mcp token=abc",
            "history": [],
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["draft"]["url"] == "https://mcp.example.com/mcp"
    assert body["saved"] is not None
