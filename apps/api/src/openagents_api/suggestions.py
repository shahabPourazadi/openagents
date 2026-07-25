from __future__ import annotations

import asyncio
import re
import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from openagents_api.models import Document, DocumentRevision, Suggestion


@dataclass
class PendingSuggestion:
    kind: str
    old_text: str
    new_text: str
    section_heading: str | None = None
    # File path this edit targets (document path today; workspace files later).
    target_path: str | None = None


@dataclass
class PendingChangeView:
    """A pending edit visible to the agent on the next turn."""

    id: uuid.UUID
    kind: str
    target_path: str
    section_heading: str | None
    new_text: str
    old_text: str = ""


@dataclass
class AgentRunState:
    """Mutable per-request state shared with agent tools."""

    user_id: str
    workspace_id: uuid.UUID
    thread_id: uuid.UUID
    document_id: uuid.UUID | None
    document_md: str = ""
    # Workspace-relative path of the active document (e.g. document.md).
    document_path: str = ""
    # When True, suggest_edit may create an empty document on first use.
    uses_document: bool = False
    openrouter_api_key: str = ""
    model: str = "openrouter:z-ai/glm-5.2"
    workspace_dir: str = ""
    pending: list[PendingSuggestion] = field(default_factory=list)
    # Pending Accept/Reject edits loaded at run start (any file in this thread).
    pending_changes: list[PendingChangeView] = field(default_factory=list)
    pending_changes_text: str = ""
    agent_md: str = ""
    soul_md: str = ""
    company_agent_md: str = ""
    company_soul_md: str = ""
    # Names of skills loaded via load_skill this run (for context metering).
    loaded_skills: list[str] = field(default_factory=list)
    # Approximate text of skills catalog injected into instructions.
    skills_catalog_text: str = ""
    # Text of fully loaded skill bodies (for metering).
    loaded_skill_text: str = ""
    # Selected library skills rooted in system instructions for this agent.
    predefined_skills_text: str = ""
    # Mid-tool AG-UI events (e.g. research progress) drained by the SSE multiplex.
    ui_events: asyncio.Queue[Any] | None = None
    # OpenRouter MCP image / multimodal generation billed this run (USD).
    multimodal_cost_usd: float = 0.0


SECTION_RE = re.compile(r"^(#{1,6})\s+(.+)$", re.MULTILINE)
STEP_MARKER_RE = re.compile(r"<!--\s*step:\s*\w+\s*-->", re.IGNORECASE)


def apply_patch(content: str, old_text: str, new_text: str) -> str | None:
    if not old_text:
        return content + (("\n" if content and not content.endswith("\n") else "") + new_text)
    if old_text not in content:
        return None
    return content.replace(old_text, new_text, 1)


def get_section_span(content: str, heading: str) -> tuple[int, int, int, re.Match[str]] | None:
    """Return (heading_start, body_start, body_end, heading_match) or None."""
    matches = list(SECTION_RE.finditer(content))
    target = None
    for i, m in enumerate(matches):
        if m.group(2).strip().lower() == heading.strip().lower():
            target = (i, m)
            break
    if target is None:
        return None

    i, m = target
    level = len(m.group(1))
    start = m.end()
    end = len(content)
    for j in range(i + 1, len(matches)):
        if len(matches[j].group(1)) <= level:
            end = matches[j].start()
            break
    return m.start(), start, end, m


def get_section_body(content: str, heading: str) -> str | None:
    span = get_section_span(content, heading)
    if span is None:
        return None
    _, start, end, _ = span
    return content[start:end]


def strip_section_scaffolding(body: str) -> str:
    """Remove step markers / whitespace so we can tell if a section has real content."""
    return STEP_MARKER_RE.sub("", body or "").strip()


def is_section_body_empty(body: str) -> bool:
    return not strip_section_scaffolding(body)


def is_document_effectively_empty(content: str) -> bool:
    """True when the doc is blank or only empty step headings (default template)."""
    if not (content or "").strip():
        return True
    matches = list(SECTION_RE.finditer(content))
    if not matches:
        return not strip_section_scaffolding(content)
    for i, m in enumerate(matches):
        level = len(m.group(1))
        start = m.end()
        end = len(content)
        for j in range(i + 1, len(matches)):
            if len(matches[j].group(1)) <= level:
                end = matches[j].start()
                break
        if not is_section_body_empty(content[start:end]):
            return False
    return True


def rewrite_section(content: str, heading: str, new_body: str) -> str | None:
    """Replace the body under a markdown heading until the next same-or-higher level heading."""
    span = get_section_span(content, heading)
    if span is None:
        return None

    heading_start, start, end, m = span
    heading_line = m.group(0)
    old_raw = content[start:end]
    marker = STEP_MARKER_RE.search(old_raw)
    body = new_body.strip("\n")
    # Avoid duplicating a step marker the model already included.
    if marker and STEP_MARKER_RE.search(body):
        prefix = "\n\n"
    elif marker:
        prefix = f"\n{marker.group(0)}\n\n"
    else:
        prefix = "\n\n"
    replacement = f"{heading_line}{prefix}{body}\n\n"
    return content[:heading_start] + replacement + content[end:].lstrip("\n")


def apply_pending_item(content: str, item: PendingSuggestion) -> str | None:
    """Apply a pending suggestion to markdown. Returns None if it cannot apply."""
    if item.kind == "patch":
        return apply_patch(content, item.old_text, item.new_text)
    if item.kind == "section" and item.section_heading:
        updated = rewrite_section(content, item.section_heading, item.new_text)
        if updated is not None:
            return updated
        # New heading not in the doc yet — append as a new section.
        heading = item.section_heading.strip()
        body = (item.new_text or "").strip("\n")
        sep = "" if not content or content.endswith("\n\n") else ("\n" if content.endswith("\n") else "\n\n")
        return f"{content}{sep}## {heading}\n\n{body}\n"
    if item.kind == "full":
        return item.new_text
    return None


def suggestion_mode(content: str, item: PendingSuggestion) -> str:
    """Return ``apply`` for pure additions, ``review`` when existing text is changed/removed."""
    if item.kind == "patch":
        # Empty old_text = append; otherwise it replaces existing text.
        if not (item.old_text or "").strip():
            return "apply"
        return "review"

    if item.kind == "section" and item.section_heading:
        body = get_section_body(content, item.section_heading)
        if body is None:
            # Heading does not exist yet — adding a new section.
            return "apply"
        if is_section_body_empty(body):
            return "apply"
        old = strip_section_scaffolding(body)
        new = strip_section_scaffolding(item.new_text or "")
        # Pure append under an existing section (keeps prior text as a prefix).
        if old and new.startswith(old):
            return "apply"
        return "review"

    if item.kind == "full":
        if is_document_effectively_empty(content):
            return "apply"
        old = (content or "").strip()
        new = (item.new_text or "").strip()
        if old and new.startswith(old):
            return "apply"
        return "review"

    return "review"


def suggestions_conflict(content: str, suggestion: Suggestion, edited_content: str) -> bool:
    """True if user edits mean this suggestion can no longer apply cleanly."""
    if suggestion.kind == "patch":
        return suggestion.old_text not in edited_content
    if suggestion.kind == "section" and suggestion.section_heading:
        return rewrite_section(edited_content, suggestion.section_heading, suggestion.new_text) is None
    if suggestion.kind == "full":
        return False
    return suggestion.old_text not in edited_content and bool(suggestion.old_text)


_PREVIEW_CHARS = 900


def format_pending_changes_prompt(changes: list[PendingChangeView]) -> str:
    """Build instruction text so the model sees queued edits for this thread."""
    if not changes:
        return (
            "## Pending changes\n"
            "None. Saved document/file content is the source of truth until you queue new suggestions."
        )

    by_path: dict[str, list[PendingChangeView]] = {}
    for change in changes:
        by_path.setdefault(change.target_path, []).append(change)

    lines = [
        "## Pending changes (awaiting Accept/Reject)",
        "These are edits that change/remove existing text. They are NOT in saved content yet.",
        "(Pure additions apply immediately and will already appear in the document.)",
        "Treat queued edits as already drafted for planning. Do NOT re-suggest the same change unless fixing a real error or the user asks.",
        "If you must revise a pending section, queue a new suggestion (it supersedes the older pending one).",
        "",
    ]
    for path, items in by_path.items():
        lines.append(f"### `{path}`")
        for i, item in enumerate(items, start=1):
            label = item.section_heading or item.kind
            preview = (item.new_text or "").strip()
            if len(preview) > _PREVIEW_CHARS:
                preview = preview[:_PREVIEW_CHARS] + "\n…[truncated]"
            lines.append(f"{i}. **{item.kind}** — `{label}` (id=`{item.id}`)")
            if preview:
                lines.append(f"   Proposed content:\n```md\n{preview}\n```")
            else:
                lines.append("   (empty proposal)")
        lines.append("")
    return "\n".join(lines).rstrip()


async def load_pending_changes_for_thread(
    session: AsyncSession,
    *,
    thread_id: uuid.UUID,
    workspace_id: uuid.UUID,
    active_document_id: uuid.UUID | None = None,
) -> list[PendingChangeView]:
    """Load pending suggestions for this thread (and active doc fallback).

    Scoped by thread when possible so each chat sees its own queue.
    Includes active-document pending rows with null thread_id (legacy).
    target_path uses the document path today; workspace-file targets can share
    the same PendingChangeView shape later.
    """
    from sqlalchemy import and_, or_

    doc_ids_result = await session.execute(
        select(Document.id, Document.path).where(Document.workspace_id == workspace_id)
    )
    path_by_id = {row.id: row.path for row in doc_ids_result.all()}
    if not path_by_id:
        return []

    conditions = [Suggestion.thread_id == thread_id]
    if active_document_id is not None:
        conditions.append(
            and_(
                Suggestion.document_id == active_document_id,
                Suggestion.thread_id.is_(None),
            )
        )

    result = await session.execute(
        select(Suggestion)
        .where(
            Suggestion.status == "pending",
            Suggestion.document_id.in_(list(path_by_id.keys())),
            or_(*conditions),
        )
        .order_by(Suggestion.created_at)
    )
    views: list[PendingChangeView] = []
    for row in result.scalars():
        views.append(
            PendingChangeView(
                id=row.id,
                kind=row.kind,
                target_path=path_by_id.get(row.document_id, f"document:{row.document_id}"),
                section_heading=row.section_heading,
                new_text=row.new_text or "",
                old_text=row.old_text or "",
            )
        )
    return views


async def persist_document_md(
    session: AsyncSession,
    state: AgentRunState,
) -> Document | None:
    """Write auto-applied document_md changes back to the Document row."""
    if not state.document_id:
        return None
    doc = await session.get(Document, state.document_id)
    if not doc:
        return None
    if (doc.content_md or "") == (state.document_md or ""):
        return doc
    session.add(
        DocumentRevision(
            document_id=doc.id,
            content_md=doc.content_md,
            summary="Before auto-applied AI addition",
        )
    )
    doc.content_md = state.document_md or ""
    await session.commit()
    await session.refresh(doc)
    return doc


async def persist_pending_suggestions(
    session: AsyncSession,
    state: AgentRunState,
) -> list[Suggestion]:
    # Always flush auto-applied markdown first (even when no review queue).
    await persist_document_md(session, state)

    if not state.document_id or not state.pending:
        return []

    # Last suggestion for a given section heading wins within this run.
    deduped: list[PendingSuggestion] = []
    seen_sections: set[str] = set()
    for item in reversed(state.pending):
        if item.kind == "section" and item.section_heading:
            key = item.section_heading.strip().lower()
            if key in seen_sections:
                continue
            seen_sections.add(key)
        deduped.append(item)
    deduped.reverse()

    # Supersede any older pending section suggestions for the same headings.
    if seen_sections:
        existing = await session.execute(
            select(Suggestion).where(
                Suggestion.document_id == state.document_id,
                Suggestion.status == "pending",
                Suggestion.kind == "section",
            )
        )
        for row in existing.scalars():
            heading = (row.section_heading or "").strip().lower()
            if heading and heading in seen_sections:
                row.status = "invalidated"

    rows: list[Suggestion] = []
    for item in deduped:
        row = Suggestion(
            document_id=state.document_id,
            thread_id=state.thread_id,
            kind=item.kind,
            old_text=item.old_text,
            new_text=item.new_text,
            section_heading=item.section_heading,
            status="pending",
        )
        session.add(row)
        rows.append(row)
    await session.commit()
    for row in rows:
        await session.refresh(row)
    return rows


async def apply_suggestion(
    session: AsyncSession,
    suggestion: Suggestion,
    *,
    accept: bool,
) -> Document | None:
    doc = await session.get(Document, suggestion.document_id)
    if not doc:
        return None

    if not accept:
        suggestion.status = "rejected"
        await session.commit()
        return doc

    content = doc.content_md
    item = PendingSuggestion(
        kind=suggestion.kind,
        old_text=suggestion.old_text or "",
        new_text=suggestion.new_text or "",
        section_heading=suggestion.section_heading,
    )
    updated = apply_pending_item(content, item)

    if updated is None:
        suggestion.status = "invalidated"
        await session.commit()
        return doc

    session.add(
        DocumentRevision(
            document_id=doc.id,
            content_md=content,
            summary=f"Before accept ({suggestion.kind})",
        )
    )
    doc.content_md = updated
    suggestion.status = "accepted"
    await session.commit()
    await session.refresh(doc)
    return doc


async def invalidate_conflicting(
    session: AsyncSession,
    document_id: uuid.UUID,
    new_content: str,
) -> int:
    result = await session.execute(
        select(Suggestion).where(
            Suggestion.document_id == document_id,
            Suggestion.status == "pending",
        )
    )
    pending = list(result.scalars())
    count = 0
    for s in pending:
        if suggestions_conflict(new_content, s, new_content):
            s.status = "invalidated"
            count += 1
    if count:
        await session.commit()
    return count
