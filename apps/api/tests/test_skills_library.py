"""Library skills — builtin skills/ + user_skills API."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from openagents_api.auth import AuthUser, get_current_user
from openagents_api.config import Settings, get_settings
from openagents_api.db import get_session
from openagents_api.models import Base
from openagents_api.skills_library import (
    list_builtin_library_skills,
    load_builtin_library_skill,
    skills_root,
)


def test_skills_root_points_at_repo_skills() -> None:
    root = skills_root()
    assert root.name == "skills"
    assert root.is_dir()


def test_create_skill_builtin_exists() -> None:
    skill = load_builtin_library_skill("create-skill")
    assert skill.slug == "create-skill"
    assert skill.source == "builtin"
    assert "Creating Skills" in skill.content
    assert skill.description
    assert skill.icon == "pencil-ruler"


def test_format_predefined_skills_prompt() -> None:
    from openagents_api.skills_library import (
        LibrarySkill,
        format_predefined_skills_prompt,
        normalize_skill_slugs,
    )

    assert normalize_skill_slugs(["Create-Skill", "create-skill", "bad slug"]) == [
        "create-skill"
    ]
    text = format_predefined_skills_prompt(
        [
            LibrarySkill(
                slug="create-skill",
                name="Create skill",
                content="# Creating Skills\n\nDo the thing.\n",
            )
        ]
    )
    assert "Predefined skills" in text
    assert "/create-skill" in text
    assert "Do the thing" in text
    assert format_predefined_skills_prompt([]) == ""


def test_list_builtin_includes_create_skill() -> None:
    slugs = {s.slug for s in list_builtin_library_skills()}
    assert "create-skill" in slugs


@pytest.mark.asyncio
async def test_resolve_predefined_includes_agent_skills(
    api_client: tuple[AsyncClient, AsyncSession, AuthUser],
) -> None:
    """Agent playbooks (e.g. triage) can be rooted via predefined_skill_slugs."""
    from openagents_api.skills_library import resolve_library_skill

    _client, session, user = api_client
    skill = await resolve_library_skill(session, "triage", user.id)
    assert skill.slug == "triage"
    assert (skill.content or "").strip()
    assert "triage" in skill.name.lower() or skill.name == "Triage" or skill.slug == "triage"


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
    )
    monkeypatch.setattr("openagents_api.config.get_settings", lambda: settings)
    monkeypatch.setattr("openagents_api.db.settings", settings)

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
            yield client, session, user

    app.dependency_overrides.clear()
    await engine.dispose()


@pytest.mark.asyncio
async def test_skills_api_list_create_edit_delete(
    api_client: tuple[AsyncClient, AsyncSession, AuthUser],
) -> None:
    client, _session, _user = api_client

    listed = (await client.get("/api/skills")).json()
    assert any(s["slug"] == "create-skill" for s in listed)
    assert all("content" not in s or s["content"] is None for s in listed)

    detail = (await client.get("/api/skills/create-skill")).json()
    assert detail["source"] == "builtin"
    assert "SKILL.md" in detail["content"] or "Creating Skills" in detail["content"]

    created = (
        await client.post(
            "/api/skills",
            json={
                "name": "My Tip",
                "description": "Quick tip playbook",
                "icon": "search",
                "content": "---\nname: my-tip\ndescription: Quick tip playbook\n---\n\n# Tip\n\nBe brief.\n",
            },
        )
    ).json()
    assert created["slug"] == "my-tip"
    assert created["source"] == "user"
    assert created["icon"] == "search"

    patched = (
        await client.patch(
            "/api/skills/my-tip",
            json={"name": "My Tip Updated", "icon": "book"},
        )
    ).json()
    assert patched["name"] == "My Tip Updated"
    assert patched["icon"] == "book"

    bad = await client.patch("/api/skills/create-skill", json={"name": "X"})
    assert bad.status_code == 400

    deleted = await client.delete("/api/skills/my-tip")
    assert deleted.status_code == 200
    missing = await client.get("/api/skills/my-tip")
    assert missing.status_code == 404


@pytest.mark.asyncio
async def test_duplicate_create_skill(
    api_client: tuple[AsyncClient, AsyncSession, AuthUser],
) -> None:
    client, _session, _user = api_client
    dup = (await client.post("/api/skills/create-skill/duplicate")).json()
    assert dup["source"] == "user"
    assert "copy" in dup["slug"] or "Copy" in dup["name"]
    assert "Creating Skills" in dup["content"]
