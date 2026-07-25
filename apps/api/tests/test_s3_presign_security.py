"""Presigned URL security with SSE-C (Garage)."""

from __future__ import annotations

import base64
import uuid

import pytest

from openagents_api import s3_uploads as s3
from openagents_api.config import Settings


def _sse_key_b64() -> str:
    return base64.b64encode(b"0" * 32).decode("ascii")


def test_presign_refuses_when_sse_c_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = Settings(
        openagents_s3_endpoint="https://s3.example.test",
        openagents_s3_region="garage",
        openagents_s3_bucket="openagents-uploads",
        openagents_s3_access_key_id="AKIATEST",
        openagents_s3_secret_access_key="secret",
        openagents_s3_force_path_style=True,
        openagents_s3_sse_c_key_base64=_sse_key_b64(),
    )
    monkeypatch.setattr(s3, "get_settings", lambda: settings)
    s3.clear_s3_client_cache()

    with pytest.raises(PermissionError, match="SSE-C"):
        s3.presign_get_url(uuid.uuid4(), "abc-file.txt", settings=settings)


def test_presign_allowed_without_sse_c(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = Settings(
        openagents_s3_endpoint="https://s3.example.test",
        openagents_s3_region="garage",
        openagents_s3_bucket="openagents-uploads",
        openagents_s3_access_key_id="AKIATEST",
        openagents_s3_secret_access_key="secret",
        openagents_s3_force_path_style=True,
        openagents_s3_sse_c_key_base64="",
    )
    monkeypatch.setattr(s3, "get_settings", lambda: settings)
    s3.clear_s3_client_cache()

    url = s3.presign_get_url(
        uuid.uuid4(),
        "abc-file.txt",
        expires_in=60,
        settings=settings,
    )
    assert "s3.example.test" in url
    assert "openagents-uploads" in url or "uploads" in url
