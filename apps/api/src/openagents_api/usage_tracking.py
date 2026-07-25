"""Context-window and token-usage helpers for the chat UI."""

from __future__ import annotations

import io
import re
from typing import Any

from openagents_api.suggestions import AgentRunState

# Approx chars per token for Latin text — good enough for a UI meter.
_CHARS_PER_TOKEN = 4

# Injected by pydantic-ai-summarization when history is compressed.
_SUMMARY_PREFIX = "Summary of previous conversation:\n\n"

# Inline base64 blobs sometimes leak into message text / trace dumps.
_INLINE_IMAGE_RE = re.compile(
    r"(?:data:image/[a-zA-Z0-9.+-]+;base64,|iVBORw0KGgo)[A-Za-z0-9+/=\s]{200,}"
)

# Context windows from OpenRouter `/api/v1/models` (context_length).
MODEL_CONTEXT_WINDOWS: dict[str, int] = {
    "openrouter:anthropic/claude-sonnet-5": 1_000_000,
    "openrouter:x-ai/grok-4.5": 500_000,
    "openrouter:z-ai/glm-5.2": 1_048_576,
    "openrouter:openai/gpt-5.6-terra": 1_050_000,
}
DEFAULT_CONTEXT_WINDOW = 1_000_000

# OpenRouter list prices ($ / 1M tokens) — fallback when genai_prices lacks a model.
MODEL_PRICES_PER_M: dict[str, tuple[float, float]] = {
    "openrouter:z-ai/glm-5.2": (0.93, 3.0),
    "openrouter:anthropic/claude-sonnet-5": (2.0, 10.0),
    "openrouter:openai/gpt-5.6-terra": (2.5, 15.0),
}


# Tool schemas don't live in AgentRunState; use a stable estimate.
TOOL_DEFINITIONS_TOKENS = 2_400


def estimate_tokens(text: str) -> int:
    if not text:
        return 0
    return max(1, (len(text) + _CHARS_PER_TOKEN - 1) // _CHARS_PER_TOKEN)


def context_window_for_model(model: str) -> int:
    if model in MODEL_CONTEXT_WINDOWS:
        return MODEL_CONTEXT_WINDOWS[model]
    bare = model.split(":", 1)[-1].lower()
    for key, value in MODEL_CONTEXT_WINDOWS.items():
        if key.split(":", 1)[-1].lower() == bare:
            return value
    if "grok" in bare:
        return 500_000
    return DEFAULT_CONTEXT_WINDOW


def _strip_inline_image_blobs(text: str) -> str:
    """Remove base64 image dumps so the meter doesn't treat pixels as text tokens."""
    return _INLINE_IMAGE_RE.sub("[image omitted]", text)


def _is_binary_content(value: Any) -> bool:
    if value is None or isinstance(value, (str, bytes, bytearray)):
        return False
    return hasattr(value, "data") and hasattr(value, "media_type")


def _estimate_binary_tokens(binary: Any) -> int:
    """Approximate vision tokens from image dimensions (Claude-style width*height/750)."""
    data = getattr(binary, "data", None) or b""
    if not isinstance(data, (bytes, bytearray)) or not data:
        return 85
    try:
        from PIL import Image

        with Image.open(io.BytesIO(data)) as img:
            width, height = img.size
            return max(85, (int(width) * int(height)) // 750)
    except Exception:
        # Compressed bytes ≠ pixels; keep a small floor so one image can't look like MTok.
        return max(85, min(2_000, len(data) // 2_000))


def _iter_content_units(content: Any) -> list[tuple[str, Any]]:
    """Flatten part content into ('text', str) | ('binary', BinaryContent) units."""
    if content is None:
        return []
    if isinstance(content, str):
        return [("text", content)]
    if _is_binary_content(content):
        return [("binary", content)]
    if isinstance(content, (list, tuple)):
        units: list[tuple[str, Any]] = []
        for item in content:
            units.extend(_iter_content_units(item))
        return units
    # Never str() BinaryContent-like dumps into the meter.
    rendered = str(content)
    if "BinaryContent(" in rendered or "iVBORw0KGgo" in rendered:
        return [("text", "[non-text content omitted]")]
    return [("text", rendered)]


def estimate_message_parts(messages: list[Any] | None) -> tuple[int, int, int]:
    """Estimate (conversation_text, summarization, vision) tokens from history."""
    text_tokens = 0
    summary_tokens = 0
    vision_tokens = 0
    if not messages:
        return 0, 0, 0

    for msg in messages:
        parts = getattr(msg, "parts", None) or []
        for part in parts:
            for kind, value in _iter_content_units(getattr(part, "content", None)):
                if kind == "binary":
                    vision_tokens += _estimate_binary_tokens(value)
                    continue
                text = _strip_inline_image_blobs(value)
                if text.startswith(_SUMMARY_PREFIX) or _SUMMARY_PREFIX in text:
                    # Count the summary block under Summarization, not Conversation.
                    if text.startswith(_SUMMARY_PREFIX):
                        summary_tokens += estimate_tokens(text)
                    else:
                        before, _, after = text.partition(_SUMMARY_PREFIX)
                        if before.strip():
                            text_tokens += estimate_tokens(before)
                        summary_tokens += estimate_tokens(_SUMMARY_PREFIX + after)
                else:
                    text_tokens += estimate_tokens(text)
    return text_tokens, summary_tokens, vision_tokens


def _message_text(msg: Any) -> str:
    """Best-effort plain text from a pydantic-ai ModelMessage (no binary dumps)."""
    chunks: list[str] = []
    for part in getattr(msg, "parts", None) or []:
        for kind, value in _iter_content_units(getattr(part, "content", None)):
            if kind == "text":
                chunks.append(_strip_inline_image_blobs(value))
            else:
                chunks.append("[image]")
    return "\n".join(chunks)


def _static_price_rates(model: str) -> tuple[float, float] | None:
    rates = MODEL_PRICES_PER_M.get(model)
    if rates is not None:
        return rates
    bare = model.split(":", 1)[-1].lower() if ":" in model else model.lower()
    for key, value in MODEL_PRICES_PER_M.items():
        if key.split(":", 1)[-1].lower() == bare:
            return value
    return None


def _cost_from_messages(messages: list[Any] | None) -> float | None:
    """Sum ModelResponse.cost when OpenRouter / genai_prices can price each reply."""
    if not messages:
        return None
    total = 0.0
    found = False
    for msg in messages:
        cost_attr = getattr(msg, "cost", None)
        if cost_attr is None:
            continue
        try:
            price = cost_attr() if callable(cost_attr) else cost_attr
            total += float(price.total_price)
            found = True
        except Exception:
            continue
    return total if found else None


def estimate_run_cost_usd(
    *,
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int = 0,
    cache_write_tokens: int = 0,
    messages: list[Any] | None = None,
) -> float | None:
    """USD for one run.

    Order: message-level costs (incl. OpenRouter usage accounting) → genai_prices
    → hardcoded MODEL_PRICES_PER_M → admin catalog list prices.
    """
    from_messages = _cost_from_messages(messages)
    if from_messages is not None:
        return from_messages

    if model.strip().lower().startswith("openrouter:"):
        try:
            from genai_prices import calc_price
            from pydantic_ai.usage import RequestUsage

            bare = model.split(":", 1)[-1] if ":" in model else model
            price = calc_price(
                RequestUsage(
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    cache_read_tokens=cache_read_tokens,
                    cache_write_tokens=cache_write_tokens,
                ),
                bare,
                provider_id="openrouter",
            )
            return float(price.total_price)
        except Exception:
            pass

    rates = _static_price_rates(model)
    if rates is None:
        try:
            from openagents_api.model_settings import price_rates_for_model

            rates = price_rates_for_model(model)
        except Exception:
            rates = None
    if rates is None:
        return None

    # Cache-read/write billed as uncached input when we only have list rates
    # (conservative vs typical discounted cache pricing).
    billable_input = input_tokens + cache_read_tokens + cache_write_tokens
    return (billable_input * rates[0] + output_tokens * rates[1]) / 1_000_000


def build_usage_payload(
    *,
    state: AgentRunState,
    usage: Any,
    messages: list[Any] | None = None,
    system_instructions: str = "",
) -> dict[str, Any]:
    """Build a CUSTOM `usage` event payload for the web client.

    Context meter ≈ what's filling the window (input-side).
    Cost meter = billed tokens for this run (input + output).
    """
    model = state.model or ""
    context_max = context_window_for_model(model)

    system_tokens = estimate_tokens(system_instructions)
    persona_tokens = estimate_tokens(
        f"{state.agent_md or ''}\n{state.soul_md or ''}"
    )
    skills_catalog_tokens = estimate_tokens(state.skills_catalog_text or "")
    loaded_skills_tokens = estimate_tokens(state.loaded_skill_text or "")
    memory_tokens = 0
    if state.workspace_dir:
        from pathlib import Path

        for rel in ("memory/preferences.md", "memory/company.md"):
            path = Path(state.workspace_dir) / rel
            if path.exists():
                memory_tokens += estimate_tokens(path.read_text(encoding="utf-8")[:4000])
    # Document body is fetched via read_document / file tools — not injected into system prompt.
    document_tokens = 0
    pending_tokens = estimate_tokens(state.pending_changes_text or "")
    # Todo tools + existing domain tools inflate schemas slightly.
    tools_tokens = TOOL_DEFINITIONS_TOKENS + 800

    text_tokens, summary_tokens, vision_tokens = estimate_message_parts(messages)
    conversation_tokens = text_tokens + vision_tokens

    breakdown = [
        {"id": "system", "label": "System prompt", "tokens": system_tokens},
        {"id": "persona", "label": "Persona (agent.md / soul.md)", "tokens": persona_tokens},
        {"id": "skills", "label": "Skills catalog", "tokens": skills_catalog_tokens},
        {
            "id": "loaded_skills",
            "label": "Loaded skills"
            + (f" ({', '.join(state.loaded_skills)})" if state.loaded_skills else ""),
            "tokens": loaded_skills_tokens,
        },
        {"id": "memory", "label": "Workspace memory", "tokens": memory_tokens},
        {"id": "document", "label": "Document (via tools)", "tokens": document_tokens},
        {"id": "pending", "label": "Pending changes", "tokens": pending_tokens},
        {"id": "tools", "label": "Tool definitions", "tokens": tools_tokens},
    ]
    if summary_tokens > 0:
        breakdown.append(
            {
                "id": "summarization",
                "label": "Summarization",
                "tokens": summary_tokens,
            }
        )
    breakdown.append(
        {"id": "conversation", "label": "Conversation", "tokens": conversation_tokens}
    )

    estimated_context = sum(item["tokens"] for item in breakdown)

    input_tokens = int(getattr(usage, "input_tokens", 0) or 0)
    output_tokens = int(getattr(usage, "output_tokens", 0) or 0)
    requests = int(getattr(usage, "requests", 0) or 0)
    cache_read = int(getattr(usage, "cache_read_tokens", 0) or 0)
    cache_write = int(getattr(usage, "cache_write_tokens", 0) or 0)
    run_total = input_tokens + output_tokens

    fixed = (
        system_tokens
        + persona_tokens
        + skills_catalog_tokens
        + loaded_skills_tokens
        + memory_tokens
        + document_tokens
        + pending_tokens
        + tools_tokens
        + summary_tokens
    )

    # Provider input_tokens is often only the *uncached* part of the prompt.
    # Cached tokens are still in the window — same text as system/tools/history,
    # just billed as a cache hit. For a single request, window ≈ uncached + cache read.
    # For multi-request runs, summed provider tokens overstate fill % — use the
    # compositional estimate (with binary/base64 stripped) instead.
    if requests <= 1 and (input_tokens > 0 or cache_read > 0):
        context_used = input_tokens + cache_read
        conversation_tokens = max(0, context_used - fixed)
        for item in breakdown:
            if item["id"] == "conversation":
                item["tokens"] = conversation_tokens
                break
    else:
        context_used = estimated_context

    token_cost_usd = estimate_run_cost_usd(
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cache_read_tokens=cache_read,
        cache_write_tokens=cache_write,
        messages=messages,
    )
    multimodal_cost_usd = float(getattr(state, "multimodal_cost_usd", 0.0) or 0.0)
    if multimodal_cost_usd < 0:
        multimodal_cost_usd = 0.0
    multimodal_cost_usd = round(multimodal_cost_usd, 6)

    cost_usd: float | None
    if token_cost_usd is None and multimodal_cost_usd <= 0:
        cost_usd = None
    else:
        cost_usd = round(float(token_cost_usd or 0.0) + multimodal_cost_usd, 6)

    return {
        "model": model,
        "context_max": context_max,
        "context_used": context_used,
        "context_pct": round(min(1.0, context_used / context_max), 4) if context_max else 0.0,
        "breakdown": breakdown,
        "run": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": run_total,
            "requests": requests,
            "cache_read_tokens": cache_read,
            "cache_write_tokens": cache_write,
            "cost_usd": cost_usd,
            "token_cost_usd": token_cost_usd,
            "multimodal_cost_usd": multimodal_cost_usd,
        },
    }


def merge_thread_usage(existing: dict | None, payload: dict[str, Any]) -> dict[str, Any]:
    """Accumulate session totals onto the thread-stored usage snapshot."""
    prev = existing or {}
    run = payload.get("run") or {}
    input_tokens = int(run.get("input_tokens") or 0)
    output_tokens = int(run.get("output_tokens") or 0)
    total_tokens = int(run.get("total_tokens") or (input_tokens + output_tokens))
    return {
        "context_max": payload.get("context_max"),
        "context_used": payload.get("context_used"),
        "context_pct": payload.get("context_pct"),
        "breakdown": payload.get("breakdown") or [],
        "session_tokens": int(prev.get("session_tokens") or 0) + total_tokens,
        "session_input_tokens": int(prev.get("session_input_tokens") or 0) + input_tokens,
        "session_output_tokens": int(prev.get("session_output_tokens") or 0) + output_tokens,
        "last_run_tokens": total_tokens,
    }


def merge_spend_totals(existing: dict | None, payload: dict[str, Any]) -> dict[str, Any]:
    """Accumulate lifetime user spend — never decreased when threads are deleted."""
    prev = existing or {}
    run = payload.get("run") or {}
    input_tokens = int(run.get("input_tokens") or 0)
    output_tokens = int(run.get("output_tokens") or 0)
    total_tokens = int(run.get("total_tokens") or (input_tokens + output_tokens))
    run_cost = run.get("cost_usd")
    prev_cost = prev.get("total_cost_usd")
    total_cost: float | None = None
    if isinstance(run_cost, (int, float)) or isinstance(prev_cost, (int, float)):
        total_cost = float(prev_cost or 0) + float(run_cost or 0)

    run_token_cost = run.get("token_cost_usd")
    run_multi_cost = run.get("multimodal_cost_usd")
    # Back-compat: older runs only had total cost — treat as token cost.
    if run_token_cost is None and run_multi_cost is None and isinstance(run_cost, (int, float)):
        run_token_cost = float(run_cost)
        run_multi_cost = 0.0
    prev_token = prev.get("token_cost_usd")
    prev_multi = prev.get("multimodal_cost_usd")
    if prev_token is None and prev_multi is None and isinstance(prev_cost, (int, float)):
        prev_token = float(prev_cost)
        prev_multi = 0.0
    token_cost_usd = float(prev_token or 0) + float(run_token_cost or 0)
    multimodal_cost_usd = float(prev_multi or 0) + float(run_multi_cost or 0)

    return {
        "total_tokens": int(prev.get("total_tokens") or 0) + total_tokens,
        "input_tokens": int(prev.get("input_tokens") or 0) + input_tokens,
        "output_tokens": int(prev.get("output_tokens") or 0) + output_tokens,
        "run_count": int(prev.get("run_count") or 0) + 1,
        "total_cost_usd": total_cost,
        "token_cost_usd": round(token_cost_usd, 6),
        "multimodal_cost_usd": round(multimodal_cost_usd, 6),
        "last_run_tokens": total_tokens,
    }


def spent_usd(spend_totals: dict | None) -> float:
    """Lifetime cost so far (missing cost treated as $0)."""
    if not spend_totals:
        return 0.0
    raw = spend_totals.get("total_cost_usd")
    try:
        return max(0.0, float(raw or 0))
    except (TypeError, ValueError):
        return 0.0


def resolve_spend_budget_usd(
    stored: float | None,
    *,
    default: float = 5.0,
) -> float:
    """Normalize a stored budget; fall back to default when unset/invalid."""
    try:
        if stored is None:
            return float(default)
        return max(0.0, float(stored))
    except (TypeError, ValueError):
        return float(default)


def spend_budget_exceeded(
    spend_totals: dict | None,
    budget_usd: float,
) -> bool:
    """True when lifetime cost has reached/exceeded the budget."""
    return spent_usd(spend_totals) >= float(budget_usd)
