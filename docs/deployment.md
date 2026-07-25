# Deployment

OpenAgents is designed to self-host. Local Compose is the primary path; any VPS that can run Docker works the same way.

## Docker Compose (recommended)

From the repo root:

```bash
cp .env.example .env
# Required for chat:
# OPENROUTER_API_KEY=sk-or-...

docker compose up --build -d
```

Services:

| Service | Port | Notes |
|---------|------|--------|
| `api` | `8000` | SQLite volume `api-data`, open auth by default |
| `web` | `3000` | Next.js; `NEXT_PUBLIC_API_URL` baked at build |

Stop with `docker compose down`. Data persists in named volumes (`api-data`, `api-uploads`). With the default Compose `DATABASE_URL`, threads and chats are in SQLite at `./data/openagents.db` on the `api-data` volume.

### Production-ish Compose checklist

1. Set a strong `OPENROUTER_API_KEY`.
2. Point `NEXT_PUBLIC_API_URL` at your public API URL before building web.
3. Set `API_CORS_ORIGINS` to your public web origin.
4. For multi-user auth: `AUTH_MODE=supabase` plus Supabase auth env vars (see [configuration.md](configuration.md#auth--supabase-optional)).
5. Prefer Postgres over SQLite for durable multi-user installs — set `DATABASE_URL=postgresql+asyncpg://…` (e.g. Supabase Postgres) and apply [`supabase/migrations/`](../supabase/migrations/). Auth and the app DB are independent; linking Supabase auth alone does **not** move SQLite chats. Details: [configuration.md](configuration.md#app-data-on-supabase-postgres).
6. Set `AGENT_SANDBOX=docker` only if the API container/host can reach a Docker daemon and you’ve built the sandbox image (see [sandbox.md](sandbox.md)).
7. Put TLS termination (Caddy, nginx, Traefik, or your host’s reverse proxy) in front of `:3000` / `:8000`.

## Generic VPS

1. Install Docker Engine + Compose plugin.
2. Clone the repo (or pull prebuilt images if you publish to a registry).
3. Copy `.env.example` → `.env` and fill secrets.
4. `docker compose up --build -d` (or `docker compose pull && docker compose up -d` if using registry images).
5. Open firewall ports for the reverse proxy only (not raw DB ports).

### Prebuilt images (optional)

The GitHub Actions workflow [`.github/workflows/docker-publish.yml`](../.github/workflows/docker-publish.yml) can push:

- `ghcr.io/<github-owner>/openagents-api`
- `ghcr.io/<github-owner>/openagents-web`

Point a compose file at those tags instead of `build:` if you prefer pull-only deploys. Web image build args need `NEXT_PUBLIC_API_URL` (and Supabase public vars if you use Supabase auth).

## Without Docker

Run API and web as long-lived processes (systemd, process manager, etc.):

```bash
# API
cd apps/api && uv sync && uv run uvicorn openagents_api.main:app --host 0.0.0.0 --port 8000

# Web
cd apps/web && pnpm install && pnpm build && pnpm start
```

Use a process supervisor and reverse proxy; keep `DATABASE_URL` and secrets in the environment.

## Health

API exposes FastAPI’s default OpenAPI at `/docs` when running. Confirm:

```bash
curl -sS http://localhost:8000/docs >/dev/null && echo ok
```

## Related

- [configuration.md](configuration.md) — full env reference
- [sandbox.md](sandbox.md) — Docker sandbox image on the host
- [admin-panel.md](admin-panel.md) — post-deploy admin toggles
