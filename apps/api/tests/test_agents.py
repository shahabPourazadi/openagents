"""Agent loader — built-in agents under repo agents/."""

from __future__ import annotations

import pytest

from openagents_api.agents import (
    DEFAULT_AGENT_SLUG,
    AgentError,
    list_builtin_agents,
    load_agent,
    agents_root,
)


def test_agents_root_points_at_repo_packs() -> None:
    root = agents_root()
    assert root.name == "agents"
    assert root.is_dir()


def test_list_builtin_agents_includes_stubs() -> None:
    manifests = list_builtin_agents()
    slugs = {m.slug for m in manifests}
    assert "agent" in slugs
    assert "research-assistant" in slugs
    assert "coding-assistant" in slugs
    assert "agent-builder" in slugs
    research = next(m for m in manifests if m.slug == "research-assistant")
    assert research.uses_document is True
    coding = next(m for m in manifests if m.slug == "coding-assistant")
    assert coding.uses_document is False


def test_default_pack_is_auto_agent() -> None:
    assert DEFAULT_AGENT_SLUG == "agent"
    pack = load_agent(DEFAULT_AGENT_SLUG)
    assert pack.slug == "agent"
    assert pack.manifest.name == "Auto Agent"
    assert pack.manifest.icon == "mouse-pointer-2"


def test_load_agent_research_assistant() -> None:
    pack = load_agent("research-assistant")
    assert pack.slug == "research-assistant"
    assert pack.manifest.name
    assert "Research" in pack.agent_md or "research" in pack.agent_md.lower()
    assert pack.system_prompt
    assert pack.document_template_md
    assert any(s.slug == "research" for s in pack.skills)


def test_load_agent_coding_assistant_no_document() -> None:
    pack = load_agent("coding-assistant")
    assert pack.manifest.uses_document is False
    assert pack.document_template_md == ""


def test_load_agent_missing_raises() -> None:
    with pytest.raises(AgentError, match="not found"):
        load_agent("does-not-exist-pack")


def test_load_agent_invalid_slug_raises() -> None:
    with pytest.raises(AgentError, match="Invalid"):
        load_agent("../etc")


def test_load_agent_missing_agent_md(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    pack_dir = tmp_path / "broken-pack"
    pack_dir.mkdir()
    (pack_dir / "agent.yaml").write_text(
        "name: Broken\nslug: broken-pack\nuses_document: false\n",
        encoding="utf-8",
    )
    monkeypatch.setattr("openagents_api.agents.agents_root", lambda: tmp_path)
    with pytest.raises(AgentError, match="missing agent.md"):
        load_agent("broken-pack")
