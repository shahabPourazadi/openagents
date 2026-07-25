"""TDD seams: deep-agent security hooks, shields, and degrade instructions."""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest
from pydantic_ai_shields import PromptInjection, SecretRedaction, ToolGuard
from pydantic_deep import default_security_hook

from openagents_api.agent_runtime import AgentSafetyConfig
from openagents_api.deep_agent_builder import (
    EXECUTE_UNAVAILABLE_NOTE,
    OpenAgentsDeepDeps,
    build_deep_agent,
    build_deep_deps,
    deep_agent_security_capabilities,
    deep_agent_security_hooks,
)
from openagents_api.sandbox import AgentBackendHandle
from openagents_api.suggestions import AgentRunState


def test_deep_agent_security_hooks_match_default_preset() -> None:
    hooks = deep_agent_security_hooks()
    expected = list(default_security_hook())
    assert len(hooks) == len(expected)
    assert len(hooks) >= 1
    assert deep_agent_security_hooks(enabled=False) == []


def test_deep_agent_security_capabilities_include_beta_shields() -> None:
    caps = deep_agent_security_capabilities()
    types = {type(c) for c in caps}
    assert PromptInjection in types
    assert SecretRedaction in types
    assert ToolGuard in types
    tool_guard = next(c for c in caps if isinstance(c, ToolGuard))
    # Execute must remain available inside Docker — do not block it.
    blocked = getattr(tool_guard, "blocked", None) or getattr(
        tool_guard, "_blocked", None
    )
    if blocked is not None:
        assert "execute" not in list(blocked)
    assert deep_agent_security_capabilities(
        prompt_injection=False, secret_redaction=False, tool_guard=False
    ) == []


def test_build_deep_agent_passes_hooks_and_capabilities(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def fake_create_deep_agent(**kwargs: Any) -> Any:
        captured.update(kwargs)
        agent = MagicMock()
        # Support @agent.instructions decorator registration.
        agent.instructions = lambda fn=None: (fn if fn is not None else (lambda f: f))
        return agent

    monkeypatch.setattr(
        "openagents_api.deep_agent_builder.create_deep_agent", fake_create_deep_agent
    )
    monkeypatch.setattr(
        "openagents_api.deep_agent_builder.create_mcp_toolsets", lambda *_a, **_k: []
    )
    monkeypatch.setattr(
        "openagents_api.deep_agent_builder._build_liteparse_toolset", lambda *_a, **_k: None
    )

    build_deep_agent("test-model")

    assert "hooks" in captured
    assert len(captured["hooks"]) == len(deep_agent_security_hooks())
    assert "capabilities" in captured
    cap_types = {type(c) for c in captured["capabilities"]}
    assert PromptInjection in cap_types
    assert SecretRedaction in cap_types
    assert ToolGuard in cap_types
    assert captured.get("include_execute") is True
    assert captured.get("max_binary_content") == 3


def test_build_deep_agent_honors_disabled_safety(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def fake_create_deep_agent(**kwargs: Any) -> Any:
        captured.update(kwargs)
        agent = MagicMock()
        agent.instructions = lambda fn=None: (fn if fn is not None else (lambda f: f))
        return agent

    monkeypatch.setattr(
        "openagents_api.deep_agent_builder.create_deep_agent", fake_create_deep_agent
    )
    monkeypatch.setattr(
        "openagents_api.deep_agent_builder.create_mcp_toolsets", lambda *_a, **_k: []
    )
    monkeypatch.setattr(
        "openagents_api.deep_agent_builder._build_liteparse_toolset", lambda *_a, **_k: None
    )

    build_deep_agent(
        "test-model",
        safety=AgentSafetyConfig(
            filesystem_hooks=False,
            prompt_injection=False,
            secret_redaction=True,
            tool_guard=False,
        ),
    )
    assert captured["hooks"] == []
    cap_types = {type(c) for c in captured["capabilities"]}
    assert cap_types == {SecretRedaction}


@pytest.mark.asyncio
async def test_build_deep_deps_sets_execute_degraded(tmp_path: Path) -> None:
    from pydantic_ai_backends import LocalBackend

    state = AgentRunState(
        user_id="u1",
        workspace_id=uuid.uuid4(),
        thread_id=uuid.uuid4(),
        document_id=None,
        document_md="",
        document_path="",
        openrouter_api_key="",
        model="test",
        workspace_dir=str(tmp_path),
    )
    backend = LocalBackend(root_dir=str(tmp_path), enable_execute=False)
    handle = AgentBackendHandle(
        backend=backend, execute_enabled=False, degraded=True
    )
    deps = build_deep_deps(state, backend_handle=handle)
    assert deps.execute_degraded is True
    assert deps.backend is not None
    # DeepAgentDeps may wrap the backend in an async adapter.
    inner = getattr(deps.backend, "_backend", deps.backend)
    assert getattr(inner, "execute_enabled", None) is False


def test_execute_unavailable_note_content() -> None:
    assert "Shell execution is temporarily unavailable" in EXECUTE_UNAVAILABLE_NOTE
    assert "diagrams/" in EXECUTE_UNAVAILABLE_NOTE


def test_degraded_instruction_helper() -> None:
    """Mirror of execute_availability instruction body when degraded."""
    deps = OpenAgentsDeepDeps(execute_degraded=True)
    text = (
        f"## Execution\n{EXECUTE_UNAVAILABLE_NOTE}"
        if deps.execute_degraded
        else ""
    )
    assert EXECUTE_UNAVAILABLE_NOTE in text
    assert "apt/brew/rsvg" in text
