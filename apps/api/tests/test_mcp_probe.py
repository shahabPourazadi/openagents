"""MCP connect + list_tools probe (test-before-save)."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from openagents_api.mcp_probe import McpProbeError, McpProbeResult, probe_mcp_server
from openagents_api.mcp_user_config import McpServerDraft


@pytest.mark.asyncio
async def test_probe_returns_tool_names_on_success() -> None:
    async def fake_list_tools(url: str, headers: dict[str, str] | None) -> list[SimpleNamespace]:
        assert url == "https://mcp.example.com/mcp"
        assert headers == {"Authorization": "Bearer t"}
        return [SimpleNamespace(name="ping"), SimpleNamespace(name="search")]

    result = await probe_mcp_server(
        McpServerDraft(
            name="Example",
            slug="example",
            url="https://mcp.example.com/mcp",
            token="t",
        ),
        list_tools=fake_list_tools,
    )
    assert result == McpProbeResult(ok=True, tool_names=["ping", "search"], error=None)


@pytest.mark.asyncio
async def test_probe_surfaces_connection_failure() -> None:
    async def boom(url: str, headers: dict[str, str] | None) -> list[SimpleNamespace]:
        raise RuntimeError("connection refused")

    with pytest.raises(McpProbeError, match="connection refused"):
        await probe_mcp_server(
            McpServerDraft(
                name="Broken",
                slug="broken",
                url="https://mcp.example.com/mcp",
            ),
            list_tools=boom,
        )
