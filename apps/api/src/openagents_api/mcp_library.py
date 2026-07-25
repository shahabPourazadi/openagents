"""User MCP server library — ensure prebuilts, probe-before-save, resolve for runs."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from openagents_api.config import Settings
from openagents_api.mcp_probe import McpProbeError, probe_mcp_server
from openagents_api.mcp_secrets import decrypt_secret, encrypt_secret
from openagents_api.mcp_toolsets import McpServerConfig
from openagents_api.mcp_user_config import McpServerDraft, parse_mcp_user_input, slugify_mcp_name
from openagents_api.models import UserMcpServer, UserSettings

OPENROUTER_MCP_SLUG = "openrouter"
OPENROUTER_MCP_URL = "https://mcp.openrouter.ai/mcp"
OPENROUTER_MCP_NAME = "OpenRouter"


class McpLibraryError(ValueError):
    pass


def mcp_server_to_out(row: UserMcpServer) -> dict[str, Any]:
    tools = row.last_tools_json if isinstance(row.last_tools_json, list) else []
    return {
        "id": str(row.id),
        "slug": row.slug,
        "name": row.name,
        "url": row.url,
        "headers": dict(row.headers_json or {}),
        "auth_mode": row.auth_mode,
        "allowlist": list(row.allowlist) if isinstance(row.allowlist, list) else None,
        "is_prebuilt": bool(row.is_prebuilt),
        "has_token": bool((row.auth_token_enc or "").strip()),
        "tool_names": [str(t) for t in tools],
        "last_tested_at": row.last_tested_at.isoformat() if row.last_tested_at else None,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


async def ensure_openrouter_prebuilt(
    session: AsyncSession, owner_id: str
) -> UserMcpServer:
    result = await session.execute(
        select(UserMcpServer).where(
            UserMcpServer.owner_id == owner_id,
            UserMcpServer.slug == OPENROUTER_MCP_SLUG,
        )
    )
    row = result.scalar_one_or_none()
    if row is not None:
        return row
    row = UserMcpServer(
        owner_id=owner_id,
        slug=OPENROUTER_MCP_SLUG,
        name=OPENROUTER_MCP_NAME,
        url=OPENROUTER_MCP_URL,
        headers_json={},
        auth_token_enc=None,
        auth_mode="openrouter_settings",
        allowlist=None,
        is_prebuilt=True,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def list_user_mcp_servers(
    session: AsyncSession, owner_id: str
) -> list[UserMcpServer]:
    await ensure_openrouter_prebuilt(session, owner_id)
    result = await session.execute(
        select(UserMcpServer)
        .where(UserMcpServer.owner_id == owner_id)
        .order_by(UserMcpServer.is_prebuilt.desc(), UserMcpServer.name.asc())
    )
    return list(result.scalars().all())


async def get_user_mcp_server(
    session: AsyncSession, owner_id: str, server_id: uuid.UUID
) -> UserMcpServer:
    result = await session.execute(
        select(UserMcpServer).where(
            UserMcpServer.owner_id == owner_id,
            UserMcpServer.id == server_id,
        )
    )
    row = result.scalar_one_or_none()
    if row is None:
        raise McpLibraryError("MCP server not found")
    return row


async def _unique_slug(session: AsyncSession, owner_id: str, base: str) -> str:
    slug = slugify_mcp_name(base)
    candidate = slug
    n = 2
    while True:
        existing = await session.execute(
            select(UserMcpServer).where(
                UserMcpServer.owner_id == owner_id,
                UserMcpServer.slug == candidate,
            )
        )
        if existing.scalar_one_or_none() is None:
            return candidate
        candidate = f"{slug}-{n}"
        n += 1


def draft_from_create_body(
    *,
    name: str,
    url: str,
    token: str | None = None,
    headers: dict[str, str] | None = None,
    allowlist: list[str] | None = None,
    slug: str | None = None,
    auth_mode: str | None = None,
) -> McpServerDraft:
    mode = (auth_mode or "token").strip() or "token"
    draft_token = token if mode == "token" else None
    return McpServerDraft(
        name=name.strip() or "MCP Server",
        slug=slugify_mcp_name(slug or name),
        url=url.strip(),
        token=draft_token,
        headers=dict(headers or {}),
        allowlist=allowlist,
    )


async def create_user_mcp_server(
    session: AsyncSession,
    settings: Settings,
    owner_id: str,
    *,
    name: str,
    url: str,
    token: str | None = None,
    headers: dict[str, str] | None = None,
    allowlist: list[str] | None = None,
    slug: str | None = None,
    auth_mode: str = "token",
    openrouter_api_key: str | None = None,
) -> UserMcpServer:
    mode = normalize_mcp_auth_mode(auth_mode, token)
    if mode not in {"token", "openrouter_settings", "none"}:
        raise McpLibraryError("Invalid auth_mode")

    draft = draft_from_create_body(
        name=name,
        url=url,
        token=token if mode == "token" else None,
        headers=headers,
        allowlist=allowlist,
        slug=slug,
        auth_mode=mode,
    )
    # For probe: resolve openrouter settings key into draft token.
    probe_draft = draft
    if mode == "openrouter_settings":
        key = (openrouter_api_key or "").strip()
        if not key:
            raise McpLibraryError("OpenRouter API key is not set in Settings")
        probe_draft = draft.model_copy(update={"token": key})
    elif mode == "none":
        probe_draft = draft.model_copy(update={"token": None})

    try:
        probe = await probe_mcp_server(probe_draft)
    except McpProbeError as exc:
        raise McpLibraryError(str(exc)) from exc

    unique_slug = await _unique_slug(session, owner_id, draft.slug)
    enc = encrypt_secret(token if mode == "token" else None, settings)
    row = UserMcpServer(
        owner_id=owner_id,
        slug=unique_slug,
        name=draft.name,
        url=draft.url,
        headers_json=dict(draft.headers or {}),
        auth_token_enc=enc,
        auth_mode=mode,
        allowlist=list(draft.allowlist) if draft.allowlist else None,
        is_prebuilt=False,
        last_tested_at=datetime.now(timezone.utc),
        last_tools_json=list(probe.tool_names),
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def update_user_mcp_server(
    session: AsyncSession,
    settings: Settings,
    owner_id: str,
    server_id: uuid.UUID,
    *,
    name: str | None = None,
    url: str | None = None,
    token: str | None = None,
    headers: dict[str, str] | None = None,
    allowlist: list[str] | None = None,
    auth_mode: str | None = None,
    openrouter_api_key: str | None = None,
    clear_token: bool = False,
) -> UserMcpServer:
    row = await get_user_mcp_server(session, owner_id, server_id)
    requested_mode = (auth_mode or row.auth_mode or "token").strip() or "token"
    if requested_mode not in {"token", "openrouter_settings", "none"}:
        raise McpLibraryError("Invalid auth_mode")

    new_name = name.strip() if name is not None else row.name
    new_url = url.strip() if url is not None else row.url
    new_headers = dict(headers) if headers is not None else dict(row.headers_json or {})
    new_allowlist = allowlist if allowlist is not None else (
        list(row.allowlist) if isinstance(row.allowlist, list) else None
    )

    stored_token: str | None
    if clear_token:
        stored_token = None
    elif token is not None and token.strip():
        stored_token = token.strip()
    else:
        stored_token = decrypt_secret(row.auth_token_enc, settings)

    mode = (
        normalize_mcp_auth_mode(requested_mode, stored_token)
        if requested_mode == "token"
        else requested_mode
    )

    probe_token = stored_token
    if mode == "openrouter_settings":
        probe_token = (openrouter_api_key or "").strip() or None
        if not probe_token:
            raise McpLibraryError("OpenRouter API key is not set in Settings")
    elif mode == "none":
        probe_token = None

    draft = McpServerDraft(
        name=new_name,
        slug=row.slug,
        url=new_url,
        token=probe_token,
        headers=new_headers,
        allowlist=new_allowlist,
    )
    try:
        probe = await probe_mcp_server(draft)
    except McpProbeError as exc:
        raise McpLibraryError(str(exc)) from exc

    row.name = new_name
    row.url = new_url
    row.headers_json = new_headers
    row.allowlist = new_allowlist
    row.auth_mode = mode
    if mode == "token":
        if clear_token:
            row.auth_token_enc = None
        elif token is not None and token.strip():
            row.auth_token_enc = encrypt_secret(token.strip(), settings)
    else:
        # Non-token modes don't keep a dedicated MCP token.
        row.auth_token_enc = None
    row.last_tested_at = datetime.now(timezone.utc)
    row.last_tools_json = list(probe.tool_names)
    await session.commit()
    await session.refresh(row)
    return row


async def delete_user_mcp_server(
    session: AsyncSession, owner_id: str, server_id: uuid.UUID
) -> None:
    row = await get_user_mcp_server(session, owner_id, server_id)
    if row.is_prebuilt and row.slug == OPENROUTER_MCP_SLUG:
        raise McpLibraryError("Cannot delete the OpenRouter prebuilt MCP server")
    await session.delete(row)
    await session.commit()


async def resolve_openrouter_api_key(
    session: AsyncSession, settings: Settings, owner_id: str
) -> str | None:
    result = await session.execute(
        select(UserSettings).where(UserSettings.user_id == owner_id)
    )
    row = result.scalar_one_or_none()
    if row and row.openrouter_api_key_enc:
        return row.openrouter_api_key_enc
    return (settings.openrouter_api_key or "").strip() or None


def normalize_mcp_auth_mode(auth_mode: str | None, token: str | None) -> str:
    """Coerce empty bearer token to auth_mode=none (public HTTP MCP)."""
    mode = (auth_mode or "token").strip() or "token"
    if mode == "token" and not (token or "").strip():
        return "none"
    return mode


def row_to_mcp_server_config(
    row: UserMcpServer,
    settings: Settings,
    *,
    openrouter_api_key: str | None = None,
) -> McpServerConfig | None:
    """Build a runtime McpServerConfig from a library row.

    Returns None only when openrouter_settings auth is required but missing.
    Token mode with an empty token is treated like none (public HTTP MCP) so
    probe/test success matches runtime attach.
    """
    headers = dict(row.headers_json or {})
    mode = (row.auth_mode or "token").strip() or "token"
    token: str | None = None
    if mode == "openrouter_settings":
        token = (openrouter_api_key or "").strip() or None
        if not token:
            return None
    elif mode == "token":
        token = decrypt_secret(row.auth_token_enc, settings)
    if token and "Authorization" not in headers:
        headers["Authorization"] = f"Bearer {token}"
    allowlist = list(row.allowlist) if isinstance(row.allowlist, list) else None
    return McpServerConfig(
        name=row.slug,
        url=row.url,
        headers=headers,
        allowlist=allowlist,
    )


async def resolve_user_mcp_configs(
    session: AsyncSession,
    settings: Settings,
    owner_id: str,
    mcp_server_ids: list[uuid.UUID] | list[str] | None,
) -> list[McpServerConfig]:
    if not mcp_server_ids:
        return []
    ids: list[uuid.UUID] = []
    for raw in mcp_server_ids:
        try:
            ids.append(raw if isinstance(raw, uuid.UUID) else uuid.UUID(str(raw)))
        except ValueError:
            continue
    if not ids:
        return []
    or_key = await resolve_openrouter_api_key(session, settings, owner_id)
    result = await session.execute(
        select(UserMcpServer).where(
            UserMcpServer.owner_id == owner_id,
            UserMcpServer.id.in_(ids),
        )
    )
    rows = list(result.scalars().all())
    by_id = {r.id: r for r in rows}
    out: list[McpServerConfig] = []
    for sid in ids:
        row = by_id.get(sid)
        if row is None:
            continue
        cfg = row_to_mcp_server_config(row, settings, openrouter_api_key=or_key)
        if cfg is not None:
            out.append(cfg)
    return out


async def resolve_all_user_mcp_configs(
    session: AsyncSession,
    settings: Settings,
    owner_id: str,
) -> list[McpServerConfig]:
    """Attach every MCP server in the owner's library (used by Auto Agent)."""
    rows = await list_user_mcp_servers(session, owner_id)
    return await resolve_user_mcp_configs(
        session, settings, owner_id, [row.id for row in rows]
    )


async def list_owner_mcp_server_ids(
    session: AsyncSession, owner_id: str
) -> list[uuid.UUID]:
    """Return all library MCP server ids for the owner (OpenRouter prebuilt included)."""
    rows = await list_user_mcp_servers(session, owner_id)
    return [row.id for row in rows]


def parse_user_mcp_payload(raw: Any) -> list[McpServerDraft]:
    return parse_mcp_user_input(raw)


def normalize_mcp_server_ids(raw: Any) -> list[uuid.UUID]:
    if not isinstance(raw, list):
        return []
    out: list[uuid.UUID] = []
    seen: set[uuid.UUID] = set()
    for item in raw:
        try:
            sid = item if isinstance(item, uuid.UUID) else uuid.UUID(str(item))
        except (ValueError, TypeError):
            continue
        if sid in seen:
            continue
        seen.add(sid)
        out.append(sid)
    return out
