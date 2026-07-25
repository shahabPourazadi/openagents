"""Durable assets (diagrams/, other/) in Garage S3 or local disk.

- ``diagrams/`` — image embeds for documents (PNG/SVG/…).
- ``other/`` — images plus safe document/data formats (txt, md, csv, json, pdf, …).

Agent-written files under these prefixes are persisted at end of run and
restored into the next sandbox. Markdown image embeds use relative paths like
``![alt](diagrams/foo.png)``.
"""

from __future__ import annotations

import logging
import re
import uuid
from pathlib import Path

from openagents_api import s3_uploads as s3
from openagents_api.uploads import uploads_root, use_s3

_log = logging.getLogger(__name__)

ASSET_PREFIXES = ("diagrams/", "other/")

# Figures for document embeds — keep image-only.
IMAGE_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".svg",
    ".bmp",
    ".tif",
    ".tiff",
}

# Safe non-executable formats for other/ (plus images).
OTHER_SAFE_EXTENSIONS = IMAGE_EXTENSIONS | {
    ".txt",
    ".md",
    ".markdown",
    ".csv",
    ".tsv",
    ".json",
    ".jsonl",
    ".yaml",
    ".yml",
    ".xml",
    ".log",
    ".pdf",
}

# Back-compat alias used by older call sites / tests.
ALLOWED_ASSET_EXTENSIONS = OTHER_SAFE_EXTENSIONS

MAX_ASSET_BYTES = 40 * 1024 * 1024


def workspace_assets_dir(workspace_id: uuid.UUID) -> Path:
    path = uploads_root() / str(workspace_id) / "assets"
    path.mkdir(parents=True, exist_ok=True)
    return path


def normalize_asset_path(relative_path: str) -> str | None:
    """Return a safe ``diagrams/…`` or ``other/…`` path, or None."""
    rel = (relative_path or "").strip().replace("\\", "/").lstrip("/")
    while rel.startswith("./"):
        rel = rel[2:]
    if not any(rel.startswith(p) for p in ASSET_PREFIXES):
        return None
    parts = [p for p in rel.split("/") if p]
    if len(parts) < 2 or parts[0] not in ("diagrams", "other"):
        return None
    for part in parts:
        if part in (".", "..") or not re.fullmatch(r"[\w.\- ]+", part):
            return None
    return "/".join(parts)


def allowed_extensions_for_path(relative_path: str) -> set[str]:
    """Extension allowlist for a normalized asset path."""
    if relative_path.startswith("diagrams/"):
        return IMAGE_EXTENSIONS
    if relative_path.startswith("other/"):
        return OTHER_SAFE_EXTENSIONS
    return set()


def is_allowed_asset_path(relative_path: str) -> bool:
    rel = normalize_asset_path(relative_path)
    if rel is None:
        return False
    return Path(rel).suffix.lower() in allowed_extensions_for_path(rel)


def guess_asset_content_type(ext: str) -> str:
    return {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".svg": "image/svg+xml",
        ".bmp": "image/bmp",
        ".tif": "image/tiff",
        ".tiff": "image/tiff",
        ".txt": "text/plain; charset=utf-8",
        ".md": "text/markdown; charset=utf-8",
        ".markdown": "text/markdown; charset=utf-8",
        ".csv": "text/csv; charset=utf-8",
        ".tsv": "text/tab-separated-values; charset=utf-8",
        ".json": "application/json",
        ".jsonl": "application/x-ndjson",
        ".yaml": "application/yaml",
        ".yml": "application/yaml",
        ".xml": "application/xml",
        ".log": "text/plain; charset=utf-8",
        ".pdf": "application/pdf",
    }.get(ext, "application/octet-stream")


def _validate_asset_file(path: Path, relative_path: str) -> str | None:
    """Return lowercase ext if path is an allowed asset for its prefix, else None."""
    if not path.is_file():
        return None
    if not is_allowed_asset_path(relative_path):
        return None
    ext = Path(relative_path).suffix.lower()
    try:
        if path.stat().st_size > MAX_ASSET_BYTES or path.stat().st_size == 0:
            return None
    except OSError:
        return None
    return ext


def list_assets(workspace_id: uuid.UUID) -> list[dict]:
    """Return [{path, filename, size, content_type}, ...] newest first."""
    rows: list[dict] = []
    if use_s3():
        for obj in s3.list_asset_objects(workspace_id):
            rel = obj["relative_path"]
            if not is_allowed_asset_path(rel):
                continue
            ext = Path(rel).suffix.lower()
            rows.append(
                {
                    "path": rel,
                    "filename": Path(rel).name,
                    "size": int(obj.get("size") or 0),
                    "content_type": guess_asset_content_type(ext),
                }
            )
        return rows

    root = workspace_assets_dir(workspace_id)
    if not root.exists():
        return []
    found: list[tuple[float, dict]] = []
    for path in root.rglob("*"):
        rel = str(path.relative_to(root)).replace("\\", "/")
        ext = _validate_asset_file(path, rel)
        if ext is None:
            continue
        found.append(
            (
                path.stat().st_mtime,
                {
                    "path": rel,
                    "filename": path.name,
                    "size": path.stat().st_size,
                    "content_type": guess_asset_content_type(ext),
                },
            )
        )
    found.sort(key=lambda t: t[0], reverse=True)
    return [row for _, row in found]


def read_asset_bytes(workspace_id: uuid.UUID, relative_path: str) -> bytes | None:
    rel = normalize_asset_path(relative_path)
    if rel is None or not is_allowed_asset_path(rel):
        return None
    if use_s3():
        return s3.get_asset_bytes(workspace_id, rel)
    path = workspace_assets_dir(workspace_id) / rel
    if not path.is_file():
        return None
    return path.read_bytes()


def resolve_asset_file(workspace_id: uuid.UUID, relative_path: str) -> Path | None:
    if use_s3():
        return None
    rel = normalize_asset_path(relative_path)
    if rel is None or not is_allowed_asset_path(rel):
        return None
    path = workspace_assets_dir(workspace_id) / rel
    if not path.is_file():
        return None
    return path


def save_asset_bytes(
    workspace_id: uuid.UUID,
    relative_path: str,
    data: bytes,
) -> dict:
    """Persist bytes at a stable asset path. Returns UploadOut-shaped dict."""
    rel = normalize_asset_path(relative_path)
    if rel is None:
        raise ValueError("Invalid asset path (use diagrams/… or other/…)")
    ext = Path(rel).suffix.lower()
    if not is_allowed_asset_path(rel):
        if rel.startswith("diagrams/"):
            raise ValueError("diagrams/ only allows image formats (png, svg, …)")
        raise ValueError(
            "Unsupported type for other/ "
            "(allowed: images, txt, md, csv, json, yaml, xml, log, pdf)"
        )
    if not data or len(data) > MAX_ASSET_BYTES:
        raise ValueError(f"Asset too large or empty (max {MAX_ASSET_BYTES // (1024 * 1024)} MB)")
    content_type = guess_asset_content_type(ext)
    if use_s3():
        s3.put_asset_bytes(workspace_id, rel, data, content_type=content_type)
    else:
        dest = workspace_assets_dir(workspace_id) / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
    return {
        "path": rel,
        "filename": Path(rel).name,
        "size": len(data),
        "content_type": content_type,
    }


def delete_asset(workspace_id: uuid.UUID, relative_path: str) -> bool:
    rel = normalize_asset_path(relative_path)
    if rel is None:
        return False
    if use_s3():
        return s3.delete_asset(workspace_id, rel)
    path = workspace_assets_dir(workspace_id) / rel
    if not path.is_file():
        return False
    path.unlink()
    return True


def materialize_assets(workspace_id: uuid.UUID, dest_root: Path) -> int:
    """Restore persisted assets into the per-run workspace (diagrams/, other/)."""
    count = 0
    if use_s3():
        for obj in s3.list_asset_objects(workspace_id):
            rel = normalize_asset_path(obj["relative_path"])
            if rel is None or not is_allowed_asset_path(rel):
                continue
            data = s3.get_asset_bytes(workspace_id, rel)
            if data is None:
                continue
            dest = dest_root / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
            count += 1
        return count

    src = workspace_assets_dir(workspace_id)
    if not src.exists():
        return 0
    for path in src.rglob("*"):
        rel = str(path.relative_to(src)).replace("\\", "/")
        if _validate_asset_file(path, rel) is None:
            continue
        dest = dest_root / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(path.read_bytes())
        count += 1
    return count


def write_back_workspace_assets(workspace_id: uuid.UUID, workspace_dir: str) -> list[str]:
    """Persist diagrams/ and other/ from the temp sandbox into durable storage.

    Returns the relative paths that were written (for thread Resources linking).
    """
    root = Path(workspace_dir)
    if not root.exists():
        return []
    written: list[str] = []
    for prefix in ASSET_PREFIXES:
        folder = root / prefix.rstrip("/")
        if not folder.is_dir():
            continue
        for path in folder.rglob("*"):
            rel = str(path.relative_to(root)).replace("\\", "/")
            if _validate_asset_file(path, rel) is None:
                continue
            try:
                save_asset_bytes(workspace_id, rel, path.read_bytes())
                written.append(rel)
            except Exception:
                _log.exception("Failed to persist asset %s", rel)
    return written
