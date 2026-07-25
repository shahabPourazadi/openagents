"""Live Garage smoke tests — skipped unless .local/openagents-uploads-garage.env exists."""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from openagents_api import s3_uploads as s3
from openagents_api.config import Settings, get_settings
from openagents_api.uploads import (
    delete_upload,
    list_uploads,
    materialize_uploads,
    read_upload_bytes,
    save_upload,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
ENV_FILE = REPO_ROOT / ".local" / "openagents-uploads-garage.env"


def _load_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        out[key.strip()] = val.strip().strip('"').strip("'")
    return out


@pytest.fixture
def garage_settings(monkeypatch: pytest.MonkeyPatch) -> Settings:
    if not ENV_FILE.is_file():
        pytest.skip(f"Missing {ENV_FILE}")
    raw = _load_env_file(ENV_FILE)
    required = [
        "OPENAGENTS_S3_ENDPOINT",
        "OPENAGENTS_S3_BUCKET",
        "OPENAGENTS_S3_ACCESS_KEY_ID",
        "OPENAGENTS_S3_SECRET_ACCESS_KEY",
        "OPENAGENTS_S3_SSE_C_KEY_BASE64",
    ]
    if any(not raw.get(k) for k in required):
        pytest.skip("Garage env incomplete")

    settings = Settings(
        openagents_s3_endpoint=raw["OPENAGENTS_S3_ENDPOINT"],
        openagents_s3_region=raw.get("OPENAGENTS_S3_REGION", "garage"),
        openagents_s3_bucket=raw["OPENAGENTS_S3_BUCKET"],
        openagents_s3_access_key_id=raw["OPENAGENTS_S3_ACCESS_KEY_ID"],
        openagents_s3_secret_access_key=raw["OPENAGENTS_S3_SECRET_ACCESS_KEY"],
        openagents_s3_force_path_style=raw.get("OPENAGENTS_S3_FORCE_PATH_STYLE", "true").lower()
        in {"1", "true", "yes"},
        openagents_s3_sse_c_key_base64=raw["OPENAGENTS_S3_SSE_C_KEY_BASE64"],
        auth_bypass=True,
    )
    get_settings.cache_clear()
    s3.clear_s3_client_cache()
    monkeypatch.setattr("openagents_api.uploads.get_settings", lambda: settings)
    monkeypatch.setattr("openagents_api.s3_uploads.get_settings", lambda: settings)
    yield settings
    get_settings.cache_clear()
    s3.clear_s3_client_cache()


@pytest.mark.integration
def test_live_garage_put_get_list_delete_materialize(
    garage_settings: Settings, tmp_path: Path
) -> None:
    ws = uuid.uuid4()
    payload = b"openagents garage live test\nline2\n"
    meta = save_upload(ws, filename="live-test.txt", data=payload)
    assert meta["path"].startswith("uploads/")
    assert meta["size"] == len(payload)

    listed = list_uploads(ws)
    assert any(r["path"] == meta["path"] for r in listed)

    got = read_upload_bytes(ws, meta["path"])
    assert got == payload

    # SSE-C: get without customer key must fail
    client = s3.get_s3_client(garage_settings)
    stored = meta["path"].removeprefix("uploads/")
    with pytest.raises(Exception):
        client.get_object(
            Bucket=garage_settings.openagents_s3_bucket,
            Key=s3.object_key(ws, stored),
        )

    # Presign must be refused under SSE-C
    with pytest.raises(PermissionError, match="SSE-C"):
        s3.presign_get_url(ws, stored, settings=garage_settings)

    run_root = tmp_path / "agent-ws"
    run_root.mkdir()
    copied = materialize_uploads(ws, run_root)
    assert len(copied) == 1
    assert (run_root / "uploads" / stored).read_bytes() == payload

    assert delete_upload(ws, meta["path"]) is True
    assert read_upload_bytes(ws, meta["path"]) is None
