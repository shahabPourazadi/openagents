"""User MCP library API (Skills pane → MCP)."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from openagents_api.auth import AuthUser, require_active_user
from openagents_api.config import Settings, get_settings
from openagents_api.db import get_session
from openagents_api.mcp_library import (
    McpLibraryError,
    create_user_mcp_server,
    delete_user_mcp_server,
    get_user_mcp_server,
    list_user_mcp_servers,
    mcp_server_to_out,
    parse_user_mcp_payload,
    resolve_openrouter_api_key,
    update_user_mcp_server,
)
from openagents_api.mcp_probe import McpProbeError, probe_mcp_server
from openagents_api.mcp_user_config import McpConfigParseError, McpServerDraft
from openagents_api.schemas import (
    McpServerCreate,
    McpServerDraftOut,
    McpServerOut,
    McpServerParseIn,
    McpServerTestIn,
    McpServerTestOut,
    McpServerUpdate,
    McpSetupChatIn,
    McpSetupChatOut,
)

router = APIRouter(prefix="/api", tags=["mcp"])


def _out(row) -> McpServerOut:
    return McpServerOut.model_validate(mcp_server_to_out(row))


@router.get("/mcp-servers", response_model=list[McpServerOut])
async def list_mcp_servers(
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> list[McpServerOut]:
    rows = await list_user_mcp_servers(session, user.id)
    return [_out(r) for r in rows]


@router.get("/mcp-servers/{server_id}", response_model=McpServerOut)
async def get_mcp_server(
    server_id: uuid.UUID,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> McpServerOut:
    try:
        row = await get_user_mcp_server(session, user.id, server_id)
    except McpLibraryError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return _out(row)


@router.post("/mcp-servers/parse")
async def parse_mcp_servers(
    body: McpServerParseIn,
    user: AuthUser = Depends(require_active_user),
) -> dict:
    del user  # auth gate only
    try:
        drafts = parse_user_mcp_payload(body.raw)
    except McpConfigParseError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "drafts": [
            McpServerDraftOut(
                name=d.name,
                slug=d.slug,
                url=d.url,
                token=d.token,
                headers=d.headers,
                allowlist=d.allowlist,
            ).model_dump()
            for d in drafts
        ]
    }


@router.post("/mcp-servers/test", response_model=McpServerTestOut)
async def test_mcp_server(
    body: McpServerTestIn,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> McpServerTestOut:
    from openagents_api.mcp_library import normalize_mcp_auth_mode

    mode = normalize_mcp_auth_mode(body.auth_mode, body.token)
    token = body.token
    if mode == "openrouter_settings":
        token = await resolve_openrouter_api_key(session, settings, user.id)
        if not token:
            return McpServerTestOut(ok=False, error="OpenRouter API key is not set in Settings")
    elif mode == "none":
        token = None
    draft = McpServerDraft(
        name=body.name,
        slug=body.slug or "mcp-server",
        url=body.url,
        token=token,
        headers=dict(body.headers or {}),
        allowlist=body.allowlist,
    )
    try:
        result = await probe_mcp_server(draft)
    except McpProbeError as exc:
        return McpServerTestOut(ok=False, error=str(exc))
    return McpServerTestOut(ok=True, tool_names=result.tool_names)


@router.post("/mcp-servers/setup-chat", response_model=McpSetupChatOut)
async def setup_mcp_chat(
    body: McpSetupChatIn,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> McpSetupChatOut:
    from openagents_api.mcp_setup import run_mcp_setup_turn

    result = await run_mcp_setup_turn(
        session,
        settings,
        user.id,
        message=body.message,
        history=body.history,
    )
    draft_out = None
    if result.draft is not None:
        draft_out = McpServerDraftOut(
            name=result.draft.name,
            slug=result.draft.slug,
            url=result.draft.url,
            token=result.draft.token,
            headers=result.draft.headers,
            allowlist=result.draft.allowlist,
        )
    saved_out = None
    if result.saved is not None:
        saved_out = McpServerOut.model_validate(result.saved)
    return McpSetupChatOut(
        reply=result.reply,
        draft=draft_out,
        saved=saved_out,
        tool_names=result.tool_names,
        error=result.error,
    )


@router.post("/mcp-servers", response_model=McpServerOut)
async def create_mcp_server(
    body: McpServerCreate,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> McpServerOut:
    or_key = await resolve_openrouter_api_key(session, settings, user.id)
    try:
        row = await create_user_mcp_server(
            session,
            settings,
            user.id,
            name=body.name,
            url=body.url,
            token=body.token,
            headers=body.headers,
            allowlist=body.allowlist,
            slug=body.slug,
            auth_mode=body.auth_mode,
            openrouter_api_key=or_key,
        )
    except McpLibraryError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _out(row)


@router.patch("/mcp-servers/{server_id}", response_model=McpServerOut)
async def patch_mcp_server(
    server_id: uuid.UUID,
    body: McpServerUpdate,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> McpServerOut:
    or_key = await resolve_openrouter_api_key(session, settings, user.id)
    try:
        row = await update_user_mcp_server(
            session,
            settings,
            user.id,
            server_id,
            name=body.name,
            url=body.url,
            token=body.token,
            headers=body.headers,
            allowlist=body.allowlist,
            auth_mode=body.auth_mode,
            openrouter_api_key=or_key,
            clear_token=body.clear_token,
        )
    except McpLibraryError as exc:
        status = 404 if "not found" in str(exc).lower() else 400
        raise HTTPException(status_code=status, detail=str(exc)) from exc
    return _out(row)


@router.delete("/mcp-servers/{server_id}")
async def remove_mcp_server(
    server_id: uuid.UUID,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> dict[str, bool]:
    try:
        await delete_user_mcp_server(session, user.id, server_id)
    except McpLibraryError as exc:
        status = 404 if "not found" in str(exc).lower() else 400
        raise HTTPException(status_code=status, detail=str(exc)) from exc
    return {"ok": True}
