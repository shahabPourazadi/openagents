"""Seam A: upload store — save, list, delete, resolve, size/type gates."""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from openagents_api.uploads import (
    MAX_UPLOAD_BYTES,
    delete_upload,
    list_uploads,
    resolve_upload_file,
    save_upload,
    validate_upload_candidate,
)

# Minimal valid magic headers
PNG_HEADER = b"\x89PNG\r\n\x1a\n" + b"\x00" * 20
JPEG_HEADER = b"\xff\xd8\xff\xe0" + b"\x00" * 20
PDF_HEADER = b"%PDF-1.4\n" + b"\x00" * 20
GIF_HEADER = b"GIF89a" + b"\x00" * 20
WEBP_HEADER = b"RIFF" + b"\x00\x00\x00\x00" + b"WEBP" + b"\x00" * 12


def test_validate_rejects_unsupported_extension() -> None:
    with pytest.raises(ValueError, match="Unsupported file type"):
        validate_upload_candidate(filename="malware.exe", size=100)


def test_validate_rejects_oversized() -> None:
    with pytest.raises(ValueError, match="too large"):
        validate_upload_candidate(filename="big.pdf", size=MAX_UPLOAD_BYTES + 1)


def test_validate_accepts_allowed_under_limit() -> None:
    ext = validate_upload_candidate(filename="spec.pdf", size=1024)
    assert ext == ".pdf"


def test_save_upload_persists_and_lists(upload_tmp: Path, workspace_id: uuid.UUID) -> None:
    meta = save_upload(workspace_id, filename="notes.txt", data=b"hello inventors\n")
    assert meta["path"].startswith("uploads/")
    assert meta["filename"] == "notes.txt"
    assert meta["size"] == 16
    assert meta["content_type"] == "text/plain"

    rows = list_uploads(workspace_id)
    assert len(rows) == 1
    assert rows[0]["path"] == meta["path"]
    assert rows[0]["size"] == 16

    resolved = resolve_upload_file(workspace_id, meta["path"])
    assert resolved is not None
    assert resolved.read_bytes() == b"hello inventors\n"


def test_save_upload_stream_rejects_when_chunks_exceed_limit(
    upload_tmp: Path, workspace_id: uuid.UUID
) -> None:
    chunk = b"x" * (1024 * 1024)  # 1 MB
    # Stream more than 40 MB without holding all in one bytes object up front.
    oversized = (chunk for _ in range(41))
    with pytest.raises(ValueError, match="too large"):
        save_upload(workspace_id, filename="huge.txt", stream=oversized)

    assert list_uploads(workspace_id) == []


def test_save_upload_rejects_magic_mismatch_png(
    upload_tmp: Path, workspace_id: uuid.UUID
) -> None:
    with pytest.raises(ValueError, match="does not match"):
        save_upload(workspace_id, filename="fake.png", data=b"not a png file at all")


def test_save_upload_accepts_png_magic(upload_tmp: Path, workspace_id: uuid.UUID) -> None:
    meta = save_upload(workspace_id, filename="diagram.png", data=PNG_HEADER)
    assert meta["content_type"] == "image/png"
    assert resolve_upload_file(workspace_id, meta["path"]) is not None


def test_save_upload_accepts_pdf_jpeg_gif_webp_magic(
    upload_tmp: Path, workspace_id: uuid.UUID
) -> None:
    for name, data, ctype in [
        ("a.pdf", PDF_HEADER, "application/pdf"),
        ("a.jpg", JPEG_HEADER, "image/jpeg"),
        ("a.gif", GIF_HEADER, "image/gif"),
        ("a.webp", WEBP_HEADER, "image/webp"),
    ]:
        meta = save_upload(workspace_id, filename=name, data=data)
        assert meta["content_type"] == ctype


def test_resolve_rejects_path_traversal(upload_tmp: Path, workspace_id: uuid.UUID) -> None:
    assert resolve_upload_file(workspace_id, "uploads/../etc/passwd") is None
    assert resolve_upload_file(workspace_id, "memory/secret.md") is None


def test_delete_upload_removes_file(upload_tmp: Path, workspace_id: uuid.UUID) -> None:
    meta = save_upload(workspace_id, filename="gone.txt", data=b"bye")
    assert delete_upload(workspace_id, meta["path"]) is True
    assert resolve_upload_file(workspace_id, meta["path"]) is None
    assert delete_upload(workspace_id, meta["path"]) is False
