"""User MCP config parse/normalize (form + JSON paste)."""

from __future__ import annotations

import pytest

from openagents_api.mcp_user_config import (
    McpConfigParseError,
    McpServerDraft,
    parse_mcp_user_input,
)


def test_parse_form_fields_to_draft() -> None:
    drafts = parse_mcp_user_input(
        {
            "name": "DeepWiki",
            "url": "https://mcp.deepwiki.com/mcp",
            "token": "secret-token",
            "headers": {"X-Custom": "1"},
        }
    )
    assert drafts == [
        McpServerDraft(
            name="DeepWiki",
            slug="deepwiki",
            url="https://mcp.deepwiki.com/mcp",
            token="secret-token",
            headers={"X-Custom": "1"},
            allowlist=None,
        )
    ]


def test_parse_json_array() -> None:
    drafts = parse_mcp_user_input(
        '[{"name":"docs","url":"https://example.com/mcp","token":"t1"}]'
    )
    assert len(drafts) == 1
    assert drafts[0].name == "docs"
    assert drafts[0].url == "https://example.com/mcp"
    assert drafts[0].token == "t1"


def test_parse_claude_mcp_servers_map_keeps_remote_urls() -> None:
    raw = {
        "mcpServers": {
            "openrouter": {"url": "https://mcp.openrouter.ai/mcp"},
            "local": {"command": "npx", "args": ["-y", "foo"]},
        }
    }
    drafts = parse_mcp_user_input(raw)
    assert len(drafts) == 1
    assert drafts[0].name == "openrouter"
    assert drafts[0].url == "https://mcp.openrouter.ai/mcp"


def test_parse_rejects_stdio_only_entry() -> None:
    with pytest.raises(McpConfigParseError, match="HTTP"):
        parse_mcp_user_input({"name": "local", "command": "npx", "args": ["foo"]})


def test_parse_rejects_empty() -> None:
    with pytest.raises(McpConfigParseError):
        parse_mcp_user_input({})
