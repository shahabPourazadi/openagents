"""Pack / agent eval scenarios.

Default CI runs unit-level pack loads and validation failures (no LLM).
Tests marked ``@pytest.mark.eval`` skip unless ``OPENAGENTS_EVALS=1`` and
``OPENROUTER_API_KEY`` are set — see docs/evals.md.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
import yaml

from openagents_api.agents import (
    AgentError,
    AgentManifest,
    list_builtin_agents,
    load_agent,
    validate_agent_draft,
    validate_agent_slug,
)

BUILTIN_SLUGS = ("agent", "research-assistant", "coding-assistant", "agent-builder")


def _evals_enabled() -> bool:
    return os.getenv("OPENAGENTS_EVALS", "").strip() == "1" and bool(
        os.getenv("OPENROUTER_API_KEY", "").strip()
    )


# ---------------------------------------------------------------------------
# Always-on pack scenarios (no LLM)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("slug", BUILTIN_SLUGS)
def test_eval_builtin_pack_loads(slug: str) -> None:
    pack = load_agent(slug)
    assert pack.slug == slug
    assert pack.manifest.name
    assert pack.agent_md.strip()
    assert pack.system_prompt.strip()
    assert pack.source == "builtin"


def test_eval_list_builtin_agents_complete() -> None:
    slugs = {m.slug for m in list_builtin_agents()}
    for slug in BUILTIN_SLUGS:
        assert slug in slugs


def test_eval_research_assistant_has_document_and_skills() -> None:
    pack = load_agent("research-assistant")
    assert pack.manifest.uses_document is True
    assert pack.document_template_md.strip()
    skill_slugs = {s.slug for s in pack.skills}
    assert "research" in skill_slugs
    assert "synthesize" in skill_slugs


def test_eval_coding_assistant_chat_only() -> None:
    pack = load_agent("coding-assistant")
    assert pack.manifest.uses_document is False
    assert pack.document_template_md == ""
    assert any(s.slug == "code-review" for s in pack.skills)


def test_eval_pack_builder_has_authoring_skill() -> None:
    pack = load_agent("agent-builder")
    assert pack.manifest.uses_document is False
    assert any(s.slug == "agent-authoring" for s in pack.skills)


def test_eval_agent_generalist_and_merged_skills(tmp_path: Path) -> None:
    from openagents_api.agents import materialize_agent_skills

    pack = load_agent("agent")
    assert pack.manifest.uses_document is True
    assert pack.manifest.icon == "mouse-pointer-2"
    assert any(s.slug == "triage" for s in pack.skills)
    root = materialize_agent_skills(tmp_path, pack)
    skill_dirs = {p.name for p in root.iterdir() if p.is_dir()}
    assert "triage" in skill_dirs
    assert "research" in skill_dirs
    assert "code-review" in skill_dirs
    assert "agent-authoring" in skill_dirs


def test_eval_specialist_gets_full_skill_inventory(tmp_path: Path) -> None:
    """Non-generalist agents still materialize other agents' playbooks for `/`."""
    from openagents_api.agents import materialize_agent_skills

    pack = load_agent("coding-assistant")
    root = materialize_agent_skills(tmp_path, pack)
    skill_dirs = {p.name for p in root.iterdir() if p.is_dir()}
    assert "code-review" in skill_dirs
    assert "iterate-on-failure" in skill_dirs
    assert "triage" in skill_dirs
    assert "research" in skill_dirs
    assert "agent-authoring" in skill_dirs


def test_eval_pack_yaml_missing_name(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    pack_dir = tmp_path / "bad-yaml"
    pack_dir.mkdir()
    (pack_dir / "agent.yaml").write_text("description: no name\n", encoding="utf-8")
    (pack_dir / "agent.md").write_text("# Agent\n", encoding="utf-8")
    monkeypatch.setattr("openagents_api.agents.agents_root", lambda: tmp_path)
    with pytest.raises(AgentError, match="invalid agent.yaml"):
        load_agent("bad-yaml")


def test_eval_pack_yaml_not_mapping(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    pack_dir = tmp_path / "list-yaml"
    pack_dir.mkdir()
    (pack_dir / "agent.yaml").write_text("- just\n- a\n- list\n", encoding="utf-8")
    (pack_dir / "agent.md").write_text("# Agent\n", encoding="utf-8")
    monkeypatch.setattr("openagents_api.agents.agents_root", lambda: tmp_path)
    with pytest.raises(AgentError, match="must be a mapping"):
        load_agent("list-yaml")


def test_eval_pack_yaml_invalid_syntax(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    pack_dir = tmp_path / "broken-yaml"
    pack_dir.mkdir()
    (pack_dir / "agent.yaml").write_text("name: [unterminated\n", encoding="utf-8")
    (pack_dir / "agent.md").write_text("# Agent\n", encoding="utf-8")
    monkeypatch.setattr("openagents_api.agents.agents_root", lambda: tmp_path)
    with pytest.raises(AgentError, match="invalid YAML"):
        load_agent("broken-yaml")


def test_eval_empty_agent_md(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    pack_dir = tmp_path / "empty-agent"
    pack_dir.mkdir()
    (pack_dir / "agent.yaml").write_text(
        "name: Empty\nslug: empty-agent\nuses_document: false\n",
        encoding="utf-8",
    )
    (pack_dir / "agent.md").write_text("   \n", encoding="utf-8")
    monkeypatch.setattr("openagents_api.agents.agents_root", lambda: tmp_path)
    with pytest.raises(AgentError, match="agent.md is empty"):
        load_agent("empty-agent")


def test_eval_validate_agent_draft_requires_name_and_agent() -> None:
    with pytest.raises(AgentError, match="name"):
        validate_agent_draft(name="", agent_md="hello")
    with pytest.raises(AgentError, match="agent_md"):
        validate_agent_draft(name="Ok", agent_md="  ")
    validate_agent_draft(name="Ok", agent_md="# Agent")


def test_eval_validate_agent_slug_rejects_traversal() -> None:
    with pytest.raises(AgentError, match="Invalid"):
        validate_agent_slug("../etc")


def test_eval_manifest_roundtrip_from_builtin_yaml() -> None:
    """Each built-in agent.yaml validates as AgentManifest."""
    from openagents_api.agents import agents_root

    root = agents_root()
    for slug in BUILTIN_SLUGS:
        raw = yaml.safe_load((root / slug / "agent.yaml").read_text(encoding="utf-8"))
        manifest = AgentManifest.model_validate(raw)
        assert manifest.name


# ---------------------------------------------------------------------------
# Opt-in live evals (LLM)
# ---------------------------------------------------------------------------


@pytest.mark.eval
@pytest.mark.skipif(not _evals_enabled(), reason="Set OPENAGENTS_EVALS=1 and OPENROUTER_API_KEY")
def test_eval_pack_builder_structure_smoke() -> None:
    """Optional smoke: Pack Builder pack itself is structurally valid for generation.

    A full LLM round-trip that writes a new pack is intentionally not run in
    default CI. Enable with OPENAGENTS_EVALS=1 when you want a live check stub.
    """
    pack = load_agent("agent-builder")
    # Structural contract the Pack Builder agent is expected to produce for others.
    assert "agent.yaml" in pack.agent_md.lower() or "agent" in pack.agent_md.lower()
    assert pack.skills, "agent-builder should ship authoring skills"
    # Key present so live harnesses can call OpenRouter without re-reading env shape.
    assert os.environ["OPENROUTER_API_KEY"]
