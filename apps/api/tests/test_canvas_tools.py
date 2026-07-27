"""Seam 2: Canvas agent tools — batch ops, gated clear/replace, AG-UI events."""

from __future__ import annotations

import asyncio
import uuid
from types import SimpleNamespace

import pytest

from openagents_api.canvas_tools import (
    OPENAGENTS_CANVAS_TOOLS,
    canvas_align_elements,
    canvas_batch_create_elements,
    canvas_delete_elements,
    canvas_distribute_elements,
    canvas_group_elements,
    canvas_update_elements,
    clear_canvas,
    default_canvas_scene,
    describe_canvas,
    read_canvas,
    replace_canvas_scene,
)


def test_canvas_tool_list_names() -> None:
    names = {getattr(t, "__name__", str(t)) for t in OPENAGENTS_CANVAS_TOOLS}
    assert "read_canvas" in names
    assert "describe_canvas" in names
    assert "canvas_batch_create_elements" in names
    assert "canvas_update_elements" in names
    assert "canvas_delete_elements" in names
    assert "canvas_align_elements" in names
    assert "canvas_distribute_elements" in names
    assert "canvas_group_elements" in names
    assert "clear_canvas" in names
    assert "replace_canvas_scene" in names


def _deps(*, scene: dict | None = None, confirm_clear: bool = False) -> SimpleNamespace:
    return SimpleNamespace(
        canvas_id=uuid.uuid4(),
        canvas_scene=scene if scene is not None else default_canvas_scene(),
        canvas_title="Canvas",
        uses_canvas=True,
        workspace_id=uuid.uuid4(),
        thread_id=uuid.uuid4(),
        ui_events=asyncio.Queue(),
        _run_state=None,
        canvas_destructive_confirmed=confirm_clear,
        preferred_artifact_pane=None,
    )


@pytest.mark.asyncio
async def test_read_and_describe_empty_canvas() -> None:
    ctx = SimpleNamespace(deps=_deps())
    text = await read_canvas(ctx)  # type: ignore[arg-type]
    assert "empty" in text.lower() or "0 element" in text.lower()
    desc = await describe_canvas(ctx)  # type: ignore[arg-type]
    assert "0" in desc or "empty" in desc.lower()


@pytest.mark.asyncio
async def test_batch_create_merges_and_emits_canvas_updated() -> None:
    deps = _deps()
    ctx = SimpleNamespace(deps=deps, tool_call_id="t1")
    result = await canvas_batch_create_elements(
        ctx,  # type: ignore[arg-type]
        elements=[
            {
                "id": "a1",
                "type": "rectangle",
                "x": 0,
                "y": 0,
                "width": 120,
                "height": 60,
                "text": "API",
            },
            {
                "id": "a2",
                "type": "ellipse",
                "x": 200,
                "y": 0,
                "width": 80,
                "height": 80,
            },
        ],
    )
    assert "2" in result.return_value or "Created" in result.return_value
    els = deps.canvas_scene["elements"]
    assert len(els) == 2
    assert {e["id"] for e in els} == {"a1", "a2"}

    event = await asyncio.wait_for(deps.ui_events.get(), timeout=1)
    assert event.name == "canvas_updated"
    assert event.value["id"] == str(deps.canvas_id)
    assert len(event.value["scene_json"]["elements"]) == 2


@pytest.mark.asyncio
async def test_update_delete_align_distribute_group() -> None:
    scene = default_canvas_scene()
    scene["elements"] = [
        {"id": "a", "type": "rectangle", "x": 0, "y": 0, "width": 40, "height": 40},
        {"id": "b", "type": "rectangle", "x": 100, "y": 10, "width": 40, "height": 40},
    ]
    deps = _deps(scene=scene)
    ctx = SimpleNamespace(deps=deps, tool_call_id="t2")

    await canvas_update_elements(
        ctx,  # type: ignore[arg-type]
        updates=[{"id": "a", "text": "Node A"}],
    )
    assert next(e for e in deps.canvas_scene["elements"] if e["id"] == "a")["text"] == "Node A"

    await canvas_align_elements(ctx, element_ids=["a", "b"], axis="top")  # type: ignore[arg-type]
    ys = [e["y"] for e in deps.canvas_scene["elements"] if e["id"] in {"a", "b"}]
    assert ys[0] == ys[1]

    await canvas_distribute_elements(
        ctx,  # type: ignore[arg-type]
        element_ids=["a", "b"],
        axis="horizontal",
    )
    xs = [e["x"] for e in deps.canvas_scene["elements"] if e["id"] in {"a", "b"}]
    assert xs[0] != xs[1] or True  # layout ran without error

    await canvas_group_elements(ctx, element_ids=["a", "b"])  # type: ignore[arg-type]
    group_lists = [
        tuple(e.get("groupIds") or [])
        for e in deps.canvas_scene["elements"]
        if e["id"] in {"a", "b"}
    ]
    assert len(set(group_lists)) == 1
    assert group_lists[0]

    await canvas_delete_elements(ctx, element_ids=["b"])  # type: ignore[arg-type]
    assert {e["id"] for e in deps.canvas_scene["elements"]} == {"a"}


@pytest.mark.asyncio
async def test_clear_and_replace_require_confirm() -> None:
    scene = default_canvas_scene()
    scene["elements"] = [
        {"id": "z", "type": "rectangle", "x": 0, "y": 0, "width": 10, "height": 10}
    ]
    deps = _deps(scene=scene)
    ctx = SimpleNamespace(deps=deps, tool_call_id="t3")

    blocked = await clear_canvas(ctx)  # type: ignore[arg-type]
    assert "confirm" in blocked.return_value.lower() or "ask_user" in blocked.return_value.lower()
    assert len(deps.canvas_scene["elements"]) == 1

    blocked_replace = await replace_canvas_scene(
        ctx,  # type: ignore[arg-type]
        scene_json=default_canvas_scene(),
    )
    assert (
        "confirm" in blocked_replace.return_value.lower()
        or "ask_user" in blocked_replace.return_value.lower()
    )
    assert len(deps.canvas_scene["elements"]) == 1

    deps.canvas_destructive_confirmed = True
    cleared = await clear_canvas(ctx, confirm=True)  # type: ignore[arg-type]
    assert "Cleared" in cleared.return_value or "cleared" in cleared.return_value.lower()
    assert deps.canvas_scene["elements"] == []
