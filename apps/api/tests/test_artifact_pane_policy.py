"""Seam 4: artifact pane selection — document vs canvas vs ask."""

from __future__ import annotations

from openagents_api.artifact_pane_policy import (
    ARTIFACT_PANE_INSTRUCTIONS,
    choose_artifact_pane,
    remember_artifact_pane,
)


def test_prefer_canvas_for_diagram_requests() -> None:
    assert (
        choose_artifact_pane("Draw an architecture diagram of our API") == "canvas"
    )
    assert choose_artifact_pane("brainstorm options on a whiteboard") == "canvas"
    assert choose_artifact_pane("flowchart for the onboarding process") == "canvas"
    assert choose_artifact_pane("compare three vendors visually") == "canvas"


def test_prefer_document_for_prose() -> None:
    assert choose_artifact_pane("Write research notes as a markdown report") == "document"
    assert choose_artifact_pane("Draft a long-form summary of findings") == "document"


def test_ask_when_ambiguous() -> None:
    assert choose_artifact_pane("Help me with this project") == "ask"
    assert choose_artifact_pane("Let's work on the options") == "ask"


def test_remembered_preference_wins_until_cleared() -> None:
    assert (
        choose_artifact_pane(
            "Help me with this project",
            preferred="canvas",
        )
        == "canvas"
    )
    assert (
        choose_artifact_pane(
            "Draw an architecture diagram",
            preferred="document",
        )
        == "document"
    )


def test_remember_artifact_pane_helper() -> None:
    state: dict[str, str | None] = {"preferred_artifact_pane": None}
    remember_artifact_pane(state, "canvas")
    assert state["preferred_artifact_pane"] == "canvas"
    remember_artifact_pane(state, "document")
    assert state["preferred_artifact_pane"] == "document"


def test_instructions_mention_both_panes() -> None:
    text = ARTIFACT_PANE_INSTRUCTIONS
    assert "canvas" in text.lower()
    assert "document" in text.lower()
    assert "ask_user" in text.lower()
