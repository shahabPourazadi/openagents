"""Promote inline tool-result images into durable workspace Assets."""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from openagents_api.workspace_assets import (
    IMAGE_EXTENSIONS,
    is_allowed_asset_path,
    list_assets,
    normalize_asset_path,
    read_asset_bytes,
    save_asset_bytes,
)

_log = logging.getLogger(__name__)

_ASSET_PATH_RE = re.compile(
    r"(?:diagrams|other)/(?:[\w.\- ]+/)*[\w.\- ]+\.[\w]+",
)

_MEDIA_TYPE_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
}


@dataclass(frozen=True)
class ToolMediaPromotion:
    """Sanitized tool result content plus durable asset paths."""

    content: str
    images: list[str] = field(default_factory=list)
    files: list[str] = field(default_factory=list)


def _pad_b64(raw: str) -> str:
    return raw + ("=" * ((4 - len(raw) % 4) % 4))


def _looks_like_image_bytes(data: bytes) -> bool:
    if len(data) < 24:
        return False
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return True
    if data.startswith(b"\xff\xd8\xff"):
        return True
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return True
    if data.startswith(b"GIF87a") or data.startswith(b"GIF89a"):
        return True
    head = data.lstrip()[:64].lower()
    return head.startswith(b"<svg") or head.startswith(b"<?xml")


def _decode_image_data(data: Any) -> bytes | None:
    """Decode image bytes from AG-UI / MCP payloads.

    AG-UI serializes ``BinaryContent`` with **URL-safe** base64 (``-`` / ``_``).
    MCP image blocks often use standard base64 (``+`` / ``/``). Try both.
    """
    if isinstance(data, (bytes, bytearray)):
        return bytes(data) if data else None
    if isinstance(data, list) and data and all(isinstance(x, int) and 0 <= x <= 255 for x in data[:8]):
        try:
            return bytes(data)
        except Exception:
            return None
    if not isinstance(data, str) or not data:
        return None
    raw = data.strip()
    if raw.startswith("data:") and "," in raw:
        raw = raw.split(",", 1)[1]
    # Strip whitespace/newlines common in wrapped base64.
    compact = "".join(raw.split())
    if not compact:
        return None

    candidates: list[bytes] = []
    for decoder in (base64.urlsafe_b64decode, base64.b64decode):
        try:
            decoded = decoder(_pad_b64(compact), validate=False)
        except Exception:
            continue
        if decoded and _looks_like_image_bytes(decoded):
            return decoded
        if decoded:
            candidates.append(decoded)

    # Prefer a candidate that at least has a PNG/JPEG header after urlsafe translate.
    translated = compact.replace("-", "+").replace("_", "/")
    try:
        decoded = base64.b64decode(_pad_b64(translated), validate=False)
        if decoded and _looks_like_image_bytes(decoded):
            return decoded
        if decoded:
            candidates.append(decoded)
    except Exception:
        pass

    return candidates[0] if candidates else None


def _normalize_image_bytes(data: bytes, media_type: str) -> bytes | None:
    """Re-encode raster images so browsers can open them.

    Returns None when bytes are not a loadable image (never persist broken PNGs).
    """
    mt = (media_type or "").split(";")[0].strip().lower()
    if mt in {"image/svg+xml"} or data.lstrip()[:5].lower() in {b"<svg", b"<?xml"}:
        return data
    try:
        from io import BytesIO

        from PIL import Image

        im = Image.open(BytesIO(data))
        im.load()
        out = BytesIO()
        fmt = "PNG"
        if mt in {"image/jpeg", "image/jpg"}:
            fmt = "JPEG"
            if im.mode in {"RGBA", "P"}:
                im = im.convert("RGB")
        elif mt == "image/webp":
            fmt = "WEBP"
        elif mt == "image/gif":
            fmt = "GIF"
        else:
            if im.mode not in {"RGB", "RGBA", "L", "P"}:
                im = im.convert("RGBA" if "A" in im.getbands() else "RGB")
        im.save(out, format=fmt)
        return out.getvalue()
    except Exception as exc:
        _log.warning(
            "tool_media: rejected unloadable image bytes len=%s media_type=%s err=%s head=%s",
            len(data),
            mt,
            exc,
            data[:16].hex() if data else "",
        )
        return None


def _ext_for_media_type(media_type: str) -> str | None:
    mt = (media_type or "").split(";")[0].strip().lower()
    return _MEDIA_TYPE_EXT.get(mt)


def _debug_dump_payload(content: str, *, reason: str) -> None:
    """Optionally dump raw tool-result payloads for local debugging."""
    if os.environ.get("OPENAGENTS_DEBUG_TOOL_MEDIA", "").lower() not in {
        "1",
        "true",
        "yes",
    }:
        return
    try:
        path = Path("/tmp/openagents-tool-media-debug.json")
        meta = {
            "reason": reason,
            "content_len": len(content),
            "has_plus": "+" in content,
            "has_slash": "/" in content,
            "has_minus": "-" in content,
            "has_underscore": "_" in content,
            "head": content[:500],
            "tail": content[-500:] if len(content) > 500 else content,
        }
        # Also capture first data-field stats if JSON.
        try:
            parsed = json.loads(content)

            def first_data(obj: Any) -> str | None:
                if isinstance(obj, dict):
                    for key in ("data", "blob", "b64_json", "b64Json"):
                        v = obj.get(key)
                        if isinstance(v, str) and len(v) > 64:
                            return v
                    for v in obj.values():
                        got = first_data(v)
                        if got:
                            return got
                elif isinstance(obj, list):
                    for item in obj:
                        got = first_data(item)
                        if got:
                            return got
                return None

            data_field = first_data(parsed)
            if data_field:
                compact = "".join(data_field.split())
                meta["data_field_len"] = len(compact)
                meta["data_alphabet"] = {
                    "plus": compact.count("+"),
                    "slash": compact.count("/"),
                    "minus": compact.count("-"),
                    "underscore": compact.count("_"),
                }
                for name, decoder in (
                    ("urlsafe", base64.urlsafe_b64decode),
                    ("std", base64.b64decode),
                ):
                    try:
                        decoded = decoder(_pad_b64(compact), validate=False)
                        meta[f"decode_{name}_len"] = len(decoded)
                        meta[f"decode_{name}_magic"] = decoded[:8].hex()
                    except Exception as exc:
                        meta[f"decode_{name}_err"] = str(exc)
        except Exception as exc:
            meta["json_err"] = str(exc)
        path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
        _log.warning("tool_media: wrote debug dump to %s (%s)", path, reason)
    except Exception:
        _log.exception("tool_media: failed to write debug dump")


def _collect_from_rehydrated(obj: Any, found: list[tuple[str, bytes]]) -> None:
    """Pull bytes from pydantic-ai BinaryContent / BinaryImage after official rehydrate."""
    data = getattr(obj, "data", None)
    media = getattr(obj, "media_type", None)
    if isinstance(data, (bytes, bytearray)) and isinstance(media, str) and media.startswith("image/"):
        normalized = _normalize_image_bytes(bytes(data), media)
        if normalized:
            found.append((media, normalized))
        return
    if isinstance(obj, dict):
        for value in obj.values():
            _collect_from_rehydrated(value, found)
        return
    if isinstance(obj, (list, tuple)):
        for item in obj:
            _collect_from_rehydrated(item, found)


def _walk_collect_images(obj: Any, found: list[tuple[str, bytes]]) -> None:
    if isinstance(obj, dict):
        media = obj.get("media_type") or obj.get("mimeType") or obj.get("mime_type")
        # AG-UI BinaryContent, MCP image blocks, OpenRouter b64_json payloads.
        data = (
            obj.get("data")
            or obj.get("blob")
            or obj.get("b64_json")
            or obj.get("b64Json")
        )
        if isinstance(media, str) and media.startswith("image/"):
            decoded = _decode_image_data(data)
            if isinstance(data, str):
                _log.info(
                    "tool_media: image field media=%s data_len=%s decoded_len=%s "
                    "alphabet(+/=%s,/=%s,-=%s,_=%s)",
                    media,
                    len(data),
                    len(decoded) if decoded else None,
                    data.count("+"),
                    data.count("/"),
                    data.count("-"),
                    data.count("_"),
                )
            ext = _ext_for_media_type(media)
            if decoded and ext:
                normalized = _normalize_image_bytes(decoded, media)
                if normalized:
                    found.append((media, normalized))
                else:
                    _debug_dump_payload(json.dumps(obj)[:50_000], reason="pil_reject")
                return
        # kind=binary without a usable media_type still often carries image bytes.
        if obj.get("kind") == "binary" and data is not None:
            decoded = _decode_image_data(data)
            if decoded and _looks_like_image_bytes(decoded):
                mt = (
                    media
                    if isinstance(media, str) and media.startswith("image/")
                    else "image/png"
                )
                normalized = _normalize_image_bytes(decoded, mt)
                if normalized:
                    found.append((mt, normalized))
                else:
                    _debug_dump_payload(json.dumps(obj)[:50_000], reason="pil_reject_binary")
                return
        for value in obj.values():
            _walk_collect_images(value, found)
        return
    if isinstance(obj, list):
        for item in obj:
            _walk_collect_images(item, found)


def _generated_path(index: int, media_type: str) -> str:
    ext = _ext_for_media_type(media_type) or ".png"
    short = uuid.uuid4().hex[:12]
    return f"diagrams/generated-{short}-{index}{ext}"


# Filesystem / vision re-reads — bytes are already durable; do not mint a new asset.
_NO_INLINE_PROMOTE_TOOLS = frozenset(
    {
        "read_file",
        "read_workspace_file",
        "read_resource",
        "cat",
    }
)


def normalize_tool_name(tool_name: str | None) -> str:
    if not tool_name:
        return ""
    bare = tool_name.split("|")[-1] if "|" in tool_name else tool_name
    return (
        bare.replace("-", "_")
        .replace(" ", "_")
        .strip()
        .lower()
    )


def should_promote_inline_images(tool_name: str | None) -> bool:
    """False for read_file-style tools that only re-surface existing image bytes."""
    key = normalize_tool_name(tool_name)
    if not key:
        return True
    if key in _NO_INLINE_PROMOTE_TOOLS:
        return False
    if key.startswith("read_") and "file" in key:
        return False
    return True


def find_asset_path_by_bytes(workspace_id: uuid.UUID, data: bytes) -> str | None:
    """Return an existing asset path with identical bytes (size + sha256), if any."""
    if not data:
        return None
    digest = hashlib.sha256(data).digest()
    size = len(data)
    for row in list_assets(workspace_id):
        if int(row.get("size") or 0) != size:
            continue
        path = row.get("path")
        if not isinstance(path, str):
            continue
        existing = read_asset_bytes(workspace_id, path)
        if existing is not None and hashlib.sha256(existing).digest() == digest:
            return path
    return None


def save_generated_image_asset(
    workspace_id: uuid.UUID,
    data: bytes,
    media_type: str,
    *,
    index: int = 1,
    sandbox_dir: str | Path | None = None,
) -> str:
    """Persist image bytes, reusing an existing asset when content matches."""
    existing = find_asset_path_by_bytes(workspace_id, data)
    if existing:
        _log.info("tool_media: reuse existing asset %s (content match)", existing)
        if sandbox_dir is not None:
            dest = Path(sandbox_dir) / existing
            if not dest.is_file():
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(data)
        return existing

    path = _generated_path(index, media_type)
    save_asset_bytes(workspace_id, path, data)
    if sandbox_dir is not None:
        dest = Path(sandbox_dir) / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
    return path


def _looks_like_inline_media(content: str) -> bool:
    if not content:
        return False
    head = content[:2_000]
    return (
        '"media_type"' in head
        or '"mimeType"' in head
        or "iVBOR" in head
        or len(content) >= 4_000
    )


def _strip_binary_tool_result(content: str) -> str:
    """Fallback: strip base64 BinaryContent without persisting (no workspace)."""
    if not content:
        return content
    if len(content) < 4_000 and '"media_type"' not in content[:1_200]:
        return content

    texts: list[str] = []
    image_count = 0

    def walk(obj: Any) -> None:
        nonlocal image_count
        if isinstance(obj, str):
            if len(obj) < 4_000 and not obj.startswith("iVBOR"):
                texts.append(obj)
            return
        if isinstance(obj, dict):
            media = obj.get("media_type")
            data = obj.get("data")
            if isinstance(media, str) and media.startswith(("image/", "application/pdf")):
                image_count += 1
                return
            if isinstance(data, str) and len(data) > 500:
                image_count += 1
                return
            for value in obj.values():
                walk(value)
            return
        if isinstance(obj, list):
            for item in obj:
                walk(item)

    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        if len(content) > 20_000:
            return f"[Large tool result omitted — {len(content):,} chars]"
        return content

    if isinstance(parsed, (dict, list)):
        walk(parsed)
        parts: list[str] = []
        for t in texts:
            t = t.strip()
            if t and t not in parts:
                parts.append(t)
        if image_count:
            parts.append(f"[Attached {image_count} image(s) for vision — not shown as text.]")
        if parts:
            return "\n".join(parts)
        if len(content) > 20_000:
            return f"[Binary tool result omitted — {len(content):,} chars]"
    elif len(content) > 20_000:
        return f"[Large tool result omitted — {len(content):,} chars]"
    return content


def _media_payload(*, images: list[str], files: list[str], texts: list[str] | None = None) -> str:
    payload: dict[str, Any] = {}
    if texts:
        payload["text"] = "\n".join(texts)
    if images:
        payload["images"] = images
    if files:
        payload["files"] = files
    return json.dumps(payload, separators=(",", ":"))


def promote_sandbox_assets(
    workspace_id: uuid.UUID,
    paths: list[str],
    *,
    sandbox_dir: str | Path,
) -> ToolMediaPromotion:
    """Eager-save sandbox asset paths and classify images vs other files."""
    root = Path(sandbox_dir)
    images: list[str] = []
    files: list[str] = []
    for raw in paths:
        rel = normalize_asset_path(raw)
        if rel is None or not is_allowed_asset_path(rel):
            continue
        src = root / rel
        if not src.is_file():
            continue
        data = src.read_bytes()
        if not data:
            continue
        try:
            save_asset_bytes(workspace_id, rel, data)
        except ValueError:
            continue
        if Path(rel).suffix.lower() in IMAGE_EXTENSIONS:
            if rel not in images:
                images.append(rel)
        elif rel not in files:
            files.append(rel)
    if not images and not files:
        return ToolMediaPromotion(content="{}")
    return ToolMediaPromotion(
        content=_media_payload(images=images, files=files),
        images=images,
        files=files,
    )


def extract_asset_paths(content: str) -> list[str]:
    """Find diagrams/… and other/… path mentions in tool-result text/JSON."""
    if not content:
        return []
    found: list[str] = []
    for match in _ASSET_PATH_RE.findall(content):
        rel = normalize_asset_path(match)
        if rel and rel not in found:
            found.append(rel)
    return found


def _collect_short_texts(content: str) -> list[str]:
    texts: list[str] = []

    def walk(obj: Any) -> None:
        if isinstance(obj, str):
            s = obj.strip()
            if (
                s
                and len(s) < 4_000
                and not s.startswith("iVBOR")
                and normalize_asset_path(s) is None
                and '"media_type"' not in s[:80]
            ):
                if s not in texts:
                    texts.append(s)
            return
        if isinstance(obj, dict):
            media = obj.get("media_type") or obj.get("mimeType")
            if isinstance(media, str) and media.startswith("image/"):
                return
            for value in obj.values():
                walk(value)
            return
        if isinstance(obj, list):
            for item in obj:
                walk(item)

    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        return texts
    if isinstance(parsed, (dict, list)):
        walk(parsed)
    return texts


def sanitize_tool_result_for_ui(
    content: str,
    *,
    workspace_id: uuid.UUID | None = None,
    sandbox_dir: str | Path | None = None,
    tool_name: str | None = None,
) -> str:
    """Compact TOOL_CALL_RESULT for chat/SSE; promote inline images when possible."""
    if not content:
        return content

    images: list[str] = []
    files: list[str] = []
    texts: list[str] = []
    promote_inline = should_promote_inline_images(tool_name)

    if (
        promote_inline
        and workspace_id is not None
        and _looks_like_inline_media(content)
    ):
        promoted = promote_tool_result_media(
            workspace_id, content, sandbox_dir=sandbox_dir
        )
        images.extend(promoted.images)
        files.extend(promoted.files)
        if promoted.images or promoted.files:
            try:
                meta = json.loads(promoted.content)
                if isinstance(meta.get("text"), str) and meta["text"]:
                    texts.append(meta["text"])
            except json.JSONDecodeError:
                pass

    if workspace_id is not None and sandbox_dir is not None:
        path_hits = extract_asset_paths(content)
        if path_hits:
            from_sandbox = promote_sandbox_assets(
                workspace_id, path_hits, sandbox_dir=sandbox_dir
            )
            for p in from_sandbox.images:
                if p not in images:
                    images.append(p)
            for p in from_sandbox.files:
                if p not in files:
                    files.append(p)
            for t in _collect_short_texts(content):
                if t not in texts:
                    texts.append(t)

    if images or files:
        return _media_payload(images=images, files=files, texts=texts or None)

    # read_file / vision re-reads: strip binary, never mint a second generated-* path.
    if not promote_inline and _looks_like_inline_media(content):
        return _strip_binary_tool_result(content)

    return _strip_binary_tool_result(content)


def promote_tool_result_media(
    workspace_id: uuid.UUID,
    content: str,
    *,
    sandbox_dir: str | Path | None = None,
) -> ToolMediaPromotion:
    """Extract inline images from a tool result, save to Assets, return path metadata.

    History stays small: returned ``content`` never includes base64 image payloads.
    """
    if not content:
        return ToolMediaPromotion(content=content or "")

    images: list[str] = []
    texts: list[str] = []
    found: list[tuple[str, bytes]] = []

    _log.info(
        "tool_media: promote start content_len=%s workspace=%s",
        len(content),
        workspace_id,
    )

    # Prefer pydantic-ai's official rehydrate (handles URL-safe BinaryContent).
    try:
        from pydantic_ai.ui.ag_ui._utils import rehydrate_tool_return_content

        rehydrated = rehydrate_tool_return_content(content)
        _collect_from_rehydrated(rehydrated, found)
        if found:
            _log.info("tool_media: rehydrate collected %s image(s)", len(found))
    except Exception:
        _log.exception("tool_media: rehydrate failed; falling back to JSON walk")

    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        if not found:
            return ToolMediaPromotion(content=content)
        parsed = None

    if not found and isinstance(parsed, (dict, list)):
        _walk_collect_images(parsed, found)

    if isinstance(parsed, (dict, list)):

        def collect_text(obj: Any) -> None:
            if isinstance(obj, str):
                s = obj.strip()
                if (
                    s
                    and len(s) < 4_000
                    and not s.startswith("iVBOR")
                    and "media_type" not in s[:80]
                ):
                    if s not in texts:
                        texts.append(s)
                return
            if isinstance(obj, dict):
                media = obj.get("media_type") or obj.get("mimeType")
                if isinstance(media, str) and media.startswith("image/"):
                    return
                if obj.get("kind") == "binary":
                    return
                for value in obj.values():
                    collect_text(value)
                return
            if isinstance(obj, list):
                for item in obj:
                    collect_text(item)

        collect_text(parsed)

    if not found and _looks_like_inline_media(content):
        _debug_dump_payload(content, reason="no_images_extracted")
        _log.warning(
            "tool_media: no loadable images extracted from content_len=%s",
            len(content),
        )

    for i, (media_type, data) in enumerate(found, start=1):
        path = save_generated_image_asset(
            workspace_id,
            data,
            media_type,
            index=i,
            sandbox_dir=sandbox_dir,
        )
        if path not in images:
            images.append(path)
        _log.info(
            "tool_media: saved %s (%s bytes, %s)",
            path,
            len(data),
            media_type,
        )

    if not images and not texts:
        return ToolMediaPromotion(content=content)

    return ToolMediaPromotion(
        content=_media_payload(images=images, files=[], texts=texts or None),
        images=images,
    )
