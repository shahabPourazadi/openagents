"""Parse and normalize user-supplied MCP server configs (form + JSON paste)."""

from __future__ import annotations

import json
import re
from typing import Any

from pydantic import BaseModel, Field


class McpConfigParseError(ValueError):
    """User MCP input could not be normalized to an HTTP/SSE server draft."""


class McpServerDraft(BaseModel):
    name: str
    slug: str
    url: str
    token: str | None = None
    headers: dict[str, str] = Field(default_factory=dict)
    allowlist: list[str] | None = None


_SLUG_RE = re.compile(r"[^a-z0-9]+")


def slugify_mcp_name(name: str) -> str:
    slug = _SLUG_RE.sub("-", (name or "").strip().lower()).strip("-")
    return slug or "mcp-server"


def parse_mcp_user_input(raw: Any) -> list[McpServerDraft]:
    """Normalize form fields, JSON string, or object into HTTP MCP drafts.

    Accepts:
    - form-like dict: ``{name, url, token?, headers?, allowlist?}``
    - single server object (same shape, or Claude remote ``{url}``)
    - JSON array of server objects
    - Claude Desktop map: ``{ "mcpServers": { name: { url | command } } }``
      (stdio ``command`` entries are skipped; error if none remain)
    """
    data = _coerce_data(raw)
    if isinstance(data, list):
        drafts = [_draft_from_entry(item, default_name=None) for item in data]
        return _require_drafts(drafts)
    if not isinstance(data, dict):
        raise McpConfigParseError("MCP config must be an object or array")

    if "mcpServers" in data:
        servers = data["mcpServers"]
        if not isinstance(servers, dict):
            raise McpConfigParseError("mcpServers must be an object")
        drafts: list[McpServerDraft] = []
        for name, entry in servers.items():
            if not isinstance(entry, dict):
                continue
            if entry.get("command") and not entry.get("url"):
                continue
            drafts.append(_draft_from_entry(entry, default_name=str(name)))
        return _require_drafts(drafts, empty_msg="No HTTP MCP servers found (stdio/command entries are not supported)")

    if data.get("command") and not data.get("url"):
        raise McpConfigParseError("Only HTTP/SSE MCP servers are supported (url required; stdio/command rejected)")

    if data.get("url") or data.get("name"):
        return _require_drafts([_draft_from_entry(data, default_name=None)])

    raise McpConfigParseError("MCP config is empty or unrecognized")


def _coerce_data(raw: Any) -> Any:
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            raise McpConfigParseError("MCP config is empty")
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise McpConfigParseError(f"Invalid JSON: {exc}") from exc
    return raw


def _require_drafts(
    drafts: list[McpServerDraft],
    *,
    empty_msg: str = "MCP config is empty or unrecognized",
) -> list[McpServerDraft]:
    out = [d for d in drafts if d is not None]
    if not out:
        raise McpConfigParseError(empty_msg)
    return out


def _draft_from_entry(entry: dict[str, Any], *, default_name: str | None) -> McpServerDraft:
    if entry.get("command") and not entry.get("url"):
        raise McpConfigParseError("Only HTTP/SSE MCP servers are supported (url required; stdio/command rejected)")

    url = str(entry.get("url") or "").strip()
    if not url:
        raise McpConfigParseError("MCP server url is required")
    if not (url.startswith("http://") or url.startswith("https://")):
        raise McpConfigParseError("MCP server url must be HTTP or HTTPS")

    name = str(entry.get("name") or default_name or "").strip() or "MCP Server"
    slug = str(entry.get("slug") or "").strip() or slugify_mcp_name(name)

    headers = entry.get("headers") or {}
    if not isinstance(headers, dict):
        raise McpConfigParseError("headers must be an object")
    clean_headers = {str(k): str(v) for k, v in headers.items()}

    token = entry.get("token") or entry.get("auth_token") or entry.get("api_key")
    if token is not None:
        token = str(token).strip() or None
    # Authorization Bearer in headers → treat as token, strip from headers for storage.
    auth_header = clean_headers.pop("Authorization", None) or clean_headers.pop("authorization", None)
    if auth_header and not token:
        m = re.match(r"(?i)bearer\s+(.+)", auth_header.strip())
        token = (m.group(1).strip() if m else auth_header.strip()) or None

    allowlist = entry.get("allowlist")
    if allowlist is not None:
        if not isinstance(allowlist, list) or not all(isinstance(x, str) for x in allowlist):
            raise McpConfigParseError("allowlist must be a list of strings")

    return McpServerDraft(
        name=name,
        slug=slug,
        url=url,
        token=token,
        headers=clean_headers,
        allowlist=allowlist,
    )
