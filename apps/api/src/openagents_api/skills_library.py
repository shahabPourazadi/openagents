"""Library skills — built-in ``skills/<slug>/`` + owner ``user_skills`` rows."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from openagents_api.agents import AgentError, slugify_agent_name, validate_agent_slug

_SLUG_RE = re.compile(r"[^a-z0-9]+")


class LibrarySkill(BaseModel):
    slug: str
    name: str
    description: str = ""
    icon: str = ""
    content: str
    source: str = "builtin"  # builtin | user

    model_config = {"arbitrary_types_allowed": True}


DEFAULT_SKILL_ICON = "pencil-ruler"
_MAX_PREDEFINED_SKILL_CHARS = 12_000


def normalize_skill_slugs(raw: Any) -> list[str]:
    """Dedupe and validate a list of library skill slug strings."""
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        slug = str(item or "").strip().lower()
        if not slug or slug in seen:
            continue
        try:
            slug = validate_agent_slug(slug)
        except AgentError:
            continue
        seen.add(slug)
        out.append(slug)
    return out


def format_predefined_skills_prompt(skills: list[LibrarySkill]) -> str:
    """Inline selected library skills for system instructions."""
    if not skills:
        return ""
    parts = [
        "## Predefined skills (rooted for this agent)",
        "Follow these playbooks when relevant — they are part of this agent's "
        "defaults. The full skills library remains available under `skills/` "
        "for on-demand load; only the skills listed here are always in context.",
    ]
    for skill in skills:
        body = (skill.content or "").strip()
        if len(body) > _MAX_PREDEFINED_SKILL_CHARS:
            body = body[:_MAX_PREDEFINED_SKILL_CHARS].rstrip() + "\n\n…(truncated)"
        title = skill.name or skill.slug
        parts.append(f"### /{skill.slug} — {title}\n\n{body}")
    return "\n\n".join(parts)


class SkillError(AgentError):
    """Invalid or missing library skill."""


def skills_root() -> Path:
    """Repo ``skills/`` directory (library builtins)."""
    from openagents_api.config import get_settings

    settings = get_settings()
    custom = getattr(settings, "skills_dir", None) or ""
    if custom:
        path = Path(custom)
        if path.is_dir():
            return path
    repo = Path(__file__).resolve().parents[4]
    candidate = repo / "skills"
    return candidate


def _read_skill_md(path: Path) -> tuple[str, str, str, str]:
    """Return (name, description, icon, full_content) from a SKILL.md file."""
    content = path.read_text(encoding="utf-8")
    name = path.parent.name
    description = ""
    icon = ""
    if content.startswith("---"):
        parts = content.split("---", 2)
        if len(parts) >= 3:
            try:
                meta = yaml.safe_load(parts[1]) or {}
                if isinstance(meta, dict):
                    if meta.get("name"):
                        name = str(meta["name"])
                    if meta.get("description"):
                        description = str(meta["description"])
                    if meta.get("icon"):
                        icon = str(meta["icon"]).strip()
            except yaml.YAMLError:
                pass
    return name, description, icon, content


def list_builtin_library_skills() -> list[LibrarySkill]:
    root = skills_root()
    if not root.is_dir():
        return []
    out: list[LibrarySkill] = []
    for child in sorted(root.iterdir()):
        if not child.is_dir() or child.name.startswith("."):
            continue
        skill_md = child / "SKILL.md"
        if not skill_md.is_file():
            continue
        try:
            slug = validate_agent_slug(child.name)
        except AgentError:
            continue
        name, description, icon, content = _read_skill_md(skill_md)
        if not content.strip():
            continue
        out.append(
            LibrarySkill(
                slug=slug,
                name=name,
                description=description,
                icon=icon or DEFAULT_SKILL_ICON,
                content=content,
                source="builtin",
            )
        )
    return out


def load_builtin_library_skill(slug: str) -> LibrarySkill:
    slug = validate_agent_slug(slug)
    path = skills_root() / slug / "SKILL.md"
    if not path.is_file():
        raise SkillError(f"Skill not found: {slug}")
    name, description, icon, content = _read_skill_md(path)
    if not content.strip():
        raise SkillError(f"Skill {slug!r} SKILL.md is empty")
    return LibrarySkill(
        slug=slug,
        name=name,
        description=description,
        icon=icon or DEFAULT_SKILL_ICON,
        content=content,
        source="builtin",
    )


def builtin_library_slug_exists(slug: str) -> bool:
    try:
        load_builtin_library_skill(slug)
        return True
    except SkillError:
        return False


def validate_skill_draft(*, name: str, content: str) -> None:
    if not (name or "").strip():
        raise SkillError("Skill name is required")
    if not (content or "").strip():
        raise SkillError("SKILL.md content is required")


def default_skill_content(name: str, description: str = "") -> str:
    title = (name or "").strip() or "Untitled skill"
    slug_hint = slugify_agent_name(title)
    desc = (description or "").strip() or f"Playbook for {title}."
    return (
        f"---\n"
        f"name: {slug_hint}\n"
        f"description: {desc}\n"
        f"---\n\n"
        f"# {title}\n\n"
        f"## Instructions\n\n"
        f"Describe the workflow the agent should follow.\n"
    )


def library_skill_from_user_row(row: Any) -> LibrarySkill:
    content = (getattr(row, "content", None) or "").strip()
    if not content:
        raise SkillError(f"User skill {row.slug!r} missing content")
    icon = (getattr(row, "icon", None) or "").strip() or DEFAULT_SKILL_ICON
    return LibrarySkill(
        slug=row.slug,
        name=row.name,
        description=row.description or "",
        icon=icon,
        content=content,
        source="user",
    )


async def resolve_predefined_library_skills(
    session: AsyncSession,
    owner_id: str,
    slugs: list[str] | None,
) -> list[LibrarySkill]:
    """Resolve selected library skill slugs (skip missing)."""
    out: list[LibrarySkill] = []
    for slug in normalize_skill_slugs(slugs or []):
        try:
            out.append(await resolve_library_skill(session, slug, owner_id))
        except SkillError:
            continue
    return out


async def get_user_skill_row(
    session: AsyncSession, *, owner_id: str, slug: str
) -> Any | None:
    from openagents_api.models import UserSkill

    result = await session.execute(
        select(UserSkill).where(UserSkill.owner_id == owner_id, UserSkill.slug == slug)
    )
    return result.scalar_one_or_none()


async def resolve_library_skill(
    session: AsyncSession, slug: str, owner_id: str
) -> LibrarySkill:
    try:
        return load_builtin_library_skill(slug)
    except SkillError:
        pass
    row = await get_user_skill_row(session, owner_id=owner_id, slug=slug)
    if row is not None:
        return library_skill_from_user_row(row)
    # Allow predefined rooting of playbooks that live on agents (sidebar Skills).
    from openagents_api.agents import find_agent_skill_by_slug

    agent_skill = await find_agent_skill_by_slug(session, owner_id, slug)
    if agent_skill is not None:
        return LibrarySkill(
            slug=agent_skill.slug,
            name=agent_skill.name or agent_skill.slug,
            description=agent_skill.description or "",
            icon=(agent_skill.icon or "").strip() or DEFAULT_SKILL_ICON,
            content=agent_skill.content,
            source="builtin",
        )
    raise SkillError(f"Skill not found: {slug}")


def materialize_library_skills(
    workspace_dir: str | Path,
    skills: list[LibrarySkill],
    *,
    overwrite: bool = False,
) -> Path:
    """Write library skills into ``workspace_dir/skills/<slug>/SKILL.md``.

    Does not wipe existing agent skills; skips slugs that already exist unless
    ``overwrite`` is true.
    """
    root = Path(workspace_dir) / "skills"
    root.mkdir(parents=True, exist_ok=True)
    for skill in skills:
        skill_dir = root / skill.slug
        skill_md = skill_dir / "SKILL.md"
        if skill_md.is_file() and not overwrite:
            continue
        skill_dir.mkdir(parents=True, exist_ok=True)
        skill_md.write_text(skill.content, encoding="utf-8")
    return root


async def list_owner_library_skills(
    session: AsyncSession, owner_id: str
) -> list[LibrarySkill]:
    from openagents_api.models import UserSkill

    out = list_builtin_library_skills()
    result = await session.execute(
        select(UserSkill).where(UserSkill.owner_id == owner_id).order_by(UserSkill.name)
    )
    for row in result.scalars():
        try:
            out.append(library_skill_from_user_row(row))
        except SkillError:
            continue
    return out


async def list_all_attachable_skill_slugs(
    session: AsyncSession, owner_id: str
) -> list[str]:
    """Library skills + unique agent playbooks (same universe as the agent dialog).

    Used by Auto Agent so it roots every available skill by default.
    """
    from openagents_api.agents import (
        _skills_from_json,
        list_builtin_agents,
        load_agent,
        AgentError,
    )
    from openagents_api.models import UserAgent

    seen: set[str] = set()
    out: list[str] = []
    for skill in await list_owner_library_skills(session, owner_id):
        if skill.slug and skill.slug not in seen:
            seen.add(skill.slug)
            out.append(skill.slug)

    for manifest in list_builtin_agents():
        try:
            pack = load_agent(manifest.slug)
        except AgentError:
            continue
        for skill in pack.skills:
            if skill.slug and (skill.content or "").strip() and skill.slug not in seen:
                seen.add(skill.slug)
                out.append(skill.slug)

    result = await session.execute(
        select(UserAgent).where(UserAgent.owner_id == owner_id).order_by(UserAgent.name)
    )
    for row in result.scalars():
        for skill in _skills_from_json(getattr(row, "skills_json", None)):
            if skill.slug and (skill.content or "").strip() and skill.slug not in seen:
                seen.add(skill.slug)
                out.append(skill.slug)
    return out
