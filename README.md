# OpenAgents

Self-hostable agent workspace specialized via Agents.

Pick an agent (or build one), chat with a deep agent over AG-UI, optionally edit a markdown document with Accept/Reject suggestions, and run tools in a local or Docker sandbox — all on your own machine or VPS.

![OpenAgents workspace](docs/assets/ui.png)

Built on [Pydantic AI](https://ai.pydantic.dev/) and the deep-agent harness from [pydantic-deepagents](https://github.com/vstorm-co/pydantic-deepagents) — OpenAgents turns that stack into a full product workspace (AG-UI, Agents, documents, MCP, Admin, and multi-user auth).

## Architecture

![Architecture](docs/assets/architecture.svg)

```mermaid
flowchart LR
  Web["Web<br/>Next.js · AG-UI"]
  API["API<br/>FastAPI · Pydantic AI"]
  Agents["Agents<br/>agents/&lt;slug&gt;/"]
  Sandbox["Sandbox<br/>local · docker"]
  MCP["MCP servers<br/>optional"]
  Models["Models<br/>OpenRouter-first"]

  Web <--> API
  API --> Agents
  API --> Sandbox
  API --> MCP
  API --> Models
```

## 5-minute quickstart

### Option A — Docker Compose

```bash
cp .env.example .env
# set OPENROUTER_API_KEY=sk-or-...
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000). The API listens on `:8000` with SQLite and open auth (`AUTH_MODE=none`, user `dev-user`).

### Option B — Local (uv + pnpm)

**API**

```bash
cd apps/api
cp .env.example .env
# set OPENROUTER_API_KEY=...
uv sync
uv run uvicorn openagents_api.main:app --reload --port 8000
```

**Web** (second terminal)

```bash
cd apps/web
echo "NEXT_PUBLIC_API_URL=http://localhost:8000" > .env.local
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

On first boot with an empty DB, OpenAgents seeds one sample workspace per built-in agent for the open-auth user so the UI is not blank.

## Agents

An **Agent** is a folder that specializes the workspace agent: persona, skills, optional document template, and tool-group hints.

```
agents/<slug>/
  agent.yaml           # name, description, icon, uses_document, predefined_skills, …
  agent.md            # required persona / operating instructions
  soul.md             # optional tone
  system_prompt.md    # optional; falls back to a OpenAgents default
  templates/
    document.md       # when uses_document: true
  skills/
    <skill-slug>/
      SKILL.md
```

**Library skills** live under repo `skills/` (and user skills in the sidebar). Agents can mark library skills as **predefined** so their bodies are rooted in the system prompt; every agent can still load the full library on demand (`/` in chat).

See [docs/agents.md](docs/agents.md), [docs/skills.md](docs/skills.md), and [docs/mcp.md](docs/mcp.md).

### Built-in agents

| Agent | Slug | Document pane |
|------|------|----------------|
| Agent | `agent` | Yes — generalist; loads specialized skills on demand |
| Research Assistant | `research-assistant` | Yes — notes with Accept/Reject suggestions |
| Coding Assistant | `coding-assistant` | No — chat + sandbox file edits |
| Agent Builder | `agent-builder` | No — interviews you and registers a new agent |

## Key features

OpenAgents is an **agent workspace** — the product layer around a deep agent harness. The model provides intelligence; the workspace provides planning, tools, memory, documents, MCP, sandboxed execution, and spend controls.

| | Feature | What you get |
|--|---------|--------------|
| 💬 | **AG-UI chat** | Streaming agent UI over SSE — text, thinking, tools, and media |
| 🧩 | **Agents** | Folder- or UI-defined specialists (`agent.md`, skills, MCP, optional document) |
| 📝 | **Document HITL** | Markdown editor with `suggest_edit` Accept/Reject and clarifying questions |
| 🔧 | **Tool-calling** | File read/write/edit, shell (sandbox), glob/grep, uploads, document parse |
| 🤝 | **Subagents + plan** | Deep builtins for plan mode, todos, and subagent delegation when enabled |
| 🧠 | **Persistent memory** | `MEMORY.md` / persona files seeded per workspace and injected into runs |
| ♾️ | **Long context** | Auto-summarization near the model token budget — conversations keep going |
| 🐳 | **Sandboxed execution** | `local` or `docker` sandbox; soft-degrades to filesystem-only when busy |
| 📚 | **Skills system** | On-demand `SKILL.md` playbooks; library + predefined skills; `/` mentions |
| 📄 | **Document parsing** | PDF/DOCX/XLSX/PPTX and images via LiteParse (optional OCR) |
| 🔌 | **MCP** | Attach HTTP MCP servers — Firecrawl, OpenRouter, or your own |
| 🖼️ | **Image generation** | Via OpenRouter MCP (`generate_image` and related tools); results become durable assets in chat |
| 🛡️ | **Security presets** | Filesystem hooks + optional prompt-injection / secret-redaction / tool-guard capabilities |
| 💰 | **Cost tracking** | Token + USD spend per run, sidebar totals, hard budget limits |
| 🌐 | **OpenRouter-first models** | Admin model tiers and ZDR; any pydantic-ai model id when keys are present |
| ⚙️ | **Admin panel** | Tool groups, sandbox/runtime, models, safety toggles, optional signup queue |

## Docs

| Doc | Topic |
|-----|--------|
| [docs/configuration.md](docs/configuration.md) | Environment variables; Supabase auth vs Postgres; where SQLite chats live |
| [docs/agents.md](docs/agents.md) | Authoring Agents (wizard, predefined skills) |
| [docs/skills.md](docs/skills.md) | Library skills, icons, `/` mentions, API |
| [docs/mcp.md](docs/mcp.md) | User MCP library, image generation, attach to agents, APIs |
| [docs/sandbox.md](docs/sandbox.md) | Local vs Docker sandbox |
| [docs/deployment.md](docs/deployment.md) | Compose and generic VPS |
| [docs/admin-panel.md](docs/admin-panel.md) | Admin UI |
| [docs/evals.md](docs/evals.md) | Agent eval harness |
| [docs/adr/](docs/adr/) | Architecture decision records |

## Roadmap

- **Live run forking** — split a run into isolated branches, try different approaches, pick a winner
- **Checkpoints** — save conversation state, rewind, and fork sessions from any point
- **Richer subagents** — named / builtin subagent configs, nesting controls, and clearer team coordination in the UI
- Cloud sandbox providers (e.g. Daytona / Modal) behind the existing sandbox interface
- Import agents from a GitHub repo or URL
- Global / shared skills outside a single agent
- Richer agent marketplace UX and versioning
- Payment gateway for spend budgets (today: soft cap via `DEFAULT_SPEND_BUDGET_USD`)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). This is a portfolio / open-source project — PRs and agent contributions welcome.

## License

[MIT](LICENSE) © 2026 Shahab Pourazadi
