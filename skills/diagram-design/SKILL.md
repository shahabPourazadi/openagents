---
name: diagram-design
description: Best practices for Excalidraw canvas diagrams — architecture, flowcharts, comparisons, brainstorms.
---

# Diagram Design (Excalidraw Canvas)

Use the **Canvas** Artifacts pane (native Excalidraw tools), not Mermaid, for freeform boards.

## When to use Canvas vs Document

| Use Canvas | Use Document (Mermaid OK) |
|------------|---------------------------|
| Architecture / system maps | Long-form research notes |
| Flowcharts / process maps | Reports and write-ups |
| Comparing 3+ options visually | Compact in-doc charts |
| Brainstorm / mind map | Prose explanations |
| Whiteboard exploration | |

If ambiguous, call `ask_user` once (document vs canvas) and remember the choice.

## Workflow

1. Plan the diagram (type, elements, layout) before drawing
2. `canvas_batch_create_elements` with element JSON
3. `canvas_align_elements` / `canvas_distribute_elements` for cleanup
4. `describe_canvas` to verify
5. `canvas_update_elements` / `canvas_group_elements` as needed

Destructive ops (`clear_canvas`, `replace_canvas_scene`) require `ask_user` then `confirm=true`.

## Tools

- `read_canvas` / `describe_canvas`
- `canvas_batch_create_elements`
- `canvas_update_elements` / `canvas_delete_elements`
- `canvas_align_elements` / `canvas_distribute_elements` / `canvas_group_elements`
- `clear_canvas` / `replace_canvas_scene` (gated)

Do **not** invent share links or export URLs — the user sees the live Artifacts canvas.

## Color palette

| Purpose | Hex |
|---------|-----|
| Primary | #1971c2 |
| Positive | #2f9e44 |
| Negative | #e03131 |
| Warning | #e8590c |
| Neutral | #868e96 |
| Highlight | #f08c00 |

## Element guidelines

- Short labels (2–4 words)
- Rectangles = processes/components; diamonds = decisions; ellipses = start/end
- Solid arrows = direct flow; dashed = optional/indirect
- ≥40px between elements; ≥80px between groups

## Mermaid

Keep Mermaid for small structured charts **inside** the document. Prefer Canvas for exploratory or multi-shape boards.
