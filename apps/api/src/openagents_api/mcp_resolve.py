"""Merge platform (env/Firecrawl) MCP configs with per-user library selections."""

from __future__ import annotations

from openagents_api.mcp_toolsets import McpServerConfig


def merge_mcp_server_configs(
    platform: list[McpServerConfig],
    user: list[McpServerConfig],
) -> list[McpServerConfig]:
    """Additive merge; user configs with the same name override platform entries."""
    by_name: dict[str, McpServerConfig] = {c.name: c for c in platform}
    for cfg in user:
        by_name[cfg.name] = cfg
    # Preserve platform order, then append new user-only names.
    platform_names = [c.name for c in platform]
    out: list[McpServerConfig] = []
    seen: set[str] = set()
    for name in platform_names:
        out.append(by_name[name])
        seen.add(name)
    for cfg in user:
        if cfg.name not in seen:
            out.append(cfg)
            seen.add(cfg.name)
    return out
