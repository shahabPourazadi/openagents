"""Agent loader — discover and validate agents from ``agents/<slug>/`` or DB."""

from __future__ import annotations

import re
import shutil
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

DEFAULT_AGENT_SLUG = "agent"

DEFAULT_SYSTEM_PROMPT = (
    "You are OpenAgents, a deep agent helper. "
    "Specialize using the selected Agent persona and skills. "
    "When a document is open, use `read_document` before editing and "
    "`suggest_edit` for all document writes. "
    "Pure additions apply immediately; edits that change existing text "
    "are queued for Accept/Reject. "
    "Use ask_user only when blocked on a high-impact decision. "
    "Never invent tool results or claim file edits without calling tools. "
    "If a tool returns Upstream error, TOOL FAILED, or Fix the errors and try again, "
    "admit the failure — do not invent diagrams/ paths or costs."
)

_SLUG_RE = re.compile(r"[^a-z0-9]+")


class AgentManifest(BaseModel):
    """Contents of ``agent.yaml``."""

    name: str
    slug: str = ""
    description: str = ""
    icon: str = ""
    uses_document: bool = True
    uses_canvas: bool = False
    document_template: str = "templates/document.md"
    tool_groups: dict[str, bool] | None = None
    default_model: str | None = None


class AgentSkill(BaseModel):
    """One skill directory under ``skills/<slug>/``."""

    slug: str
    content: str
    name: str = ""
    description: str = ""
    icon: str = ""
    root: Path | None = None

    model_config = {"arbitrary_types_allowed": True}


class LoadedAgent(BaseModel):
    slug: str
    root: Path
    manifest: AgentManifest
    agent_md: str
    soul_md: str
    system_prompt: str
    skills: list[AgentSkill] = Field(default_factory=list)
    document_template_md: str = ""
    source: str = "builtin"  # builtin | user
    # Library skill slugs rooted in system instructions (user agents).
    predefined_skill_slugs: list[str] = Field(default_factory=list)
    # User MCP library server ids attached to this agent.
    mcp_server_ids: list[str] = Field(default_factory=list)

    model_config = {"arbitrary_types_allowed": True}


class AgentError(ValueError):
    """Invalid or missing agent."""


def agents_root() -> Path:
    """Repo ``agents/`` directory (``apps/api/src/openagents_api`` → parents[4]).

    Prefers ``AGENTS_DIR`` / ``agents/``; falls back to legacy ``PACKS_DIR`` / ``packs/``.
    """
    from openagents_api.config import get_settings

    settings = get_settings()
    for attr in ("agents_dir", "packs_dir"):
        custom = getattr(settings, attr, None)
        if custom:
            path = Path(custom)
            if path.is_dir():
                return path
    repo = Path(__file__).resolve().parents[4]
    for name in ("agents", "packs"):
        candidate = repo / name
        if candidate.is_dir():
            return candidate
    return repo / "agents"


def slugify_agent_name(name: str) -> str:
    """Turn a display name into a URL-safe agent slug."""
    raw = (name or "").strip().lower()
    slug = _SLUG_RE.sub("-", raw).strip("-")
    return slug[:120] or "agent"


def validate_agent_slug(slug: str) -> str:
    slug = (slug or "").strip().lower()
    if not slug or "/" in slug or "\\" in slug or ".." in slug:
        raise AgentError(f"Invalid agent slug: {slug!r}")
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", slug):
        raise AgentError(f"Invalid agent slug: {slug!r}")
    return slug


def _read_text(path: Path) -> str:
    if not path.is_file():
        return ""
    return path.read_text(encoding="utf-8")


def _load_skills(skills_dir: Path) -> list[AgentSkill]:
    if not skills_dir.is_dir():
        return []
    out: list[AgentSkill] = []
    for child in sorted(skills_dir.iterdir()):
        if not child.is_dir():
            continue
        skill_md = child / "SKILL.md"
        if not skill_md.is_file():
            continue
        content = skill_md.read_text(encoding="utf-8")
        name = child.name
        description = ""
        icon = ""
        # Optional YAML frontmatter name / description / icon:
        if content.startswith("---"):
            parts = content.split("---", 2)
            if len(parts) >= 3:
                try:
                    meta = yaml.safe_load(parts[1]) or {}
                    if isinstance(meta, dict):
                        if meta.get("name"):
                            name = str(meta["name"])
                        if meta.get("description"):
                            description = str(meta["description"]).strip()
                        if meta.get("icon"):
                            icon = str(meta["icon"]).strip()
                except yaml.YAMLError:
                    pass
        out.append(
            AgentSkill(
                slug=child.name,
                name=name,
                description=description,
                icon=icon,
                content=content,
                root=child,
            )
        )
    return out


def list_builtin_agents() -> list[AgentManifest]:
    """List valid built-in agent manifests (skips invalid dirs)."""
    root = agents_root()
    if not root.is_dir():
        return []
    manifests: list[AgentManifest] = []
    for child in sorted(root.iterdir()):
        if not child.is_dir() or child.name.startswith("."):
            continue
        try:
            pack = load_agent(child.name)
        except AgentError:
            continue
        manifests.append(pack.manifest)
    return manifests


def builtin_slug_exists(slug: str) -> bool:
    try:
        load_agent(slug)
        return True
    except AgentError:
        return False


def load_agent(slug: str) -> LoadedAgent:
    """Load and validate a built-in agent by slug. Requires ``agent.yaml`` + ``agent.md``."""
    slug = validate_agent_slug(slug)

    root = agents_root() / slug
    if not root.is_dir():
        raise AgentError(f"Agent not found: {slug}")

    manifest_path = root / "agent.yaml"
    if not manifest_path.is_file():
        manifest_path = root / "pack.yaml"
    if not manifest_path.is_file():
        raise AgentError(f"Agent {slug!r} missing agent.yaml")

    agent_path = root / "agent.md"
    if not agent_path.is_file():
        raise AgentError(f"Agent {slug!r} missing agent.md")

    try:
        raw = yaml.safe_load(manifest_path.read_text(encoding="utf-8")) or {}
        if not isinstance(raw, dict):
            raise AgentError(f"Agent {slug!r} agent.yaml must be a mapping")
        manifest = AgentManifest.model_validate(raw)
    except ValidationError as exc:
        raise AgentError(f"Agent {slug!r} invalid agent.yaml: {exc}") from exc
    except yaml.YAMLError as exc:
        raise AgentError(f"Agent {slug!r} invalid YAML: {exc}") from exc

    if not (manifest.slug or "").strip():
        manifest.slug = slug
    elif manifest.slug != slug:
        # Folder name is the canonical slug; keep folder as source of truth.
        manifest.slug = slug

    agent_md = agent_path.read_text(encoding="utf-8")
    if not agent_md.strip():
        raise AgentError(f"Agent {slug!r} agent.md is empty")

    soul_md = _read_text(root / "soul.md")
    system_prompt = _read_text(root / "system_prompt.md").strip() or DEFAULT_SYSTEM_PROMPT

    document_template_md = ""
    if manifest.uses_document and manifest.document_template:
        tpl = root / manifest.document_template
        if tpl.is_file():
            document_template_md = tpl.read_text(encoding="utf-8")

    from openagents_api.skills_library import normalize_skill_slugs

    predefined_raw = raw.get("predefined_skills") or raw.get("predefined_skill_slugs") or []
    return LoadedAgent(
        slug=slug,
        root=root,
        manifest=manifest,
        agent_md=agent_md,
        soul_md=soul_md,
        system_prompt=system_prompt,
        skills=_load_skills(root / "skills"),
        document_template_md=document_template_md,
        source="builtin",
        predefined_skill_slugs=normalize_skill_slugs(predefined_raw),
    )


def try_load_agent(slug: str | None, *, fallback: str = DEFAULT_AGENT_SLUG) -> LoadedAgent:
    """Load built-in slug, then fallback, else raise AgentError."""
    candidates = [slug or fallback, fallback]
    seen: set[str] = set()
    last_err: AgentError | None = None
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        try:
            return load_agent(candidate)
        except AgentError as exc:
            last_err = exc
    raise last_err or AgentError("No agents available")


def _skills_from_json(raw: list[Any] | None) -> list[AgentSkill]:
    out: list[AgentSkill] = []
    if not raw:
        return out
    for item in raw:
        if not isinstance(item, dict):
            continue
        skill_slug = str(item.get("slug") or "").strip()
        content = str(item.get("content") or "")
        if not skill_slug or not content.strip():
            continue
        try:
            skill_slug = validate_agent_slug(skill_slug)
        except AgentError:
            continue
        out.append(
            AgentSkill(
                slug=skill_slug,
                name=str(item.get("name") or skill_slug),
                description=str(item.get("description") or ""),
                icon=str(item.get("icon") or ""),
                content=content,
            )
        )
    return out


def user_agent_cache_root(owner_id: str, slug: str) -> Path:
    from openagents_api.config import get_settings

    settings = get_settings()
    parent = Path(settings.workspace_tmp_root)
    parent.mkdir(parents=True, exist_ok=True)
    return parent / "user-agents" / owner_id / slug


def materialize_user_agent_files(
    *,
    owner_id: str,
    slug: str,
    name: str,
    description: str,
    icon: str,
    uses_document: bool,
    agent_md: str,
    soul_md: str,
    system_prompt: str,
    document_template_md: str,
    skills: list[AgentSkill],
    uses_canvas: bool = False,
) -> Path:
    """Write a user agent to the temp cache and return its root directory."""
    root = user_agent_cache_root(owner_id, slug)
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True, exist_ok=True)

    manifest = {
        "name": name,
        "slug": slug,
        "description": description or "",
        "icon": icon or "",
        "uses_document": bool(uses_document),
        "uses_canvas": bool(uses_canvas),
    }
    if uses_document:
        manifest["document_template"] = "templates/document.md"
    (root / "agent.yaml").write_text(
        yaml.safe_dump(manifest, sort_keys=False), encoding="utf-8"
    )
    (root / "agent.md").write_text(agent_md or "", encoding="utf-8")
    if soul_md:
        (root / "soul.md").write_text(soul_md, encoding="utf-8")
    if system_prompt:
        (root / "system_prompt.md").write_text(system_prompt, encoding="utf-8")
    if uses_document and document_template_md:
        tpl_dir = root / "templates"
        tpl_dir.mkdir(parents=True, exist_ok=True)
        (tpl_dir / "document.md").write_text(document_template_md, encoding="utf-8")
    if skills:
        skills_root = root / "skills"
        for skill in skills:
            pack_dir = skills_root / skill.slug
            pack_dir.mkdir(parents=True, exist_ok=True)
            (pack_dir / "SKILL.md").write_text(skill.content, encoding="utf-8")
    return root


def loaded_agent_from_user_row(row: Any) -> LoadedAgent:
    """Materialize a UserAgent ORM row into a LoadedAgent (skills on disk for agent)."""
    skills = _skills_from_json(getattr(row, "skills_json", None))
    agent_md = (getattr(row, "agent_md", None) or "").strip()
    if not agent_md:
        raise AgentError(f"User agent {row.slug!r} missing agent.md content")

    root = materialize_user_agent_files(
        owner_id=row.owner_id,
        slug=row.slug,
        name=row.name,
        description=row.description or "",
        icon=row.icon or "",
        uses_document=bool(row.uses_document),
        uses_canvas=bool(getattr(row, "uses_canvas", False)),
        agent_md=agent_md,
        soul_md=row.soul_md or "",
        system_prompt=row.system_prompt or "",
        document_template_md=row.document_template_md or "",
        skills=skills,
    )
    manifest = AgentManifest(
        name=row.name,
        slug=row.slug,
        description=row.description or "",
        icon=row.icon or "",
        uses_document=bool(row.uses_document),
        uses_canvas=bool(getattr(row, "uses_canvas", False)),
        document_template="templates/document.md" if row.uses_document else "",
    )
    from openagents_api.mcp_library import normalize_mcp_server_ids
    from openagents_api.skills_library import normalize_skill_slugs

    predefined = normalize_skill_slugs(getattr(row, "predefined_skill_slugs", None))
    mcp_ids = [str(x) for x in normalize_mcp_server_ids(getattr(row, "mcp_server_ids", None))]
    return LoadedAgent(
        slug=row.slug,
        root=root,
        manifest=manifest,
        agent_md=agent_md,
        soul_md=row.soul_md or "",
        system_prompt=(row.system_prompt or "").strip() or DEFAULT_SYSTEM_PROMPT,
        skills=skills,
        document_template_md=row.document_template_md or "",
        source="user",
        predefined_skill_slugs=predefined,
        mcp_server_ids=mcp_ids,
    )


async def get_user_agent_row(
    session: AsyncSession, *, owner_id: str, slug: str
) -> Any | None:
    from openagents_api.models import UserAgent

    result = await session.execute(
        select(UserAgent).where(UserAgent.owner_id == owner_id, UserAgent.slug == slug)
    )
    return result.scalar_one_or_none()


async def resolve_agent(
    session: AsyncSession,
    slug: str | None,
    owner_id: str,
    *,
    fallback: str = DEFAULT_AGENT_SLUG,
) -> LoadedAgent:
    """Resolve built-in first, then the owner's UserAgent, then fallback built-in."""
    candidates = [slug or fallback, fallback]
    seen: set[str] = set()
    last_err: AgentError | None = None
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        try:
            return load_agent(candidate)
        except AgentError as exc:
            last_err = exc
        row = await get_user_agent_row(session, owner_id=owner_id, slug=candidate)
        if row is not None:
            try:
                return loaded_agent_from_user_row(row)
            except AgentError as exc:
                last_err = exc
    raise last_err or AgentError("No agents available")


async def find_agent_skill_by_slug(
    session: AsyncSession, owner_id: str, skill_slug: str
) -> AgentSkill | None:
    """Find a skill on any built-in or owner agent (first match wins)."""
    try:
        skill_slug = validate_agent_slug(skill_slug)
    except AgentError:
        return None

    for manifest in list_builtin_agents():
        try:
            pack = load_agent(manifest.slug)
        except AgentError:
            continue
        for skill in pack.skills:
            if skill.slug == skill_slug and (skill.content or "").strip():
                return skill

    from openagents_api.models import UserAgent

    result = await session.execute(
        select(UserAgent).where(UserAgent.owner_id == owner_id).order_by(UserAgent.name)
    )
    for row in result.scalars():
        for skill in _skills_from_json(getattr(row, "skills_json", None)):
            if skill.slug == skill_slug and (skill.content or "").strip():
                return skill
    return None


def validate_agent_draft(
    *,
    name: str,
    agent_md: str,
    uses_document: bool = True,
    skills: list[dict[str, Any]] | None = None,
) -> None:
    """Lightweight validation before inserting a UserAgent."""
    if not (name or "").strip():
        raise AgentError("Agent name is required")
    if not (agent_md or "").strip():
        raise AgentError("agent_md is required")
    _skills_from_json(skills)


def materialize_agent_skills(
    workspace_dir: str | Path,
    pack: LoadedAgent,
    *,
    extra_skills: list[AgentSkill] | None = None,
) -> Path:
    """Write agent skills into ``workspace_dir/skills/<slug>/SKILL.md``.

    Always merges playbooks from every built-in agent (and optional extras) so
    ``/`` mentions and ``load_skill`` can reach the full sidebar Skills list,
    not only the active agent's own skills. The active pack's skills win on
    slug conflicts.
    """
    root = Path(workspace_dir) / "skills"
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True, exist_ok=True)

    skills_by_slug: dict[str, AgentSkill] = {}
    for manifest in list_builtin_agents():
        if manifest.slug == pack.slug:
            continue
        try:
            extra = load_agent(manifest.slug)
        except AgentError:
            continue
        for skill in extra.skills:
            if (skill.content or "").strip():
                skills_by_slug.setdefault(skill.slug, skill)
    for skill in extra_skills or []:
        if skill.slug and (skill.content or "").strip():
            skills_by_slug.setdefault(skill.slug, skill)
    for skill in pack.skills:
        if skill.slug and (skill.content or "").strip():
            skills_by_slug[skill.slug] = skill

    for skill in skills_by_slug.values():
        pack_dir = root / skill.slug
        pack_dir.mkdir(parents=True, exist_ok=True)
        (pack_dir / "SKILL.md").write_text(skill.content, encoding="utf-8")
    return root


def agent_skills_as_tuples(pack: LoadedAgent) -> list[tuple[str, str]]:
    """Compatibility shape for older materialize helpers."""
    return [(s.slug, s.content) for s in pack.skills]


def read_agent_dir_from_workspace(workspace_dir: str | Path, slug: str) -> dict[str, Any]:
    """Read ``agents/<slug>/`` from a materialized agent workspace."""
    slug = validate_agent_slug(slug)
    root = Path(workspace_dir) / "agents" / slug
    if not root.is_dir():
        root = Path(workspace_dir) / "packs" / slug
    if not root.is_dir():
        raise AgentError(f"Workspace agent directory not found: agents/{slug}")

    manifest_path = root / "agent.yaml"
    if not manifest_path.is_file():
        manifest_path = root / "pack.yaml"
    agent_path = root / "agent.md"
    if not manifest_path.is_file():
        raise AgentError(f"agents/{slug} missing agent.yaml")
    if not agent_path.is_file():
        raise AgentError(f"agents/{slug} missing agent.md")

    try:
        raw = yaml.safe_load(manifest_path.read_text(encoding="utf-8")) or {}
        if not isinstance(raw, dict):
            raise AgentError("agent.yaml must be a mapping")
        manifest = AgentManifest.model_validate(raw)
    except (ValidationError, yaml.YAMLError) as exc:
        raise AgentError(f"Invalid agent.yaml: {exc}") from exc

    agent_md = agent_path.read_text(encoding="utf-8")
    if not agent_md.strip():
        raise AgentError("agent.md is empty")

    skills = _load_skills(root / "skills")
    document_template_md = ""
    if manifest.uses_document:
        tpl_rel = manifest.document_template or "templates/document.md"
        tpl = root / tpl_rel
        if tpl.is_file():
            document_template_md = tpl.read_text(encoding="utf-8")

    from openagents_api.skills_library import normalize_skill_slugs

    predefined_raw = raw.get("predefined_skills") or raw.get("predefined_skill_slugs") or []
    return {
        "slug": slug,
        "name": manifest.name or slug,
        "description": manifest.description or "",
        "icon": manifest.icon or "",
        "uses_document": bool(manifest.uses_document),
        "uses_canvas": bool(getattr(manifest, "uses_canvas", False)),
        "agent_md": agent_md,
        "soul_md": _read_text(root / "soul.md"),
        "system_prompt": _read_text(root / "system_prompt.md"),
        "document_template_md": document_template_md,
        "skills": [
            {"slug": s.slug, "name": s.name or s.slug, "content": s.content}
            for s in skills
        ],
        "predefined_skill_slugs": normalize_skill_slugs(predefined_raw),
    }
