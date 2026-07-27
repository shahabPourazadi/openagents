"""Seam 1: Canvas persistence API — create/get/patch + active_canvas_id."""

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

EMPTY_SCENE = {
    "type": "excalidraw",
    "version": 2,
    "source": "openagents",
    "elements": [],
    "appState": {"viewBackgroundColor": "#ffffff"},
    "files": {},
}


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
    )
    get_settings.cache_clear()
    monkeypatch.setattr("openagents_api.config.get_settings", lambda: settings)
    monkeypatch.setattr("openagents_api.routers_api.get_settings", lambda: settings)

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
async def test_canvas_create_get_patch_roundtrip(
    api_client: tuple[AsyncClient, uuid.UUID],
) -> None:
    client, workspace_id = api_client
    created = await client.post(
        f"/api/workspaces/{workspace_id}/canvases",
        json={"title": "Board", "scene_json": EMPTY_SCENE},
    )
    assert created.status_code == 200, created.text
    body = created.json()
    assert body["title"] == "Board"
    assert body["workspace_id"] == str(workspace_id)
    assert body["scene_json"]["elements"] == []
    canvas_id = body["id"]

    listed = await client.get(f"/api/workspaces/{workspace_id}/canvases")
    assert listed.status_code == 200
    assert len(listed.json()) == 1
    assert listed.json()[0]["id"] == canvas_id

    scene = {
        **EMPTY_SCENE,
        "elements": [
            {
                "id": "rect1",
                "type": "rectangle",
                "x": 10,
                "y": 20,
                "width": 100,
                "height": 50,
            }
        ],
    }
    patched = await client.patch(
        f"/api/canvases/{canvas_id}",
        json={"title": "Architecture", "scene_json": scene},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["title"] == "Architecture"
    assert patched.json()["scene_json"]["elements"][0]["id"] == "rect1"

    got = await client.get(f"/api/canvases/{canvas_id}")
    assert got.status_code == 200
    assert got.json()["scene_json"]["elements"][0]["id"] == "rect1"


@pytest.mark.asyncio
async def test_thread_active_canvas_id_roundtrip(
    api_client: tuple[AsyncClient, uuid.UUID],
) -> None:
    client, workspace_id = api_client
    canvas = await client.post(
        f"/api/workspaces/{workspace_id}/canvases",
        json={"title": "Active", "scene_json": EMPTY_SCENE},
    )
    assert canvas.status_code == 200, canvas.text
    canvas_id = canvas.json()["id"]

    thread = await client.post(
        f"/api/workspaces/{workspace_id}/threads",
        json={"title": "Chat", "active_canvas_id": canvas_id},
    )
    assert thread.status_code == 200, thread.text
    assert thread.json()["active_canvas_id"] == canvas_id
    thread_id = thread.json()["id"]

    updated = await client.patch(
        f"/api/threads/{thread_id}",
        json={"active_canvas_id": canvas_id},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["active_canvas_id"] == canvas_id
