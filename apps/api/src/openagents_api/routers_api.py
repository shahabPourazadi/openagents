from __future__ import annotations

import tempfile
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from openagents_api.auth import AuthUser, require_active_user
from openagents_api.config import Settings, get_settings
from openagents_api.db import get_session
from openagents_api.models import (
    Document,
    Message,
    Thread,
    UserAgent,
    UserSettings,
    UserSkill,
    Workspace,
    WorkspaceFile,
)
from openagents_api.agents import (
    DEFAULT_AGENT_SLUG,
    AgentError,
    builtin_slug_exists,
    list_builtin_agents,
    load_agent,
    resolve_agent,
    slugify_agent_name,
    try_load_agent,
    validate_agent_draft,
    validate_agent_slug,
)
from openagents_api.schemas import (
    DocumentCreate,
    DocumentOut,
    DocumentUpdate,
    MessageCreate,
    MessageOut,
    ModelOption,
    AgentCreate,
    AgentEnhanceAgentMd,
    AgentEnhanceAgentMdOut,
    AgentOut,
    AgentSkillOut,
    AgentUpdate,
    SkillCreate,
    SkillOut,
    SkillUpdate,
    PersonaUpdate,
    SettingsUpdate,
    ThreadCreate,
    ThreadOut,
    ThreadUpdate,
    UploadOut,
    UploadPresignOut,
    WorkspaceCreate,
    WorkspaceFileCreate,
    WorkspaceFileOut,
    WorkspaceFileUpdate,
    WorkspaceOut,
    WorkspaceUpdate,
)
from openagents_api import s3_uploads as s3
from openagents_api.suggestions import invalidate_conflicting
from openagents_api.uploads import (
    delete_upload,
    list_uploads,
    read_upload_bytes,
    resolve_upload_file,
    save_upload,
    stored_name_from_relative,
    use_s3,
)
from openagents_api.workspace_assets import (
    delete_asset,
    guess_asset_content_type,
    list_assets,
    normalize_asset_path,
    read_asset_bytes,
    resolve_asset_file,
)
from openagents_api.workspace_files import (
    kind_for_path,
    list_workspace_files as list_ws_files,
    seed_default_memory_files,
)

router = APIRouter(prefix="/api")


def _skills_to_out(skills: list) -> list[AgentSkillOut]:
    return [
        AgentSkillOut(
            slug=s.slug,
            name=getattr(s, "name", "") or s.slug,
            description=getattr(s, "description", "") or "",
            icon=getattr(s, "icon", "") or "",
            content=s.content,
        )
        for s in skills
    ]


def _agent_out_from_loaded(pack, *, detail: bool = False) -> AgentOut:
    from openagents_api.mcp_library import normalize_mcp_server_ids
    from openagents_api.skills_library import normalize_skill_slugs

    return AgentOut(
        name=pack.manifest.name,
        slug=pack.slug,
        description=pack.manifest.description or "",
        icon=pack.manifest.icon or "",
        uses_document=pack.manifest.uses_document,
        default_model=pack.manifest.default_model,
        source=getattr(pack, "source", "builtin") or "builtin",
        agent_md=pack.agent_md if detail else None,
        soul_md=pack.soul_md if detail else None,
        system_prompt=pack.system_prompt if detail else None,
        document_template_md=pack.document_template_md if detail else None,
        skills=_skills_to_out(pack.skills) if detail else [
            AgentSkillOut(
                slug=s.slug,
                name=getattr(s, "name", "") or s.slug,
                description=getattr(s, "description", "") or "",
                icon=getattr(s, "icon", "") or "",
            )
            for s in pack.skills
        ],
        predefined_skill_slugs=normalize_skill_slugs(
            getattr(pack, "predefined_skill_slugs", None)
        ),
        mcp_server_ids=normalize_mcp_server_ids(
            getattr(pack, "mcp_server_ids", None)
        ),
    )


def _agent_out_from_user_row(row: UserAgent, *, detail: bool = False) -> AgentOut:
    from openagents_api.mcp_library import normalize_mcp_server_ids
    from openagents_api.skills_library import normalize_skill_slugs

    raw_skills = row.skills_json if isinstance(row.skills_json, list) else []
    skills: list[AgentSkillOut] = []
    for item in raw_skills:
        if not isinstance(item, dict):
            continue
        skill_slug = str(item.get("slug") or "").strip()
        if not skill_slug:
            continue
        skills.append(
            AgentSkillOut(
                slug=skill_slug,
                name=str(item.get("name") or skill_slug),
                description=str(item.get("description") or ""),
                icon=str(item.get("icon") or ""),
                content=str(item.get("content") or "") if detail else "",
            )
        )
    return AgentOut(
        name=row.name,
        slug=row.slug,
        description=row.description or "",
        icon=row.icon or "",
        uses_document=bool(row.uses_document),
        default_model=None,
        source="user",
        agent_md=row.agent_md if detail else None,
        soul_md=row.soul_md if detail else None,
        system_prompt=row.system_prompt if detail else None,
        document_template_md=row.document_template_md if detail else None,
        skills=skills,
        predefined_skill_slugs=normalize_skill_slugs(row.predefined_skill_slugs),
        mcp_server_ids=normalize_mcp_server_ids(row.mcp_server_ids),
    )


async def _workspace_out(session: AsyncSession, ws: Workspace) -> WorkspaceOut:
    slug = (getattr(ws, "agent_slug", None) or DEFAULT_AGENT_SLUG).strip() or DEFAULT_AGENT_SLUG
    uses_document = True
    try:
        pack = await resolve_agent(session, slug, ws.owner_id)
        uses_document = pack.manifest.uses_document
        slug = pack.slug
    except AgentError:
        pass
    return WorkspaceOut(
        id=ws.id,
        name=ws.name,
        owner_id=ws.owner_id,
        agent_slug=slug,
        uses_document=uses_document,
        agent_md=ws.agent_md,
        soul_md=ws.soul_md,
        created_at=ws.created_at,
    )


async def _unique_user_slug(
    session: AsyncSession, owner_id: str, base: str
) -> str:
    slug = validate_agent_slug(base)
    if builtin_slug_exists(slug):
        slug = validate_agent_slug(f"{slug}-custom")
    candidate = slug
    n = 2
    while True:
        if builtin_slug_exists(candidate):
            candidate = f"{slug}-{n}"
            n += 1
            continue
        existing = await session.execute(
            select(UserAgent).where(
                UserAgent.owner_id == owner_id, UserAgent.slug == candidate
            )
        )
        if existing.scalar_one_or_none() is None:
            return candidate
        candidate = f"{slug}-{n}"
        n += 1


async def _document_template_for_workspace(
    session: AsyncSession, ws: Workspace, settings: Settings
) -> str:
    """Pack document template when available; else empty."""
    _ = settings
    slug = (getattr(ws, "agent_slug", None) or DEFAULT_AGENT_SLUG).strip()
    try:
        pack = await resolve_agent(session, slug, ws.owner_id)
        if pack.document_template_md.strip():
            return pack.document_template_md
    except AgentError:
        pass
    return ""


async def _owned_workspace(
    session: AsyncSession, workspace_id: uuid.UUID, user: AuthUser
) -> Workspace:
    ws = await session.get(Workspace, workspace_id)
    if not ws or ws.owner_id != user.id:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return ws


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/config")
async def public_config(
    settings: Settings = Depends(get_settings),
) -> dict[str, str | bool]:
    """Public runtime flags for the UI (no secrets)."""
    return {
        "auth_mode": settings.auth_mode,
        "feature_signup_queue": settings.feature_signup_queue,
    }


@router.post("/agents/enhance-agent-md", response_model=AgentEnhanceAgentMdOut)
async def enhance_pack_agent_md(
    body: AgentEnhanceAgentMd,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> AgentEnhanceAgentMdOut:
    """Rewrite rough notes into a best-practice Agent agent.md."""
    from openagents_api.enhance_agent_md import enhance_agent_md

    row = await session.get(UserSettings, user.id)
    api_key = (
        row.openrouter_api_key_enc if row and row.openrouter_api_key_enc else None
    ) or settings.openrouter_api_key
    if not api_key:
        raise HTTPException(
            status_code=400,
            detail="OpenRouter API key required — set it in Settings or OPENROUTER_API_KEY.",
        )
    try:
        agent_md = await enhance_agent_md(
            draft=body.draft,
            name=body.name,
            description=body.description,
            uses_document=body.uses_document,
            api_key=api_key,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"Failed to enhance instructions: {exc}"
        ) from exc
    return AgentEnhanceAgentMdOut(agent_md=agent_md)


@router.get("/agents", response_model=list[AgentOut])
async def list_packs(
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> list[AgentOut]:
    """List built-in + the caller's user packs."""
    out: list[AgentOut] = []
    for m in list_builtin_agents():
        try:
            pack = load_agent(m.slug)
            out.append(_agent_out_from_loaded(pack, detail=False))
        except AgentError:
            out.append(
                AgentOut(
                    name=m.name,
                    slug=m.slug,
                    description=m.description,
                    icon=m.icon,
                    uses_document=m.uses_document,
                    default_model=m.default_model,
                    source="builtin",
                )
            )
    result = await session.execute(
        select(UserAgent).where(UserAgent.owner_id == user.id).order_by(UserAgent.name)
    )
    for row in result.scalars():
        out.append(_agent_out_from_user_row(row, detail=False))
    return out


@router.post("/agents", response_model=AgentOut)
async def create_pack(
    body: AgentCreate,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> AgentOut:
    """Create a user Agent."""
    try:
        base_slug = body.slug.strip() if body.slug else slugify_agent_name(body.name)
        slug = await _unique_user_slug(session, user.id, base_slug)
        agent_md = (body.agent_md or "").strip() or (
            f"# {body.name}\n\nYou help the user with their workflow.\n"
        )
        validate_agent_draft(
            name=body.name,
            agent_md=agent_md,
            uses_document=body.uses_document,
            skills=[s.model_dump() for s in body.skills],
        )
    except AgentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    from openagents_api.mcp_library import normalize_mcp_server_ids
    from openagents_api.skills_library import normalize_skill_slugs

    row = UserAgent(
        owner_id=user.id,
        slug=slug,
        name=body.name.strip(),
        description=body.description or "",
        icon=body.icon or "",
        uses_document=body.uses_document,
        document_template_md=body.document_template_md or "",
        agent_md=agent_md,
        soul_md=body.soul_md or "",
        system_prompt=body.system_prompt or "",
        skills_json=[s.model_dump() for s in body.skills],
        predefined_skill_slugs=normalize_skill_slugs(body.predefined_skill_slugs),
        mcp_server_ids=[str(x) for x in normalize_mcp_server_ids(body.mcp_server_ids)],
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return _agent_out_from_user_row(row, detail=True)


async def _expand_auto_agent_access(
    session: AsyncSession, owner_id: str, out: AgentOut
) -> AgentOut:
    """Auto Agent exposes every skill + MCP in the detail payload (UI + docs)."""
    from openagents_api.mcp_library import list_owner_mcp_server_ids
    from openagents_api.skills_library import list_all_attachable_skill_slugs

    out.predefined_skill_slugs = await list_all_attachable_skill_slugs(
        session, owner_id
    )
    out.mcp_server_ids = await list_owner_mcp_server_ids(session, owner_id)
    return out


@router.get("/agents/{slug}", response_model=AgentOut)
async def get_pack(
    slug: str,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> AgentOut:
    """Get one built-in or user pack (full content)."""
    try:
        pack = load_agent(slug)
        out = _agent_out_from_loaded(pack, detail=True)
        if pack.slug == DEFAULT_AGENT_SLUG:
            return await _expand_auto_agent_access(session, user.id, out)
        return out
    except AgentError:
        pass
    result = await session.execute(
        select(UserAgent).where(UserAgent.owner_id == user.id, UserAgent.slug == slug)
    )
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    return _agent_out_from_user_row(row, detail=True)


@router.patch("/agents/{slug}", response_model=AgentOut)
async def update_pack(
    slug: str,
    body: AgentUpdate,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> AgentOut:
    """Update a user pack (built-ins are read-only)."""
    if builtin_slug_exists(slug):
        raise HTTPException(status_code=400, detail="Cannot modify a built-in agent")
    result = await session.execute(
        select(UserAgent).where(UserAgent.owner_id == user.id, UserAgent.slug == slug)
    )
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Agent not found")

    if body.name is not None:
        row.name = body.name.strip() or row.name
    if body.description is not None:
        row.description = body.description
    if body.icon is not None:
        row.icon = body.icon
    if body.uses_document is not None:
        row.uses_document = body.uses_document
    if body.document_template_md is not None:
        row.document_template_md = body.document_template_md
    if body.agent_md is not None:
        row.agent_md = body.agent_md
    if body.soul_md is not None:
        row.soul_md = body.soul_md
    if body.system_prompt is not None:
        row.system_prompt = body.system_prompt
    if body.skills is not None:
        row.skills_json = [s.model_dump() for s in body.skills]
    if body.predefined_skill_slugs is not None:
        from openagents_api.skills_library import normalize_skill_slugs

        row.predefined_skill_slugs = normalize_skill_slugs(body.predefined_skill_slugs)
    if body.mcp_server_ids is not None:
        from openagents_api.mcp_library import normalize_mcp_server_ids

        row.mcp_server_ids = [
            str(x) for x in normalize_mcp_server_ids(body.mcp_server_ids)
        ]

    try:
        validate_agent_draft(
            name=row.name,
            agent_md=row.agent_md,
            uses_document=row.uses_document,
            skills=row.skills_json if isinstance(row.skills_json, list) else [],
        )
    except AgentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    await session.commit()
    await session.refresh(row)
    return _agent_out_from_user_row(row, detail=True)


@router.delete("/agents/{slug}")
async def delete_pack(
    slug: str,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    """Delete a user pack (built-ins cannot be deleted)."""
    if builtin_slug_exists(slug):
        raise HTTPException(status_code=400, detail="Cannot delete a built-in agent")
    result = await session.execute(
        select(UserAgent).where(UserAgent.owner_id == user.id, UserAgent.slug == slug)
    )
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    await session.delete(row)
    await session.commit()
    return {"status": "deleted", "slug": slug}


@router.post("/agents/{slug}/duplicate", response_model=AgentOut)
async def duplicate_pack(
    slug: str,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> AgentOut:
    """Duplicate a built-in or user pack into a new user pack."""
    try:
        source = load_agent(slug)
        name = f"{source.manifest.name} (copy)"
        agent_md = source.agent_md
        soul_md = source.soul_md
        system_prompt = source.system_prompt
        document_template_md = source.document_template_md
        uses_document = source.manifest.uses_document
        description = source.manifest.description or ""
        icon = source.manifest.icon or ""
        skills = [
            {"slug": s.slug, "name": getattr(s, "name", "") or s.slug, "content": s.content}
            for s in source.skills
        ]
        predefined_skill_slugs = list(
            getattr(source, "predefined_skill_slugs", None) or []
        )
        mcp_server_ids = list(getattr(source, "mcp_server_ids", None) or [])
    except AgentError:
        result = await session.execute(
            select(UserAgent).where(UserAgent.owner_id == user.id, UserAgent.slug == slug)
        )
        src_row = result.scalar_one_or_none()
        if src_row is None:
            raise HTTPException(status_code=404, detail="Agent not found") from None
        name = f"{src_row.name} (copy)"
        agent_md = src_row.agent_md
        soul_md = src_row.soul_md or ""
        system_prompt = src_row.system_prompt or ""
        document_template_md = src_row.document_template_md or ""
        uses_document = bool(src_row.uses_document)
        description = src_row.description or ""
        icon = src_row.icon or ""
        skills = src_row.skills_json if isinstance(src_row.skills_json, list) else []
        predefined_skill_slugs = (
            src_row.predefined_skill_slugs
            if isinstance(src_row.predefined_skill_slugs, list)
            else []
        )
        mcp_server_ids = (
            src_row.mcp_server_ids if isinstance(src_row.mcp_server_ids, list) else []
        )

    try:
        new_slug = await _unique_user_slug(session, user.id, f"{slug}-copy")
    except AgentError:
        new_slug = await _unique_user_slug(session, user.id, slugify_agent_name(name))

    from openagents_api.mcp_library import normalize_mcp_server_ids
    from openagents_api.skills_library import normalize_skill_slugs

    row = UserAgent(
        owner_id=user.id,
        slug=new_slug,
        name=name,
        description=description,
        icon=icon,
        uses_document=uses_document,
        document_template_md=document_template_md,
        agent_md=agent_md,
        soul_md=soul_md,
        system_prompt=system_prompt,
        skills_json=skills,
        predefined_skill_slugs=normalize_skill_slugs(predefined_skill_slugs),
        mcp_server_ids=[str(x) for x in normalize_mcp_server_ids(mcp_server_ids)],
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return _agent_out_from_user_row(row, detail=True)


def _skill_out(skill, *, detail: bool = False) -> SkillOut:
    return SkillOut(
        slug=skill.slug,
        name=skill.name,
        description=skill.description or "",
        icon=getattr(skill, "icon", None) or "",
        source=skill.source,
        content=skill.content if detail else None,
    )


async def _unique_user_skill_slug(
    session: AsyncSession, owner_id: str, base: str
) -> str:
    from openagents_api.skills_library import builtin_library_slug_exists

    slug = validate_agent_slug(base)
    if builtin_library_slug_exists(slug):
        slug = validate_agent_slug(f"{slug}-custom")
    candidate = slug
    n = 2
    while True:
        if builtin_library_slug_exists(candidate):
            candidate = f"{slug}-{n}"
            n += 1
            continue
        existing = await session.execute(
            select(UserSkill).where(
                UserSkill.owner_id == owner_id, UserSkill.slug == candidate
            )
        )
        if existing.scalar_one_or_none() is None:
            return candidate
        candidate = f"{slug}-{n}"
        n += 1


@router.get("/skills", response_model=list[SkillOut])
async def list_skills(
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> list[SkillOut]:
    """List built-in library skills + the caller's user skills."""
    from openagents_api.skills_library import list_owner_library_skills

    skills = await list_owner_library_skills(session, user.id)
    return [_skill_out(s, detail=False) for s in skills]


@router.post("/skills", response_model=SkillOut)
async def create_skill(
    body: SkillCreate,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> SkillOut:
    """Create a user library skill."""
    from openagents_api.skills_library import (
        SkillError,
        default_skill_content,
        library_skill_from_user_row,
        validate_skill_draft,
    )

    try:
        base_slug = body.slug.strip() if body.slug else slugify_agent_name(body.name)
        slug = await _unique_user_skill_slug(session, user.id, base_slug)
        content = (body.content or "").strip() or default_skill_content(
            body.name, body.description
        )
        validate_skill_draft(name=body.name, content=content)
    except (AgentError, SkillError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    row = UserSkill(
        owner_id=user.id,
        slug=slug,
        name=body.name.strip(),
        description=body.description or "",
        icon=(body.icon or "").strip(),
        content=content,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return _skill_out(library_skill_from_user_row(row), detail=True)


@router.get("/skills/{slug}", response_model=SkillOut)
async def get_skill(
    slug: str,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> SkillOut:
    """Get one built-in or user library skill (full content)."""
    from openagents_api.skills_library import SkillError, resolve_library_skill

    try:
        skill = await resolve_library_skill(session, slug, user.id)
    except SkillError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return _skill_out(skill, detail=True)


@router.patch("/skills/{slug}", response_model=SkillOut)
async def update_skill(
    slug: str,
    body: SkillUpdate,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> SkillOut:
    """Update a user library skill (built-ins are read-only)."""
    from openagents_api.skills_library import (
        SkillError,
        builtin_library_slug_exists,
        library_skill_from_user_row,
        validate_skill_draft,
    )

    if builtin_library_slug_exists(slug):
        raise HTTPException(status_code=400, detail="Cannot modify a built-in skill")
    result = await session.execute(
        select(UserSkill).where(UserSkill.owner_id == user.id, UserSkill.slug == slug)
    )
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Skill not found")
    if body.name is not None:
        row.name = body.name.strip() or row.name
    if body.description is not None:
        row.description = body.description
    if body.icon is not None:
        row.icon = body.icon.strip()
    if body.content is not None:
        row.content = body.content
    try:
        validate_skill_draft(name=row.name, content=row.content)
    except SkillError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await session.commit()
    await session.refresh(row)
    return _skill_out(library_skill_from_user_row(row), detail=True)


@router.delete("/skills/{slug}")
async def delete_skill(
    slug: str,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    """Delete a user library skill (built-ins cannot be deleted)."""
    from openagents_api.skills_library import (
        builtin_library_slug_exists,
        normalize_skill_slugs,
    )

    if builtin_library_slug_exists(slug):
        raise HTTPException(status_code=400, detail="Cannot delete a built-in skill")
    result = await session.execute(
        select(UserSkill).where(UserSkill.owner_id == user.id, UserSkill.slug == slug)
    )
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Skill not found")
    await session.delete(row)
    # Drop deleted skill from agents that rooted it in their prompt.
    agents = await session.execute(
        select(UserAgent).where(UserAgent.owner_id == user.id)
    )
    for agent_row in agents.scalars():
        current = normalize_skill_slugs(agent_row.predefined_skill_slugs)
        if slug not in current:
            continue
        agent_row.predefined_skill_slugs = [s for s in current if s != slug]
    await session.commit()
    return {"status": "deleted", "slug": slug}


@router.post("/skills/{slug}/duplicate", response_model=SkillOut)
async def duplicate_skill(
    slug: str,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> SkillOut:
    """Duplicate a built-in or user skill into a new user skill."""
    from openagents_api.skills_library import (
        SkillError,
        library_skill_from_user_row,
        resolve_library_skill,
    )

    try:
        source = await resolve_library_skill(session, slug, user.id)
    except SkillError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    try:
        new_slug = await _unique_user_skill_slug(
            session, user.id, f"{slug}-copy"
        )
    except AgentError:
        new_slug = await _unique_user_skill_slug(
            session, user.id, slugify_agent_name(f"{source.name} copy")
        )

    row = UserSkill(
        owner_id=user.id,
        slug=new_slug,
        name=f"{source.name} (copy)",
        description=source.description or "",
        icon=getattr(source, "icon", None) or "",
        content=source.content,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return _skill_out(library_skill_from_user_row(row), detail=True)


# Legacy /api/packs* aliases (same handlers).
router.add_api_route(
    "/packs/enhance-agent-md",
    enhance_pack_agent_md,
    methods=["POST"],
    response_model=AgentEnhanceAgentMdOut,
    include_in_schema=False,
)
router.add_api_route(
    "/packs",
    list_packs,
    methods=["GET"],
    response_model=list[AgentOut],
    include_in_schema=False,
)
router.add_api_route(
    "/packs",
    create_pack,
    methods=["POST"],
    response_model=AgentOut,
    include_in_schema=False,
)
router.add_api_route(
    "/packs/{slug}",
    get_pack,
    methods=["GET"],
    response_model=AgentOut,
    include_in_schema=False,
)
router.add_api_route(
    "/packs/{slug}",
    update_pack,
    methods=["PATCH"],
    response_model=AgentOut,
    include_in_schema=False,
)
router.add_api_route(
    "/packs/{slug}",
    delete_pack,
    methods=["DELETE"],
    include_in_schema=False,
)
router.add_api_route(
    "/packs/{slug}/duplicate",
    duplicate_pack,
    methods=["POST"],
    response_model=AgentOut,
    include_in_schema=False,
)


@router.get("/models", response_model=list[ModelOption])
async def list_models(
    session: AsyncSession = Depends(get_session),
) -> list[ModelOption]:
    from openagents_api.model_catalog import load_model_catalog
    from openagents_api.model_settings import set_catalog_cache

    catalog = await load_model_catalog(session)
    set_catalog_cache(zdr_only=catalog.zdr_only, tiers=catalog.tiers)
    options = catalog.to_model_options()
    if options:
        return options
    # Safety: never return an empty picker — fall back to defaults.
    from openagents_api.model_catalog import ModelCatalog, default_model_tiers

    fallback = ModelCatalog(zdr_only=False, tiers=default_model_tiers())
    return fallback.to_model_options()


@router.get("/workspaces", response_model=list[WorkspaceOut])
async def list_workspaces(
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> list[WorkspaceOut]:
    result = await session.execute(select(Workspace).where(Workspace.owner_id == user.id))
    return [await _workspace_out(session, ws) for ws in result.scalars()]


@router.post("/workspaces", response_model=WorkspaceOut)
async def create_workspace(
    body: WorkspaceCreate,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> WorkspaceOut:
    pack_slug = (body.agent_slug or DEFAULT_AGENT_SLUG).strip() or DEFAULT_AGENT_SLUG
    try:
        pack = await resolve_agent(session, pack_slug, user.id)
    except AgentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # User extensions start empty — pack persona is loaded at agent run time.
    ws = Workspace(
        owner_id=user.id,
        name=body.name,
        agent_slug=pack.slug,
        agent_md=None,
        soul_md=None,
    )
    session.add(ws)
    await session.commit()
    await session.refresh(ws)

    # Documents are created on demand (agent suggest_edit / user create) — not seeded.
    thread = Thread(
        workspace_id=ws.id,
        title="New chat",
        active_document_id=None,
        model=pack.manifest.default_model or settings.default_model,
    )
    session.add(thread)
    await seed_default_memory_files(session, ws.id)
    await session.commit()
    await session.refresh(ws)
    return await _workspace_out(session, ws)


@router.patch("/workspaces/{workspace_id}", response_model=WorkspaceOut)
async def update_workspace(
    workspace_id: uuid.UUID,
    body: WorkspaceUpdate,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> WorkspaceOut:
    """Update workspace name and/or selected pack."""
    ws = await _owned_workspace(session, workspace_id, user)
    if body.name is not None:
        ws.name = body.name.strip() or ws.name

    if body.agent_slug is not None:
        pack_slug = body.agent_slug.strip() or DEFAULT_AGENT_SLUG
        try:
            pack = await resolve_agent(session, pack_slug, user.id)
        except AgentError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        ws.agent_slug = pack.slug

    await session.commit()
    await session.refresh(ws)
    return await _workspace_out(session, ws)


@router.patch("/workspaces/{workspace_id}/persona", response_model=WorkspaceOut)
async def update_persona(
    workspace_id: uuid.UUID,
    body: PersonaUpdate,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> WorkspaceOut:
    ws = await _owned_workspace(session, workspace_id, user)
    if body.agent_md is not None:
        ws.agent_md = body.agent_md
    if body.soul_md is not None:
        ws.soul_md = body.soul_md
    await session.commit()
    await session.refresh(ws)
    return await _workspace_out(session, ws)


@router.get("/workspaces/{workspace_id}/files", response_model=list[WorkspaceFileOut])
async def list_files(
    workspace_id: uuid.UUID,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> list[WorkspaceFile]:
    await _owned_workspace(session, workspace_id, user)
    return await list_ws_files(session, workspace_id)


@router.post("/workspaces/{workspace_id}/files", response_model=WorkspaceFileOut)
async def create_file(
    workspace_id: uuid.UUID,
    body: WorkspaceFileCreate,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> WorkspaceFile:
    await _owned_workspace(session, workspace_id, user)
    path = body.path.replace("\\", "/").lstrip("/")
    if ".." in path.split("/"):
        raise HTTPException(status_code=400, detail="Invalid path")
    kind = body.kind or kind_for_path(path)
    row = WorkspaceFile(
        workspace_id=workspace_id,
        path=path,
        kind=kind,
        content_md=body.content_md or "",
    )
    session.add(row)
    try:
        await session.commit()
    except Exception as exc:
        await session.rollback()
        raise HTTPException(status_code=409, detail="File path already exists") from exc
    await session.refresh(row)
    return row


@router.get("/workspaces/{workspace_id}/files/{file_id}", response_model=WorkspaceFileOut)
async def get_file(
    workspace_id: uuid.UUID,
    file_id: uuid.UUID,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> WorkspaceFile:
    await _owned_workspace(session, workspace_id, user)
    row = await session.get(WorkspaceFile, file_id)
    if not row or row.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail="File not found")
    return row


@router.patch("/workspaces/{workspace_id}/files/{file_id}", response_model=WorkspaceFileOut)
async def update_file(
    workspace_id: uuid.UUID,
    file_id: uuid.UUID,
    body: WorkspaceFileUpdate,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> WorkspaceFile:
    await _owned_workspace(session, workspace_id, user)
    row = await session.get(WorkspaceFile, file_id)
    if not row or row.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail="File not found")
    if body.content_md is not None:
        row.content_md = body.content_md
    if body.path is not None:
        path = body.path.replace("\\", "/").lstrip("/")
        if ".." in path.split("/"):
            raise HTTPException(status_code=400, detail="Invalid path")
        row.path = path
        row.kind = body.kind or kind_for_path(path)
    elif body.kind is not None:
        row.kind = body.kind
    await session.commit()
    await session.refresh(row)
    return row


@router.delete("/workspaces/{workspace_id}/files/{file_id}")
async def delete_file(
    workspace_id: uuid.UUID,
    file_id: uuid.UUID,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    await _owned_workspace(session, workspace_id, user)
    row = await session.get(WorkspaceFile, file_id)
    if not row or row.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail="File not found")
    await session.delete(row)
    await session.commit()
    return {"status": "deleted"}


@router.get("/workspaces/{workspace_id}/uploads", response_model=list[UploadOut])
async def list_workspace_uploads(
    workspace_id: uuid.UUID,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> list[UploadOut]:
    """List binary uploads available to the deep agent (LiteParse)."""
    await _owned_workspace(session, workspace_id, user)
    return [UploadOut(**row) for row in list_uploads(workspace_id)]


@router.post("/workspaces/{workspace_id}/uploads", response_model=UploadOut)
async def upload_workspace_file(
    workspace_id: uuid.UUID,
    file: UploadFile = File(...),
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> UploadOut:
    """Upload a PDF/DOCX/XLSX/PPTX/image for deep-agent parse_document.

    Streams from the multipart spool so size/magic gates run without
    buffering the entire body in process memory first.
    """
    await _owned_workspace(session, workspace_id, user)
    filename = file.filename or "upload.bin"
    try:
        # UploadFile.file is a SpooledTemporaryFile / BinaryIO.
        meta = save_upload(workspace_id, filename=filename, stream=file.file)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return UploadOut(**meta)


@router.get("/workspaces/{workspace_id}/uploads/content")
async def get_workspace_upload_content(
    workspace_id: uuid.UUID,
    path: str,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> Response:
    """Serve an uploaded file for chat attachment preview (auth required).

    With Garage SSE-C, this authenticated proxy is the only safe browser path —
    presigned URLs cannot carry the customer key without leaking it.
    """
    await _owned_workspace(session, workspace_id, user)
    stored = stored_name_from_relative(path)
    if stored is None:
        raise HTTPException(status_code=404, detail="Upload not found")
    filename = stored.split("-", 1)[-1] if "-" in stored else stored

    if use_s3():
        data = read_upload_bytes(workspace_id, path)
        if data is None:
            raise HTTPException(status_code=404, detail="Upload not found")
        return Response(
            content=data,
            media_type="application/octet-stream",
            headers={
                "Content-Disposition": f'inline; filename="{filename}"',
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
            },
        )

    file_path = resolve_upload_file(workspace_id, path)
    if file_path is None:
        raise HTTPException(status_code=404, detail="Upload not found")
    return FileResponse(
        path=file_path,
        filename=filename,
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/workspaces/{workspace_id}/assets", response_model=list[UploadOut])
async def list_workspace_assets(
    workspace_id: uuid.UUID,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> list[UploadOut]:
    """List durable figure assets (diagrams/, other/) for the editor and Files tab."""
    await _owned_workspace(session, workspace_id, user)
    return [UploadOut(**row) for row in list_assets(workspace_id)]


@router.get("/workspaces/{workspace_id}/assets/content")
async def get_workspace_asset_content(
    workspace_id: uuid.UUID,
    path: str,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> Response:
    """Serve a diagrams/ or other/ asset (auth required; Garage SSE-C safe)."""
    await _owned_workspace(session, workspace_id, user)
    rel = normalize_asset_path(path)
    if rel is None:
        raise HTTPException(status_code=404, detail="Asset not found")
    filename = Path(rel).name

    if use_s3():
        data = read_asset_bytes(workspace_id, rel)
        if data is None:
            raise HTTPException(status_code=404, detail="Asset not found")
        media = guess_asset_content_type(Path(rel).suffix.lower())
        return Response(
            content=data,
            media_type=media,
            headers={
                "Content-Disposition": f'inline; filename="{filename}"',
                "Cache-Control": "private, max-age=60",
                "X-Content-Type-Options": "nosniff",
            },
        )

    file_path = resolve_asset_file(workspace_id, rel)
    if file_path is None:
        raise HTTPException(status_code=404, detail="Asset not found")
    media = guess_asset_content_type(Path(rel).suffix.lower())
    return FileResponse(
        path=file_path,
        filename=filename,
        media_type=media,
        headers={
            "Content-Disposition": f'inline; filename="{filename}"',
            "Cache-Control": "private, max-age=60",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.delete("/workspaces/{workspace_id}/assets")
async def delete_workspace_asset(
    workspace_id: uuid.UUID,
    path: str,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> dict[str, bool]:
    await _owned_workspace(session, workspace_id, user)
    ok = delete_asset(workspace_id, path)
    if not ok:
        raise HTTPException(status_code=404, detail="Asset not found")
    return {"ok": True}


@router.get("/workspaces/{workspace_id}/uploads/presign", response_model=UploadPresignOut)
async def presign_workspace_upload(
    workspace_id: uuid.UUID,
    path: str,
    expires_in: int = 120,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> UploadPresignOut:
    """Issue a short-lived GET URL — only when SSE-C is off.

    With SSE-C enabled (production Garage), returns 409: use /uploads/content.
    """
    await _owned_workspace(session, workspace_id, user)
    if not use_s3():
        raise HTTPException(
            status_code=501,
            detail="Presigned URLs require S3 storage; use /uploads/content",
        )
    stored = stored_name_from_relative(path)
    if stored is None or s3.head_object(workspace_id, stored) is None:
        raise HTTPException(status_code=404, detail="Upload not found")
    try:
        url = s3.presign_get_url(workspace_id, stored, expires_in=expires_in)
    except PermissionError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    ttl = max(1, min(int(expires_in), s3.MAX_PRESIGN_TTL_SECONDS))
    return UploadPresignOut(url=url, expires_in=ttl, path=path)


@router.delete("/workspaces/{workspace_id}/uploads")
async def delete_workspace_upload(
    workspace_id: uuid.UUID,
    path: str,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    await _owned_workspace(session, workspace_id, user)
    if not delete_upload(workspace_id, path):
        raise HTTPException(status_code=404, detail="Upload not found")
    return {"status": "deleted"}


@router.get("/workspaces/{workspace_id}/documents", response_model=list[DocumentOut])
async def list_documents(
    workspace_id: uuid.UUID,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> list[Document]:
    await _owned_workspace(session, workspace_id, user)
    result = await session.execute(select(Document).where(Document.workspace_id == workspace_id))
    return list(result.scalars())


@router.post("/workspaces/{workspace_id}/documents", response_model=DocumentOut)
async def create_document(
    workspace_id: uuid.UUID,
    body: DocumentCreate,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> Document:
    ws = await _owned_workspace(session, workspace_id, user)
    content = body.content_md
    if content is None and body.use_default_template:
        content = await _document_template_for_workspace(session, ws, settings)
    # Default: empty document — structure comes from the agent/user as needed.
    doc = Document(
        workspace_id=workspace_id,
        path=body.path,
        title=body.title,
        content_md=content if content is not None else "",
    )
    session.add(doc)
    await session.commit()
    await session.refresh(doc)
    return doc


@router.post("/workspaces/{workspace_id}/documents/from-template", response_model=DocumentOut)
async def create_from_custom_template(
    workspace_id: uuid.UUID,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
    title: str = "Custom document",
    path: str = "custom-document.md",
    content_md: str = "",
) -> Document:
    """Create a document from uploaded/custom markdown body (empty if omitted)."""
    await _owned_workspace(session, workspace_id, user)
    doc = Document(
        workspace_id=workspace_id,
        path=path,
        title=title,
        content_md=content_md or "",
    )
    session.add(doc)
    await session.commit()
    await session.refresh(doc)
    return doc


@router.post("/workspaces/{workspace_id}/documents/upload-template", response_model=DocumentOut)
async def upload_template(
    workspace_id: uuid.UUID,
    body: DocumentCreate,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> Document:
    """Replace/create a document from a custom markdown template (content_md required)."""
    await _owned_workspace(session, workspace_id, user)
    if not body.content_md:
        raise HTTPException(status_code=400, detail="content_md required for custom template")
    doc = Document(
        workspace_id=workspace_id,
        path=body.path or "custom-document.md",
        title=body.title or "Custom document",
        content_md=body.content_md,
    )
    session.add(doc)
    await session.commit()
    await session.refresh(doc)
    return doc


@router.get("/documents/{document_id}", response_model=DocumentOut)
async def get_document(
    document_id: uuid.UUID,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> Document:
    doc = await session.get(Document, document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    await _owned_workspace(session, doc.workspace_id, user)
    return doc


@router.patch("/documents/{document_id}", response_model=DocumentOut)
async def update_document(
    document_id: uuid.UUID,
    body: DocumentUpdate,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> Document:
    doc = await session.get(Document, document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    await _owned_workspace(session, doc.workspace_id, user)
    if body.title is not None:
        doc.title = body.title
    if body.path is not None:
        doc.path = body.path
    if body.content_md is not None:
        await invalidate_conflicting(session, doc.id, body.content_md)
        doc.content_md = body.content_md
    await session.commit()
    await session.refresh(doc)
    return doc


@router.get("/workspaces/{workspace_id}/threads", response_model=list[ThreadOut])
async def list_threads(
    workspace_id: uuid.UUID,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> list[Thread]:
    await _owned_workspace(session, workspace_id, user)
    result = await session.execute(
        select(Thread)
        .where(Thread.workspace_id == workspace_id)
        .order_by(Thread.updated_at.desc())
    )
    return list(result.scalars())


@router.post("/workspaces/{workspace_id}/threads", response_model=ThreadOut)
async def create_thread(
    workspace_id: uuid.UUID,
    body: ThreadCreate,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> Thread:
    ws = await _owned_workspace(session, workspace_id, user)
    requested_slug = (
        (body.agent_slug or getattr(ws, "agent_slug", None) or DEFAULT_AGENT_SLUG)
        .strip()
        or DEFAULT_AGENT_SLUG
    )
    try:
        pack = await resolve_agent(session, requested_slug, user.id)
    except AgentError:
        pack = try_load_agent(DEFAULT_AGENT_SLUG)
    agent_slug = pack.slug or DEFAULT_AGENT_SLUG
    # Documents are created on demand — new chats start without an artifact.
    doc_id = body.active_document_id
    kind = (body.agent_kind or "deep").strip().lower()
    if kind not in ("classic", "deep"):
        raise HTTPException(
            status_code=422, detail="agent_kind must be 'deep' (classic is deprecated)"
        )
    if kind == "classic":
        kind = "deep"
    default_model = settings.default_model
    try:
        from openagents_api.model_catalog import load_model_catalog

        catalog = await load_model_catalog(session)
        default_model = catalog.default_model_id()
    except Exception:
        pass
    thread = Thread(
        workspace_id=workspace_id,
        title=body.title,
        model=body.model or default_model,
        agent_slug=agent_slug,
        agent_kind=kind,
        active_document_id=doc_id,
    )
    session.add(thread)
    await session.commit()
    await session.refresh(thread)
    return thread


@router.patch("/threads/{thread_id}", response_model=ThreadOut)
async def update_thread(
    thread_id: uuid.UUID,
    body: ThreadUpdate,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> Thread:
    thread = await session.get(Thread, thread_id)
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")
    await _owned_workspace(session, thread.workspace_id, user)
    if body.title is not None:
        thread.title = body.title
        from datetime import datetime, timezone

        thread.updated_at = datetime.now(timezone.utc)
    if body.model is not None:
        thread.model = body.model
    if body.agent_slug is not None:
        requested = body.agent_slug.strip() or DEFAULT_AGENT_SLUG
        try:
            pack = await resolve_agent(session, requested, user.id)
        except AgentError:
            pack = try_load_agent(DEFAULT_AGENT_SLUG)
        thread.agent_slug = pack.slug or DEFAULT_AGENT_SLUG
    if body.active_document_id is not None:
        thread.active_document_id = body.active_document_id
    await session.commit()
    await session.refresh(thread)
    return thread


@router.delete("/threads/{thread_id}")
async def delete_thread(
    thread_id: uuid.UUID,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    thread = await session.get(Thread, thread_id)
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")
    await _owned_workspace(session, thread.workspace_id, user)

    workspace_id = thread.workspace_id
    doc_id = thread.active_document_id
    # Drop the thread first (messages cascade). Clear doc link so we can delete the document.
    thread.active_document_id = None
    await session.flush()
    await session.delete(thread)
    await session.flush()

    deleted_document_id = None
    if doc_id:
        # Only delete the document if no other thread still points at it.
        other = await session.execute(
            select(Thread).where(Thread.active_document_id == doc_id).limit(1)
        )
        if other.scalar_one_or_none() is None:
            doc = await session.get(Document, doc_id)
            if doc:
                await session.delete(doc)
                deleted_document_id = str(doc_id)

    # Drop research memos written for this thread (research/{thread_id}/...).
    research_prefix = f"research/{thread_id}/"
    research_rows = await session.execute(
        select(WorkspaceFile).where(
            WorkspaceFile.workspace_id == workspace_id,
            WorkspaceFile.path.like(f"{research_prefix}%"),
        )
    )
    for row in research_rows.scalars():
        await session.delete(row)

    await session.commit()
    return {"ok": True, "deleted_document_id": deleted_document_id}


@router.get("/threads/{thread_id}/messages", response_model=list[MessageOut])
async def list_messages(
    thread_id: uuid.UUID,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> list[Message]:
    thread = await session.get(Thread, thread_id)
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")
    await _owned_workspace(session, thread.workspace_id, user)
    result = await session.execute(
        select(Message).where(Message.thread_id == thread_id).order_by(Message.created_at)
    )
    return list(result.scalars())


@router.post("/threads/{thread_id}/messages", response_model=MessageOut)
async def create_message(
    thread_id: uuid.UUID,
    body: MessageCreate,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> MessageOut:
    thread = await session.get(Thread, thread_id)
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")
    await _owned_workspace(session, thread.workspace_id, user)
    if body.role not in {"user", "assistant", "system", "tool"}:
        raise HTTPException(status_code=400, detail="Invalid role")
    msg = Message(
        thread_id=thread_id,
        role=body.role,
        content=body.content or "",
        meta=body.meta,
    )
    session.add(msg)
    # Bump thread updated_at via touch
    from datetime import datetime, timezone

    thread.updated_at = datetime.now(timezone.utc)
    thread_title: str | None = None
    if body.role == "user" and body.content.strip() and thread.title in {"New chat"}:
        from openagents_api.langfuse_otel import langfuse_trace_baggage
        from openagents_api.thread_title import generate_thread_title

        row = await session.get(UserSettings, user.id)
        api_key = (row.openrouter_api_key_enc if row and row.openrouter_api_key_enc else None) or settings.openrouter_api_key
        with langfuse_trace_baggage(user_id=user.id, session_id=str(thread_id)):
            thread.title = await generate_thread_title(body.content, api_key=api_key)
        thread_title = thread.title
    await session.commit()
    await session.refresh(msg)
    return MessageOut(
        id=msg.id,
        role=msg.role,
        content=msg.content,
        meta=msg.meta,
        created_at=msg.created_at,
        thread_title=thread_title,
    )


@router.get("/settings", response_model=dict)
async def get_settings_row(
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> dict:
    from openagents_api.usage_tracking import (
        estimate_run_cost_usd,
        resolve_spend_budget_usd,
    )

    row = await session.get(UserSettings, user.id)
    if not row:
        row = UserSettings(
            user_id=user.id,
            spend_budget_usd=float(settings.default_spend_budget_usd),
        )
        session.add(row)

    # Ensure catalog prices are available for cost seed / backfill.
    try:
        from openagents_api.model_catalog import load_model_catalog
        from openagents_api.model_settings import set_catalog_cache

        catalog = await load_model_catalog(session)
        set_catalog_cache(zdr_only=catalog.zdr_only, tiers=catalog.tiers)
    except Exception:
        pass

    def _thread_cost_estimate(threads: list[Thread]) -> float | None:
        total = 0.0
        any_priced = False
        for t in threads:
            u = t.usage or {}
            inp = int(u.get("session_input_tokens") or 0)
            out = int(u.get("session_output_tokens") or 0)
            if inp <= 0 and out <= 0:
                continue
            priced = estimate_run_cost_usd(
                model=str(getattr(t, "model", "") or ""),
                input_tokens=inp,
                output_tokens=out,
            )
            if priced is None:
                continue
            total += priced
            any_priced = True
        return total if any_priced else None

    # One-time seed: if lifetime spend was never recorded, start from the sum of
    # current thread meters so the sidebar doesn't reset to 0 after this change.
    # After that, spend only grows on new runs and is never reduced by deletes.
    if row.spend_totals is None:
        ws_ids = (
            await session.execute(select(Workspace.id).where(Workspace.owner_id == user.id))
        ).scalars().all()
        total_tokens = 0
        input_tokens = 0
        output_tokens = 0
        threads: list[Thread] = []
        if ws_ids:
            threads = list(
                (
                    await session.execute(select(Thread).where(Thread.workspace_id.in_(ws_ids)))
                ).scalars().all()
            )
            for t in threads:
                u = t.usage or {}
                total_tokens += int(u.get("session_tokens") or 0)
                input_tokens += int(u.get("session_input_tokens") or 0)
                output_tokens += int(u.get("session_output_tokens") or 0)
        row.spend_totals = {
            "total_tokens": total_tokens,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "run_count": 0,
            "total_cost_usd": _thread_cost_estimate(threads),
            "last_run_tokens": 0,
        }
        await session.commit()

    spend = dict(
        row.spend_totals
        or {
            "total_tokens": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "run_count": 0,
            "total_cost_usd": None,
            "last_run_tokens": 0,
        }
    )
    # Repair: tokens were tracked before catalog pricing was wired — fill cost once.
    if spend.get("total_cost_usd") is None and int(spend.get("total_tokens") or 0) > 0:
        ws_ids = (
            await session.execute(select(Workspace.id).where(Workspace.owner_id == user.id))
        ).scalars().all()
        threads = []
        if ws_ids:
            threads = list(
                (
                    await session.execute(select(Thread).where(Thread.workspace_id.in_(ws_ids)))
                ).scalars().all()
            )
        estimated = _thread_cost_estimate(threads)
        if estimated is not None:
            spend["total_cost_usd"] = estimated
            row.spend_totals = spend
            await session.commit()
    return {
        "preferred_model": row.preferred_model,
        "has_openrouter_key": bool(row.openrouter_api_key_enc),
        "spend_totals": spend,
        "spend_budget_usd": resolve_spend_budget_usd(
            getattr(row, "spend_budget_usd", None),
            default=float(settings.default_spend_budget_usd),
        ),
    }


@router.patch("/settings", response_model=dict)
async def update_settings(
    body: SettingsUpdate,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    row = await session.get(UserSettings, user.id)
    if not row:
        row = UserSettings(user_id=user.id)
        session.add(row)
    if body.openrouter_api_key is not None:
        # Local v1: store as-is (encrypt before cloud multi-tenant).
        row.openrouter_api_key_enc = body.openrouter_api_key or None
    if body.preferred_model is not None:
        row.preferred_model = body.preferred_model
    await session.commit()
    return {"ok": True}


@router.post("/workspaces/{workspace_id}/materialize")
async def materialize_workspace(
    workspace_id: uuid.UUID,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> dict[str, str]:
    """Debug helper: materialize workspace files to a temp dir."""
    ws = await _owned_workspace(session, workspace_id, user)
    await seed_default_memory_files(session, workspace_id)
    await session.commit()
    root = Path(tempfile.mkdtemp(prefix="openagents-ws-", dir=settings.workspace_tmp_root if Path(settings.workspace_tmp_root).exists() else None))
    if ws.agent_md:
        (root / "agent.md").write_text(ws.agent_md, encoding="utf-8")
    if ws.soul_md:
        (root / "soul.md").write_text(ws.soul_md, encoding="utf-8")
    result = await session.execute(select(Document).where(Document.workspace_id == workspace_id))
    for doc in result.scalars():
        path = root / doc.path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(doc.content_md, encoding="utf-8")
    files = await list_ws_files(session, workspace_id)
    from openagents_api.workspace_files import materialize_workspace_files

    materialize_workspace_files(root, files)
    return {"path": str(root)}
