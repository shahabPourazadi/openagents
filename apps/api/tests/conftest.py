"""Shared fixtures for OpenAgents API tests."""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from openagents_api import s3_uploads as s3_mod
from openagents_api import uploads as uploads_mod
from openagents_api.config import Settings, get_settings


@pytest.fixture
def upload_tmp(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Isolate upload storage under a temp workspace_tmp_root (local disk, no S3)."""
    ws_root = tmp_path / "openagents-workspaces"
    ws_root.mkdir()
    settings = Settings(
        workspace_tmp_root=str(ws_root),
        auth_bypass=True,
        # Force local backend even if developer shell has OPENAGENTS_S3_* set.
        openagents_s3_endpoint="",
        openagents_s3_bucket="",
        openagents_s3_access_key_id="",
        openagents_s3_secret_access_key="",
        openagents_s3_sse_c_key_base64="",
    )
    get_settings.cache_clear()
    s3_mod.clear_s3_client_cache()
    monkeypatch.setattr(uploads_mod, "get_settings", lambda: settings)
    monkeypatch.setattr(s3_mod, "get_settings", lambda: settings)
    monkeypatch.setattr("openagents_api.config.get_settings", lambda: settings)
    yield tmp_path
    get_settings.cache_clear()
    s3_mod.clear_s3_client_cache()


@pytest.fixture
def workspace_id() -> uuid.UUID:
    return uuid.uuid4()
