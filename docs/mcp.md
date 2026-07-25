# MCP servers

MCP (Model Context Protocol) servers expose **tools** the deep agent can call at runtime. They are **not** skills:

| | Skills | MCP |
|--|--------|-----|
| What | Markdown playbooks / instructions | Remote tool endpoints |
| UI | Sidebar **Skills** | Sidebar **MCP** |
| Attach | Predefined skills (prompt) + on-demand `/` | Per-agent checkboxes (`mcp_server_ids`) |

## In the product

1. Open **MCP** in the left sidebar (its own page, separate from Skills).
2. **New** → add a server via:
   - **Fields** — name, URL, auth mode, token
   - **Paste JSON** — single object, array, or Claude Desktop `{ "mcpServers": { … } }` (HTTP URLs only; `command`/stdio entries are rejected)
   - **Set up with AI** — describe the server; the wizard proposes config, tests, and can look up docs on errors
3. **Test** runs connect + `list_tools`. **Save** is allowed only after a successful test.
4. In an agent’s editor, select which library servers that agent may use.

**Auto Agent** (built-in slug `agent`) always attaches **every** library MCP server. Other agents (built-in specialists and user agents) only get the servers you select.

OpenRouter ships as a **prebuilt** library entry (`https://mcp.openrouter.ai/mcp`). Auth defaults to the user’s **Settings → OpenRouter API key**; you can override with a dedicated token. Prebuilt is auto-attached on Auto Agent; for other agents, check it explicitly.

### Image generation (OpenRouter MCP)

Agents can **generate images through MCP** when the OpenRouter server is attached (or another MCP server that exposes image tools). Typical tools include `generate_image` / related OpenRouter MCP calls.

- Results stream into the AG-UI chat; inline images are promoted to **durable workspace assets** so they persist and show in the media gallery.
- Generation cost is tracked with other tool spend for the run (see cost tracking in the sidebar).
- Requires a valid OpenRouter API key (Settings or server env) and the MCP tool group enabled for that agent.

## Platform vs user MCP

- **Platform** — process env `MCP_SERVERS_JSON` or default Firecrawl when `FIRECRAWL_API_KEY` is set (see [configuration.md](configuration.md)).
- **User library** — rows in `user_mcp_servers`, managed in the UI.
- On a run with `tool_groups.mcp` (or legacy `firecrawl`) enabled, platform configs **merge** with the agent’s selected user servers.

## Transports (v1)

Only **HTTP/SSE** remote servers (`https://…` URLs). Local stdio/`command` MCP is out of scope.

## Auth

| `auth_mode` | Behavior |
|-------------|----------|
| `token` | Bearer token stored encrypted (`auth_token_enc`); never returned in full by the API |
| `openrouter_settings` | Use the user’s Settings OpenRouter key at runtime |
| `none` | No Authorization header |

Encryption uses Fernet with `MCP_SECRETS_KEY`, or a key derived from `SUPABASE_JWT_SECRET` when unset.

## API

| Method | Path | Notes |
|--------|------|--------|
| `GET` | `/api/mcp-servers` | List library (ensures OpenRouter prebuilt) |
| `GET` | `/api/mcp-servers/{id}` | Detail (no raw secrets) |
| `POST` | `/api/mcp-servers/parse` | Normalize form/JSON → drafts |
| `POST` | `/api/mcp-servers/test` | Probe connect + list tools |
| `POST` | `/api/mcp-servers` | Create (re-probes server-side) |
| `PATCH` | `/api/mcp-servers/{id}` | Update (re-probe when url/auth change) |
| `DELETE` | `/api/mcp-servers/{id}` | Delete (OpenRouter prebuilt cannot be deleted) |
| `POST` | `/api/mcp-servers/setup-chat` | AI wizard turn |

Agent create/update accepts `mcp_server_ids: string[]` (UUIDs of owned library servers).

## Runtime wiring

[`deep_agent_builder.py`](../apps/api/src/openagents_api/deep_agent_builder.py) builds MCP toolsets when the MCP tool group is on:

1. Resolve platform configs (`resolve_mcp_server_configs`)
2. Resolve user rows — Auto Agent uses `resolve_all_user_mcp_configs`; other agents use selected ids via `resolve_user_mcp_configs`
3. Merge (`merge_mcp_server_configs`) → `create_mcp_toolsets`

## Related

- [skills.md](skills.md) — playbooks (not tools)
- [configuration.md](configuration.md) — env vars for platform MCP
- [agents.md](agents.md) — agent wizard and tool groups
