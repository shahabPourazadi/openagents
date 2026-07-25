---
name: agent-authoring
description: Scaffold and register an Agent from the workspace. Always ask about predefined library skills and whether to create a new agent-scoped playbook before drafting.
icon: package
---

# Agent authoring

## Before drafting (required)

Use `ask_user` (or wait for a clear answer) for **skills** before writing files:

1. List `skills/*/SKILL.md` in the workspace (library). Call out if only `create-skill` exists.
2. Which library skills should be **predefined**? (none is OK)
3. Create a **new agent-scoped** playbook under `agents/<slug>/skills/<skill-slug>/SKILL.md`? If yes, confirm name + one-line purpose first.
4. For a reusable **library** skill in the sidebar DB, point the user to **Skills → +** or `/create-skill` after register — do not pretend you saved a library skill unless a tool confirmed it.

## Required files under `agents/<slug>/`

- `agent.yaml` — name, slug, description, icon, uses_document; optional `predefined_skills: [slug, …]`
- `agent.md` — persona (non-empty)

## Optional

- `soul.md` — tone
- `system_prompt.md` — system overlay
- `skills/<skill-slug>/SKILL.md` — short agent-scoped playbooks
- `templates/document.md` — when `uses_document: true`

## Predefined library skills

Put selected slugs in `agent.yaml`:

```yaml
predefined_skills:
  - create-skill
```

Those skills are injected into the system prompt. The full library stays available on demand.

## Register

1. Write files with filesystem tools
2. `validate_agent_draft_tool(slug)`
3. `register_agent_from_workspace(slug)` — creates or **overwrites** the owner's user agent with that slug
4. Tell the user what was predefined / created, and how to add more via Skills sidebar + Edit agent

## Edit an existing user agent

Reuse the same slug, rewrite the files, validate, and register again. Re-ask about skills if they want to change predefined or agent-scoped playbooks.
