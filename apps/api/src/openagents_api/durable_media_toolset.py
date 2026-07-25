"""Wrap MCP toolsets so generated images are saved before AG-UI stringifies them.

Huge base64 tool results get corrupted on the AG-UI wire path. Capturing
``BinaryContent.data`` (raw bytes) at ``call_tool`` time avoids that.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic_ai import RunContext
from pydantic_ai.toolsets import WrapperToolset
from pydantic_ai.toolsets.abstract import ToolsetTool

from openagents_api.tool_media import (
    ToolMediaPromotion,
    _decode_image_data,
    _media_payload,
    _normalize_image_bytes,
    save_generated_image_asset,
)

_log = logging.getLogger(__name__)


def _image_parts_from_result(result: Any) -> list[tuple[str, bytes]]:
    """Collect (media_type, raw_bytes) from a tool return value."""
    found: list[tuple[str, bytes]] = []

    def walk(obj: Any) -> None:
        if obj is None:
            return
        data = getattr(obj, "data", None)
        media = getattr(obj, "media_type", None)
        if isinstance(data, (bytes, bytearray)) and isinstance(media, str):
            if media.startswith("image/"):
                found.append((media, bytes(data)))
            return
        if isinstance(obj, dict):
            media = obj.get("media_type") or obj.get("mimeType") or obj.get("mime_type")
            raw = obj.get("data") or obj.get("blob") or obj.get("b64_json")
            if isinstance(media, str) and media.startswith("image/"):
                if isinstance(raw, (bytes, bytearray)):
                    found.append((media, bytes(raw)))
                    return
                if isinstance(raw, str) and raw:
                    decoded = _decode_image_data(raw)
                    if decoded:
                        found.append((media, decoded))
                        return
            for value in obj.values():
                walk(value)
            return
        if isinstance(obj, (list, tuple)):
            for item in obj:
                walk(item)

    walk(result)
    return found


def persist_tool_result_images(
    result: Any,
    *,
    workspace_id: uuid.UUID,
    sandbox_dir: str | Path | None,
) -> tuple[Any, ToolMediaPromotion] | None:
    """Save loadable images from a tool result; return rewritten result + promotion.

    Returns None when there is nothing to rewrite.
    """
    parts = _image_parts_from_result(result)
    if not parts:
        return None

    images: list[str] = []
    texts: list[str] = []

    # Keep short text parts from MCP content lists.
    if isinstance(result, list):
        for item in result:
            if isinstance(item, dict) and item.get("type") == "text":
                t = item.get("text")
                if isinstance(t, str) and t.strip() and len(t) < 4_000:
                    texts.append(t.strip())
            elif isinstance(item, str) and item.strip() and len(item) < 4_000:
                texts.append(item.strip())
    elif isinstance(result, str) and result.strip() and len(result) < 4_000:
        texts.append(result.strip())

    for i, (media_type, raw) in enumerate(parts, start=1):
        normalized = _normalize_image_bytes(raw, media_type)
        if not normalized:
            _log.warning(
                "durable_media: skip unloadable image from tool result (%s, %s bytes)",
                media_type,
                len(raw),
            )
            continue
        path = save_generated_image_asset(
            workspace_id,
            normalized,
            media_type,
            index=i,
            sandbox_dir=sandbox_dir,
        )
        if path not in images:
            images.append(path)
        _log.info(
            "durable_media: saved %s (%s bytes) from tool result bytes",
            path,
            len(normalized),
        )

    if not images:
        return None

    promotion = ToolMediaPromotion(
        content=_media_payload(images=images, files=[], texts=texts or None),
        images=images,
    )
    # Return JSON-serializable metadata only — no BinaryContent on the AG-UI wire.
    rewritten: dict[str, Any] = {"images": images}
    if texts:
        rewritten["text"] = "\n".join(texts)
    return rewritten, promotion


_TOOL_FAIL_HINT = (
    "\n\nTOOL FAILED — do not claim this tool succeeded. "
    "Do not invent asset paths, costs, token counts, or image details. "
    "Tell the user the error clearly. Retry only with a corrected tool call "
    "(for example a valid model id)."
)


def _strengthen_tool_failure_message(message: str) -> str:
    text = (message or "").strip()
    if not text:
        return "Tool failed." + _TOOL_FAIL_HINT
    if "TOOL FAILED" in text:
        return text
    return text + _TOOL_FAIL_HINT


@dataclass
class DurableMediaToolset(WrapperToolset[Any]):
    """MCP wrapper that persists inline images as durable Assets."""

    async def call_tool(
        self,
        name: str,
        tool_args: dict[str, Any],
        ctx: RunContext[Any],
        tool: ToolsetTool[Any],
    ) -> Any:
        from pydantic_ai.exceptions import ModelRetry

        try:
            result = await self.wrapped.call_tool(name, tool_args, ctx, tool)
        except ModelRetry as exc:
            # Soft retries become ordinary tool-result text in AG-UI; make the
            # failure unmistakable so the model cannot invent a successful image.
            raise ModelRetry(
                message=_strengthen_tool_failure_message(str(exc.message))
            ) from exc

        deps = ctx.deps
        from openagents_api.tool_costs import (
            estimate_image_generation_cost_usd,
            extract_usage_cost_usd,
            record_multimodal_cost,
        )

        billed = extract_usage_cost_usd(result)

        workspace_id = getattr(deps, "workspace_id", None)
        workspace_dir = getattr(deps, "workspace_dir", None) or None
        if workspace_id is None:
            if billed is not None:
                record_multimodal_cost(deps, billed)
            return result
        try:
            rewritten = persist_tool_result_images(
                result,
                workspace_id=workspace_id,
                sandbox_dir=workspace_dir,
            )
        except Exception:
            _log.exception("durable_media: failed to persist images for tool %s", name)
            if billed is not None:
                record_multimodal_cost(deps, billed)
            return result
        if rewritten is None:
            if billed is not None:
                record_multimodal_cost(deps, billed)
            return result
        new_result, promotion = rewritten
        if billed is None and promotion.images:
            billed = estimate_image_generation_cost_usd(
                name, tool_args, image_count=len(promotion.images)
            )
        if billed is not None:
            record_multimodal_cost(deps, billed)
            if isinstance(new_result, dict):
                new_result = {**new_result, "cost_usd": billed}
        _log.info(
            "durable_media: tool %s → %s image(s) %s cost=%s",
            name,
            len(promotion.images),
            promotion.images,
            billed,
        )
        return new_result
