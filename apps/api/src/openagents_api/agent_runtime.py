"""Resolved deep-agent sandbox/execute/safety settings (env defaults + admin overrides)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from openagents_api.config import Settings, get_settings

SAFETY_KEYS = (
    "filesystem_hooks",
    "prompt_injection",
    "secret_redaction",
    "tool_guard",
)


@dataclass(frozen=True)
class AgentSafetyConfig:
    """Deep-agent shields / guardrails (all on by default)."""

    filesystem_hooks: bool = True
    prompt_injection: bool = True
    secret_redaction: bool = True
    tool_guard: bool = True

    def as_dict(self) -> dict[str, bool]:
        return {
            "filesystem_hooks": self.filesystem_hooks,
            "prompt_injection": self.prompt_injection,
            "secret_redaction": self.secret_redaction,
            "tool_guard": self.tool_guard,
        }


@dataclass(frozen=True)
class AgentRuntimeConfig:
    sandbox: str  # local | docker
    execute: bool
    max_concurrent: int
    image: str
    safety: AgentSafetyConfig = field(default_factory=AgentSafetyConfig)

    def as_dict(self) -> dict[str, Any]:
        return {
            "sandbox": self.sandbox,
            "execute": self.execute,
            "max_concurrent": self.max_concurrent,
            "image": self.image,
            "safety": self.safety.as_dict(),
        }


def _safety_from_stored(
    stored: dict[str, Any] | None,
    *,
    base: AgentSafetyConfig,
) -> AgentSafetyConfig:
    if not stored or not isinstance(stored, dict):
        return base
    kwargs = base.as_dict()
    for key in SAFETY_KEYS:
        if key in stored:
            kwargs[key] = bool(stored[key])
    return AgentSafetyConfig(**kwargs)


def runtime_from_env(settings: Settings | None = None) -> AgentRuntimeConfig:
    s = settings or get_settings()
    mode = (s.agent_sandbox or "local").strip().lower()
    if mode not in ("local", "docker"):
        mode = "local"
    return AgentRuntimeConfig(
        sandbox=mode,
        execute=bool(s.agent_execute),
        max_concurrent=max(1, int(s.agent_sandbox_max_concurrent or 1)),
        image=(s.agent_sandbox_image or "openagents-agent-sandbox:latest").strip()
        or "openagents-agent-sandbox:latest",
        safety=AgentSafetyConfig(),
    )


def merge_agent_runtime(
    stored: dict[str, Any] | None,
    settings: Settings | None = None,
) -> AgentRuntimeConfig:
    """Admin JSON overrides env defaults field-by-field when present."""
    base = runtime_from_env(settings)
    if not stored or not isinstance(stored, dict):
        return base

    mode = stored.get("sandbox")
    if isinstance(mode, str) and mode.strip().lower() in ("local", "docker"):
        sandbox = mode.strip().lower()
    else:
        sandbox = base.sandbox

    if "execute" in stored:
        execute = bool(stored["execute"])
    else:
        execute = base.execute

    max_c = stored.get("max_concurrent")
    try:
        max_concurrent = max(1, int(max_c)) if max_c is not None else base.max_concurrent
    except (TypeError, ValueError):
        max_concurrent = base.max_concurrent

    image = stored.get("image")
    if isinstance(image, str) and image.strip():
        image_s = image.strip()
    else:
        image_s = base.image

    safety_raw = stored.get("safety")
    safety = _safety_from_stored(
        safety_raw if isinstance(safety_raw, dict) else None,
        base=base.safety,
    )

    return AgentRuntimeConfig(
        sandbox=sandbox,
        execute=execute,
        max_concurrent=max_concurrent,
        image=image_s,
        safety=safety,
    )


def normalize_agent_runtime_update(
    patch: dict[str, Any],
    *,
    current: AgentRuntimeConfig,
) -> dict[str, Any]:
    """Validate an admin patch and return a full stored dict."""
    merged = {
        "sandbox": current.sandbox,
        "execute": current.execute,
        "max_concurrent": current.max_concurrent,
        "image": current.image,
        "safety": current.safety.as_dict(),
    }
    if "sandbox" in patch and patch["sandbox"] is not None:
        mode = str(patch["sandbox"]).strip().lower()
        if mode not in ("local", "docker"):
            raise ValueError("sandbox must be 'local' or 'docker'")
        merged["sandbox"] = mode
    if "execute" in patch and patch["execute"] is not None:
        merged["execute"] = bool(patch["execute"])
    if "max_concurrent" in patch and patch["max_concurrent"] is not None:
        try:
            n = int(patch["max_concurrent"])
        except (TypeError, ValueError) as exc:
            raise ValueError("max_concurrent must be an integer >= 1") from exc
        if n < 1:
            raise ValueError("max_concurrent must be an integer >= 1")
        merged["max_concurrent"] = n
    if "image" in patch and patch["image"] is not None:
        img = str(patch["image"]).strip()
        if not img:
            raise ValueError("image must be a non-empty string")
        merged["image"] = img
    if "safety" in patch and patch["safety"] is not None:
        if not isinstance(patch["safety"], dict):
            raise ValueError("safety must be an object")
        safety = dict(merged["safety"])
        for key in SAFETY_KEYS:
            if key in patch["safety"] and patch["safety"][key] is not None:
                safety[key] = bool(patch["safety"][key])
        merged["safety"] = safety
    return merged
