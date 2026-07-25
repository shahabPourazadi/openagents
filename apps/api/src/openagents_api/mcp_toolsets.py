"""Configurable MCP toolsets for the deep agent.

Default: Firecrawl when ``FIRECRAWL_API_KEY`` is set (backward compatible).
Override with ``MCP_SERVERS_JSON``, e.g.::

    MCP_SERVERS_JSON='[{"name":"firecrawl","url":"https://mcp.firecrawl.dev/v2/mcp","auth_env":"FIRECRAWL_API_KEY","allowlist":["firecrawl_search","firecrawl_scrape","firecrawl_crawl"]}]'
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from pydantic import BaseModel, Field
from pydantic_ai.mcp import MCPToolset
from pydantic_ai.toolsets import AbstractToolset

logger = logging.getLogger(__name__)

FIRECRAWL_MCP_URL = "https://mcp.firecrawl.dev/v2/mcp"

ALLOWED_FIRECRAWL_TOOLS = frozenset({
    "firecrawl_search",
    "firecrawl_scrape",
    "firecrawl_crawl",
})


class McpServerConfig(BaseModel):
    name: str
    url: str
    auth_env: str | None = None
    headers: dict[str, str] = Field(default_factory=dict)
    allowlist: list[str] | None = None
    max_retries: int = 3


def default_mcp_servers(*, firecrawl_api_key: str | None = None) -> list[McpServerConfig]:
    """Built-in Firecrawl entry when a key is available (env or explicit)."""
    key = (firecrawl_api_key or os.environ.get("FIRECRAWL_API_KEY") or "").strip()
    if not key:
        return []
    return [
        McpServerConfig(
            name="firecrawl",
            url=FIRECRAWL_MCP_URL,
            auth_env="FIRECRAWL_API_KEY",
            headers={"Authorization": f"Bearer {key}"},
            allowlist=sorted(ALLOWED_FIRECRAWL_TOOLS),
        )
    ]


def parse_mcp_servers_json(raw: str | None) -> list[McpServerConfig]:
    text = (raw or "").strip()
    if not text:
        return []
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        logger.warning("Invalid MCP_SERVERS_JSON: %s", exc)
        return []
    if not isinstance(data, list):
        logger.warning("MCP_SERVERS_JSON must be a JSON array")
        return []
    out: list[McpServerConfig] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        try:
            out.append(McpServerConfig.model_validate(item))
        except Exception as exc:  # noqa: BLE001
            logger.warning("Skipping invalid MCP server config: %s", exc)
    return out


def resolve_mcp_server_configs(
    *,
    mcp_servers_json: str | None = None,
    firecrawl_api_key: str | None = None,
) -> list[McpServerConfig]:
    """Prefer explicit JSON config; else default Firecrawl when keyed."""
    configured = parse_mcp_servers_json(mcp_servers_json)
    if configured:
        # Fill Bearer from auth_env when headers omit Authorization.
        resolved: list[McpServerConfig] = []
        for cfg in configured:
            headers = dict(cfg.headers)
            if cfg.auth_env and "Authorization" not in headers:
                key = (os.environ.get(cfg.auth_env) or "").strip()
                if cfg.auth_env == "FIRECRAWL_API_KEY" and firecrawl_api_key:
                    key = (firecrawl_api_key or key).strip()
                if key:
                    headers["Authorization"] = f"Bearer {key}"
            resolved.append(cfg.model_copy(update={"headers": headers}))
        return resolved
    return default_mcp_servers(firecrawl_api_key=firecrawl_api_key)


def create_mcp_toolsets(
    configs: list[McpServerConfig] | None = None,
    *,
    mcp_servers_json: str | None = None,
    firecrawl_api_key: str | None = None,
) -> list[AbstractToolset[Any]]:
    """Build filtered MCP toolsets from config."""
    servers = configs if configs is not None else resolve_mcp_server_configs(
        mcp_servers_json=mcp_servers_json,
        firecrawl_api_key=firecrawl_api_key,
    )
    toolsets: list[AbstractToolset[Any]] = []
    for cfg in servers:
        if cfg.auth_env and "Authorization" not in (cfg.headers or {}):
            key = (os.environ.get(cfg.auth_env) or "").strip()
            if not key:
                logger.warning(
                    "MCP server %r skipped — %s is not set",
                    cfg.name,
                    cfg.auth_env,
                )
                continue
        headers = dict(cfg.headers or {})
        if not headers.get("Authorization") and cfg.auth_env:
            key = (os.environ.get(cfg.auth_env) or "").strip()
            if cfg.auth_env == "FIRECRAWL_API_KEY" and firecrawl_api_key:
                key = (firecrawl_api_key or key).strip()
            if key:
                headers["Authorization"] = f"Bearer {key}"
        if cfg.auth_env and not headers.get("Authorization"):
            logger.warning(
                "MCP server %r skipped — no auth for %s",
                cfg.name,
                cfg.auth_env,
            )
            continue

        toolset: AbstractToolset[Any] = MCPToolset(
            cfg.url,
            headers=headers or None,
            id=cfg.name,
            max_retries=cfg.max_retries,
        )
        if cfg.allowlist:
            allow = frozenset(cfg.allowlist)
            toolset = toolset.filtered(lambda _ctx, tool, allow=allow: tool.name in allow)
        # Persist inline images (e.g. OpenRouter generate-image) as durable Assets
        # before AG-UI stringifies BinaryContent to (corruption-prone) base64.
        from openagents_api.durable_media_toolset import DurableMediaToolset

        toolset = DurableMediaToolset(wrapped=toolset)
        toolsets.append(toolset)
    if not toolsets:
        logger.warning(
            "No MCP toolsets configured — web search/crawl tools unavailable. "
            "Set FIRECRAWL_API_KEY or MCP_SERVERS_JSON."
        )
    return toolsets


def create_firecrawl_toolset(api_key: str | None) -> AbstractToolset[Any] | None:
    """Backward-compatible Firecrawl-only helper (tests + older imports)."""
    key = (api_key or "").strip()
    if not key:
        return None
    toolsets = create_mcp_toolsets(configs=default_mcp_servers(firecrawl_api_key=key))
    return toolsets[0] if toolsets else None
