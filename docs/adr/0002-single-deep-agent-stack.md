# Single deep-agent stack

## Context

OpenAgents is built on [Pydantic AI](https://ai.pydantic.dev/) and the deep-agent harness from [pydantic-deepagents](https://github.com/vstorm-co/pydantic-deepagents) (`pydantic_deep.create_deep_agent`). The product layer (AG-UI, Agents, documents, MCP, Admin) sits on that stack rather than reimplementing a second agent runtime.

## Decision

Considered keeping the classic Pydantic AI agent alongside pydantic-deep. Classic duplicated filesystem, execute, and skill loading with a second code path and confused contributors. We deleted classic and kept only `create_deep_agent` so skills, sandbox, subagents, and plan builtins share one surface.
