# Skills

Skills are instruction folders the deep agent can load on demand. They are **not** callable tools — they are markdown playbooks.

For remote tools via Model Context Protocol, see **[mcp.md](mcp.md)** (sidebar **MCP**, separate from Skills).

## Path conventions

**Library skills (sidebar Skills)**

Built-in library skills live under:

```
skills/<skill-slug>/SKILL.md
```

Ship includes `create-skill` (same workflow as Cursor’s `/create-skill`). User library skills are stored in the `user_skills` table and managed via the sidebar **Skills → +** wizard / `/api/skills`.

Each skill can have an **icon** (Lucide id from the same catalog as agents; default `pencil-ruler`). Set it in the Skills wizard or in `SKILL.md` frontmatter for builtins.

**Predefined skills on an agent**

When creating/editing an agent (wizard or Agent Builder), you can select library skills as **predefined**. Those slugs are stored on the agent (`predefined_skill_slugs` in the DB, or `predefined_skills` / `predefined_skill_slugs` in `agent.yaml`) and their `SKILL.md` bodies are **rooted in the system prompt** for every turn.

- Deselecting a skill in the agent wizard removes it from the next turn’s prompt.
- Deleting a user library skill also drops that slug from any agent’s predefined list.
- The full library still materializes into the run workspace so any agent can load other skills on demand (`/` mentions in chat or `skills/` on disk). Predefined selection roots context; it does not gate access.

**Built-in agents**

```
agents/<agent-slug>/skills/<skill-slug>/SKILL.md
```

**User agents (DB)**

Agent-scoped skills are stored as JSON on the `user_agents` row (`skills_json`) and materialized to:

```
{WORKSPACE_TMP_ROOT}/user-agents/<owner_id>/<agent-slug>/skills/<skill-slug>/SKILL.md
```

Predefined library refs are stored separately as `predefined_skill_slugs` (list of slugs), not as copied skill bodies.

**Per agent run**

1. Agent-scoped skills materialize into the workspace `skills/` directory.
2. Library skills (builtin + user) merge in without overwriting existing agent skill slugs.
3. Company (admin) skills may merge on top when published.
4. Selected predefined library skills are additionally **inlined into system instructions**.

## Chat mentions

Type `/` in the composer to pick from the library skill list (plus any agent-scoped skills on the active agent). Each row uses that skill’s chosen icon. Selecting a skill inserts a `/{slug}` token the agent can use.

The default **Agent** also exposes a built-in agent-scoped skill **Triage** (`agents/agent/skills/triage/`) — a routing playbook that classifies requests (general / research / coding / agent-authoring). It is not a sidebar library skill; it appears in `/` when that agent is selected.

## `SKILL.md` format

Optional YAML frontmatter + markdown body:

```markdown
---
name: research
description: Gather sources and structure research notes into the document.
icon: search
---

# Research skill

## Clarify

- One sentence research question
- Audience and depth

## Gather

1. Search broadly, then scrape the best sources.
2. Never invent citations.
```

| Frontmatter | Description |
|-------------|-------------|
| `name` | Display name (defaults to folder slug) |
| `description` | Short summary for discovery |
| `icon` | Optional Lucide icon id (e.g. `pencil-ruler`, `search`, `book`) |

The folder name is the skill **slug** (must be a safe agent-style slug: `a-z0-9` + hyphens).

## Icons

Library skills use the same icon id list as agents (see the Skills / Agents wizards in the UI). Builtin `create-skill` defaults to `pencil-ruler`. User skills store `icon` on the `user_skills` row; builtins may declare `icon` in frontmatter.

## API (library skills)

| Method | Path | Notes |
|--------|------|--------|
| `GET` | `/api/skills` | Builtin + caller’s user skills (no bodies) |
| `GET` | `/api/skills/{slug}` | Full `SKILL.md` content |
| `POST` | `/api/skills` | Create user skill (`name`, `description`, `icon`, `content`, optional `slug`) |
| `PATCH` | `/api/skills/{slug}` | Update user skill (builtins are read-only) |
| `DELETE` | `/api/skills/{slug}` | Delete user skill; strips slug from agents’ `predefined_skill_slugs` |
| `POST` | `/api/skills/{slug}/duplicate` | Copy builtin or user skill into a new user skill |

Agents expose `predefined_skill_slugs` on `GET/POST/PATCH /api/agents` (and Agent Builder’s `agent.yaml` → register path).

## Authoring tips

- Keep skills short and actionable — checklists beat essays.
- Reference real tools the agent has (`suggest_edit`, sandbox execute, MCP search) without inventing APIs.
- Prefer one concern per skill (`research` vs `synthesize`).
- For document agents, remind the agent to `read_document` before editing.
- Use **predefined** rooting for playbooks the agent should always follow; leave discovery-only skills in the library for `/` load-on-demand.

## Admin / company skills

Separately, the Admin panel can manage **company** skills (draft → publish) stored in the DB. Those are platform-level, not agent folders. Prefer agent-scoped or library skills for workflow specialization; use company skills for org-wide defaults when running with Supabase auth and admin publishing.

## Related

- [agents.md](agents.md) — agent layout, wizard, `predefined_skills` on `agent.yaml`
- [configuration.md](configuration.md) — `SKILLS_DIR`
- [evals.md](evals.md) — automated agent load checks
