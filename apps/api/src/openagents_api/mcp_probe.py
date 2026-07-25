"""Probe an MCP server (connect + list_tools) before saving to the library."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from pydantic import BaseModel

from openagents_api.mcp_user_config import McpServerDraft

ListToolsFn = Callable[[str, dict[str, str] | None], Awaitable[list[Any]]]


class McpProbeError(RuntimeError):
    """MCP probe failed (connection, auth, or list_tools)."""


class McpProbeResult(BaseModel):
    ok: bool
    tool_names: list[str] = []
    error: str | None = None


def headers_for_draft(draft: McpServerDraft) -> dict[str, str] | None:
    headers = dict(draft.headers or {})
    if draft.token and "Authorization" not in headers:
        headers["Authorization"] = f"Bearer {draft.token}"
    return headers or None


async def _default_list_tools(url: str, headers: dict[str, str] | None) -> list[Any]:
    from pydantic_ai.mcp import MCPToolset

    toolset = MCPToolset(url, headers=headers, id="mcp-probe")
    return await toolset.list_tools()


async def probe_mcp_server(
    draft: McpServerDraft,
    *,
    list_tools: ListToolsFn | None = None,
) -> McpProbeResult:
    """Connect to an HTTP MCP server and return discovered tool names."""
    fn = list_tools or _default_list_tools
    headers = headers_for_draft(draft)
    try:
        tools = await fn(draft.url, headers)
    except Exception as exc:  # noqa: BLE001 — surface any connector failure
        raise McpProbeError(str(exc) or exc.__class__.__name__) from exc

    names = sorted(
        {
            str(getattr(t, "name", "") or "").strip()
            for t in (tools or [])
            if str(getattr(t, "name", "") or "").strip()
        }
    )
    return McpProbeResult(ok=True, tool_names=names, error=None)
