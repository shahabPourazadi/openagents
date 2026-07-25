"""Encrypt/decrypt user MCP auth tokens at rest."""

from __future__ import annotations

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from openagents_api.config import Settings


def _fernet_for_settings(settings: Settings) -> Fernet:
    raw = (settings.mcp_secrets_key or "").strip()
    if not raw:
        raw = (settings.supabase_jwt_secret or "openagents-mcp-secrets").strip()
    # Accept a ready Fernet key, else derive one from the passphrase.
    try:
        if len(raw) == 44:
            return Fernet(raw.encode("utf-8"))
    except (ValueError, InvalidToken):
        pass
    digest = hashlib.sha256(raw.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_secret(value: str | None, settings: Settings) -> str | None:
    text = (value or "").strip()
    if not text:
        return None
    return _fernet_for_settings(settings).encrypt(text.encode("utf-8")).decode("utf-8")


def decrypt_secret(value: str | None, settings: Settings) -> str | None:
    text = (value or "").strip()
    if not text:
        return None
    try:
        return _fernet_for_settings(settings).decrypt(text.encode("utf-8")).decode("utf-8")
    except InvalidToken:
        # Legacy plaintext (e.g. migrated rows) — return as-is.
        return text


def mask_secret(value: str | None) -> str | None:
    text = (value or "").strip()
    if not text:
        return None
    if len(text) <= 8:
        return "••••"
    return f"{text[:4]}…{text[-2:]}"
