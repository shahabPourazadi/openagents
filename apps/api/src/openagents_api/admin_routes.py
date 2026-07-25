"""Platform admin API: signup mode, users, company prompts/skills, audit."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from openagents_api.agent_runtime import (
    merge_agent_runtime,
    normalize_agent_runtime_update,
)
from openagents_api.auth import AuthUser, maybe_notify_pending, require_admin, get_current_user
from openagents_api.company_config import (
    PROMPT_KEYS,
    merge_tool_groups,
)
from openagents_api.config import Settings, get_settings
from openagents_api.db import get_session
from openagents_api.email import notify_user_approved, notify_user_rejected
from openagents_api.models import (
    AdminAuditLog,
    CompanyPromptDoc,
    CompanySkill,
    Profile,
    UserSettings,
    Workspace,
)
from openagents_api.uploads import purge_workspace_storage
from openagents_api.usage_tracking import resolve_spend_budget_usd, spent_usd

_log = logging.getLogger(__name__)

router = APIRouter(prefix="/api")


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class AccountStatusOut(BaseModel):
    user_id: str
    email: str | None = None
    display_name: str | None = None
    role: str
    status: str
    pending_count: int | None = None


class ModelTierOut(BaseModel):
    tier: str
    enabled: bool
    label: str
    model_slug: str
    provider: str
    allow_fallbacks: bool
    reasoning_mode: str = "efforts"
    reasoning_efforts: list[str] = []
    context_window: int = 1_000_000
    price_input_per_m: float | None = None
    price_output_per_m: float | None = None
    supports_vision: bool = True
    input_modalities: list[str] = ["text"]
    output_modalities: list[str] = ["text"]


class ModelTierUpdate(BaseModel):
    tier: str
    enabled: bool | None = None
    label: str | None = None
    model_slug: str | None = None
    provider: str | None = None
    allow_fallbacks: bool | None = None


class AgentSafetyOut(BaseModel):
    filesystem_hooks: bool
    prompt_injection: bool
    secret_redaction: bool
    tool_guard: bool


class AgentSafetyUpdate(BaseModel):
    filesystem_hooks: bool | None = None
    prompt_injection: bool | None = None
    secret_redaction: bool | None = None
    tool_guard: bool | None = None


class AgentRuntimeOut(BaseModel):
    sandbox: str
    execute: bool
    max_concurrent: int
    image: str
    safety: AgentSafetyOut


class AgentRuntimeUpdate(BaseModel):
    sandbox: str | None = None
    execute: bool | None = None
    max_concurrent: int | None = None
    image: str | None = None
    safety: AgentSafetyUpdate | None = None


class SystemSettingsOut(BaseModel):
    signup_mode: str
    tool_groups: dict[str, bool]
    zdr_only: bool = False
    model_tiers: list[ModelTierOut] = []
    agent_runtime: AgentRuntimeOut
    auth_mode: str = "none"
    feature_signup_queue: bool = False


class SystemSettingsUpdate(BaseModel):
    signup_mode: str | None = None
    tool_groups: dict[str, bool] | None = None
    zdr_only: bool | None = None
    model_tiers: list[ModelTierUpdate] | None = None
    agent_runtime: AgentRuntimeUpdate | None = None


class AdminUserOut(BaseModel):
    id: str
    email: str | None = None
    display_name: str | None = None
    role: str
    status: str
    created_at: datetime | None = None
    approved_at: datetime | None = None
    rejected_at: datetime | None = None
    spend_usd: float = 0.0
    spend_budget_usd: float = 5.0


class UserBudgetUpdate(BaseModel):
    spend_budget_usd: float = Field(ge=0, le=1_000_000)


class PromptDocOut(BaseModel):
    key: str
    draft_content: str
    published_content: str
    draft_updated_at: datetime | None = None
    published_at: datetime | None = None
    published_by: str | None = None
    has_unpublished_changes: bool = False


class PromptDraftUpdate(BaseModel):
    draft_content: str = Field(min_length=0)


class SkillOut(BaseModel):
    slug: str
    title: str
    enabled: bool
    draft_content: str
    published_content: str
    draft_updated_at: datetime | None = None
    published_at: datetime | None = None
    published_by: str | None = None
    has_unpublished_changes: bool = False


class SkillUpdate(BaseModel):
    draft_content: str | None = None
    enabled: bool | None = None
    title: str | None = None


class AuditOut(BaseModel):
    id: str
    actor_id: str
    action: str
    target_type: str | None = None
    target_id: str | None = None
    meta: dict | None = None
    created_at: datetime


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _audit(
    session: AsyncSession,
    *,
    actor_id: str,
    action: str,
    target_type: str | None = None,
    target_id: str | None = None,
    meta: dict | None = None,
) -> None:
    session.add(
        AdminAuditLog(
            id=uuid.uuid4(),
            actor_id=actor_id,
            action=action,
            target_type=target_type,
            target_id=target_id,
            meta=meta,
        )
    )


async def _pending_count(session: AsyncSession) -> int:
    result = await session.execute(
        select(func.count()).select_from(Profile).where(Profile.status == "pending")
    )
    return int(result.scalar_one() or 0)


def _prompt_out(row: CompanyPromptDoc) -> PromptDocOut:
    return PromptDocOut(
        key=row.key,
        draft_content=row.draft_content or "",
        published_content=row.published_content or "",
        draft_updated_at=row.draft_updated_at,
        published_at=row.published_at,
        published_by=row.published_by,
        has_unpublished_changes=(row.draft_content or "") != (row.published_content or ""),
    )


def _skill_out(row: CompanySkill) -> SkillOut:
    return SkillOut(
        slug=row.slug,
        title=row.title,
        enabled=bool(row.enabled),
        draft_content=row.draft_content or "",
        published_content=row.published_content or "",
        draft_updated_at=row.draft_updated_at,
        published_at=row.published_at,
        published_by=row.published_by,
        has_unpublished_changes=(row.draft_content or "") != (row.published_content or ""),
    )


# ---------------------------------------------------------------------------
# Account status (any authenticated user)
# ---------------------------------------------------------------------------


@router.get("/account/status", response_model=AccountStatusOut)
async def account_status(
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> AccountStatusOut:
    try:
        uid = uuid.UUID(user.id)
    except ValueError:
        return AccountStatusOut(
            user_id=user.id,
            email=user.email,
            display_name=user.display_name,
            role=user.role,
            status=user.status,
            pending_count=None,
        )

    profile = await session.get(Profile, uid)
    if profile and profile.status == "pending":
        await maybe_notify_pending(session, profile, settings=settings)

    pending = None
    if user.role == "admin":
        pending = await _pending_count(session)

    return AccountStatusOut(
        user_id=user.id,
        email=user.email,
        display_name=user.display_name,
        role=user.role,
        status=user.status,
        pending_count=pending,
    )


# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------


@router.get("/admin/me", response_model=AccountStatusOut)
async def admin_me(
    user: AuthUser = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> AccountStatusOut:
    return AccountStatusOut(
        user_id=user.id,
        email=user.email,
        display_name=user.display_name,
        role=user.role,
        status=user.status,
        pending_count=await _pending_count(session),
    )


def _settings_out(row, settings: Settings | None = None) -> SystemSettingsOut:
    from openagents_api.model_catalog import normalize_tiers
    from openagents_api.model_settings import set_catalog_cache

    tiers = normalize_tiers(getattr(row, "model_tiers", None))
    zdr = bool(getattr(row, "zdr_only", False))
    set_catalog_cache(zdr_only=zdr, tiers=tiers)
    runtime = merge_agent_runtime(
        getattr(row, "agent_runtime", None), settings or get_settings()
    )
    cfg = settings or get_settings()
    return SystemSettingsOut(
        signup_mode=row.signup_mode,
        tool_groups=merge_tool_groups(row.tool_groups),
        zdr_only=zdr,
        model_tiers=[ModelTierOut(**t) for t in tiers],
        agent_runtime=AgentRuntimeOut(**runtime.as_dict()),
        auth_mode=cfg.auth_mode,
        feature_signup_queue=cfg.feature_signup_queue,
    )


@router.get("/admin/settings", response_model=SystemSettingsOut)
async def get_admin_settings(
    _user: AuthUser = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> SystemSettingsOut:
    from openagents_api.model_catalog import ensure_model_tiers

    row = await ensure_model_tiers(session)
    await session.commit()
    return _settings_out(row, settings)


@router.patch("/admin/settings", response_model=SystemSettingsOut)
async def patch_admin_settings(
    body: SystemSettingsUpdate,
    user: AuthUser = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> SystemSettingsOut:
    from openagents_api.model_catalog import apply_tier_updates, ensure_model_tiers

    row = await ensure_model_tiers(session)
    if body.signup_mode is not None:
        if not settings.feature_signup_queue:
            raise HTTPException(
                status_code=400,
                detail="Signup queue disabled (FEATURE_SIGNUP_QUEUE=false)",
            )
        if body.signup_mode not in ("admin_approve", "auto_approve"):
            raise HTTPException(status_code=400, detail="Invalid signup_mode")
        row.signup_mode = body.signup_mode
    if body.tool_groups is not None:
        row.tool_groups = merge_tool_groups(body.tool_groups)

    if body.agent_runtime is not None:
        current = merge_agent_runtime(getattr(row, "agent_runtime", None), settings)
        try:
            row.agent_runtime = normalize_agent_runtime_update(
                body.agent_runtime.model_dump(exclude_none=True),
                current=current,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    if body.zdr_only is not None or body.model_tiers is not None:
        try:
            await apply_tier_updates(
                session,
                zdr_only=body.zdr_only,
                tier_updates=(
                    [t.model_dump(exclude_none=True) for t in body.model_tiers]
                    if body.model_tiers is not None
                    else None
                ),
                settings=settings,
                refresh_meta=True,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    row.updated_by = user.id
    await _audit(
        session,
        actor_id=user.id,
        action="settings.update",
        target_type="system_settings",
        target_id="1",
        meta=body.model_dump(exclude_none=True),
    )
    await session.commit()
    await session.refresh(row)
    return _settings_out(row, settings)


async def _get_profile(session: AsyncSession, user_id: str) -> Profile:
    try:
        uid = uuid.UUID(user_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="User not found") from exc
    row = await session.get(Profile, uid)
    if not row:
        raise HTTPException(status_code=404, detail="User not found")
    return row


async def _admin_user_out(
    session: AsyncSession,
    row: Profile,
    *,
    settings: Settings,
) -> AdminUserOut:
    us = await session.get(UserSettings, str(row.id))
    budget = resolve_spend_budget_usd(
        getattr(us, "spend_budget_usd", None) if us else None,
        default=float(settings.default_spend_budget_usd),
    )
    return AdminUserOut(
        id=str(row.id),
        email=row.email,
        display_name=row.display_name,
        role=row.role,
        status=row.status,
        created_at=row.created_at,
        approved_at=row.approved_at,
        rejected_at=row.rejected_at,
        spend_usd=spent_usd(getattr(us, "spend_totals", None) if us else None),
        spend_budget_usd=budget,
    )


@router.get("/admin/users", response_model=list[AdminUserOut])
async def list_users(
    status: str | None = Query(default=None),
    _user: AuthUser = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> list[AdminUserOut]:
    q = select(Profile).order_by(Profile.created_at.desc())
    if status:
        q = q.where(Profile.status == status)
    result = await session.execute(q)
    rows = list(result.scalars())
    return [await _admin_user_out(session, r, settings=settings) for r in rows]


@router.patch("/admin/users/{user_id}/budget", response_model=AdminUserOut)
async def patch_user_budget(
    user_id: str,
    body: UserBudgetUpdate,
    user: AuthUser = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> AdminUserOut:
    row = await _get_profile(session, user_id)
    us = await session.get(UserSettings, str(row.id))
    if not us:
        us = UserSettings(
            user_id=str(row.id),
            spend_budget_usd=float(settings.default_spend_budget_usd),
        )
        session.add(us)
    us.spend_budget_usd = float(body.spend_budget_usd)
    await _audit(
        session,
        actor_id=user.id,
        action="user.budget",
        target_type="profile",
        target_id=str(row.id),
        meta={"spend_budget_usd": us.spend_budget_usd},
    )
    await session.commit()
    return await _admin_user_out(session, row, settings=settings)


@router.post("/admin/users/{user_id}/approve", response_model=AdminUserOut)
async def approve_user(
    user_id: str,
    user: AuthUser = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> AdminUserOut:
    row = await _get_profile(session, user_id)
    if row.role == "admin":
        raise HTTPException(status_code=400, detail="Cannot change admin status here")
    now = datetime.now(timezone.utc)
    row.status = "active"
    row.approved_at = now
    row.approved_by = user.id
    row.rejected_at = None
    await _audit(
        session,
        actor_id=user.id,
        action="user.approve",
        target_type="profile",
        target_id=str(row.id),
    )
    await session.commit()
    if row.email:
        await notify_user_approved(user_email=row.email, settings=settings)
    return await _admin_user_out(session, row, settings=settings)


@router.post("/admin/users/{user_id}/reject", response_model=AdminUserOut)
async def reject_user(
    user_id: str,
    user: AuthUser = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> AdminUserOut:
    row = await _get_profile(session, user_id)
    if row.role == "admin":
        raise HTTPException(status_code=400, detail="Cannot change admin status here")
    row.status = "rejected"
    row.rejected_at = datetime.now(timezone.utc)
    await _audit(
        session,
        actor_id=user.id,
        action="user.reject",
        target_type="profile",
        target_id=str(row.id),
    )
    await session.commit()
    if row.email:
        await notify_user_rejected(user_email=row.email, settings=settings)
    return await _admin_user_out(session, row, settings=settings)


@router.post("/admin/users/{user_id}/disable", response_model=AdminUserOut)
async def disable_user(
    user_id: str,
    user: AuthUser = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> AdminUserOut:
    row = await _get_profile(session, user_id)
    if row.role == "admin":
        raise HTTPException(status_code=400, detail="Cannot disable an admin here")
    if str(row.id) == user.id:
        raise HTTPException(status_code=400, detail="Cannot disable yourself")
    row.status = "disabled"
    await _audit(
        session,
        actor_id=user.id,
        action="user.disable",
        target_type="profile",
        target_id=str(row.id),
    )
    await session.commit()
    return await _admin_user_out(session, row, settings=settings)


async def _delete_supabase_auth_user(user_id: str, settings: Settings) -> None:
    """Remove the Auth user (cascades ``profiles``). Soft-ok on 404."""
    service_key = (settings.supabase_service_role_key or "").strip()
    base = (settings.supabase_url or "").strip().rstrip("/")
    if not service_key or not base:
        raise HTTPException(
            status_code=500,
            detail="Supabase service role key is not configured",
        )
    url = f"{base}/auth/v1/admin/users/{user_id}"
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.delete(
                url,
                headers={
                    "Authorization": f"Bearer {service_key}",
                    "apikey": service_key,
                },
            )
    except httpx.HTTPError as exc:
        _log.exception("supabase auth delete failed for %s", user_id)
        raise HTTPException(
            status_code=502,
            detail="Failed to reach Supabase Auth to delete user",
        ) from exc
    if resp.status_code in (200, 204, 404):
        return
    _log.error("supabase auth delete %s: %s", resp.status_code, resp.text)
    raise HTTPException(
        status_code=502,
        detail=f"Failed to delete auth user ({resp.status_code})",
    )


@router.delete("/admin/users/{user_id}", status_code=204)
async def delete_user(
    user_id: str,
    user: AuthUser = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> Response:
    """Permanently delete a user and all their workspace data / files."""
    row = await _get_profile(session, user_id)
    if row.role == "admin":
        raise HTTPException(status_code=400, detail="Cannot delete an admin here")
    if str(row.id) == user.id:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")

    uid = str(row.id)
    result = await session.execute(select(Workspace).where(Workspace.owner_id == uid))
    workspaces = list(result.scalars())
    workspace_ids = [str(ws.id) for ws in workspaces]

    for ws in workspaces:
        purge_workspace_storage(ws.id)
        await session.delete(ws)

    us = await session.get(UserSettings, uid)
    if us:
        await session.delete(us)

    # Table exists in SQL but has no ORM model; safe no-op if empty.
    await session.execute(
        text("DELETE FROM workspace_members WHERE user_id = :uid"),
        {"uid": uid},
    )

    await _audit(
        session,
        actor_id=user.id,
        action="user.delete",
        target_type="profile",
        target_id=uid,
        meta={
            "email": row.email,
            "workspace_ids": workspace_ids,
            "workspace_count": len(workspace_ids),
        },
    )
    await session.commit()

    # Auth delete cascades the profile row.
    await _delete_supabase_auth_user(uid, settings)

    # If Auth already gone (404), ensure profile is removed too.
    leftover = await session.get(Profile, row.id)
    if leftover:
        await session.delete(leftover)
        await session.commit()

    return Response(status_code=204)


@router.get("/admin/prompts", response_model=list[PromptDocOut])
async def list_prompts(
    _user: AuthUser = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> list[PromptDocOut]:
    from openagents_api.company_config import seed_company_config_if_empty

    # Migration may insert empty rows; seed fills from templates when blank.
    await seed_company_config_if_empty(session)
    out: list[PromptDocOut] = []
    for key in PROMPT_KEYS:
        row = await session.get(CompanyPromptDoc, key)
        if row:
            out.append(_prompt_out(row))
        else:
            out.append(
                PromptDocOut(
                    key=key,
                    draft_content="",
                    published_content="",
                    has_unpublished_changes=False,
                )
            )
    return out


@router.get("/admin/prompts/{key}", response_model=PromptDocOut)
async def get_prompt(
    key: str,
    _user: AuthUser = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> PromptDocOut:
    if key not in PROMPT_KEYS:
        raise HTTPException(status_code=404, detail="Unknown prompt key")
    row = await session.get(CompanyPromptDoc, key)
    if not row:
        raise HTTPException(status_code=404, detail="Prompt not found")
    return _prompt_out(row)


@router.patch("/admin/prompts/{key}", response_model=PromptDocOut)
async def patch_prompt(
    key: str,
    body: PromptDraftUpdate,
    user: AuthUser = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> PromptDocOut:
    if key not in PROMPT_KEYS:
        raise HTTPException(status_code=404, detail="Unknown prompt key")
    row = await session.get(CompanyPromptDoc, key)
    if not row:
        row = CompanyPromptDoc(key=key)
        session.add(row)
    row.draft_content = body.draft_content
    row.draft_updated_at = datetime.now(timezone.utc)
    await _audit(
        session,
        actor_id=user.id,
        action="prompt.draft_save",
        target_type="company_prompt",
        target_id=key,
    )
    await session.commit()
    await session.refresh(row)
    return _prompt_out(row)


@router.post("/admin/prompts/{key}/publish", response_model=PromptDocOut)
async def publish_prompt(
    key: str,
    user: AuthUser = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> PromptDocOut:
    if key not in PROMPT_KEYS:
        raise HTTPException(status_code=404, detail="Unknown prompt key")
    row = await session.get(CompanyPromptDoc, key)
    if not row:
        raise HTTPException(status_code=404, detail="Prompt not found")
    now = datetime.now(timezone.utc)
    row.published_content = row.draft_content or ""
    row.published_at = now
    row.published_by = user.id
    await _audit(
        session,
        actor_id=user.id,
        action="prompt.publish",
        target_type="company_prompt",
        target_id=key,
    )
    await session.commit()
    await session.refresh(row)
    return _prompt_out(row)


@router.get("/admin/skills", response_model=list[SkillOut])
async def list_skills(
    _user: AuthUser = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> list[SkillOut]:
    from openagents_api.company_config import seed_company_config_if_empty

    await seed_company_config_if_empty(session)
    result = await session.execute(select(CompanySkill).order_by(CompanySkill.slug))
    return [_skill_out(r) for r in result.scalars()]


@router.patch("/admin/skills/{slug}", response_model=SkillOut)
async def patch_skill(
    slug: str,
    body: SkillUpdate,
    user: AuthUser = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> SkillOut:
    row = await session.get(CompanySkill, slug)
    if not row:
        raise HTTPException(status_code=404, detail="Skill not found")
    if body.draft_content is not None:
        row.draft_content = body.draft_content
        row.draft_updated_at = datetime.now(timezone.utc)
    if body.enabled is not None:
        row.enabled = body.enabled
    if body.title is not None:
        row.title = body.title.strip() or row.title
    await _audit(
        session,
        actor_id=user.id,
        action="skill.update",
        target_type="company_skill",
        target_id=slug,
        meta=body.model_dump(exclude_none=True),
    )
    await session.commit()
    await session.refresh(row)
    return _skill_out(row)


@router.post("/admin/skills/{slug}/publish", response_model=SkillOut)
async def publish_skill(
    slug: str,
    user: AuthUser = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> SkillOut:
    row = await session.get(CompanySkill, slug)
    if not row:
        raise HTTPException(status_code=404, detail="Skill not found")
    now = datetime.now(timezone.utc)
    row.published_content = row.draft_content or ""
    row.published_at = now
    row.published_by = user.id
    await _audit(
        session,
        actor_id=user.id,
        action="skill.publish",
        target_type="company_skill",
        target_id=slug,
    )
    await session.commit()
    await session.refresh(row)
    return _skill_out(row)


@router.get("/admin/audit", response_model=list[AuditOut])
async def list_audit(
    limit: int = Query(default=50, ge=1, le=200),
    _user: AuthUser = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> list[AuditOut]:
    result = await session.execute(
        select(AdminAuditLog).order_by(AdminAuditLog.created_at.desc()).limit(limit)
    )
    return [
        AuditOut(
            id=str(r.id),
            actor_id=r.actor_id,
            action=r.action,
            target_type=r.target_type,
            target_id=r.target_id,
            meta=r.meta,
            created_at=r.created_at,
        )
        for r in result.scalars()
    ]

