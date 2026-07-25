"""Unit checks for agent.md enhance helpers (no live OpenRouter)."""

from openagents_api.enhance_agent_md import _strip_fences


def test_strip_fences_removes_markdown_wrapper() -> None:
    raw = "```markdown\n# Pack\n\nHello\n```"
    assert _strip_fences(raw) == "# Pack\n\nHello"


def test_strip_fences_passthrough() -> None:
    assert _strip_fences("# Pack\n\nBody") == "# Pack\n\nBody"
