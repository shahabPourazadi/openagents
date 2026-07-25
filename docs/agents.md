# Authoring Agents

An Agent specializes OpenAgents' deep agent for a workflow. Built-in agents live under `agents/<slug>/`. Users can also create agents in-app (stored in the DB) via the **New agent** wizard, the Agent Builder chat, or the agents API. User agents can be edited from the sidebar **Edit** menu, refined in chat (`update_active_user_agent`), or rewritten through Agent Builder (same slug re-register).

## Layout

```
agents/<slug>/
  agent.yaml
  agent.md                 # required
  soul.md                  # optional
  system_prompt.md         # optional
  templates/
    document.md            # when uses_document: true
  skills/
    <skill-slug>/
      SKILL.md
```

Folder name is the canonical slug. `agent.yaml` may repeat `slug:` for readability; the loader prefers the folder name.

## `agent.yaml` fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Display name |
| `slug` | string | no | Should match folder name |
| `description` | string | no | Short picker blurb |
| `icon` | string | no | Lucide icon id for the UI (e.g. `book`, `code`, `package`, `pencil-ruler`) |
| `uses_document` | bool | no (default `true`) | Show document editor + HITL suggestions. Turn off to remove the document pane for that agent. |
| `document_template` | string | no | Relative path, usually `templates/document.md` |
| `tool_groups` | object | no | Hints for HITL / Firecrawl / document_parse / deep_builtins |
| `default_model` | string \| null | no | Override workspace/thread default model id |
| `predefined_skills` | string[] | no | Library skill slugs to **root in the system prompt** (see below). Alias: `predefined_skill_slugs`. |

Example (Research Assistant):

```yaml
name: Research Assistant
slug: research-assistant
description: Research a topic with web tools and draft structured notes via accept/reject suggestions.
icon: book
uses_document: true
document_template: templates/document.md
# Optional — root library skills in the system prompt (user agents / Agent Builder):
# predefined_skills:
#   - create-skill
tool_groups:
  hitl: true
  firecrawl: true
  document_parse: true
  deep_builtins: true
default_model: null
```

## `agent.md`

Required, non-empty. Operating instructions for the agent: goals, workflow, when to use skills/tools, honesty rules. Loaded into the agent run for that workspace’s selected agent.

## `soul.md`

Optional tone / personality. Concatenated with agent instructions at run time.

## `system_prompt.md`

Optional base system prompt. If missing or empty, OpenAgents uses a small default that reminds the agent about `read_document` / `suggest_edit` and HITL.

## Document template

When `uses_document: true`, create `templates/document.md` (or the path in `document_template`). New workspaces seed the editor from this file.

When `uses_document: false` (Coding Assistant, Agent Builder), no document pane is created — chat + files/sandbox only.

## Skills

See [skills.md](skills.md) for formats and the library vs agent-scoped distinction.

**Agent-scoped skills** live under `agents/<slug>/skills/<skill-slug>/SKILL.md` (or `skills_json` on user agents). They materialize into the run workspace and are loaded on demand.

**Library skills** (sidebar **Skills**, repo `skills/`, `/api/skills`) are available to every agent. In chat, type `/` to mention them.

**Predefined (rooted) skills** — When creating or editing a user agent in the **New agent / Edit agent** wizard, or via Agent Builder, you can select library skills as predefined. Those slugs are stored on the agent (`predefined_skill_slugs` in the DB / `predefined_skills` in `agent.yaml`). On each turn, OpenAgents injects their `SKILL.md` bodies into the system instructions so the agent always has them in context. Deselecting a skill (or deleting the library skill) stops rooting it on the next turn. The rest of the library remains available on demand — predefined selection is not an access control list.

Agent Builder **must** ask about skills before drafting: which library skills to predefined-root, and whether to create a new **agent-scoped** playbook under `agents/<slug>/skills/`. Reusable sidebar library skills are created via **Skills → +** or `/create-skill` (not by Agent Builder’s register tool). Selected predefined slugs go into `agent.yaml` before `register_agent_from_workspace`.

## MCP servers

See [mcp.md](mcp.md). User agents store attached library server ids as `mcp_server_ids`. Select them in the agent wizard under **MCP servers**. Platform MCP (Firecrawl / `MCP_SERVERS_JSON`) still merges when `tool_groups.mcp` is on.

**Auto Agent** (built-in, slug `agent`) always has access to every library skill and every MCP server. Other agents keep the per-agent skill/MCP checkboxes.

## In-app wizard

The **New agent / Edit agent** dialog lets you set name, description, icon, document editor on/off, **MCP servers**, **predefined skills**, `agent.md`, and optional tone. Changes apply on save; the next agent turn uses the updated flags, tools, and rooted skills.

## `tools.py` (future / optional)

Some designs imagine an agent-local `tools.py` for custom tool registration. **That is not implemented today.** Tooling comes from the shared API (HITL, deep builtins, MCP, sandbox). Agents influence behavior via prompts, skills, `tool_groups` hints, and (for Agent Builder) dedicated API tools.

## Validation rules

The loader (`openagents_api.agents`) requires:

- Valid slug: lowercase alphanumeric + hyphens
- `agent.yaml` present and a YAML mapping with a `name`
- `agent.md` present and non-empty

Invalid agents are skipped by `list_builtin_agents()` and raise `AgentError` on `load_agent()`.

## Testing an agent locally

1. Drop the folder under `agents/<slug>/`.
2. Restart the API (or ensure `AGENTS_DIR` points at your agents root).
3. Create a workspace with that agent slug from the UI, or rely on demo seed (open auth).
4. Run unit checks: `cd apps/api && uv run pytest tests/test_agents.py tests/test_evals_agents.py -q`
