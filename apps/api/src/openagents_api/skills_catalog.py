"""Skill catalog helpers — progressive disclosure for SKILL.md packs."""

from __future__ import annotations

import re
from pathlib import Path

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)


def _parse_frontmatter(text: str) -> dict[str, str]:
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return {}
    meta: dict[str, str] = {}
    for line in m.group(1).splitlines():
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        meta[key.strip()] = value.strip().strip("\"'")
    return meta


def list_skill_metas(skills_dir: Path) -> list[dict[str, str]]:
    """Return [{name, description, path}] for each skill folder with SKILL.md."""
    if not skills_dir.exists():
        return []
    out: list[dict[str, str]] = []
    for folder in sorted(skills_dir.iterdir()):
        if not folder.is_dir():
            continue
        skill_file = folder / "SKILL.md"
        if not skill_file.exists():
            continue
        text = skill_file.read_text(encoding="utf-8")
        meta = _parse_frontmatter(text)
        name = meta.get("name") or folder.name
        description = meta.get("description") or "Skill playbook"
        out.append({"name": name, "description": description, "path": str(skill_file)})
    return out


def skills_catalog_prompt(skills_dir: Path) -> str:
    """Compact catalog injected into system instructions so the model always sees skills."""
    skills = list_skill_metas(skills_dir)
    if not skills:
        return "## Available skills\n\nNo skills installed."

    lines = [
        "## Available skills (progressive disclosure)",
        "",
        "These skill packs are installed. **Call `load_skill(name)` before following a playbook** "
        "so you get the full workflow. Do not invent skill names.",
        "",
    ]
    for s in skills:
        lines.append(f"- `{s['name']}` — {s['description']}")
    lines.append("")
    lines.append(
        "Always call `load_skill(name)` before following a playbook. "
        "When blocked on high-impact facts, call `ask_user` with 1–4 questions "
        "(2–4 options each) and end the turn; after answers, continue todos — "
        "do not replace the plan with write_todos."
    )
    return "\n".join(lines)


def skills_catalog_text_for_usage(skills_dir: Path) -> str:
    return skills_catalog_prompt(skills_dir)
