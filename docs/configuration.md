# Configuration

Environment variables for the OpenAgents API (and Compose). Copy [`.env.example`](../.env.example) or [`apps/api/.env.example`](../apps/api/.env.example) to `.env`.

Most keys are optional for local open-auth + SQLite.

## Core

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENROUTER_API_KEY` | _(empty)_ | Required to chat with OpenRouter models |
| `AUTH_MODE` | `none` | `none` = open/single-user (`X-User-Id`, default `dev-user`); `supabase` = Bearer JWT |
| `AUTH_BYPASS` | `true` | Deprecated alias: `true` → `none`, `false` → `supabase` (ignored when `AUTH_MODE` is set) |
| `DATABASE_URL` | `sqlite+aiosqlite:///./openagents.db` | Async SQLAlchemy URL |
| `DATABASE_URL_LOCAL` | _(empty)_ | Optional Postgres override when `APP_ENV=local` |
| `DATABASE_URL_PRODUCTION` | _(empty)_ | Optional Postgres override in production / Coolify-detected env |
| `APP_ENV` | `local` | `local` or `production` / `prod` / `coolify` |
| `API_CORS_ORIGINS` | `http://localhost:3000` | Comma-separated origins |
| `DEFAULT_MODEL` | `openrouter:z-ai/glm-5.2` (code) / often overridden in `.env` | Default pydantic-ai model id |
| `DEEP_AGENT_ENABLED` | `true` | Kill switch for the deep agent endpoint |
| `WORKSPACE_TMP_ROOT` | `/tmp/openagents-workspaces` | Materialized workspace + user-agent cache |
| `TEMPLATES_DIR` | _(auto)_ | Company template seed directory |
| `AGENTS_DIR` | _(empty)_ | Override built-in agents root (default: repo `agents/`) |
| `SKILLS_DIR` | _(empty)_ | Override built-in library skills root (default: repo `skills/`). User skills live in DB (`user_skills`); see [skills.md](skills.md). |
| `LITEPARSE_OCR_LANGUAGE` | `en` | OCR language for document parse tools |
| `NEXT_PUBLIC_API_URL` | `http://localhost:8000` | Web → API base URL (build-time for Next.js) |

## Agent sandbox

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_SANDBOX` | `local` | `local` (host backend) or `docker` (isolated image) |
| `AGENT_EXECUTE` | `true` | Offer shell/execute when a sandbox is available |
| `AGENT_SANDBOX_IMAGE` | `openagents-agent-sandbox:latest` | Docker image tag |
| `AGENT_SANDBOX_MAX_CONCURRENT` | `1` | Max concurrent Docker sandboxes |

Admins can override sandbox settings live under **Admin → Tools → Agent sandbox** (stored in `system_settings.agent_runtime`). See [sandbox.md](sandbox.md).

## MCP

| Variable | Default | Description |
|----------|---------|-------------|
| `FIRECRAWL_API_KEY` | _(empty)_ | Used when `MCP_SERVERS_JSON` is unset (default Firecrawl MCP entry) |
| `MCP_SERVERS_JSON` | _(empty)_ | JSON array of **platform** MCP server configs; when set, replaces the Firecrawl-only default |
| `MCP_SECRETS_KEY` | _(empty)_ | Fernet key or passphrase for encrypting user MCP tokens; derived from `SUPABASE_JWT_SECRET` when empty |

Platform MCP (env / Firecrawl) merges with per-user library servers selected on an agent. Users manage their library under the sidebar **MCP** page (see [mcp.md](mcp.md)). The OpenRouter prebuilt MCP entry also enables **image generation** tools when attached (see [mcp.md](mcp.md#image-generation-openrouter-mcp)).

Example platform JSON:

```json
[
  {
    "name": "firecrawl",
    "url": "https://mcp.firecrawl.dev/v2/mcp",
    "auth_env": "FIRECRAWL_API_KEY",
    "allowlist": ["firecrawl_search", "firecrawl_scrape", "firecrawl_crawl"]
  }
]
```

## Auth & database (Supabase)

OpenAgents can run entirely locally (open auth + SQLite), or use [Supabase](https://supabase.com/) for production-ready **authentication** and/or **Postgres** storage.

| Concern | What controls it | Local default | Production option |
|---------|------------------|---------------|-------------------|
| Who can sign in | `AUTH_MODE` + auth keys | `AUTH_MODE=none` (`dev-user`) | [Supabase Auth](https://supabase.com/auth) (`AUTH_MODE=supabase`) |
| Where threads/chats live | `DATABASE_URL` (or `DATABASE_URL_LOCAL` / `DATABASE_URL_PRODUCTION`) | SQLite file | [Supabase Database](https://supabase.com/database) (Postgres) |

**Auth and the app database are independent.** Enabling Supabase Auth for login does **not** move threads or messages into Supabase Postgres. Common setups:

- Local: open auth + SQLite
- Auth only: Supabase Auth + SQLite
- Full cloud: Supabase Auth + Supabase Postgres
- Postgres only: any Postgres `DATABASE_URL` without Supabase Auth

Create a project at [supabase.com](https://supabase.com/). Keys and connection strings are under **Project Settings** (see [Supabase docs](https://supabase.com/docs)).

### Where chats live (SQLite)

Threads and messages are always stored by the API via `DATABASE_URL`, never in the browser.

| How you run the API | SQLite path |
|---------------------|-------------|
| Docker Compose | `./data/openagents.db` inside the API container → Docker volume `api-data` |
| Local `uvicorn` (default) | `./openagents.db` relative to the API working directory |

### Supabase Auth (keep SQLite)

1. Set `AUTH_MODE=supabase`.
2. Fill the Supabase auth keys below (API + web `NEXT_PUBLIC_*`).
3. Leave `DATABASE_URL` on SQLite.

Users sign in with [Supabase Auth](https://supabase.com/auth); workspaces, threads, and messages stay in local SQLite.

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Project URL from [Supabase](https://supabase.com/) |
| `SUPABASE_ANON_KEY` | Anon (public) key |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (admin user delete, etc.) |
| `SUPABASE_JWT_SECRET` | JWT secret for Bearer verification |
| `NEXT_PUBLIC_SUPABASE_URL` | Web client project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Web client anon key |

### App data on Supabase Postgres

Use this for durable multi-user storage (recommended with Supabase Auth in production).

1. In the [Supabase Dashboard](https://supabase.com/dashboard): **Project Settings → Database** → copy the Postgres connection string ([Database docs](https://supabase.com/docs/guides/database/overview)).
2. Convert it for the async driver, for example:  
   `postgresql+asyncpg://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`  
   (or the direct host; use `asyncpg`, not the default sync `postgresql://` URL).
3. Set `DATABASE_URL` (or `DATABASE_URL_LOCAL` / `DATABASE_URL_PRODUCTION` per `APP_ENV`).
4. Apply schema from [`supabase/migrations/`](../supabase/migrations/) (Supabase CLI or SQL editor). On a fresh empty database the API also runs `create_all` at startup; the SQL migrations remain the source of truth for Postgres installs.
5. Restart the API.

**Existing SQLite data is not migrated automatically.** Switching `DATABASE_URL` starts a new empty (or migration-applied) database. Export or import manually if you need to keep local chats.

## Signup queue (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `FEATURE_SIGNUP_QUEUE` | `false` | When `true`, honor Admin signup mode (approve vs auto) |
| `RESEND_API_KEY` | _(empty)_ | Transactional email for approve/reject |
| `RESEND_FROM_EMAIL` | _(empty)_ | From header, e.g. `OpenAgents <noreply@example.com>` |

## Spend budget

| Variable | Default | Description |
|----------|---------|-------------|
| `DEFAULT_SPEND_BUDGET_USD` | `5.0` | Per-user lifetime spend cap (soft budget until billing is added) |

Admins can override per-user budgets in the admin panel.

## Observability (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `LOGFIRE_TOKEN` / `LOGFIRE_ENABLED` | off | Pydantic Logfire |
| `LANGFUSE_ENABLED` | `false` | Export OTEL spans to Langfuse |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | | Langfuse credentials |
| `LANGFUSE_BASE_URL` | | Langfuse host |
| `LANGFUSE_OTEL_ENDPOINT` | | Optional OTLP base override |

## S3 uploads (optional)

Omit all `OPENAGENTS_S3_*` keys to store uploads on local disk under the workspace tmp root.

| Variable | Description |
|----------|-------------|
| `OPENAGENTS_S3_ENDPOINT` | S3-compatible endpoint |
| `OPENAGENTS_S3_REGION` | Region (e.g. `garage`) |
| `OPENAGENTS_S3_BUCKET` | Bucket name |
| `OPENAGENTS_S3_ACCESS_KEY_ID` / `OPENAGENTS_S3_SECRET_ACCESS_KEY` | Credentials |
| `OPENAGENTS_S3_FORCE_PATH_STYLE` | Default `true` |
| `OPENAGENTS_S3_SSE_C_KEY_BASE64` | Optional AES-256 SSE-C key |
