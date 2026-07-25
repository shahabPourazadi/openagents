"""AI-assisted MCP setup turns (wizard chat).

Uses the same parse/probe/save library as the manual wizard. On probe failures,
optionally looks up docs on the web (Firecrawl/platform MCP when available).
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import urlparse

from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from openagents_api.config import Settings
from openagents_api.mcp_library import (
    McpLibraryError,
    create_user_mcp_server,
    mcp_server_to_out,
    resolve_openrouter_api_key,
)
from openagents_api.mcp_probe import McpProbeError, probe_mcp_server
from openagents_api.mcp_user_config import McpServerDraft, slugify_mcp_name

LookupWebFn = Callable[[str], Awaitable[str]]

_URL_RE = re.compile(r"https?://[^\s\"'<>]+", re.I)
_TOKEN_RE = re.compile(
    r"(?:token|api[_-]?key|bearer)\s*[=:]\s*['\"]?([^\s'\"]+)",
    re.I,
)


class McpSetupResult(BaseModel):
    reply: str
    draft: McpServerDraft | None = None
    saved: dict[str, Any] | None = None
    tool_names: list[str] = Field(default_factory=list)
    error: str | None = None


def _extract_draft(message: str) -> McpServerDraft | None:
    text = (message or "").strip()
    if not text:
        return None
    urls = _URL_RE.findall(text)
    if not urls:
        return None
    url = urls[0].rstrip(").,;]")
    token_m = _TOKEN_RE.search(text)
    token = token_m.group(1) if token_m else None
    if re.search(r"\bno\s+auth\b|\bwithout\s+auth\b|\bno\s+token\b", text, re.I):
        token = None
        auth_none = True
    else:
        auth_none = False

    host = urlparse(url).hostname or "mcp-server"
    name_m = re.search(
        r"(?:add|connect|setup|configure)\s+([A-Za-z0-9][\w .-]{1,40}?)\s+(?:at|mcp|server)",
        text,
        re.I,
    )
    if name_m:
        name = name_m.group(1).strip()
    else:
        name = host.split(".")[0].replace("-", " ").title() or "MCP Server"

    return McpServerDraft(
        name=name,
        slug=slugify_mcp_name(name),
        url=url,
        token=None if auth_none else token,
        headers={},
        allowlist=None,
    )


async def _default_lookup_web(query: str) -> str:
    """Best-effort web lookup via Firecrawl MCP when configured; else empty."""
    try:
        from openagents_api.mcp_toolsets import create_mcp_toolsets, resolve_mcp_server_configs
        from openagents_api.config import get_settings

        settings = get_settings()
        configs = resolve_mcp_server_configs(
            mcp_servers_json=settings.mcp_servers_json or None,
            firecrawl_api_key=settings.firecrawl_api_key,
        )
        toolsets = create_mcp_toolsets(configs=configs)
        if not toolsets:
            return ""
        # Prefer a search-like tool if present.
        tools = await toolsets[0].list_tools()
        names = {getattr(t, "name", "") for t in tools}
        tool_name = None
        for candidate in ("firecrawl_search", "search", "web_search"):
            if candidate in names:
                tool_name = candidate
                break
        if not tool_name:
            return ""
        async with toolsets[0]:
            result = await toolsets[0].call_tool(tool_name, {"query": query})
        return str(result)[:2000]
    except Exception:  # noqa: BLE001
        return ""


async def run_mcp_setup_turn(
    session: AsyncSession,
    settings: Settings,
    owner_id: str,
    *,
    message: str,
    history: list[dict[str, str]] | None = None,
    lookup_web: LookupWebFn | None = None,
) -> McpSetupResult:
    del history  # reserved for multi-turn LLM later
    draft = _extract_draft(message)
    if draft is None:
        return McpSetupResult(
            reply=(
                "Share the MCP server HTTPS URL (and optional token=…). "
                "Example: Add DeepWiki at https://mcp.deepwiki.com/mcp with no auth"
            ),
            error="missing_url",
        )

    auth_mode = "none" if draft.token is None and "no auth" in message.lower() else (
        "token" if draft.token else "none"
    )
    # If user mentioned openrouter settings key, prefer that mode.
    if re.search(r"openrouter\s+settings|my\s+openrouter\s+key", message, re.I):
        auth_mode = "openrouter_settings"

    probe_draft = draft
    or_key = await resolve_openrouter_api_key(session, settings, owner_id)
    if auth_mode == "openrouter_settings":
        if not or_key:
            return McpSetupResult(
                reply="OpenRouter API key is not set in Settings. Add one, or paste a token=…",
                draft=draft,
                error="missing_openrouter_key",
            )
        probe_draft = draft.model_copy(update={"token": or_key})

    try:
        probe = await probe_mcp_server(probe_draft)
    except McpProbeError as exc:
        web_fn = lookup_web or _default_lookup_web
        docs = ""
        try:
            docs = await web_fn(f"MCP server {draft.url} authentication error {exc}")
        except Exception:  # noqa: BLE001
            docs = ""
        hint = f"\n\nWeb lookup:\n{docs[:800]}" if docs else ""
        return McpSetupResult(
            reply=f"Could not connect to {draft.url}: {exc}.{hint}",
            draft=draft,
            error=str(exc),
        )

    try:
        row = await create_user_mcp_server(
            session,
            settings,
            owner_id,
            name=draft.name,
            url=draft.url,
            token=draft.token if auth_mode == "token" else None,
            headers=draft.headers,
            allowlist=draft.allowlist,
            slug=draft.slug,
            auth_mode=auth_mode,
            openrouter_api_key=or_key,
        )
    except McpLibraryError as exc:
        return McpSetupResult(
            reply=f"Connected (tools: {', '.join(probe.tool_names)}) but save failed: {exc}",
            draft=draft,
            tool_names=list(probe.tool_names),
            error=str(exc),
        )

    tools = ", ".join(probe.tool_names[:12]) or "none listed"
    return McpSetupResult(
        reply=(
            f"Connected and saved **{row.name}**. Tools: {tools}. "
            "Attach it to an agent under Agents → MCP servers."
        ),
        draft=draft,
        saved=mcp_server_to_out(row),
        tool_names=list(probe.tool_names),
    )
