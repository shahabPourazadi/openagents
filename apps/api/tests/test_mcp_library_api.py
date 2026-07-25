"""User MCP library API — CRUD, secrets masking, OpenRouter prebuilt."""

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

    async def _ok_probe(draft, **_kwargs):
        return McpProbeResult(ok=True, tool_names=["ping", "search"], error=None)

    monkeypatch.setattr(
        "openagents_api.mcp_library.probe_mcp_server",
        AsyncMock(side_effect=_ok_probe),
    )

    engine = create_async_engine(settings.database_url)
    session_factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    user = AuthUser(
        id="test-user",
        email="test@localhost",
        role="admin",
        status="active",
    )

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
async def test_list_ensures_openrouter_prebuilt(
    api_client: tuple[AsyncClient, AsyncSession, AuthUser, Settings],
) -> None:
    client, *_ = api_client
    listed = (await client.get("/api/mcp-servers")).json()
    assert any(s["slug"] == "openrouter" and s["is_prebuilt"] for s in listed)
    orow = next(s for s in listed if s["slug"] == "openrouter")
    assert orow["auth_mode"] == "openrouter_settings"
    assert orow["url"] == "https://mcp.openrouter.ai/mcp"
    assert "auth_token" not in orow
    assert orow["has_token"] is False


@pytest.mark.asyncio
async def test_create_requires_successful_probe_and_masks_token(
    api_client: tuple[AsyncClient, AsyncSession, AuthUser, Settings],
) -> None:
    client, *_ = api_client
    created = (
        await client.post(
            "/api/mcp-servers",
            json={
                "name": "Docs",
                "url": "https://mcp.example.com/mcp",
                "token": "super-secret-token-value",
            },
        )
    ).json()
    assert created["slug"] == "docs"
    assert created["has_token"] is True
    assert created["tool_names"] == ["ping", "search"]
    assert "super-secret" not in str(created)
    assert created.get("auth_token") is None

    detail = (await client.get(f"/api/mcp-servers/{created['id']}")).json()
    assert detail["has_token"] is True
    assert "super-secret" not in str(detail)


@pytest.mark.asyncio
async def test_create_blocked_when_probe_fails(
    api_client: tuple[AsyncClient, AsyncSession, AuthUser, Settings],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from openagents_api.mcp_probe import McpProbeError

    monkeypatch.setattr(
        "openagents_api.mcp_library.probe_mcp_server",
        AsyncMock(side_effect=McpProbeError("auth failed")),
    )
    client, *_ = api_client
    resp = await client.post(
        "/api/mcp-servers",
        json={"name": "Bad", "url": "https://mcp.example.com/mcp", "token": "x"},
    )
    assert resp.status_code == 400
    assert "auth failed" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_parse_endpoint(
    api_client: tuple[AsyncClient, AsyncSession, AuthUser, Settings],
) -> None:
    client, *_ = api_client
    resp = await client.post(
        "/api/mcp-servers/parse",
        json={
            "raw": {
                "mcpServers": {
                    "wiki": {"url": "https://mcp.deepwiki.com/mcp"},
                    "local": {"command": "npx"},
                }
            }
        },
    )
    assert resp.status_code == 200
    drafts = resp.json()["drafts"]
    assert len(drafts) == 1
    assert drafts[0]["name"] == "wiki"
