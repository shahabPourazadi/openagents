"""User agent CRUD + resolve_agent."""

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
from openagents_api.models import Base, UserAgent, Workspace
from openagents_api.agents import (
    AgentError,
    loaded_agent_from_user_row,
    resolve_agent,
    slugify_agent_name,
)


@pytest_asyncio.fixture
async def api_client(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> AsyncGenerator[tuple[AsyncClient, AsyncSession, AuthUser], None]:
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
    monkeypatch.setattr("openagents_api.config.get_settings", lambda: settings)
    monkeypatch.setattr("openagents_api.routers_api.get_settings", lambda: settings)

    engine = create_async_engine(settings.database_url, echo=False)
    session_factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    user = AuthUser(id="test-user", email="test@localhost", role="admin", status="active")

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
        async with session_factory() as session:
            yield client, session, user

    app.dependency_overrides.clear()
    await engine.dispose()
    get_settings.cache_clear()


def test_slugify_agent_name() -> None:
    assert slugify_agent_name("My Grant Writer!") == "my-grant-writer"


@pytest.mark.asyncio
async def test_create_list_get_patch_delete_user_pack(
    api_client: tuple[AsyncClient, AsyncSession, AuthUser],
) -> None:
    client, _session, _user = api_client

    created = (
        await client.post(
            "/api/agents",
            json={
                "name": "Grant Writer",
                "description": "Helps with grants",
                "uses_document": True,
                "agent_md": "# Grant Writer\n\nHelp draft grants.\n",
                "document_template_md": "# Grant draft\n\n",
                "skills": [
                    {
                        "slug": "outline",
                        "name": "outline",
                        "content": "# Outline\n\nBuild a grant outline.\n",
                    }
                ],
                "predefined_skill_slugs": ["create-skill"],
            },
        )
    ).json()
    assert created["source"] == "user"
    assert created["slug"] == "grant-writer"
    assert created["uses_document"] is True
    assert len(created["skills"]) == 1
    assert created["predefined_skill_slugs"] == ["create-skill"]

    listed = (await client.get("/api/agents")).json()
    slugs = {p["slug"] for p in listed}
    assert "research-assistant" in slugs
    assert "grant-writer" in slugs
    user_row = next(p for p in listed if p["slug"] == "grant-writer")
    assert user_row["source"] == "user"
    assert user_row["predefined_skill_slugs"] == ["create-skill"]

    detail = (await client.get("/api/agents/grant-writer")).json()
    assert "Help draft grants" in detail["agent_md"]
    assert detail["skills"][0]["content"]

    patched = (
        await client.patch(
            "/api/agents/grant-writer",
            json={
                "description": "Updated",
                "uses_document": False,
                "predefined_skill_slugs": [],
            },
        )
    ).json()
    assert patched["description"] == "Updated"
    assert patched["uses_document"] is False
    assert patched["predefined_skill_slugs"] == []

    # Cannot patch builtin
    bad = await client.patch("/api/agents/research-assistant", json={"name": "X"})
    assert bad.status_code == 400

    deleted = await client.delete("/api/agents/grant-writer")
    assert deleted.status_code == 200
    missing = await client.get("/api/agents/grant-writer")
    assert missing.status_code == 404


@pytest.mark.asyncio
async def test_duplicate_builtin_pack(
    api_client: tuple[AsyncClient, AsyncSession, AuthUser],
) -> None:
    client, _session, _user = api_client
    dup = (await client.post("/api/agents/coding-assistant/duplicate")).json()
    assert dup["source"] == "user"
    assert dup["slug"].startswith("coding-assistant")
    assert dup["uses_document"] is False
    assert "Coding" in dup["name"] or "coding" in dup["name"].lower()


@pytest.mark.asyncio
async def test_resolve_user_pack(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws_root = tmp_path / "ws"
    ws_root.mkdir()
    db_path = tmp_path / "r.db"
    settings = Settings(
        workspace_tmp_root=str(ws_root),
        auth_bypass=True,
        database_url=f"sqlite+aiosqlite:///{db_path}",
        database_url_local=f"sqlite+aiosqlite:///{db_path}",
    )
    get_settings.cache_clear()
    monkeypatch.setattr("openagents_api.config.get_settings", lambda: settings)

    engine = create_async_engine(settings.database_url, echo=False)
    session_factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        row = UserAgent(
            owner_id="u1",
            slug="my-agent",
            name="My Pack",
            agent_md="# My Pack\n\nHello.\n",
            uses_document=False,
            skills_json=[{"slug": "tip", "name": "tip", "content": "# Tip\n\nBe brief.\n"}],
        )
        session.add(row)
        await session.commit()
        await session.refresh(row)

        loaded = loaded_agent_from_user_row(row)
        assert loaded.source == "user"
        assert loaded.slug == "my-agent"
        assert (loaded.root / "agent.md").is_file()
        assert any(s.slug == "tip" for s in loaded.skills)

        resolved = await resolve_agent(session, "my-agent", "u1")
        assert resolved.source == "user"
        assert resolved.slug == "my-agent"

        # Builtin wins when slug exists as builtin
        research = await resolve_agent(session, "research-assistant", "u1")
        assert research.source == "builtin"

        with pytest.raises(AgentError):
            await resolve_agent(session, "nope-missing", "u1", fallback="also-missing")

    await engine.dispose()
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_workspace_agent_slug_patch_does_not_seed_document(
    api_client: tuple[AsyncClient, AsyncSession, AuthUser],
) -> None:
    client, session, user = api_client
    ws_id = uuid.uuid4()
    session.add(
        Workspace(
            id=ws_id,
            owner_id=user.id,
            name="WS",
            agent_slug="coding-assistant",
        )
    )
    await session.commit()

    # Create a doc-using user agent and switch to it — documents are on-demand.
    await client.post(
        "/api/agents",
        json={
            "name": "Notes Agent",
            "slug": "notes-agent",
            "uses_document": True,
            "agent_md": "# Notes\n\nTake notes.\n",
            "document_template_md": "# Seeded notes\n\n",
        },
    )

    updated = (
        await client.patch(
            f"/api/workspaces/{ws_id}",
            json={"agent_slug": "notes-agent"},
        )
    ).json()
    assert updated["agent_slug"] == "notes-agent"
    assert updated["uses_document"] is True

    docs = (await client.get(f"/api/workspaces/{ws_id}/documents")).json()
    assert docs == []
