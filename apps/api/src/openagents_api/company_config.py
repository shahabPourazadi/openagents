"""Load / seed company proprietary agent config (prompts + skills + tool groups).

Agents supply the primary agent persona. Company config still owns
system_settings (tool_groups, model tiers) and optional org-wide overrides.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from openagents_api.config import Settings, get_settings
from openagents_api.models import CompanyPromptDoc, CompanySkill, SystemSettings

_log = logging.getLogger(__name__)

PROMPT_KEYS = ("system_prompt", "agent_md", "soul_md")

DEFAULT_TOOL_GROUPS: dict[str, bool] = {
    "hitl": True,
    "mcp": True,
    # Alias kept so older admin JSON still works.
    "firecrawl": True,
    "document_parse": True,
    "deep_builtins": True,
}

# Empty by default — pack skills are the source of truth.
DEFAULT_SKILLS: tuple[tuple[str, str], ...] = ()


def templates_base(settings: Settings | None = None) -> Path:
    s = settings or get_settings()
    if s.templates_dir:
        return Path(s.templates_dir)
    return Path(__file__).resolve().parents[4] / "templates"


def default_system_prompt() -> str:
    """Generic deep-agent base prompt (packs add specialization)."""
    from openagents_api.deep_agent_builder import DEEP_SYSTEM_INSTRUCTIONS

    return DEEP_SYSTEM_INSTRUCTIONS


def _read_template(rel: str, fallback: str = "") -> str:
    path = templates_base() / rel
    if path.exists():
        return path.read_text(encoding="utf-8")
    return fallback


@dataclass
class PublishedCompanyConfig:
    system_prompt: str
    agent_md: str
    soul_md: str
    tool_groups: dict[str, bool]
    skills: list[tuple[str, str]]  # (slug, published_content) enabled only


async def ensure_system_settings(session: AsyncSession) -> SystemSettings:
    from openagents_api.model_catalog import default_model_tiers, normalize_tiers

    row = await session.get(SystemSettings, 1)
    if row:
        if not row.tool_groups:
            row.tool_groups = dict(DEFAULT_TOOL_GROUPS)
        if getattr(row, "model_tiers", None) is None or (
            isinstance(row.model_tiers, list) and len(row.model_tiers) == 0
        ):
            row.model_tiers = default_model_tiers()
        else:
            row.model_tiers = normalize_tiers(row.model_tiers)
        if getattr(row, "zdr_only", None) is None:
            row.zdr_only = False
        return row
    settings = get_settings()
    # Queue off → auto-approve; queue on → admin approve (existing behavior).
    signup_mode = "admin_approve" if settings.feature_signup_queue else "auto_approve"
    row = SystemSettings(
        id=1,
        signup_mode=signup_mode,
        tool_groups=dict(DEFAULT_TOOL_GROUPS),
        zdr_only=False,
        model_tiers=default_model_tiers(),
    )
    session.add(row)
    await session.flush()
    return row


_OLD_ATTACHMENT_WORKFLOW = (
    "Attachment workflow: (1) parse_document for text/tables/OCR; "
    "(2) if diagrams/figures need visual understanding, screenshot_document with target_pages "
    "for those pages — images are returned to you as vision content (also saved under screenshots/); "
    "(3) you may read_file a saved PNG later to re-inspect. Prefer specific pages over dumping many. "
)

# Previous inline-BinaryContent wording (pre path-first).
_MID_ATTACHMENT_WORKFLOW = (
    "Attachment workflow: "
    "(1) Raster images (PNG/JPG/WEBP/GIF/…): call screenshot_document or parse_document first — "
    "vision-capable models receive image pixels; do NOT rely on OCR alone for UI, icons, or diagrams. "
    "(2) PDF/DOCX/XLSX/PPTX: parse_document for text/tables; then screenshot_document on pages "
    "with figures (images returned as vision content, also saved under screenshots/). "
    "(3) You may read_file a saved PNG later to re-inspect. Prefer specific pages over dumping many. "
)

_NEW_ATTACHMENT_WORKFLOW = (
    "Attachment workflow: "
    "(1) Raster images (PNG/JPG/WEBP/GIF/…): call screenshot_document or parse_document — "
    "they save an optimized preview under screenshots/; then call read_file on that path to see "
    "pixels (vision models). Do NOT rely on OCR alone for UI, icons, or diagrams. "
    "(2) PDF/DOCX/XLSX/PPTX: parse_document for text/tables; screenshot_document on figure pages, "
    "then read_file the saved screenshot path(s). "
    "(3) Prefer specific pages; only read_file images you need this turn. "
)

_OLD_FS_WRITE_RULE = (
    "Filesystem tools may write memory/ and research/ only — never write the "
    "markdown directly; always use suggest_* for document content. "
)

_NEW_FS_WRITE_RULE = (
    "Filesystem tools may write memory/, research/, diagrams/, and other/ — "
    "never write the active document markdown directly; always use suggest_edit. "
    "For figures to show in the editor: save PNG/SVG under "
    "diagrams/ or other/, then embed with markdown like "
    "`![Figure caption](diagrams/figure-1.png)` via suggest_edit. "
    "Do not use screenshots/ for durable embeds (that folder is ephemeral). "
)


def _migrate_attachment_workflow(text: str) -> str:
    if not text:
        return text
    out = text
    if _OLD_ATTACHMENT_WORKFLOW in out:
        out = out.replace(_OLD_ATTACHMENT_WORKFLOW, _NEW_ATTACHMENT_WORKFLOW)
    if _MID_ATTACHMENT_WORKFLOW in out:
        out = out.replace(_MID_ATTACHMENT_WORKFLOW, _NEW_ATTACHMENT_WORKFLOW)
    if _OLD_FS_WRITE_RULE in out:
        out = out.replace(_OLD_FS_WRITE_RULE, _NEW_FS_WRITE_RULE)
    return out


async def seed_company_config_if_empty(session: AsyncSession) -> None:
    """Fill empty draft+published from generic defaults (packs own persona)."""
    await ensure_system_settings(session)

    seeds = {
        "system_prompt": default_system_prompt(),
        "agent_md": _read_template(
            "agent.md",
            "You help users accomplish tasks using the selected Agent.",
        ),
        "soul_md": _read_template(
            "soul.md",
            "Be precise, collaborative, and honest about uncertainty.",
        ),
    }
    now = datetime.now(timezone.utc)
    for key, content in seeds.items():
        row = await session.get(CompanyPromptDoc, key)
        if row is None:
            session.add(
                CompanyPromptDoc(
                    key=key,
                    draft_content=content,
                    published_content=content,
                    draft_updated_at=now,
                    published_at=now,
                    published_by="seed",
                )
            )
        elif not (row.published_content or "").strip() and not (row.draft_content or "").strip():
            row.draft_content = content
            row.published_content = content
            row.draft_updated_at = now
            row.published_at = now
            row.published_by = row.published_by or "seed"
        elif key == "system_prompt" and row is not None:
            # One-shot prompt fixes (attachment vision + durable figure paths).
            draft = _migrate_attachment_workflow(row.draft_content or "")
            published = _migrate_attachment_workflow(row.published_content or "")
            if draft != (row.draft_content or "") or published != (row.published_content or ""):
                row.draft_content = draft
                row.published_content = published
                row.draft_updated_at = now
                _log.info("migrated system_prompt (attachments / durable diagrams)")

    for slug, title in DEFAULT_SKILLS:
        content = _read_template(f"skills/{slug}/SKILL.md", "")
        row = await session.get(CompanySkill, slug)
        if row is None:
            session.add(
                CompanySkill(
                    slug=slug,
                    title=title,
                    enabled=True,
                    draft_content=content,
                    published_content=content,
                    draft_updated_at=now,
                    published_at=now,
                    published_by="seed",
                )
            )
        elif not (row.published_content or "").strip() and not (row.draft_content or "").strip():
            row.title = title
            row.draft_content = content
            row.published_content = content
            row.draft_updated_at = now
            row.published_at = now
            row.published_by = row.published_by or "seed"

    await session.commit()
    _log.info("company config seed checked")


async def load_published_company_config(session: AsyncSession) -> PublishedCompanyConfig:
    settings_row = await ensure_system_settings(session)
    tool_groups = merge_tool_groups(
        settings_row.tool_groups if isinstance(settings_row.tool_groups, dict) else None
    )

    prompts: dict[str, str] = {}
    for key in PROMPT_KEYS:
        row = await session.get(CompanyPromptDoc, key)
        text = (row.published_content if row else "") or ""
        if key == "system_prompt":
            text = _migrate_attachment_workflow(text)
        prompts[key] = text.strip()

    if not prompts.get("system_prompt"):
        prompts["system_prompt"] = default_system_prompt()
    if not prompts.get("agent_md"):
        prompts["agent_md"] = _read_template(
            "agent.md",
            "You help users accomplish tasks using the selected Agent.",
        )
    if not prompts.get("soul_md"):
        prompts["soul_md"] = _read_template(
            "soul.md",
            "Be precise, collaborative, and honest about uncertainty.",
        )

    result = await session.execute(
        select(CompanySkill).where(CompanySkill.enabled.is_(True)).order_by(CompanySkill.slug)
    )
    skills: list[tuple[str, str]] = []
    for skill in result.scalars():
        body = (skill.published_content or "").strip()
        if not body:
            body = _read_template(f"skills/{skill.slug}/SKILL.md", "")
        if body:
            skills.append((skill.slug, body))

    return PublishedCompanyConfig(
        system_prompt=prompts["system_prompt"],
        agent_md=prompts["agent_md"],
        soul_md=prompts["soul_md"],
        tool_groups=tool_groups,
        skills=skills,
    )


def materialize_published_skills(workspace_dir: str | Path, skills: list[tuple[str, str]]) -> Path:
    """Write enabled published skills into workspace_dir/skills/<slug>/SKILL.md."""
    root = Path(workspace_dir) / "skills"
    if root.exists():
        import shutil

        shutil.rmtree(root)
    root.mkdir(parents=True, exist_ok=True)
    for slug, content in skills:
        pack = root / slug
        pack.mkdir(parents=True, exist_ok=True)
        (pack / "SKILL.md").write_text(content, encoding="utf-8")
    return root


def merge_tool_groups(raw: dict | None) -> dict[str, bool]:
    out = dict(DEFAULT_TOOL_GROUPS)
    if isinstance(raw, dict):
        for k, v in raw.items():
            if k in out:
                out[k] = bool(v)
    # Keep mcp ↔ firecrawl aligned for older admin rows.
    if "mcp" in (raw or {}) and "firecrawl" not in (raw or {}):
        out["firecrawl"] = out["mcp"]
    elif "firecrawl" in (raw or {}) and "mcp" not in (raw or {}):
        out["mcp"] = out["firecrawl"]
    return out
