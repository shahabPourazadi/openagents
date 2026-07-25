# OpenAgents

A self-hostable agent workspace where Agents specialize a deep agent for a workflow. Users select, edit, or generate agents; the agent runs with agent-scoped skills, optional documents, and configurable tools.

## Language

**Agent**:
A bundle of prompt, persona, skills, optional document template, and optional tools that specializes the workspace agent. The unit of tailoring. Stored under `agents/` and `/api/agents`.
_Avoid_: pack, template set, persona pack

**Built-in Agent**:
An agent shipped in the repository under `agents/`.
_Avoid_: default agent, system agent

**User Agent**:
An agent created in-app and stored in the database.
_Avoid_: custom agent, private agent

**Agent Builder**:
The built-in agent whose chat flow creates other agents through conversation (slug `agent-builder`).
_Avoid_: agent wizard, meta-agent (when referring to this specific agent)

**Skill**:
An agent-scoped folder with a `SKILL.md` the agent loads on demand.
_Avoid_: plugin, tool (skills are instructions, not callable tools)

**MCP server**:
An HTTP/SSE Model Context Protocol endpoint whose tools the deep agent can call; stored in the user MCP library and attached per agent.
_Avoid_: skill, plugin (MCP exposes tools; skills are playbooks)

**Document**:
The markdown artifact shown in the editor pane; exists only for agents with `uses_document`.
_Avoid_: file, artifact (when referring to the editor pane target)

**Suggestion**:
An agent-proposed document edit awaiting user Accept or Reject; never auto-applied.
_Avoid_: diff, patch, edit (when referring to the HITL proposal)

**Workspace**:
A user's container of documents, threads, and files, bound to a selected agent.
_Avoid_: project, session

**Sandbox**:
The execution backend for agent code or shell — `local` or `docker` (network-disabled, soft-degrades to filesystem-only).
_Avoid_: runtime, executor
