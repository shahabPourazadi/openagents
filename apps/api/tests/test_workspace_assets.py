"""Tests for durable diagrams/ / other/ asset store."""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from openagents_api.workspace_assets import (
    is_allowed_asset_path,
    list_assets,
    materialize_assets,
    normalize_asset_path,
    read_asset_bytes,
    save_asset_bytes,
    write_back_workspace_assets,
)


def test_normalize_asset_path_accepts_diagrams_and_other() -> None:
    assert normalize_asset_path("diagrams/figure-1.png") == "diagrams/figure-1.png"
    assert normalize_asset_path("./other/sketch.svg") == "other/sketch.svg"
    assert normalize_asset_path("memory/notes.md") is None
    assert normalize_asset_path("diagrams/../evil.png") is None
    assert normalize_asset_path("diagrams/") is None


def test_extension_rules_by_folder() -> None:
    assert is_allowed_asset_path("diagrams/figure-1.png")
    assert not is_allowed_asset_path("diagrams/notes.txt")
    assert is_allowed_asset_path("other/notes.txt")
    assert is_allowed_asset_path("other/data.json")
    assert is_allowed_asset_path("other/report.pdf")
    assert not is_allowed_asset_path("other/run.exe")
    assert not is_allowed_asset_path("other/script.sh")


def test_write_back_and_materialize_roundtrip(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAGENTS_S3_ENDPOINT", "")
    # Force local disk backend (clear any prior s3 config from env in CI).
    from openagents_api import uploads as uploads_mod
    from openagents_api.config import get_settings

    get_settings.cache_clear()
    monkeypatch.setattr(uploads_mod, "use_s3", lambda: False)
    monkeypatch.setattr(
        "openagents_api.workspace_assets.use_s3",
        lambda: False,
    )
    monkeypatch.setattr(
        "openagents_api.workspace_assets.uploads_root",
        lambda: tmp_path / "openagents-uploads",
    )

    ws_id = uuid.uuid4()
    sandbox = tmp_path / "sandbox"
    (sandbox / "diagrams").mkdir(parents=True)
    (sandbox / "other").mkdir(parents=True)
    png = sandbox / "diagrams" / "figure-1.png"
    # Minimal valid PNG header + junk (enough for our size gate).
    png.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)
    # diagrams/ ignores txt; other/ keeps it.
    (sandbox / "diagrams" / "skip.txt").write_text("nope", encoding="utf-8")
    (sandbox / "other" / "test.txt").write_text("hello", encoding="utf-8")

    written = write_back_workspace_assets(ws_id, str(sandbox))
    assert set(written) == {"diagrams/figure-1.png", "other/test.txt"}

    rows = {r["path"]: r for r in list_assets(ws_id)}
    assert set(rows) == {"diagrams/figure-1.png", "other/test.txt"}
    assert rows["diagrams/figure-1.png"]["content_type"] == "image/png"
    assert "text/plain" in rows["other/test.txt"]["content_type"]

    data = read_asset_bytes(ws_id, "diagrams/figure-1.png")
    assert data is not None and data.startswith(b"\x89PNG")
    assert read_asset_bytes(ws_id, "other/test.txt") == b"hello"

    dest = tmp_path / "restored"
    dest.mkdir()
    count = materialize_assets(ws_id, dest)
    assert count == 2
    assert (dest / "diagrams" / "figure-1.png").is_file()
    assert (dest / "other" / "test.txt").read_text(encoding="utf-8") == "hello"


def test_save_asset_bytes_rejects_bad_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("openagents_api.workspace_assets.use_s3", lambda: False)
    monkeypatch.setattr(
        "openagents_api.workspace_assets.uploads_root",
        lambda: tmp_path / "openagents-uploads",
    )
    with pytest.raises(ValueError, match="Invalid asset path"):
        save_asset_bytes(uuid.uuid4(), "uploads/x.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 8)
    with pytest.raises(ValueError, match="diagrams/ only allows"):
        save_asset_bytes(uuid.uuid4(), "diagrams/notes.txt", b"hello")
