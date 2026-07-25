"""Garage / S3 helpers for OpenAgents workspace uploads (SSE-C when configured)."""

from __future__ import annotations

import base64
import hashlib
import logging
from functools import lru_cache
from typing import Any, BinaryIO
from urllib.parse import urlparse

import boto3
from botocore.client import BaseClient
from botocore.config import Config
from botocore.exceptions import ClientError

from openagents_api.config import Settings, get_settings

_log = logging.getLogger(__name__)

# Browser-facing presigned GETs are unsafe with SSE-C (client must also send the key).
DEFAULT_PRESIGN_TTL_SECONDS = 120
MAX_PRESIGN_TTL_SECONDS = 300


def s3_configured(settings: Settings | None = None) -> bool:
    s = settings or get_settings()
    return bool(
        (s.openagents_s3_endpoint or "").strip()
        and (s.openagents_s3_bucket or "").strip()
        and (s.openagents_s3_access_key_id or "").strip()
        and (s.openagents_s3_secret_access_key or "").strip()
    )


def sse_c_configured(settings: Settings | None = None) -> bool:
    s = settings or get_settings()
    return bool((s.openagents_s3_sse_c_key_base64 or "").strip())


def object_key(workspace_id: Any, stored_name: str) -> str:
    return f"workspaces/{workspace_id}/uploads/{stored_name}"


def prefix_for_workspace(workspace_id: Any) -> str:
    return f"workspaces/{workspace_id}/uploads/"


def asset_object_key(workspace_id: Any, relative_path: str) -> str:
    """S3 key for a durable workspace asset (``diagrams/…`` / ``other/…``)."""
    return f"workspaces/{workspace_id}/assets/{relative_path}"


def asset_prefix_for_workspace(workspace_id: Any) -> str:
    return f"workspaces/{workspace_id}/assets/"


def _sse_c_params(settings: Settings) -> dict[str, Any]:
    raw_b64 = (settings.openagents_s3_sse_c_key_base64 or "").strip()
    if not raw_b64:
        return {}
    key = base64.b64decode(raw_b64)
    if len(key) != 32:
        raise ValueError("OPENAGENTS_S3_SSE_C_KEY_BASE64 must decode to 32 bytes (AES-256)")
    # botocore expects SSECustomerKey as a base64 *string* (not raw bytes).
    return {
        "SSECustomerAlgorithm": "AES256",
        "SSECustomerKey": raw_b64,
        "SSECustomerKeyMD5": base64.b64encode(hashlib.md5(key).digest()).decode("ascii"),
    }


@lru_cache
def _client_for(
    endpoint: str,
    region: str,
    access_key: str,
    secret_key: str,
    force_path_style: bool,
) -> BaseClient:
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name=region or "garage",
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path" if force_path_style else "auto"},
        ),
    )


def get_s3_client(settings: Settings | None = None) -> BaseClient:
    s = settings or get_settings()
    if not s3_configured(s):
        raise RuntimeError("S3 uploads are not configured")
    return _client_for(
        (s.openagents_s3_endpoint or "").strip(),
        (s.openagents_s3_region or "garage").strip(),
        (s.openagents_s3_access_key_id or "").strip(),
        (s.openagents_s3_secret_access_key or "").strip(),
        bool(s.openagents_s3_force_path_style),
    )


def put_object_bytes(
    workspace_id: Any,
    stored_name: str,
    data: bytes,
    *,
    content_type: str,
    settings: Settings | None = None,
) -> None:
    s = settings or get_settings()
    client = get_s3_client(s)
    params: dict[str, Any] = {
        "Bucket": s.openagents_s3_bucket,
        "Key": object_key(workspace_id, stored_name),
        "Body": data,
        "ContentType": content_type,
        **_sse_c_params(s),
    }
    client.put_object(**params)


def put_object_fileobj(
    workspace_id: Any,
    stored_name: str,
    fileobj: BinaryIO,
    *,
    content_type: str,
    settings: Settings | None = None,
) -> None:
    s = settings or get_settings()
    client = get_s3_client(s)
    extra: dict[str, Any] = {"ContentType": content_type, **_sse_c_params(s)}
    client.upload_fileobj(
        fileobj,
        s.openagents_s3_bucket,
        object_key(workspace_id, stored_name),
        ExtraArgs=extra,
    )


def get_object_bytes(
    workspace_id: Any,
    stored_name: str,
    *,
    settings: Settings | None = None,
) -> bytes | None:
    s = settings or get_settings()
    client = get_s3_client(s)
    try:
        resp = client.get_object(
            Bucket=s.openagents_s3_bucket,
            Key=object_key(workspace_id, stored_name),
            **_sse_c_params(s),
        )
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code in {"NoSuchKey", "404", "NotFound"}:
            return None
        raise
    return resp["Body"].read()


def head_object(
    workspace_id: Any,
    stored_name: str,
    *,
    settings: Settings | None = None,
) -> dict[str, Any] | None:
    s = settings or get_settings()
    client = get_s3_client(s)
    try:
        return client.head_object(
            Bucket=s.openagents_s3_bucket,
            Key=object_key(workspace_id, stored_name),
            **_sse_c_params(s),
        )
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code in {"NoSuchKey", "404", "NotFound", "403"}:
            # Garage may return 403 for missing + SSE mismatch; treat as missing for head.
            return None
        raise


def delete_object(
    workspace_id: Any,
    stored_name: str,
    *,
    settings: Settings | None = None,
) -> bool:
    s = settings or get_settings()
    client = get_s3_client(s)
    key = object_key(workspace_id, stored_name)
    # delete_object does not require SSE-C on AWS; Garage may still accept it.
    try:
        client.delete_object(Bucket=s.openagents_s3_bucket, Key=key)
        return True
    except ClientError:
        _log.exception("Failed to delete s3://%s/%s", s.openagents_s3_bucket, key)
        return False


def delete_prefix(
    prefix: str,
    *,
    settings: Settings | None = None,
) -> int:
    """Delete all objects under ``prefix``. Returns count of deleted keys."""
    s = settings or get_settings()
    if not s3_configured(s):
        return 0
    client = get_s3_client(s)
    paginator = client.get_paginator("list_objects_v2")
    deleted = 0
    batch: list[dict[str, str]] = []
    for page in paginator.paginate(Bucket=s.openagents_s3_bucket, Prefix=prefix):
        for obj in page.get("Contents") or []:
            key = obj.get("Key")
            if not key:
                continue
            batch.append({"Key": key})
            if len(batch) >= 1000:
                client.delete_objects(
                    Bucket=s.openagents_s3_bucket,
                    Delete={"Objects": batch, "Quiet": True},
                )
                deleted += len(batch)
                batch = []
    if batch:
        client.delete_objects(
            Bucket=s.openagents_s3_bucket,
            Delete={"Objects": batch, "Quiet": True},
        )
        deleted += len(batch)
    return deleted


def list_objects(
    workspace_id: Any,
    *,
    settings: Settings | None = None,
) -> list[dict[str, Any]]:
    """Return [{stored_name, size, last_modified}, ...] newest first."""
    s = settings or get_settings()
    client = get_s3_client(s)
    prefix = prefix_for_workspace(workspace_id)
    paginator = client.get_paginator("list_objects_v2")
    rows: list[dict[str, Any]] = []
    for page in paginator.paginate(Bucket=s.openagents_s3_bucket, Prefix=prefix):
        for obj in page.get("Contents") or []:
            key = obj["Key"]
            if not key.startswith(prefix):
                continue
            stored = key[len(prefix) :]
            if not stored or "/" in stored:
                continue
            rows.append(
                {
                    "stored_name": stored,
                    "size": int(obj.get("Size") or 0),
                    "last_modified": obj.get("LastModified"),
                }
            )
    rows.sort(key=lambda r: r.get("last_modified") or 0, reverse=True)
    return rows


def presign_get_url(
    workspace_id: Any,
    stored_name: str,
    *,
    expires_in: int = DEFAULT_PRESIGN_TTL_SECONDS,
    settings: Settings | None = None,
) -> str:
    """Create a short-lived GET URL.

    **Security:** When SSE-C is enabled this raises ``PermissionError`` — a browser
    cannot complete the download without also possessing the customer key, so
    shipping a presigned URL alone is either useless or encourages leaking the key.
    Use the authenticated ``/uploads/content`` proxy instead.
    """
    s = settings or get_settings()
    if sse_c_configured(s):
        raise PermissionError(
            "Presigned URLs are disabled while SSE-C is enabled. "
            "Use the authenticated /uploads/content endpoint."
        )
    ttl = max(1, min(int(expires_in), MAX_PRESIGN_TTL_SECONDS))
    client = get_s3_client(s)
    return client.generate_presigned_url(
        "get_object",
        Params={
            "Bucket": s.openagents_s3_bucket,
            "Key": object_key(workspace_id, stored_name),
        },
        ExpiresIn=ttl,
    )


def endpoint_host(settings: Settings | None = None) -> str:
    s = settings or get_settings()
    return urlparse((s.openagents_s3_endpoint or "").strip()).netloc or ""


def put_asset_bytes(
    workspace_id: Any,
    relative_path: str,
    data: bytes,
    *,
    content_type: str,
    settings: Settings | None = None,
) -> None:
    s = settings or get_settings()
    client = get_s3_client(s)
    params: dict[str, Any] = {
        "Bucket": s.openagents_s3_bucket,
        "Key": asset_object_key(workspace_id, relative_path),
        "Body": data,
        "ContentType": content_type,
        **_sse_c_params(s),
    }
    client.put_object(**params)


def get_asset_bytes(
    workspace_id: Any,
    relative_path: str,
    *,
    settings: Settings | None = None,
) -> bytes | None:
    s = settings or get_settings()
    client = get_s3_client(s)
    try:
        resp = client.get_object(
            Bucket=s.openagents_s3_bucket,
            Key=asset_object_key(workspace_id, relative_path),
            **_sse_c_params(s),
        )
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code in {"NoSuchKey", "404", "NotFound"}:
            return None
        raise
    return resp["Body"].read()


def delete_asset(
    workspace_id: Any,
    relative_path: str,
    *,
    settings: Settings | None = None,
) -> bool:
    s = settings or get_settings()
    client = get_s3_client(s)
    key = asset_object_key(workspace_id, relative_path)
    try:
        client.delete_object(Bucket=s.openagents_s3_bucket, Key=key)
        return True
    except ClientError:
        _log.exception("Failed to delete s3://%s/%s", s.openagents_s3_bucket, key)
        return False


def list_asset_objects(
    workspace_id: Any,
    *,
    settings: Settings | None = None,
) -> list[dict[str, Any]]:
    """Return [{relative_path, size, last_modified}, ...] newest first."""
    s = settings or get_settings()
    client = get_s3_client(s)
    prefix = asset_prefix_for_workspace(workspace_id)
    paginator = client.get_paginator("list_objects_v2")
    rows: list[dict[str, Any]] = []
    for page in paginator.paginate(Bucket=s.openagents_s3_bucket, Prefix=prefix):
        for obj in page.get("Contents") or []:
            key = obj["Key"]
            if not key.startswith(prefix):
                continue
            relative = key[len(prefix) :]
            if not relative or relative.endswith("/"):
                continue
            rows.append(
                {
                    "relative_path": relative,
                    "size": int(obj.get("Size") or 0),
                    "last_modified": obj.get("LastModified"),
                }
            )
    rows.sort(key=lambda r: r.get("last_modified") or 0, reverse=True)
    return rows


def clear_s3_client_cache() -> None:
    _client_for.cache_clear()
