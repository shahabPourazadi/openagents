"""Shared OpenAgents HITL / domain tools used by the deep agent builder.

Tools read/write attributes on ``OpenAgentsDeepDeps`` (and ``AgentRunState`` for
shared suggestion/state helpers): document_md, pending, workspace_dir, ui_events, …
"""

from __future__ import annotations

import asyncio
import os
import tempfile
import uuid
from pathlib import Path
from typing import Any

from ag_ui.core import CustomEvent, EventType
from pydantic import BaseModel, Field
from pydantic_ai import RunContext, ToolReturn

from openagents_api.config import get_settings
from openagents_api.suggestions import (
    PendingSuggestion,
    apply_pending_item,
    suggestion_mode,
)


class AskUserOption(BaseModel):
    """One choice for ask_user (deepagents-style)."""

    label: str = Field(description="Short option label the user can pick")
    description: str = Field(default="", description="Optional one-line explanation")
    recommended: bool = Field(
        default=False,
        description="True if this is your preferred default when the user is unsure",
    )


class AskUserQuestion(BaseModel):
    """One clarifying question with 2–4 options."""

    question: str = Field(description="The clarifying question to show the user")
    options: list[AskUserOption] = Field(
        description="2–4 concrete choices; mark one recommended when you have a lean"
    )
    context: str = Field(
        default="",
        description="Optional short note on why this blocks progress",
    )


async def emit_tool_progress(
    deps: Any,
    tool_call_id: str | None,
    status: str,
    detail: str = "",
) -> None:
    """Push a mid-tool progress CustomEvent onto the SSE multiplex queue."""
    ui_events = getattr(deps, "ui_events", None)
    if ui_events is None or not tool_call_id:
        return
    await ui_events.put(
        CustomEvent(
            type=EventType.CUSTOM,
            name="tool_progress",
            value={
                "tool_call_id": tool_call_id,
                "status": status,
                "detail": detail,
            },
        )
    )


def safe_workspace_path(root: Path, relative_path: str) -> Path | None:
    path = (root / relative_path).resolve()
    if not str(path).startswith(str(root.resolve())):
        return None
    return path


def write_workspace_file_content(workspace_dir: str, relative_path: str, content: str) -> str:
    if not workspace_dir:
        return "Error: no workspace directory"
    root = Path(workspace_dir)
    path = safe_workspace_path(root, relative_path)
    if path is None:
        return "Error: path escapes workspace"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return f"Wrote {relative_path} ({len(content)} chars)"


def read_workspace_file_content(workspace_dir: str, relative_path: str) -> str:
    if not workspace_dir:
        return ""
    root = Path(workspace_dir)
    path = safe_workspace_path(root, relative_path)
    if path is None or not path.exists():
        return ""
    return path.read_text(encoding="utf-8")[:50_000]


def _sync_document_workspace_file(deps: Any, content: str) -> None:
    """Keep the on-disk document file in sync when document_md is auto-applied."""
    workspace_dir = getattr(deps, "workspace_dir", "") or ""
    document_path = getattr(deps, "document_path", "") or ""
    if not workspace_dir or not document_path:
        return
    write_workspace_file_content(workspace_dir, document_path, content)


def commit_or_queue_suggestion(
    deps: Any,
    item: PendingSuggestion,
    *,
    rationale: str = "",
) -> CustomEvent:
    """Auto-apply pure additions; queue edits that change/remove existing text for review."""
    content = getattr(deps, "document_md", "") or ""
    mode = suggestion_mode(content, item)
    base_value: dict[str, Any] = {
        "kind": item.kind,
        "old_text": item.old_text,
        "new_text": item.new_text,
        "section_heading": item.section_heading,
        "rationale": rationale,
        "mode": mode,
        "title": getattr(item, "title", None) or "",
    }

    if mode == "apply":
        updated = apply_pending_item(content, item)
        if updated is not None:
            deps.document_md = updated
            # Deep agent: document_md is a str copy on OpenAgentsDeepDeps — mirror onto AgentRunState.
            run_state = getattr(deps, "_run_state", None)
            if run_state is not None:
                run_state.document_md = updated
            _sync_document_workspace_file(deps, updated)
            return CustomEvent(
                type=EventType.CUSTOM,
                name="md_applied",
                value={**base_value, "content_md": updated},
            )
        # Fall through to review queue if apply unexpectedly fails.

    deps.pending.append(item)
    return CustomEvent(
        type=EventType.CUSTOM,
        name="md_suggestion",
        value=base_value,
    )


# ---------------------------------------------------------------------------
# Shared tool functions
# ---------------------------------------------------------------------------


async def ask_user(ctx: RunContext[Any], questions: list[AskUserQuestion]) -> ToolReturn:
    """Ask the user 1–4 clarifying questions (each with 2–4 options).

    Batch related questions in one call so the user can answer them together.
    Use when a decision significantly affects the work or you are blocked.
    After calling this tool, END YOUR TURN — do not invent answers or call more tools.
    When they reply, continue the same todo/plan — do not rewrite the whole plan.
    """
    if not questions:
        return ToolReturn(return_value="Error: ask_user requires 1–4 questions.")
    if len(questions) > 4:
        return ToolReturn(
            return_value="Error: ask_user allows at most 4 questions per call."
        )

    cleaned_questions: list[dict] = []
    for i, q in enumerate(questions):
        prompt = (q.question or "").strip()
        if not prompt:
            return ToolReturn(
                return_value=f"Error: question {i + 1} is missing text."
            )
        opts = [
            {
                "label": opt.label.strip(),
                "description": (opt.description or "").strip(),
                "recommended": bool(opt.recommended),
            }
            for opt in (q.options or [])
            if opt.label and opt.label.strip()
        ]
        if len(opts) < 2 or len(opts) > 4:
            return ToolReturn(
                return_value=(
                    f"Error: question {i + 1} needs 2–4 options with non-empty labels."
                )
            )
        cleaned_questions.append(
            {
                "id": f"q{i + 1}",
                "question": prompt,
                "options": opts,
                "context": (q.context or "").strip(),
            }
        )

    payload = {
        "questions": cleaned_questions,
        "tool_call_id": ctx.tool_call_id,
    }
    n = len(cleaned_questions)
    return ToolReturn(
        return_value=(
            f"{n} clarifying question{'s' if n != 1 else ''} shown to the user. "
            "Do not call more tools or invent answers — end your turn and wait for their reply. "
            "When they answer, continue the existing plan; do not replace the whole todo list."
        ),
        metadata=[
            CustomEvent(
                type=EventType.CUSTOM,
                name="clarifying_question",
                value=payload,
            )
        ],
    )


async def read_document(ctx: RunContext[Any]) -> str:
    """Read the active workspace document markdown.

    The document body is not injected into system instructions — call this
    (or read_file on the active path) when you need the current text before editing.
    """
    if not getattr(ctx.deps, "document_id", None):
        return "No active document is open."
    md = getattr(ctx.deps, "document_md", "") or ""
    path = (getattr(ctx.deps, "document_path", "") or "").strip()
    if not md.strip():
        return (f"path: {path}\n" if path else "") + "(empty document)"
    header = f"Active document path: {path}\n\n" if path else ""
    return (header + md)[:50_000]


async def ensure_active_document(deps: Any) -> CustomEvent | None:
    """Create an empty active document when the agent first needs one.

    No template is applied — content is whatever the agent/user writes next.
    """
    if getattr(deps, "document_id", None):
        return None
    if not getattr(deps, "uses_document", False):
        return None

    from openagents_api.db import SessionLocal
    from openagents_api.models import Document, Thread

    workspace_id = getattr(deps, "workspace_id", None)
    thread_id = getattr(deps, "thread_id", None)
    if workspace_id is None or thread_id is None:
        return None

    suffix = uuid.uuid4().hex[:8]
    path = f"document-{suffix}.md"
    title = (getattr(deps, "document_title", None) or "").strip() or "Document"

    async with SessionLocal() as session:
        doc = Document(
            workspace_id=workspace_id,
            path=path,
            title=title,
            content_md="",
        )
        session.add(doc)
        await session.flush()
        thread = await session.get(Thread, thread_id)
        if thread is not None:
            thread.active_document_id = doc.id
        await session.commit()
        await session.refresh(doc)
        doc_id = doc.id

    deps.document_id = doc_id
    deps.document_path = path
    if not (getattr(deps, "document_md", None) or "").strip():
        deps.document_md = ""
    run_state = getattr(deps, "_run_state", None)
    if run_state is not None:
        run_state.document_id = doc_id
        run_state.document_path = path
        if not (getattr(run_state, "document_md", None) or "").strip():
            run_state.document_md = getattr(deps, "document_md", "") or ""

    # Materialize empty file so later syncs have a path.
    _sync_document_workspace_file(deps, getattr(deps, "document_md", "") or "")

    return CustomEvent(
        type=EventType.CUSTOM,
        name="document_created",
        value={
            "id": str(doc_id),
            "path": path,
            "title": title,
            "content_md": getattr(deps, "document_md", "") or "",
        },
    )


async def suggest_edit(
    ctx: RunContext[Any],
    title: str,
    new_content: str | None = None,
    old_text: str | None = None,
    new_text: str | None = None,
    rationale: str = "",
) -> ToolReturn:
    """Propose a document edit (full rewrite or find/replace).

    Provide either:
    - ``new_content`` — replace the whole document, or
    - ``old_text`` + ``new_text`` — search-and-replace (empty ``old_text`` appends).

    If no document is open yet and this agent supports documents, creates an
    empty one first (no template). Pure additions apply immediately. Edits that
    change or remove existing text are queued for Accept/Reject with a red/green
    diff. ``title`` is a short label shown in the UI (e.g. "Draft findings").
    """
    created = await ensure_active_document(ctx.deps)
    if created is None and not getattr(ctx.deps, "document_id", None):
        return ToolReturn(
            return_value=(
                "Error: no active document. This agent does not use a document pane, "
                "or the document could not be created."
            )
        )
    if created is not None:
        ui_events = getattr(ctx.deps, "ui_events", None)
        if ui_events is not None:
            await ui_events.put(created)

    label = (title or "").strip() or "Edit"
    why = (rationale or "").strip()
    note = f"{label}" + (f" — {why}" if why else "")
    meta: list[Any] = [created] if created is not None else []

    if new_content is not None:
        item = PendingSuggestion(
            kind="full",
            old_text=getattr(ctx.deps, "document_md", "") or "",
            new_text=new_content,
        )
        event = commit_or_queue_suggestion(ctx.deps, item, rationale=note)
        meta.append(event)
        if event.name == "md_applied":
            msg = f"Applied full-document edit ({label})."
        else:
            msg = f"Queued full-document edit for review ({label})."
        return ToolReturn(return_value=f"{msg} {why}".strip(), metadata=meta)

    if new_text is None:
        return ToolReturn(
            return_value=(
                "Error: suggest_edit requires new_content "
                "(full rewrite) or old_text+new_text (find/replace)."
            )
        )

    item = PendingSuggestion(
        kind="patch",
        old_text=old_text or "",
        new_text=new_text,
    )
    event = commit_or_queue_suggestion(ctx.deps, item, rationale=note)
    meta.append(event)
    if event.name == "md_applied":
        msg = f"Applied addition ({label}, {len(new_text)} chars)."
    else:
        msg = (
            f"Queued patch for review ({label}, "
            f"{len(old_text or '')}→{len(new_text)} chars)."
        )
    return ToolReturn(return_value=f"{msg} {why}".strip(), metadata=meta)


async def read_workspace_file(ctx: RunContext[Any], relative_path: str) -> str:
    """Read a file from the materialized workspace directory."""
    root = Path(ctx.deps.workspace_dir) if getattr(ctx.deps, "workspace_dir", None) else None
    if not root:
        return "Error: no workspace"
    path = safe_workspace_path(root, relative_path)
    if path is None:
        return "Error: path escapes workspace"
    if not path.exists():
        return f"Not found: {relative_path}"
    return path.read_text(encoding="utf-8")[:50_000]


async def list_workspace_files(ctx: RunContext[Any]) -> str:
    """List files in the workspace directory."""
    root = Path(ctx.deps.workspace_dir) if getattr(ctx.deps, "workspace_dir", None) else None
    if not root or not root.exists():
        return "Workspace empty"
    files = [str(p.relative_to(root)) for p in root.rglob("*") if p.is_file()]
    return "\n".join(sorted(files)) or "(empty)"


async def write_workspace_file(
    ctx: RunContext[Any],
    relative_path: str,
    content: str,
) -> str:
    """Write a non-document workspace file under memory/ or research/ only."""
    allowed_prefixes = ("memory/", "research/")
    if not relative_path.startswith(allowed_prefixes):
        return (
            "Error: write_workspace_file only allows memory/ or research/. "
            "Use suggest_edit for document edits."
        )
    if relative_path.startswith("research/"):
        thread_prefix = f"research/{ctx.deps.thread_id}/"
        if not relative_path.startswith(thread_prefix):
            relative_path = thread_prefix + relative_path.removeprefix("research/")
    return write_workspace_file_content(
        getattr(ctx.deps, "workspace_dir", "") or "",
        relative_path,
        content,
    )


async def _run_python(code: str, workdir: str | None = None) -> dict[str, str]:
    """Run Python in a restricted subprocess (timeout, isolated cwd)."""
    settings = get_settings()
    root = Path(workdir or tempfile.mkdtemp(prefix="openagents-ci-"))
    root.mkdir(parents=True, exist_ok=True)
    script = root / "_run.py"
    script.write_text(code, encoding="utf-8")

    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(root),
        "PYTHONPATH": "",
        "PYTHONDONTWRITEBYTECODE": "1",
    }

    try:
        proc = await asyncio.create_subprocess_exec(
            "python3",
            str(script),
            cwd=str(root),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=settings.code_interpreter_timeout_s
            )
        except TimeoutError:
            proc.kill()
            await proc.communicate()
            return {"ok": "false", "stdout": "", "stderr": "Timed out", "cwd": str(root)}

        return {
            "ok": "true" if proc.returncode == 0 else "false",
            "stdout": stdout.decode("utf-8", errors="replace")[:20_000],
            "stderr": stderr.decode("utf-8", errors="replace")[:20_000],
            "cwd": str(root),
        }
    except Exception as exc:  # noqa: BLE001
        return {"ok": "false", "stdout": "", "stderr": str(exc), "cwd": str(root)}


async def run_code_interpreter(ctx: RunContext[Any], code: str) -> str:
    """Execute Python in a restricted subprocess. Use for calculations and matplotlib plots saved to cwd."""
    result = await _run_python(code, workdir=getattr(ctx.deps, "workspace_dir", None) or None)
    return (
        f"ok={result['ok']}\n"
        f"stdout:\n{result['stdout']}\n"
        f"stderr:\n{result['stderr']}\n"
        f"cwd={result['cwd']}"
    )


# Tools registered on the deep agent.
OPENAGENTS_HITL_TOOLS = [
    ask_user,
    read_document,
    suggest_edit,
]

# Classic-only workspace helpers (deep agent uses LocalBackend filesystem tools).
OPENAGENTS_CLASSIC_WORKSPACE_TOOLS = [
    read_workspace_file,
    list_workspace_files,
    write_workspace_file,
    run_code_interpreter,
]
