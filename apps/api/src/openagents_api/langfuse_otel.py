"""Fix Logfire → Langfuse OTEL attribute mapping for OpenAgents agent traces.

Langfuse Input must show the latest user message *and* full chat history
(system / tools / thinking). Setting ``langfuse.observation.input`` to only the
last user string replaces ``gen_ai.input.messages`` and drops history. Setting
nothing leaves Input as a huge messages blob with no clear user prompt.

We set ``langfuse.observation.input`` to a structured object:

  { "prompt": "<last user text>", "messages": [...], "tools": [...] }

so the UI gets a readable Input *and* the full message list.

Also maps ``operation.cost`` → ``gen_ai.usage.cost`` and falls back to OpenAgents prices.
"""

from __future__ import annotations

import json
from typing import Any

from opentelemetry.sdk.trace import ReadableSpan, SpanProcessor

_MAX_IO_CHARS = 500_000
_MAX_PROMPT_CHARS = 8_000


def _as_str(value: Any) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, default=str)


def _truncate(text: str, limit: int = _MAX_IO_CHARS) -> str:
    if len(text) <= limit:
        return text
    return text[: limit - 20] + "\n…[truncated]"


def _parse_jsonish(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return value
    return value


def _messages_list(value: Any) -> list[Any]:
    parsed = _parse_jsonish(value)
    if isinstance(parsed, list):
        return parsed
    if isinstance(parsed, dict):
        for key in ("messages", "all_messages", "events"):
            inner = parsed.get(key)
            if isinstance(inner, list):
                return inner
    return []


def _role_of(message: Any) -> str:
    if not isinstance(message, dict):
        return ""
    role = message.get("role") or message.get("kind") or message.get("type") or ""
    return str(role).lower()


def _message_text(message: Any) -> str | None:
    if isinstance(message, str):
        text = message.strip()
        return text or None
    if not isinstance(message, dict):
        return None

    content = message.get("content")
    if isinstance(content, str) and content.strip():
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, str) and part.strip():
                parts.append(part.strip())
            elif isinstance(part, dict):
                for key in ("text", "content", "input_text"):
                    val = part.get(key)
                    if isinstance(val, str) and val.strip():
                        parts.append(val.strip())
                        break
        if parts:
            return "\n".join(parts)

    parts = message.get("parts")
    if isinstance(parts, list):
        texts: list[str] = []
        for part in parts:
            if not isinstance(part, dict):
                continue
            if part.get("type") in {"text", "input_text", "output_text"} or "content" in part:
                val = part.get("content") or part.get("text")
                if isinstance(val, str) and val.strip():
                    texts.append(val.strip())
        if texts:
            return "\n".join(texts)

    return None


def _last_user_text(*candidates: Any) -> str | None:
    for candidate in candidates:
        messages = _messages_list(candidate)
        for message in reversed(messages):
            if _role_of(message) in {"user", "human"}:
                text = _message_text(message)
                if text:
                    return text
        if isinstance(candidate, str) and candidate.strip() and not candidate.strip().startswith(("[", "{")):
            return candidate.strip()
        parsed = _parse_jsonish(candidate)
        if isinstance(parsed, str) and parsed.strip():
            return parsed.strip()
    return None


def _last_assistant_text(*candidates: Any) -> str | None:
    for candidate in candidates:
        if candidate is None:
            continue
        parsed = _parse_jsonish(candidate)
        if isinstance(parsed, str) and parsed.strip():
            return parsed.strip()
        messages = _messages_list(candidate)
        for message in reversed(messages):
            if _role_of(message) in {"assistant", "model", "ai"}:
                text = _message_text(message)
                if text:
                    return text
        text = _message_text(parsed) if isinstance(parsed, dict) else None
        if text:
            return text
    return None


def _price_usd(model: str | None, input_tokens: int, output_tokens: int) -> float | None:
    if not model or (input_tokens <= 0 and output_tokens <= 0):
        return None
    from openagents_api.usage_tracking import estimate_run_cost_usd

    return estimate_run_cost_usd(
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
    )


def _system_content_from_attrs(attrs: dict[str, Any]) -> str | None:
    """Extract system instructions (Pydantic AI puts these outside input.messages)."""
    raw = attrs.get("gen_ai.system_instructions")
    if raw is None:
        return None
    parsed = _parse_jsonish(raw)
    if isinstance(parsed, str) and parsed.strip():
        return parsed.strip()
    if isinstance(parsed, list):
        chunks: list[str] = []
        for part in parsed:
            if isinstance(part, str) and part.strip():
                chunks.append(part.strip())
            elif isinstance(part, dict):
                text = part.get("content") or part.get("text")
                if isinstance(text, str) and text.strip():
                    chunks.append(text.strip())
        if chunks:
            return "\n".join(chunks)
    if isinstance(parsed, dict):
        text = parsed.get("content") or parsed.get("text")
        if isinstance(text, str) and text.strip():
            return text.strip()
    return None


def _messages_with_system(attrs: dict[str, Any], messages: list[Any]) -> list[Any]:
    """Ensure system instructions appear as a ``role=system`` message (Langfuse UI)."""
    if messages and _role_of(messages[0]) == "system":
        return messages
    system_text = _system_content_from_attrs(attrs)
    if not system_text:
        return messages
    return [{"role": "system", "content": system_text}, *messages]


def _build_observation_input(attrs: dict[str, Any]) -> str | None:
    """Readable prompt + full messages (+ tools) for Langfuse Input."""
    gen_in = attrs.get("gen_ai.input.messages")
    all_msgs = attrs.get("pydantic_ai.all_messages") or attrs.get("all_messages_events")
    prompt_attr = attrs.get("prompt")
    messages = _messages_list(gen_in) or _messages_list(all_msgs)
    messages = _messages_with_system(attrs, messages)
    user_text = _last_user_text(prompt_attr, gen_in, all_msgs)
    tools = _parse_jsonish(attrs.get("gen_ai.tool.definitions"))

    if not messages and not user_text:
        # System-only span (rare) — still show instructions.
        system_text = _system_content_from_attrs(attrs)
        if system_text:
            messages = [{"role": "system", "content": system_text}]
        else:
            return None

    if user_text and not messages and tools is None:
        return _truncate(user_text, _MAX_PROMPT_CHARS)

    payload: dict[str, Any] = {}
    if user_text:
        payload["prompt"] = _truncate(user_text, _MAX_PROMPT_CHARS)
    if messages:
        payload["messages"] = messages
    if tools is not None:
        payload["tools"] = tools
    return _truncate(_as_str(payload))


def enrich_span_attributes(attrs: dict[str, Any]) -> dict[str, Any]:
    """Return extra attributes to merge onto a span for Langfuse."""
    extra: dict[str, Any] = {}

    if "langfuse.observation.input" not in attrs:
        built = _build_observation_input(attrs)
        if built is not None:
            extra["langfuse.observation.input"] = built

    # Keep gen_ai.output.messages (thinking / tool calls). Only fill agent spans.
    if "langfuse.observation.output" not in attrs and "gen_ai.output.messages" not in attrs:
        final_result = attrs.get("final_result")
        all_msgs = attrs.get("pydantic_ai.all_messages") or attrs.get("all_messages_events")
        assistant_text = _last_assistant_text(final_result, all_msgs)
        if assistant_text:
            extra["langfuse.observation.output"] = _truncate(assistant_text)
        elif final_result is not None:
            extra["langfuse.observation.output"] = _truncate(_as_str(final_result))

    if "gen_ai.usage.cost" not in attrs:
        if "operation.cost" in attrs:
            extra["gen_ai.usage.cost"] = attrs["operation.cost"]
        else:
            model = attrs.get("gen_ai.request.model") or attrs.get("gen_ai.response.model")
            if isinstance(model, str):
                if ":" not in model and "/" in model:
                    model = f"openrouter:{model}"
                try:
                    inp_tok = int(attrs.get("gen_ai.usage.input_tokens") or 0)
                    out_tok = int(attrs.get("gen_ai.usage.output_tokens") or 0)
                except (TypeError, ValueError):
                    inp_tok, out_tok = 0, 0
                cost = _price_usd(model, inp_tok, out_tok)
                if cost is not None:
                    extra["gen_ai.usage.cost"] = cost

    return extra


class LangfuseAttributeProcessor(SpanProcessor):
    """Mutate span attributes before export so Langfuse shows cost + I/O correctly."""

    def on_start(self, span, parent_context=None) -> None:  # type: ignore[no-untyped-def]
        # Ensure Langfuse user/session attrs land even if Logfire baggage
        # copying races with span start (filter/aggregate needs them on every span).
        try:
            from opentelemetry import baggage

            ctx = parent_context
            bag = baggage.get_all(context=ctx) if ctx is not None else baggage.get_all()
            for key in (
                "langfuse.user.id",
                "user.id",
                "langfuse.session.id",
                "session.id",
            ):
                val = bag.get(key)
                if val is not None and key not in (span.attributes or {}):
                    span.set_attribute(key, val)
        except Exception:
            pass

    def on_end(self, span: ReadableSpan) -> None:
        attrs = span.attributes
        if not attrs:
            return
        extra = enrich_span_attributes(dict(attrs))
        if not extra:
            return
        try:
            merged = {**dict(attrs), **extra}
            object.__setattr__(span, "_attributes", merged)
        except Exception:
            pass

    def shutdown(self) -> None:
        return None

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return True


def langfuse_trace_baggage(*, user_id: str, session_id: str | None = None):
    """Attach Langfuse user/session ids to all spans created in this context.

    Logfire copies OpenTelemetry baggage onto span attributes when
    ``add_baggage_to_attributes`` is enabled (default).
    """
    import logfire

    values: dict[str, str] = {
        "langfuse.user.id": user_id,
        "user.id": user_id,
    }
    if session_id:
        values["langfuse.session.id"] = session_id
        values["session.id"] = session_id
    return logfire.set_baggage(**values)


def patch_model_response_cost_for_openrouter() -> None:
    """Prefer OpenRouter's returned USD cost when genai-prices has no model entry."""
    from decimal import Decimal
    from types import SimpleNamespace

    from pydantic_ai.messages import ModelResponse

    if getattr(ModelResponse.cost, "_openagents_openrouter_patched", False):
        return

    original = ModelResponse.cost

    def cost(self):  # type: ignore[no-untyped-def]
        try:
            return original(self)
        except LookupError:
            details = getattr(self, "provider_details", None) or {}
            raw = details.get("cost")
            if raw is None:
                raise
            return SimpleNamespace(total_price=Decimal(str(raw)))

    cost._openagents_openrouter_patched = True  # type: ignore[attr-defined]
    ModelResponse.cost = cost  # type: ignore[method-assign]
