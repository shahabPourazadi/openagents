"""Resolve OpenRouter auth + merge platform/user MCP configs for a run."""

from __future__ import annotations

from openagents_api.config import Settings
from openagents_api.mcp_library import row_to_mcp_server_config
from openagents_api.mcp_secrets import encrypt_secret
from openagents_api.mcp_toolsets import McpServerConfig, resolve_mcp_server_configs
from openagents_api.mcp_resolve import merge_mcp_server_configs
from openagents_api.models import UserMcpServer


def test_row_uses_openrouter_settings_key() -> None:
    settings = Settings(mcp_secrets_key="test-mcp-secrets-key-32bytes-long!!")
    row = UserMcpServer(
        owner_id="u1",
        slug="openrouter",
        name="OpenRouter",
        url="https://mcp.openrouter.ai/mcp",
        headers_json={},
        auth_mode="openrouter_settings",
        auth_token_enc=None,
        is_prebuilt=True,
    )
    cfg = row_to_mcp_server_config(row, settings, openrouter_api_key="sk-or-user")
    assert cfg is not None
    assert cfg.headers["Authorization"] == "Bearer sk-or-user"


def test_row_prefers_override_token_over_settings() -> None:
    settings = Settings(mcp_secrets_key="test-mcp-secrets-key-32bytes-long!!")
    row = UserMcpServer(
        owner_id="u1",
        slug="openrouter",
        name="OpenRouter",
        url="https://mcp.openrouter.ai/mcp",
        headers_json={},
        auth_mode="token",
        auth_token_enc=encrypt_secret("sk-or-override", settings),
        is_prebuilt=True,
    )
    cfg = row_to_mcp_server_config(row, settings, openrouter_api_key="sk-or-user")
    assert cfg is not None
    assert cfg.headers["Authorization"] == "Bearer sk-or-override"


def test_row_token_mode_without_token_still_resolves() -> None:
    """Public HTTP MCP often saved as auth_mode=token with empty token."""
    settings = Settings(mcp_secrets_key="test-mcp-secrets-key-32bytes-long!!")
    row = UserMcpServer(
        owner_id="u1",
        slug="deepwiki",
        name="DeepWiki",
        url="https://mcp.deepwiki.com/mcp",
        headers_json={},
        auth_mode="token",
        auth_token_enc=None,
        is_prebuilt=False,
    )
    cfg = row_to_mcp_server_config(row, settings)
    assert cfg is not None
    assert cfg.name == "deepwiki"
    assert cfg.url == "https://mcp.deepwiki.com/mcp"
    assert "Authorization" not in (cfg.headers or {})


def test_row_openrouter_settings_without_key_returns_none() -> None:
    settings = Settings(mcp_secrets_key="test-mcp-secrets-key-32bytes-long!!")
    row = UserMcpServer(
        owner_id="u1",
        slug="openrouter",
        name="OpenRouter",
        url="https://mcp.openrouter.ai/mcp",
        headers_json={},
        auth_mode="openrouter_settings",
        auth_token_enc=None,
        is_prebuilt=True,
    )
    assert row_to_mcp_server_config(row, settings, openrouter_api_key=None) is None


def test_merge_platform_and_user_configs() -> None:
    platform = resolve_mcp_server_configs(firecrawl_api_key="fc-key")
    user = [
        McpServerConfig(
            name="docs",
            url="https://mcp.example.com/mcp",
            headers={"Authorization": "Bearer t"},
        )
    ]
    merged = merge_mcp_server_configs(platform, user)
    names = [c.name for c in merged]
    assert "firecrawl" in names
    assert "docs" in names
