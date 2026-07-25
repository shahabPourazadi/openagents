"""Generate a short, meaningful chat thread title from the first user message."""

from __future__ import annotations

import os
import re

from pydantic_ai import Agent

    # Cheap/fast model for a 2–6 word title.
_TITLE_MODEL = "openrouter:openai/gpt-4o-mini"

_TITLE_INSTRUCTIONS = (
    "You name chat threads. Given the user's first message, reply with ONLY a short title "
    "(2–6 words) that captures the intent or topic — not a quote of the message. "
    'Examples: "hi" → Greeting; "hey there" → Greeting; '
    '"help me debug a failing test" → Test debug help; '
    '"summarize this research paper" → Paper summary. '
    "No quotes, trailing punctuation, or explanation."
)


def _fallback_title(user_message: str) -> str:
    text = re.sub(r"\s+", " ", user_message.strip())
    return text[:60] if text else "New chat"


def _clean_title(raw: str, fallback: str) -> str:
    title = re.sub(r"\s+", " ", (raw or "").strip().strip("\"'"))
    title = title.rstrip(".,;:!")
    if not title or len(title) > 80:
        return fallback
    return title[:60]


async def generate_thread_title(user_message: str, *, api_key: str) -> str:
    """Return a concise thread title. Falls back to truncated message text on failure."""
    fallback = _fallback_title(user_message)
    if not api_key or not user_message.strip():
        return fallback
    try:
        # Must set before Agent init — OpenRouter provider reads the env at construct time.
        os.environ["OPENROUTER_API_KEY"] = api_key
        from openagents_api.model_settings import openrouter_usage_settings

        agent: Agent[None, str] = Agent(
            _TITLE_MODEL,
            output_type=str,
            instructions=_TITLE_INSTRUCTIONS,
            model_settings=openrouter_usage_settings(),
        )
        result = await agent.run(f"User message:\n{user_message.strip()[:500]}")
        return _clean_title(result.output, fallback)
    except Exception:
        return fallback
