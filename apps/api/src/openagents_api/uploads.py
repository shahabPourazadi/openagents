"""Persistent binary uploads for deep-agent LiteParse (local disk or Garage S3)."""

from __future__ import annotations

import logging
import re
import shutil
import tempfile
import uuid
from collections.abc import Iterable, Iterator
from pathlib import Path
from typing import BinaryIO

from openagents_api import s3_uploads as s3
from openagents_api.config import get_settings

_log = logging.getLogger(__name__)

UPLOADS_PREFIX = "uploads/"
ALLOWED_EXTENSIONS = {
    ".pdf",
    ".docx",
    ".doc",
    ".xlsx",
    ".xls",
    ".pptx",
    ".ppt",
    ".odt",
    ".ods",
    ".odp",
    ".png",
    ".jpg",
    ".jpeg",
    ".tif",
    ".tiff",
    ".webp",
    ".gif",
    ".bmp",
    # Plain text — no LiteParse needed; agent reads via filesystem tools.
    ".md",
    ".markdown",
    ".txt",
    ".csv",
}
MAX_UPLOAD_BYTES = 40 * 1024 * 1024  # 40 MB
_STREAM_CHUNK = 64 * 1024

# Extensions that get magic-byte validation (None = no sniff required).
_MAGIC_CHECKS: dict[str, tuple[bytes, ...]] = {
    ".pdf": (b"%PDF",),
    ".png": (b"\x89PNG\r\n\x1a\n",),
    ".jpg": (b"\xff\xd8\xff",),
    ".jpeg": (b"\xff\xd8\xff",),
    ".gif": (b"GIF87a", b"GIF89a"),
    ".webp": (b"RIFF",),  # RIFF....WEBP — checked specially
}


def use_s3() -> bool:
    return s3.s3_configured()


def uploads_root() -> Path:
    settings = get_settings()
    root = Path(settings.workspace_tmp_root).resolve().parent / "openagents-uploads"
    root.mkdir(parents=True, exist_ok=True)
    return root


def workspace_uploads_dir(workspace_id: uuid.UUID) -> Path:
    path = uploads_root() / str(workspace_id)
    path.mkdir(parents=True, exist_ok=True)
    return path


def purge_workspace_storage(workspace_id: uuid.UUID) -> None:
    """Remove all on-disk / S3 files for a workspace (uploads + assets)."""
    if use_s3():
        try:
            s3.delete_prefix(f"workspaces/{workspace_id}/")
        except Exception:
            _log.exception(
                "Failed to purge S3 prefix for workspace %s", workspace_id
            )
    local = uploads_root() / str(workspace_id)
    if local.exists():
        shutil.rmtree(local, ignore_errors=True)


def _safe_filename(name: str) -> str:
    base = Path(name).name.strip() or "upload.bin"
    base = re.sub(r"[^\w.\- ]+", "_", base).strip(" ._") or "upload.bin"
    return base[:180]


def relative_upload_path(stored_name: str) -> str:
    return f"{UPLOADS_PREFIX}{stored_name}"


def stored_name_from_relative(relative_path: str) -> str | None:
    """Return stored filename for a safe ``uploads/…`` path, or None."""
    if not relative_path.startswith(UPLOADS_PREFIX):
        return None
    name = relative_path.removeprefix(UPLOADS_PREFIX)
    if "/" in name or name in (".", "..") or ".." in name:
        return None
    return name


def validate_upload_candidate(*, filename: str, size: int | None = None) -> str:
    """Pure gate: return lowercase extension or raise ValueError."""
    ext = Path(filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise ValueError(
            "Unsupported file type. Allowed: PDF, DOCX, XLSX, PPTX, ODF, images, "
            "Markdown, TXT, and CSV."
        )
    if size is not None and size > MAX_UPLOAD_BYTES:
        raise ValueError(f"File too large (max {MAX_UPLOAD_BYTES // (1024 * 1024)} MB)")
    return ext


def _header_matches_extension(ext: str, header: bytes) -> bool:
    """Return True if header is OK for ext (or no magic check applies)."""
    if ext == ".webp":
        return (
            len(header) >= 12
            and header.startswith(b"RIFF")
            and header[8:12] == b"WEBP"
        )
    expected = _MAGIC_CHECKS.get(ext)
    if not expected:
        return True
    return any(header.startswith(sig) for sig in expected)


def _assert_magic(ext: str, header: bytes) -> None:
    if not _header_matches_extension(ext, header):
        raise ValueError(
            f"File content does not match extension {ext}. "
            "Upload a real file of that type."
        )


def _iter_chunks(source: BinaryIO | Iterable[bytes]) -> Iterator[bytes]:
    if hasattr(source, "read"):
        while True:
            chunk = source.read(_STREAM_CHUNK)  # type: ignore[union-attr]
            if not chunk:
                break
            yield chunk
    else:
        yield from source  # type: ignore[misc]


def _spool_validated(
    *,
    filename: str,
    data: bytes | None,
    stream: BinaryIO | Iterable[bytes] | None,
) -> tuple[str, str, int, Path]:
    """Validate and write to a temp file; return (ext, safe_name, size, temp_path)."""
    if data is None and stream is None:
        raise ValueError("No file data provided")
    if data is not None and stream is not None:
        raise ValueError("Pass either data or stream, not both")

    ext = validate_upload_candidate(
        filename=filename, size=len(data) if data is not None else None
    )
    safe = _safe_filename(filename)
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=ext)
    tmp_path = Path(tmp.name)
    try:
        if data is not None:
            _assert_magic(ext, data[:16])
            tmp.write(data)
            size = len(data)
            tmp.close()
        else:
            assert stream is not None
            size = 0
            header = b""
            for chunk in _iter_chunks(stream):
                if not chunk:
                    continue
                if len(header) < 16:
                    need = 16 - len(header)
                    header += chunk[:need]
                    if len(header) >= 16:
                        _assert_magic(ext, header)
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise ValueError(
                        f"File too large (max {MAX_UPLOAD_BYTES // (1024 * 1024)} MB)"
                    )
                tmp.write(chunk)
            tmp.close()
            if size == 0:
                raise ValueError("Empty file")
            if len(header) < 16:
                _assert_magic(ext, header)
    except Exception:
        tmp.close()
        tmp_path.unlink(missing_ok=True)
        raise
    return ext, safe, size, tmp_path


def save_upload(
    workspace_id: uuid.UUID,
    *,
    filename: str,
    data: bytes | None = None,
    stream: BinaryIO | Iterable[bytes] | None = None,
) -> dict:
    """Persist bytes (or a stream) with size/type gates; return metadata.

    Uses Garage S3 (+ SSE-C) when ``OPENAGENTS_S3_*`` is configured; otherwise local disk.
    """
    ext, safe, size, tmp_path = _spool_validated(
        filename=filename, data=data, stream=stream
    )
    stored = f"{uuid.uuid4().hex[:10]}-{safe}"
    content_type = _guess_content_type(ext)
    moved = False
    try:
        if use_s3():
            with tmp_path.open("rb") as fh:
                s3.put_object_fileobj(
                    workspace_id,
                    stored,
                    fh,
                    content_type=content_type,
                )
        else:
            dest = workspace_uploads_dir(workspace_id) / stored
            shutil.move(str(tmp_path), dest)
            moved = True
    finally:
        if not moved:
            tmp_path.unlink(missing_ok=True)

    return {
        "path": relative_upload_path(stored),
        "filename": safe,
        "size": size,
        "content_type": content_type,
    }


def list_uploads(workspace_id: uuid.UUID) -> list[dict]:
    if use_s3():
        rows: list[dict] = []
        for obj in s3.list_objects(workspace_id):
            stored = obj["stored_name"]
            rows.append(
                {
                    "path": relative_upload_path(stored),
                    "filename": stored.split("-", 1)[-1] if "-" in stored else stored,
                    "size": obj["size"],
                    "content_type": _guess_content_type(Path(stored).suffix.lower()),
                }
            )
        return rows

    root = workspace_uploads_dir(workspace_id)
    rows = []
    for path in sorted(root.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if not path.is_file() or path.name.endswith(".partial"):
            continue
        rows.append(
            {
                "path": relative_upload_path(path.name),
                "filename": path.name.split("-", 1)[-1] if "-" in path.name else path.name,
                "size": path.stat().st_size,
                "content_type": _guess_content_type(path.suffix.lower()),
            }
        )
    return rows


def resolve_upload_file(workspace_id: uuid.UUID, relative_path: str) -> Path | None:
    """Resolve a workspace-relative uploads/ path to a local file, or None.

    Only applies to the local-disk backend. For S3 use ``read_upload_bytes``.
    """
    if use_s3():
        return None
    name = stored_name_from_relative(relative_path)
    if name is None:
        return None
    path = workspace_uploads_dir(workspace_id) / name
    if not path.is_file():
        return None
    return path


def upload_exists(workspace_id: uuid.UUID, relative_path: str) -> bool:
    name = stored_name_from_relative(relative_path)
    if name is None:
        return False
    if use_s3():
        return s3.head_object(workspace_id, name) is not None
    path = workspace_uploads_dir(workspace_id) / name
    return path.is_file()


def read_upload_bytes(workspace_id: uuid.UUID, relative_path: str) -> bytes | None:
    """Load upload bytes (S3 with SSE-C or local disk)."""
    name = stored_name_from_relative(relative_path)
    if name is None:
        return None
    if use_s3():
        return s3.get_object_bytes(workspace_id, name)
    path = workspace_uploads_dir(workspace_id) / name
    if not path.is_file():
        return None
    return path.read_bytes()


def delete_upload(workspace_id: uuid.UUID, relative_path: str) -> bool:
    name = stored_name_from_relative(relative_path)
    if name is None:
        return False
    if use_s3():
        if s3.head_object(workspace_id, name) is None:
            return False
        return s3.delete_object(workspace_id, name)
    path = workspace_uploads_dir(workspace_id) / name
    if not path.is_file():
        return False
    path.unlink()
    return True


def materialize_uploads(
    workspace_id: uuid.UUID,
    dest_root: Path,
    *,
    only_paths: set[str] | None = None,
) -> list[dict]:
    """Copy persisted uploads into the per-run workspace under uploads/.

    Returns metadata dicts for files that were copied (relative ``uploads/`` paths).
    When ``only_paths`` is set, only those relative paths are copied; otherwise all.
    """
    dest = dest_root / "uploads"
    dest.mkdir(parents=True, exist_ok=True)
    copied: list[dict] = []

    if use_s3():
        for obj in s3.list_objects(workspace_id):
            stored = obj["stored_name"]
            rel = relative_upload_path(stored)
            if only_paths is not None and rel not in only_paths:
                continue
            data = s3.get_object_bytes(workspace_id, stored)
            if data is None:
                continue
            (dest / stored).write_bytes(data)
            copied.append(
                {
                    "path": rel,
                    "filename": stored.split("-", 1)[-1] if "-" in stored else stored,
                    "size": len(data),
                    "content_type": _guess_content_type(Path(stored).suffix.lower()),
                    "stored_name": stored,
                }
            )
        return copied

    src = workspace_uploads_dir(workspace_id)
    if not src.exists():
        return []
    for path in src.iterdir():
        if not path.is_file() or path.name.endswith(".partial"):
            continue
        rel = relative_upload_path(path.name)
        if only_paths is not None and rel not in only_paths:
            continue
        shutil.copy2(path, dest / path.name)
        copied.append(
            {
                "path": rel,
                "filename": path.name.split("-", 1)[-1] if "-" in path.name else path.name,
                "size": path.stat().st_size,
                "content_type": _guess_content_type(path.suffix.lower()),
                "stored_name": path.name,
            }
        )
    return copied


def _text_line_count(content: bytes) -> tuple[int | None, str]:
    """Return (line_count, encoding) — binary files get (None, 'binary')."""
    try:
        import chardet

        detection = chardet.detect(content)
        encoding = detection.get("encoding")
        if encoding:
            text = content.decode(encoding)
            return len(text.splitlines()), encoding
    except Exception:
        pass
    try:
        text = content.decode("utf-8")
        if b"\x00" in content[:1024]:
            return None, "binary"
        return len(text.splitlines()), "utf-8"
    except UnicodeDecodeError:
        return None, "binary"


_TEXT_EXTENSIONS_FOR_LINE_COUNT = frozenset({
    ".md",
    ".markdown",
    ".txt",
    ".csv",
})


def register_workspace_uploads(deps: object, workspace_dir: str) -> int:
    """Populate ``deps.uploads`` from ``workspace_dir/uploads/`` (relative paths).

    Matches pydantic-deep's Uploaded Files system-prompt section via
    ``deps.get_uploads_summary()``. Paths stay relative (``uploads/…``) so
    LocalBackend can resolve them inside the run workspace.
    """
    uploads_attr = getattr(deps, "uploads", None)
    if uploads_attr is None or not isinstance(uploads_attr, dict):
        return 0

    root = Path(workspace_dir) / "uploads"
    if not root.is_dir():
        return 0

    count = 0
    for path in sorted(root.iterdir()):
        if not path.is_file() or path.name.endswith(".partial"):
            continue
        rel = relative_upload_path(path.name)
        name = path.name.split("-", 1)[-1] if "-" in path.name else path.name
        size = path.stat().st_size
        ext = path.suffix.lower()
        if ext in _TEXT_EXTENSIONS_FOR_LINE_COUNT and size <= MAX_UPLOAD_BYTES:
            content = path.read_bytes()
            line_count, encoding = _text_line_count(content)
        else:
            line_count, encoding = None, "binary"
        uploads_attr[rel] = {
            "name": name,
            "path": rel,
            "size": size,
            "line_count": line_count,
            "mime_type": _guess_content_type(ext),
            "encoding": encoding,
        }
        count += 1
    return count


def _guess_content_type(ext: str) -> str:
    return {
        ".pdf": "application/pdf",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".doc": "application/msword",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".xls": "application/vnd.ms-excel",
        ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".ppt": "application/vnd.ms-powerpoint",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".tif": "image/tiff",
        ".tiff": "image/tiff",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".bmp": "image/bmp",
        ".md": "text/markdown",
        ".markdown": "text/markdown",
        ".txt": "text/plain",
        ".csv": "text/csv",
    }.get(ext, "application/octet-stream")
