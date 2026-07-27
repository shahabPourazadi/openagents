"""Native Excalidraw canvas tools (DeepResearch-parity element ops).

Mutates ``canvas_scene`` on OpenAgents deps and emits AG-UI CustomEvents
``canvas_created`` / ``canvas_updated``. Clear / full replace are gated.
"""

from __future__ import annotations

import copy
import uuid
from typing import Any

from ag_ui.core import CustomEvent, EventType
from pydantic_ai import RunContext, ToolReturn


def default_canvas_scene() -> dict[str, Any]:
    return {
        "type": "excalidraw",
        "version": 2,
        "source": "openagents",
        "elements": [],
        "appState": {"viewBackgroundColor": "#ffffff"},
        "files": {},
    }


def normalize_scene(scene: dict[str, Any] | None) -> dict[str, Any]:
    base = default_canvas_scene()
    if not isinstance(scene, dict):
        return base
    out = copy.deepcopy(base)
    out.update({k: v for k, v in scene.items() if k in {"type", "version", "source", "appState", "files"}})
    elements = scene.get("elements")
    out["elements"] = copy.deepcopy(elements) if isinstance(elements, list) else []
    if not isinstance(out.get("appState"), dict):
        out["appState"] = {"viewBackgroundColor": "#ffffff"}
    if not isinstance(out.get("files"), dict):
        out["files"] = {}
    return out


def _elements(deps: Any) -> list[dict[str, Any]]:
    scene = getattr(deps, "canvas_scene", None)
    if not isinstance(scene, dict):
        deps.canvas_scene = default_canvas_scene()
        return deps.canvas_scene["elements"]
    els = scene.get("elements")
    if not isinstance(els, list):
        scene["elements"] = []
        return scene["elements"]
    return els


def _mirror_run_state(deps: Any) -> None:
    run_state = getattr(deps, "_run_state", None)
    if run_state is None:
        return
    run_state.canvas_id = getattr(deps, "canvas_id", None)
    run_state.canvas_scene = getattr(deps, "canvas_scene", None)
    run_state.canvas_title = getattr(deps, "canvas_title", None)
    run_state.canvas_destructive_confirmed = getattr(
        deps, "canvas_destructive_confirmed", False
    )


async def _emit_canvas_updated(deps: Any) -> CustomEvent:
    _mirror_run_state(deps)
    event = CustomEvent(
        type=EventType.CUSTOM,
        name="canvas_updated",
        value={
            "id": str(getattr(deps, "canvas_id", "") or ""),
            "title": getattr(deps, "canvas_title", None) or "Canvas",
            "scene_json": copy.deepcopy(normalize_scene(getattr(deps, "canvas_scene", None))),
        },
    )
    ui_events = getattr(deps, "ui_events", None)
    if ui_events is not None:
        await ui_events.put(event)
    return event


async def ensure_active_canvas(deps: Any) -> CustomEvent | None:
    """Create an empty active canvas when the agent first needs one."""
    if getattr(deps, "canvas_id", None):
        if not isinstance(getattr(deps, "canvas_scene", None), dict):
            deps.canvas_scene = default_canvas_scene()
        return None
    if not getattr(deps, "uses_canvas", False):
        return None

    from openagents_api.db import SessionLocal
    from openagents_api.models import Canvas, Thread

    workspace_id = getattr(deps, "workspace_id", None)
    thread_id = getattr(deps, "thread_id", None)
    if workspace_id is None or thread_id is None:
        return None

    title = (getattr(deps, "canvas_title", None) or "").strip() or "Canvas"
    scene = normalize_scene(getattr(deps, "canvas_scene", None))

    async with SessionLocal() as session:
        canvas = Canvas(
            workspace_id=workspace_id,
            title=title,
            scene_json=scene,
        )
        session.add(canvas)
        await session.flush()
        thread = await session.get(Thread, thread_id)
        if thread is not None:
            thread.active_canvas_id = canvas.id
        await session.commit()
        await session.refresh(canvas)
        canvas_id = canvas.id

    deps.canvas_id = canvas_id
    deps.canvas_title = title
    deps.canvas_scene = scene
    _mirror_run_state(deps)

    event = CustomEvent(
        type=EventType.CUSTOM,
        name="canvas_created",
        value={
            "id": str(canvas_id),
            "title": title,
            "scene_json": copy.deepcopy(scene),
        },
    )
    ui_events = getattr(deps, "ui_events", None)
    if ui_events is not None:
        await ui_events.put(event)
    return event


async def _require_canvas(ctx: RunContext[Any]) -> str | None:
    created = await ensure_active_canvas(ctx.deps)
    if created is None and not getattr(ctx.deps, "canvas_id", None):
        return (
            "Error: no active canvas. This agent does not use a canvas pane, "
            "or the canvas could not be created."
        )
    if not isinstance(getattr(ctx.deps, "canvas_scene", None), dict):
        ctx.deps.canvas_scene = default_canvas_scene()
    return None


def _normalize_element(raw: dict[str, Any]) -> dict[str, Any]:
    el = copy.deepcopy(raw)
    if not el.get("id"):
        el["id"] = uuid.uuid4().hex[:12]
    el.setdefault("type", "rectangle")
    el.setdefault("x", 0)
    el.setdefault("y", 0)
    el.setdefault("width", 100)
    el.setdefault("height", 60)
    el.setdefault("angle", 0)
    el.setdefault("strokeColor", "#1e1e1e")
    el.setdefault("backgroundColor", "transparent")
    el.setdefault("fillStyle", "solid")
    el.setdefault("strokeWidth", 2)
    el.setdefault("strokeStyle", "solid")
    el.setdefault("roughness", 1)
    el.setdefault("opacity", 100)
    el.setdefault("groupIds", [])
    el.setdefault("frameId", None)
    el.setdefault("roundness", None)
    el.setdefault("seed", int(uuid.uuid4().int % 2_000_000_000))
    el.setdefault("version", 1)
    el.setdefault("versionNonce", int(uuid.uuid4().int % 2_000_000_000))
    el.setdefault("isDeleted", False)
    el.setdefault("boundElements", None)
    el.setdefault("updated", 1)
    el.setdefault("link", None)
    el.setdefault("locked", False)
    return el


async def read_canvas(ctx: RunContext[Any]) -> str:
    """Return the current Excalidraw scene JSON (truncated)."""
    err = await _require_canvas(ctx)
    if err:
        return err
    scene = normalize_scene(ctx.deps.canvas_scene)
    els = scene.get("elements") or []
    if not els:
        return "Active canvas is empty (0 elements)."
    import json

    payload = json.dumps(scene, ensure_ascii=False)
    return payload[:50_000]


async def describe_canvas(ctx: RunContext[Any]) -> str:
    """Summarize elements on the active canvas for layout inspection."""
    err = await _require_canvas(ctx)
    if err:
        return err
    els = [e for e in _elements(ctx.deps) if isinstance(e, dict) and not e.get("isDeleted")]
    if not els:
        return "Canvas is empty (0 elements)."
    lines = [f"{len(els)} element(s):"]
    for e in els[:80]:
        eid = e.get("id", "?")
        et = e.get("type", "?")
        text = (e.get("text") or e.get("label") or "").strip()
        label = f' "{text}"' if text else ""
        lines.append(
            f"- {eid}: {et}{label} @ ({e.get('x', 0)}, {e.get('y', 0)}) "
            f"{e.get('width', 0)}x{e.get('height', 0)}"
        )
    if len(els) > 80:
        lines.append(f"... and {len(els) - 80} more")
    return "\n".join(lines)


async def canvas_batch_create_elements(
    ctx: RunContext[Any],
    elements: list[dict[str, Any]],
) -> ToolReturn:
    """Add or replace elements by id on the active canvas (live-apply)."""
    err = await _require_canvas(ctx)
    if err:
        return ToolReturn(return_value=err)
    if not elements:
        return ToolReturn(return_value="Error: elements list is empty.")

    current = _elements(ctx.deps)
    by_id = {e.get("id"): i for i, e in enumerate(current) if isinstance(e, dict) and e.get("id")}
    created = 0
    updated = 0
    for raw in elements:
        if not isinstance(raw, dict):
            continue
        el = _normalize_element(raw)
        eid = el["id"]
        if eid in by_id:
            current[by_id[eid]] = el
            updated += 1
        else:
            by_id[eid] = len(current)
            current.append(el)
            created += 1

    event = await _emit_canvas_updated(ctx.deps)
    return ToolReturn(
        return_value=f"Created {created}, updated {updated} element(s) on the canvas.",
        metadata=[event],
    )


async def canvas_update_elements(
    ctx: RunContext[Any],
    updates: list[dict[str, Any]],
) -> ToolReturn:
    """Patch existing elements by id (partial fields)."""
    err = await _require_canvas(ctx)
    if err:
        return ToolReturn(return_value=err)
    current = _elements(ctx.deps)
    by_id = {e.get("id"): e for e in current if isinstance(e, dict) and e.get("id")}
    n = 0
    for raw in updates or []:
        if not isinstance(raw, dict) or not raw.get("id"):
            continue
        target = by_id.get(raw["id"])
        if target is None:
            continue
        for k, v in raw.items():
            if k == "id":
                continue
            target[k] = v
        target["version"] = int(target.get("version") or 1) + 1
        n += 1
    event = await _emit_canvas_updated(ctx.deps)
    return ToolReturn(return_value=f"Updated {n} element(s).", metadata=[event])


async def canvas_delete_elements(
    ctx: RunContext[Any],
    element_ids: list[str],
) -> ToolReturn:
    """Remove elements by id from the active canvas."""
    err = await _require_canvas(ctx)
    if err:
        return ToolReturn(return_value=err)
    ids = {i for i in element_ids or [] if i}
    before = len(_elements(ctx.deps))
    ctx.deps.canvas_scene["elements"] = [
        e
        for e in _elements(ctx.deps)
        if not (isinstance(e, dict) and e.get("id") in ids)
    ]
    removed = before - len(_elements(ctx.deps))
    event = await _emit_canvas_updated(ctx.deps)
    return ToolReturn(return_value=f"Deleted {removed} element(s).", metadata=[event])


async def canvas_align_elements(
    ctx: RunContext[Any],
    element_ids: list[str],
    axis: str = "left",
) -> ToolReturn:
    """Align elements along an axis: left, right, top, bottom, center_x, center_y."""
    err = await _require_canvas(ctx)
    if err:
        return ToolReturn(return_value=err)
    ids = [i for i in element_ids or [] if i]
    els = [e for e in _elements(ctx.deps) if isinstance(e, dict) and e.get("id") in ids]
    if len(els) < 2:
        return ToolReturn(return_value="Need at least 2 elements to align.")
    ax = (axis or "left").strip().lower()
    if ax == "left":
        val = min(float(e.get("x") or 0) for e in els)
        for e in els:
            e["x"] = val
    elif ax == "right":
        val = max(float(e.get("x") or 0) + float(e.get("width") or 0) for e in els)
        for e in els:
            e["x"] = val - float(e.get("width") or 0)
    elif ax == "top":
        val = min(float(e.get("y") or 0) for e in els)
        for e in els:
            e["y"] = val
    elif ax == "bottom":
        val = max(float(e.get("y") or 0) + float(e.get("height") or 0) for e in els)
        for e in els:
            e["y"] = val - float(e.get("height") or 0)
    elif ax == "center_x":
        centers = [
            float(e.get("x") or 0) + float(e.get("width") or 0) / 2 for e in els
        ]
        mid = sum(centers) / len(centers)
        for e in els:
            e["x"] = mid - float(e.get("width") or 0) / 2
    elif ax == "center_y":
        centers = [
            float(e.get("y") or 0) + float(e.get("height") or 0) / 2 for e in els
        ]
        mid = sum(centers) / len(centers)
        for e in els:
            e["y"] = mid - float(e.get("height") or 0) / 2
    else:
        return ToolReturn(
            return_value="Error: axis must be left|right|top|bottom|center_x|center_y."
        )
    event = await _emit_canvas_updated(ctx.deps)
    return ToolReturn(return_value=f"Aligned {len(els)} elements on {ax}.", metadata=[event])


async def canvas_distribute_elements(
    ctx: RunContext[Any],
    element_ids: list[str],
    axis: str = "horizontal",
) -> ToolReturn:
    """Evenly distribute elements horizontally or vertically."""
    err = await _require_canvas(ctx)
    if err:
        return ToolReturn(return_value=err)
    ids = [i for i in element_ids or [] if i]
    els = [e for e in _elements(ctx.deps) if isinstance(e, dict) and e.get("id") in ids]
    if len(els) < 2:
        return ToolReturn(return_value="Need at least 2 elements to distribute.")
    ax = (axis or "horizontal").strip().lower()
    if ax.startswith("h"):
        els_sorted = sorted(els, key=lambda e: float(e.get("x") or 0))
        left = float(els_sorted[0].get("x") or 0)
        right = float(els_sorted[-1].get("x") or 0) + float(els_sorted[-1].get("width") or 0)
        total_w = sum(float(e.get("width") or 0) for e in els_sorted)
        gap = (right - left - total_w) / max(len(els_sorted) - 1, 1)
        cursor = left
        for e in els_sorted:
            e["x"] = cursor
            cursor += float(e.get("width") or 0) + gap
    elif ax.startswith("v"):
        els_sorted = sorted(els, key=lambda e: float(e.get("y") or 0))
        top = float(els_sorted[0].get("y") or 0)
        bottom = float(els_sorted[-1].get("y") or 0) + float(els_sorted[-1].get("height") or 0)
        total_h = sum(float(e.get("height") or 0) for e in els_sorted)
        gap = (bottom - top - total_h) / max(len(els_sorted) - 1, 1)
        cursor = top
        for e in els_sorted:
            e["y"] = cursor
            cursor += float(e.get("height") or 0) + gap
    else:
        return ToolReturn(return_value="Error: axis must be horizontal or vertical.")
    event = await _emit_canvas_updated(ctx.deps)
    return ToolReturn(
        return_value=f"Distributed {len(els)} elements ({ax}).",
        metadata=[event],
    )


async def canvas_group_elements(
    ctx: RunContext[Any],
    element_ids: list[str],
) -> ToolReturn:
    """Assign a shared groupId to the given elements."""
    err = await _require_canvas(ctx)
    if err:
        return ToolReturn(return_value=err)
    ids = {i for i in element_ids or [] if i}
    group_id = uuid.uuid4().hex[:10]
    n = 0
    for e in _elements(ctx.deps):
        if isinstance(e, dict) and e.get("id") in ids:
            e["groupIds"] = [group_id]
            n += 1
    event = await _emit_canvas_updated(ctx.deps)
    return ToolReturn(return_value=f"Grouped {n} elements ({group_id}).", metadata=[event])


def _destructive_allowed(deps: Any, *, confirm: bool) -> bool:
    if confirm:
        return True
    return bool(getattr(deps, "canvas_destructive_confirmed", False))


async def clear_canvas(
    ctx: RunContext[Any],
    confirm: bool = False,
) -> ToolReturn:
    """Clear all elements. Requires confirm=true after ask_user approval."""
    err = await _require_canvas(ctx)
    if err:
        return ToolReturn(return_value=err)
    if not _destructive_allowed(ctx.deps, confirm=confirm):
        return ToolReturn(
            return_value=(
                "Clearing the canvas is destructive. Call ask_user to confirm with the user, "
                "then call clear_canvas(confirm=true)."
            )
        )
    ctx.deps.canvas_scene = default_canvas_scene()
    ctx.deps.canvas_destructive_confirmed = False
    event = await _emit_canvas_updated(ctx.deps)
    return ToolReturn(return_value="Cleared the canvas.", metadata=[event])


async def replace_canvas_scene(
    ctx: RunContext[Any],
    scene_json: dict[str, Any],
    confirm: bool = False,
) -> ToolReturn:
    """Replace the entire scene. Requires confirm=true after ask_user approval."""
    err = await _require_canvas(ctx)
    if err:
        return ToolReturn(return_value=err)
    if not _destructive_allowed(ctx.deps, confirm=confirm):
        return ToolReturn(
            return_value=(
                "Replacing the full canvas scene is destructive. Call ask_user to confirm, "
                "then call replace_canvas_scene(..., confirm=true)."
            )
        )
    ctx.deps.canvas_scene = normalize_scene(scene_json)
    ctx.deps.canvas_destructive_confirmed = False
    event = await _emit_canvas_updated(ctx.deps)
    return ToolReturn(return_value="Replaced the canvas scene.", metadata=[event])


OPENAGENTS_CANVAS_TOOLS = [
    read_canvas,
    describe_canvas,
    canvas_batch_create_elements,
    canvas_update_elements,
    canvas_delete_elements,
    canvas_align_elements,
    canvas_distribute_elements,
    canvas_group_elements,
    clear_canvas,
    replace_canvas_scene,
]
