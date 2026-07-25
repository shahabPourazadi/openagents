"""Extract multimodal / image-generation costs from MCP tool results."""

from __future__ import annotations

import json
import re
from typing import Any

# Fallback USD when OpenRouter usage.cost is missing but we saved an image.
# Keys are normalized model id fragments (lowercase).
_IMAGE_COST_FALLBACKS: list[tuple[str, float]] = [
    ("grok-imagine", 0.05),
    ("recraft", 0.04),
    ("flux", 0.04),
    ("gemini", 0.04),
    ("gpt-image", 0.04),
    ("dall-e", 0.04),
    ("krea", 0.04),
]

_COST_IN_TEXT_RE = re.compile(
    r'"cost"\s*:\s*(-?\d+(?:\.\d+)?)',
    re.IGNORECASE,
)


def _as_cost(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if not (n >= 0) or n > 1_000:
        return None
    return n


def extract_usage_cost_usd(obj: Any) -> float | None:
    """Best-effort USD cost from a tool return (OpenRouter usage.cost preferred)."""
    found: list[float] = []

    def walk(node: Any) -> None:
        if node is None:
            return
        if isinstance(node, str):
            s = node.strip()
            if not s or len(s) > 8_000:
                return
            if s.startswith("{") or s.startswith("["):
                try:
                    walk(json.loads(s))
                    return
                except json.JSONDecodeError:
                    pass
            for m in _COST_IN_TEXT_RE.finditer(s):
                c = _as_cost(m.group(1))
                if c is not None:
                    found.append(c)
            return
        if isinstance(node, dict):
            usage = node.get("usage")
            if isinstance(usage, dict):
                c = _as_cost(usage.get("cost"))
                if c is not None:
                    found.append(c)
                    return
            # Explicit cost on media metadata we may re-emit.
            if "cost_usd" in node:
                c = _as_cost(node.get("cost_usd"))
                if c is not None:
                    found.append(c)
            elif "cost" in node and not isinstance(node.get("cost"), dict):
                c = _as_cost(node.get("cost"))
                if c is not None:
                    found.append(c)
            for value in node.values():
                if value is usage:
                    continue
                walk(value)
            return
        if isinstance(node, (list, tuple)):
            for item in node:
                walk(item)
            return
        # pydantic BinaryContent / objects with .data — skip binary, walk attrs lightly
        text = getattr(node, "text", None)
        if isinstance(text, str):
            walk(text)
        content = getattr(node, "content", None)
        if content is not None and content is not node:
            walk(content)

    walk(obj)
    if not found:
        return None
    return round(sum(found), 6)


def estimate_image_generation_cost_usd(
    tool_name: str,
    tool_args: dict[str, Any] | None,
    *,
    image_count: int = 1,
) -> float | None:
    """Fallback per-image estimate when the tool result has no usage.cost."""
    if image_count <= 0:
        return None
    name = (tool_name or "").lower()
    if not any(k in name for k in ("generate_image", "generate-image", "image_gen", "flux")):
        # Still allow if args clearly name an image model.
        pass
    blob = " ".join(
        str(v)
        for v in (
            tool_name,
            *(tool_args or {}).values(),
        )
    ).lower()
    for needle, price in _IMAGE_COST_FALLBACKS:
        if needle in blob:
            return round(price * image_count, 6)
    if any(k in name.replace("-", "_") for k in ("generate_image", "image_gen")):
        return round(0.04 * image_count, 6)
    return None


def record_multimodal_cost(deps: Any, amount: float) -> None:
    """Accumulate multimodal USD onto deep deps + shared AgentRunState."""
    if amount <= 0:
        return
    current = float(getattr(deps, "multimodal_cost_usd", 0.0) or 0.0)
    deps.multimodal_cost_usd = round(current + amount, 6)
    state = getattr(deps, "_run_state", None)
    if state is not None:
        state_current = float(getattr(state, "multimodal_cost_usd", 0.0) or 0.0)
        state.multimodal_cost_usd = round(state_current + amount, 6)
