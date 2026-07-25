"""Env defaults + admin overrides for agent sandbox runtime."""

from __future__ import annotations

from openagents_api.agent_runtime import (
    merge_agent_runtime,
    normalize_agent_runtime_update,
    runtime_from_env,
)
from openagents_api.config import Settings


def test_runtime_from_env_defaults() -> None:
    r = runtime_from_env(
        Settings(
            agent_sandbox="docker",
            agent_execute=False,
            agent_sandbox_max_concurrent=2,
            agent_sandbox_image="openagents-agent-sandbox:dev",
        )
    )
    assert r.sandbox == "docker"
    assert r.execute is False
    assert r.max_concurrent == 2
    assert r.image == "openagents-agent-sandbox:dev"
    assert r.safety.filesystem_hooks is True
    assert r.safety.prompt_injection is True
    assert r.safety.secret_redaction is True
    assert r.safety.tool_guard is True


def test_merge_agent_runtime_overrides_env() -> None:
    settings = Settings(agent_sandbox="local", agent_execute=True)
    r = merge_agent_runtime(
        {
            "sandbox": "docker",
            "execute": False,
            "max_concurrent": 3,
            "safety": {"prompt_injection": False, "tool_guard": False},
        },
        settings,
    )
    assert r.sandbox == "docker"
    assert r.execute is False
    assert r.max_concurrent == 3
    # image falls back to env default
    assert r.image == settings.agent_sandbox_image
    assert r.safety.prompt_injection is False
    assert r.safety.tool_guard is False
    assert r.safety.filesystem_hooks is True
    assert r.safety.secret_redaction is True


def test_normalize_agent_runtime_update_validates() -> None:
    current = runtime_from_env(Settings(agent_sandbox="local", agent_execute=True))
    out = normalize_agent_runtime_update(
        {
            "sandbox": "docker",
            "max_concurrent": 2,
            "safety": {"secret_redaction": False},
        },
        current=current,
    )
    assert out["sandbox"] == "docker"
    assert out["execute"] is True
    assert out["max_concurrent"] == 2
    assert out["safety"]["secret_redaction"] is False
    assert out["safety"]["prompt_injection"] is True
