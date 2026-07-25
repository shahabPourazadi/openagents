"""Seam B: materialize uploads into workspace and register on deps.uploads."""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest
from pydantic_ai_backends import LocalBackend
from pydantic_deep import DeepAgentDeps

from openagents_api.uploads import (
    materialize_uploads,
    register_workspace_uploads,
    save_upload,
)


@pytest.mark.asyncio
async def test_materialize_and_register_populates_uploads_summary(
    upload_tmp: Path, workspace_id: uuid.UUID, tmp_path: Path
) -> None:
    meta = save_upload(
        workspace_id,
        filename="sales.csv",
        data=b"product,qty\nA,1\nB,2\n",
    )
    run_root = tmp_path / "run-ws"
    run_root.mkdir()

    copied = materialize_uploads(workspace_id, run_root)
    assert len(copied) == 1
    assert (run_root / "uploads" / Path(meta["path"]).name).is_file()

    deps = DeepAgentDeps(backend=LocalBackend(root_dir=str(run_root)))
    count = register_workspace_uploads(deps, str(run_root))
    assert count == 1

    # Relative path — LocalBackend-safe (not /uploads/...).
    assert meta["path"] in deps.uploads
    assert not meta["path"].startswith("/")
    info = deps.uploads[meta["path"]]
    assert info["name"] == "sales.csv"
    assert info["size"] == len(b"product,qty\nA,1\nB,2\n")
    assert info["line_count"] == 3

    summary = deps.get_uploads_summary()
    assert "## Uploaded Files" in summary
    assert meta["path"] in summary
    assert "3 lines" in summary
    assert "offset" in summary.lower() or "limit" in summary.lower()


@pytest.mark.asyncio
async def test_materialize_only_paths_skips_others(
    upload_tmp: Path, workspace_id: uuid.UUID, tmp_path: Path
) -> None:
    a = save_upload(workspace_id, filename="keep.txt", data=b"keep me")
    b = save_upload(workspace_id, filename="skip.txt", data=b"skip me")
    run_root = tmp_path / "run-ws2"
    run_root.mkdir()

    copied = materialize_uploads(workspace_id, run_root, only_paths={a["path"]})
    assert len(copied) == 1
    assert copied[0]["path"] == a["path"]
    assert (run_root / "uploads" / Path(a["path"]).name).is_file()
    assert not (run_root / "uploads" / Path(b["path"]).name).exists()


def test_register_marks_binary_without_line_count(
    upload_tmp: Path, workspace_id: uuid.UUID, tmp_path: Path
) -> None:
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 20
    meta = save_upload(workspace_id, filename="fig.png", data=png)
    run_root = tmp_path / "run-ws3"
    run_root.mkdir()
    materialize_uploads(workspace_id, run_root)
    deps = DeepAgentDeps(backend=LocalBackend(root_dir=str(run_root)))
    register_workspace_uploads(deps, str(run_root))
    info = deps.uploads[meta["path"]]
    assert info["line_count"] is None
    assert info["encoding"] == "binary"
    summary = deps.get_uploads_summary()
    assert meta["path"] in summary
    assert "lines" not in summary.split(meta["path"])[1].split("\n")[0]
