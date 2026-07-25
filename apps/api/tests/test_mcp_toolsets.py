"""Configurable MCP toolsets (Firecrawl default)."""

from __future__ import annotations

from pydantic_ai.tools import ToolDefinition
from pydantic_ai.toolsets import FilteredToolset

from openagents_api.mcp_toolsets import (
    ALLOWED_FIRECRAWL_TOOLS,
    create_firecrawl_toolset,
    create_mcp_toolsets,
    parse_mcp_servers_json,
)


def test_create_firecrawl_toolset_returns_none_without_key() -> None:
    assert create_firecrawl_toolset(None) is None
    assert create_firecrawl_toolset("") is None


def test_create_firecrawl_toolset_filters_to_allowlist() -> None:
    from openagents_api.durable_media_toolset import DurableMediaToolset

    toolset = create_firecrawl_toolset("fc-test-key")
    assert isinstance(toolset, DurableMediaToolset)
    filtered = toolset.wrapped
    assert isinstance(filtered, FilteredToolset)
    for name in ALLOWED_FIRECRAWL_TOOLS:
        assert filtered.filter_func(None, ToolDefinition(name=name)) is True
    assert filtered.filter_func(None, ToolDefinition(name="firecrawl_parse")) is False


def test_parse_mcp_servers_json() -> None:
    raw = (
        '[{"name":"firecrawl","url":"https://mcp.firecrawl.dev/v2/mcp",'
        '"auth_env":"FIRECRAWL_API_KEY",'
        '"allowlist":["firecrawl_search"]}]'
    )
    configs = parse_mcp_servers_json(raw)
    assert len(configs) == 1
    assert configs[0].name == "firecrawl"
    assert configs[0].allowlist == ["firecrawl_search"]


def test_create_mcp_toolsets_empty_without_config() -> None:
    assert create_mcp_toolsets(mcp_servers_json="", firecrawl_api_key="") == []
