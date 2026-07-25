"""Rewrite rough agent notes into a solid Agent agent.md."""

from __future__ import annotations

import os
import re

from pydantic_ai import Agent

_ENHANCE_MODEL = "openrouter:openai/gpt-4o-mini"

_ENHANCE_INSTRUCTIONS = """\
You rewrite drafts into OpenAgents Agent `agent.md` files.

Output ONLY the markdown body for agent.md — no code fences, no preamble.

Structure (adapt section titles to the agent; omit sections that do not apply):

# <Agent name>

One short paragraph: who you help and what success looks like.

## Operating loop
Numbered steps the agent should follow each turn (clarify → plan → act → verify).

## Conventions
How to structure work (document headings, file layout, communication style).

## Tools to prefer
A short markdown table or bullets mapping goals to tools when relevant
(e.g. read_document / suggest_edit when a document editor is on;
filesystem/sandbox for coding; ask_user for ambiguity; web MCP when researching).

## Constraints
Honesty rules: no invented sources, no silent failures, HITL for document edits
when uses_document is true, etc.

Rules:
- Preserve the user's intent and domain; do not invent a different product.
- Be concrete and actionable; prefer short bullets over essays.
- If the draft is empty or tiny, expand from agent name + description only.
- Keep under ~80 lines.
- Do not mention that you are an AI rewriting a prompt.
"""


def _strip_fences(text: str) -> str:
    raw = (text or "").strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:markdown|md)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
    return raw.strip()


async def enhance_agent_md(
    *,
    draft: str,
    name: str = "",
    description: str = "",
    uses_document: bool = False,
    api_key: str,
) -> str:
    """Return enhanced agent.md markdown. Raises ValueError if no API key / empty result."""
    if not api_key:
        raise ValueError("OpenRouter API key is not configured")

    pack_name = (name or "").strip() or "Untitled agent"
    desc = (description or "").strip()
    notes = (draft or "").strip()

    user_prompt = (
        f"Agent name: {pack_name}\n"
        f"Description: {desc or '(none)'}\n"
        f"Document editor enabled: {uses_document}\n\n"
        f"User draft / notes:\n{notes or '(empty — invent a sensible minimal agent.md)'}\n"
    )

    os.environ["OPENROUTER_API_KEY"] = api_key
    from openagents_api.model_settings import openrouter_usage_settings

    agent: Agent[None, str] = Agent(
        _ENHANCE_MODEL,
        output_type=str,
        instructions=_ENHANCE_INSTRUCTIONS,
        model_settings=openrouter_usage_settings(),
    )
    result = await agent.run(user_prompt[:8000])
    enhanced = _strip_fences(result.output)
    if not enhanced:
        raise ValueError("Model returned empty instructions")
    return enhanced
