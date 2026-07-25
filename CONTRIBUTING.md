# Contributing to OpenAgents

Thanks for helping improve this open-source agent workspace. Keep changes focused and accurate to the current codebase.

## Development setup

**API**

```bash
cd apps/api
cp .env.example .env
# optional for chat: OPENROUTER_API_KEY=...
uv sync
uv run uvicorn openagents_api.main:app --reload --port 8000
```

**Web**

```bash
cd apps/web
echo "NEXT_PUBLIC_API_URL=http://localhost:8000" > .env.local
pnpm install
pnpm dev
```

Or use Compose from the repo root (`docker compose up --build`). See the root [README](README.md).

## Tests

API tests are the source of truth for CI:

```bash
cd apps/api
uv run pytest -q
```

Optional:

```bash
# Ruff (if available)
uvx ruff check src tests

# Live evals (needs key)
OPENAGENTS_EVALS=1 OPENROUTER_API_KEY=... uv run pytest -m eval -q
```

Web lint (best-effort):

```bash
cd apps/web
pnpm install
pnpm lint
```

## Lint / style

- Python: prefer clear, small modules; match existing patterns in `apps/api/src/openagents_api/`.
- TypeScript/React: follow patterns in `apps/web`; run `pnpm lint` when you touch UI.
- Do not commit secrets (`.env`, service role keys, SSE-C keys).

## Pull requests

1. One concern per PR when practical.
2. Include or update tests for API behavior changes.
3. Update docs under `docs/` if you change env vars, agent format, or deploy steps.
4. Keep the PR description short: what changed and how to verify.
5. Ensure `cd apps/api && uv run pytest -q` stays green.

## Agent contributions

New built-in agents belong under `agents/<slug>/` with:

- Valid `agent.yaml` + non-empty `agent.md`
- Agent-scoped skills under `agents/<slug>/skills/<skill-slug>/SKILL.md` when useful
- Document template only if `uses_document: true`

Shared **library** skills (sidebar Skills, `/` mentions, optional predefined rooting on user agents) belong under repo `skills/<skill-slug>/SKILL.md` with frontmatter `name`, `description`, and optional `icon`.

Guidelines:

- No proprietary / confidential prompts.
- Prefer generic, reusable workflows (research, coding, authoring).
- Add a load assertion in `apps/api/tests/test_evals_agents.py` or `test_agents.py`.
- See [docs/agents.md](docs/agents.md) and [docs/skills.md](docs/skills.md).

## Docs & demo assets

- Architecture diagram: ASCII block in the root [README](README.md) (prefer editing that over adding a separate image)
- Hero screenshot: `docs/assets/ui.webp`
- Optional demo GIF: contributors can add `docs/assets/demo.gif` (do not commit huge binaries)

## License

By contributing, you agree your contributions are licensed under the MIT License (see [LICENSE](LICENSE)).
