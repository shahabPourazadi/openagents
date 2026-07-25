"""Backward-compatible Firecrawl helpers — prefer ``mcp_toolsets``."""

from openagents_api.mcp_toolsets import (
    ALLOWED_FIRECRAWL_TOOLS,
    FIRECRAWL_MCP_URL,
    create_firecrawl_toolset,
)

__all__ = [
    "ALLOWED_FIRECRAWL_TOOLS",
    "FIRECRAWL_MCP_URL",
    "create_firecrawl_toolset",
]
