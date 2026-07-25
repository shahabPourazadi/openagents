"""Generic HITL tools — read_document / suggest_edit."""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest

from openagents_api.hitl_tools import (
    OPENAGENTS_HITL_TOOLS,
    commit_or_queue_suggestion,
    read_document,
    suggest_edit,
)
from openagents_api.suggestions import PendingSuggestion


def test_hitl_tool_list_is_generic() -> None:
    names = {getattr(t, "__name__", str(t)) for t in OPENAGENTS_HITL_TOOLS}
    assert names == {"ask_user", "read_document", "suggest_edit"}
    assert "get_rubric" not in names
    assert "intake_content" not in names
    assert "score_section" not in names
    assert "score_step" not in names
    assert "read_disclosure" not in names


@pytest.mark.asyncio
async def test_read_document_empty_and_full() -> None:
    ctx = SimpleNamespace(
        deps=SimpleNamespace(
            document_id=None,
            document_md="",
            document_path="",
        )
    )
    assert "No active document" in await read_document(ctx)  # type: ignore[arg-type]

    ctx.deps.document_id = uuid.uuid4()
    ctx.deps.document_path = "document.md"
    ctx.deps.document_md = "# Hello\n\nWorld"
    text = await read_document(ctx)  # type: ignore[arg-type]
    assert "document.md" in text
    assert "Hello" in text


@pytest.mark.asyncio
async def test_suggest_edit_full_and_patch() -> None:
    deps = SimpleNamespace(
        document_md="",
        document_id=uuid.uuid4(),
        document_path="document.md",
        workspace_dir="",
        pending=[],
        _run_state=None,
    )
    ctx = SimpleNamespace(deps=deps, tool_call_id="t1")

    result = await suggest_edit(
        ctx,  # type: ignore[arg-type]
        title="Draft",
        new_content="# Notes\n\nA",
        rationale="start",
    )
    assert "Applied" in result.return_value
    assert deps.document_md.startswith("# Notes")

    result = await suggest_edit(
        ctx,  # type: ignore[arg-type]
        title="Tweak",
        old_text="A",
        new_text="B",
    )
    assert "Queued" in result.return_value or "Applied" in result.return_value
    assert deps.pending or "B" in deps.document_md


def test_commit_or_queue_patch_append() -> None:
    deps = SimpleNamespace(
        document_md="hello",
        document_path="",
        workspace_dir="",
        pending=[],
        _run_state=None,
    )
    item = PendingSuggestion(kind="patch", old_text="", new_text="\nworld")
    event = commit_or_queue_suggestion(deps, item, rationale="append")
    assert event.name == "md_applied"
    assert "world" in deps.document_md
