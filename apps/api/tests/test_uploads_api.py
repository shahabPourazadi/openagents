"""Seam D: HTTP /api/workspaces/{id}/uploads endpoints."""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from openagents_api.auth import AuthUser, get_current_user
from openagents_api.config import Settings, get_settings
from openagents_api.db import get_session
from openagents_api.models import Base, Workspace
from openagents_api import uploads as uploads_mod

PNG_HEADER = b"\x89PNG\r\n\x1a\n" + b"\x00" * 20


@pytest_asyncio.fixture
async def api_client(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> AsyncGenerator[tuple[AsyncClient, uuid.UUID], None]:
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
        openagents_s3_sse_c_key_base64="",
    )
    get_settings.cache_clear()
    monkeypatch.setattr(uploads_mod, "get_settings", lambda: settings)
    monkeypatch.setattr("openagents_api.config.get_settings", lambda: settings)
    monkeypatch.setattr("openagents_api.routers_api.get_settings", lambda: settings)
    monkeypatch.setattr("openagents_api.s3_uploads.get_settings", lambda: settings)

    engine = create_async_engine(settings.database_url, echo=False)
    session_factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    user = AuthUser(id="test-user", email="test@localhost")
    workspace_id = uuid.uuid4()
    async with session_factory() as session:
        session.add(
            Workspace(id=workspace_id, owner_id=user.id, name="Test WS", agent_md="", soul_md="")
        )
        await session.commit()

    async def override_session() -> AsyncGenerator[AsyncSession, None]:
        async with session_factory() as session:
            yield session

    async def override_user() -> AuthUser:
        return user

    # Minimal app (no lifespan/init_db) — exercise the uploads router only.
    from fastapi import FastAPI
    from openagents_api.routers_api import router

    app = FastAPI()
    app.include_router(router)

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_current_user] = override_user

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, workspace_id

    app.dependency_overrides.clear()
    await engine.dispose()
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_upload_list_get_delete_roundtrip(
    api_client: tuple[AsyncClient, uuid.UUID],
) -> None:
    client, workspace_id = api_client
    files = {"file": ("diagram.png", PNG_HEADER, "image/png")}
    r = await client.post(f"/api/workspaces/{workspace_id}/uploads", files=files)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["path"].startswith("uploads/")
    assert body["filename"] == "diagram.png"
    assert body["size"] == len(PNG_HEADER)

    listed = await client.get(f"/api/workspaces/{workspace_id}/uploads")
    assert listed.status_code == 200
    assert len(listed.json()) == 1
    assert listed.json()[0]["path"] == body["path"]

    content = await client.get(
        f"/api/workspaces/{workspace_id}/uploads/content",
        params={"path": body["path"]},
    )
    assert content.status_code == 200
    assert content.content[:8] == b"\x89PNG\r\n\x1a\n"

    deleted = await client.delete(
        f"/api/workspaces/{workspace_id}/uploads",
        params={"path": body["path"]},
    )
    assert deleted.status_code == 200
    assert (await client.get(f"/api/workspaces/{workspace_id}/uploads")).json() == []


@pytest.mark.asyncio
async def test_upload_rejects_bad_extension(
    api_client: tuple[AsyncClient, uuid.UUID],
) -> None:
    client, workspace_id = api_client
    files = {"file": ("evil.exe", b"MZ\x00\x00" + b"\x00" * 20, "application/octet-stream")}
    r = await client.post(f"/api/workspaces/{workspace_id}/uploads", files=files)
    assert r.status_code == 422
    assert "Unsupported" in r.text


@pytest.mark.asyncio
async def test_upload_rejects_magic_mismatch(
    api_client: tuple[AsyncClient, uuid.UUID],
) -> None:
    client, workspace_id = api_client
    files = {"file": ("fake.png", b"not-a-png-content!!!!", "image/png")}
    r = await client.post(f"/api/workspaces/{workspace_id}/uploads", files=files)
    assert r.status_code == 422
    assert "does not match" in r.text
