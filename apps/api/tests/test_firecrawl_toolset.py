"""Firecrawl MCP toolset allowlist — hide parse and other extras."""

from __future__ import annotations

from pydantic_ai.tools import ToolDefinition
from pydantic_ai.toolsets import FilteredToolset

from openagents_api.firecrawl import ALLOWED_FIRECRAWL_TOOLS, create_firecrawl_toolset


def test_create_firecrawl_toolset_returns_none_without_key() -> None:
    assert create_firecrawl_toolset(None) is None
    assert create_firecrawl_toolset("") is None
    assert create_firecrawl_toolset("   ") is None


def test_create_firecrawl_toolset_filters_to_allowlist() -> None:
    from openagents_api.durable_media_toolset import DurableMediaToolset

    toolset = create_firecrawl_toolset("fc-test-key")
    assert isinstance(toolset, DurableMediaToolset)
    filtered = toolset.wrapped
    assert isinstance(filtered, FilteredToolset)

    for name in ALLOWED_FIRECRAWL_TOOLS:
        assert filtered.filter_func(None, ToolDefinition(name=name)) is True

    assert filtered.filter_func(None, ToolDefinition(name="firecrawl_parse")) is False
    assert filtered.filter_func(None, ToolDefinition(name="firecrawl_map")) is False
    assert filtered.filter_func(None, ToolDefinition(name="parse_document")) is False


def test_allowed_firecrawl_tools_match_documented_set() -> None:
    assert ALLOWED_FIRECRAWL_TOOLS == frozenset({
        "firecrawl_search",
        "firecrawl_scrape",
        "firecrawl_crawl",
    })
