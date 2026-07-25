# Eval harness

OpenAgents keeps a lightweight, pytest-based eval story so agent and tool regressions are caught without requiring a live LLM for the default CI path.

## Location

| Path | Role |
|------|------|
| `apps/api/tests/test_evals_agents.py` | Agent load scenarios, YAML validation, optional live evals |
| `apps/api/tests/test_hitl_tools.py` | `read_document` / `suggest_edit` unit tests |
| `apps/api/tests/test_agents.py` | Core agent loader unit tests |

All of these are collected by the default pytest config (`testpaths = ["tests"]` in `apps/api/pyproject.toml`).

## Default CI (no LLM)

```bash
cd apps/api
uv run pytest -q
```

This always runs:

- Built-in agent loads (`agent`, `research-assistant`, `coding-assistant`, `agent-builder`)
- Invalid `agent.yaml` / missing `agent.md` failures

Library skills under `skills/` and user-agent fields like `predefined_skill_slugs` are covered in [skills.md](skills.md) / [agents.md](agents.md); add API tests under `apps/api/tests/test_skills_library.py` when changing that surface.
- HITL document tool unit tests

No `OPENROUTER_API_KEY` required.

## Live / opt-in evals

Tests marked `@pytest.mark.eval` skip unless **both**:

1. `OPENAGENTS_EVALS=1`
2. `OPENROUTER_API_KEY` is set

```bash
cd apps/api
OPENAGENTS_EVALS=1 OPENROUTER_API_KEY=sk-or-... uv run pytest -m eval -q
```

These are higher-level scenarios (e.g. Agent Builder structure smoke checks). Prefer stubs or narrow assertions — avoid flaky full-chat transcripts in CI.

## Adding a scenario

1. Prefer a pure unit test under `tests/` that loads agents or tools with fixtures.
2. If the scenario needs a model, mark it `@pytest.mark.eval` and gate with `_evals_enabled()` from `test_evals_agents.py`.
3. Document the intent in the test docstring.

## Related markers

| Marker | Meaning |
|--------|---------|
| `eval` | Needs `OPENAGENTS_EVALS=1` + API key |
| `integration` | Live external services (e.g. Garage S3) |
| `docker` | Needs Docker; set `OPENAGENTS_DOCKER_TESTS=1` |
