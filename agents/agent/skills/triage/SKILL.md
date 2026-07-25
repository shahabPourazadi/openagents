---
name: Triage
description: Route the request — classify general vs research, coding, or agent-authoring, then load the right playbooks. Built into the default Agent (not a sidebar library skill).
icon: clipboard
---

# Triage

Built-in routing skill for the default **Agent**. Use when you need to classify the user’s ask before specializing.

1. Label the request: `general` | `research` | `coding` | `agent-authoring` | `mixed`.
2. If `research` — load `research` / `synthesize`.
3. If `coding` — load `code-review` / `iterate-on-failure`; use sandbox when verifying.
4. If `agent-authoring` — load `agent-authoring`, or recommend the Agent Builder agent for a longer authoring session.
5. If `mixed` — handle the primary thread here; call out an agent switch only if one specialty will dominate.
