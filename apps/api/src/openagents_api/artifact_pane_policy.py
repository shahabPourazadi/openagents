"""Choose Document vs Excalidraw canvas for Artifacts pane output."""

from __future__ import annotations

import re
from typing import Any, Literal

PaneChoice = Literal["document", "canvas", "ask"]

_CANVAS_RE = re.compile(
    r"\b("
    r"architecture|flowchart|flow\s*chart|whiteboard|brainstorm|"
    r"diagram|excalidraw|mind\s*map|wireframe|storyboard|"
    r"visual\w*\s*compar|compar(e|ison).{0,40}visual\w*|"
    r"draw|sketch|canvas|board"
    r")\b",
    re.IGNORECASE,
)

_DOCUMENT_RE = re.compile(
    r"\b("
    r"markdown|document|report|notes?|write\s+up|write-up|"
    r"long[- ]?form|essay|draft\s+(a\s+)?(summary|report|notes)|"
    r"research\s+notes|prose|readme"
    r")\b",
    re.IGNORECASE,
)

ARTIFACT_PANE_INSTRUCTIONS = (
    "This agent has both a Document (markdown/BlockNote) and an Excalidraw Canvas "
    "in the Artifacts pane. "
    "Use the Document for prose, research notes, and reports (`read_document` / `suggest_edit`). "
    "Use the Canvas for architecture, flowcharts, comparisons, brainstorming, and freeform "
    "diagrams (`read_canvas` / `describe_canvas` / `canvas_batch_create_elements` and related tools). "
    "When the user's request clearly fits one, use that pane. "
    "When ambiguous, call ask_user once to choose document vs canvas, remember their choice "
    "for the rest of the thread, and do not ask again unless they switch topics. "
    "Keep Mermaid for small structured charts inside the document; prefer the canvas for "
    "exploratory boards. "
    "Never clear or fully replace the canvas without ask_user confirmation, then "
    "clear_canvas(confirm=true) or replace_canvas_scene(..., confirm=true)."
)


def choose_artifact_pane(
    user_message: str,
    *,
    preferred: str | None = None,
) -> PaneChoice:
    """Heuristic for which Artifacts pane to use.

    A remembered ``preferred`` (document|canvas) wins for the thread until cleared.
    """
    pref = (preferred or "").strip().lower()
    if pref in ("document", "canvas"):
        return pref  # type: ignore[return-value]

    text = (user_message or "").strip()
    if not text:
        return "ask"

    wants_canvas = bool(_CANVAS_RE.search(text))
    wants_document = bool(_DOCUMENT_RE.search(text))

    if wants_canvas and not wants_document:
        return "canvas"
    if wants_document and not wants_canvas:
        return "document"
    if wants_canvas and wants_document:
        return "ask"
    return "ask"


def remember_artifact_pane(target: Any, pane: str) -> None:
    """Store preferred_artifact_pane on a deps/state object or dict."""
    value = pane if pane in ("document", "canvas") else None
    if isinstance(target, dict):
        target["preferred_artifact_pane"] = value
        return
    setattr(target, "preferred_artifact_pane", value)
