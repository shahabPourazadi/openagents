"""Tests for AUTH_MODE resolution and FEATURE_SIGNUP_QUEUE."""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from openagents_api.config import Settings, get_settings
from openagents_api.email import (
    notify_admins_pending_signup,
    notify_user_approved,
    notify_user_rejected,
)


@pytest.fixture(autouse=True)
def _isolate_auth_env(monkeypatch: pytest.MonkeyPatch):
    """Avoid local .env / shell AUTH_* leaking into resolution tests."""
    get_settings.cache_clear()
    for key in ("AUTH_MODE", "AUTH_BYPASS", "FEATURE_SIGNUP_QUEUE"):
        monkeypatch.delenv(key, raising=False)
    # Ignore env_file so only kwargs / process env under test apply.
    monkeypatch.setenv("OPENAGENTS_TEST_ISOLATION", "1")
    yield
    get_settings.cache_clear()


def _settings(**kwargs) -> Settings:
    """Build Settings without reading a developer .env file."""
    return Settings(_env_file=None, **kwargs)


def test_default_auth_mode_is_none_and_open() -> None:
    s = _settings()
    assert s.auth_mode == "none"
    assert s.auth_is_open is True
    assert s.feature_signup_queue is False


def test_auth_bypass_true_derives_none_when_auth_mode_unset() -> None:
    s = _settings(auth_bypass=True)
    assert s.auth_mode == "none"
    assert s.auth_is_open is True


def test_auth_bypass_false_derives_supabase_when_auth_mode_unset() -> None:
    s = _settings(auth_bypass=False)
    assert s.auth_mode == "supabase"
    assert s.auth_is_open is False


def test_explicit_auth_mode_wins_over_auth_bypass() -> None:
    s = _settings(auth_mode="none", auth_bypass=False)
    assert s.auth_mode == "none"
    assert s.auth_is_open is True

    s2 = _settings(auth_mode="supabase", auth_bypass=True)
    assert s2.auth_mode == "supabase"
    assert s2.auth_is_open is False


def test_auth_mode_from_env_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUTH_MODE", "supabase")
    monkeypatch.setenv("AUTH_BYPASS", "true")
    s = _settings()
    assert s.auth_mode == "supabase"
    assert s.auth_is_open is False


def test_auth_bypass_from_env_when_auth_mode_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("AUTH_MODE", raising=False)
    monkeypatch.setenv("AUTH_BYPASS", "false")
    s = _settings()
    assert s.auth_mode == "supabase"
    assert s.auth_is_open is False


def test_feature_signup_queue_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FEATURE_SIGNUP_QUEUE", "true")
    s = _settings()
    assert s.feature_signup_queue is True


@pytest.mark.asyncio
async def test_ensure_profile_auto_activates_when_queue_off() -> None:
    from openagents_api.auth import _ensure_profile

    uid = str(uuid.uuid4())
    settings = _settings(feature_signup_queue=False, auth_mode="supabase")
    session = AsyncMock()
    session.get = AsyncMock(return_value=None)
    session.commit = AsyncMock()
    session.refresh = AsyncMock()
    session.add = MagicMock()

    row = await _ensure_profile(
        session,
        user_id=uid,
        email="user@example.com",
        settings=settings,
    )
    assert row.status == "active"
    session.add.assert_called_once()


@pytest.mark.asyncio
async def test_ensure_profile_upgrades_pending_when_queue_off() -> None:
    from openagents_api.auth import _ensure_profile
    from openagents_api.models import Profile

    uid = uuid.uuid4()
    existing = Profile(
        id=uid,
        email="user@example.com",
        role="user",
        status="pending",
    )
    settings = _settings(feature_signup_queue=False)
    session = AsyncMock()
    session.get = AsyncMock(return_value=existing)
    session.commit = AsyncMock()

    row = await _ensure_profile(
        session,
        user_id=str(uid),
        email="user@example.com",
        settings=settings,
    )
    assert row.status == "active"
    session.commit.assert_awaited()


@pytest.mark.asyncio
async def test_ensure_profile_respects_signup_mode_when_queue_on() -> None:
    from openagents_api.auth import _ensure_profile

    uid = str(uuid.uuid4())
    settings = _settings(feature_signup_queue=True, auth_mode="supabase")
    session = AsyncMock()
    session.get = AsyncMock(return_value=None)
    session.commit = AsyncMock()
    session.refresh = AsyncMock()
    session.add = MagicMock()

    settings_row = MagicMock()
    settings_row.signup_mode = "admin_approve"

    with patch(
        "openagents_api.company_config.ensure_system_settings",
        new=AsyncMock(return_value=settings_row),
    ):
        row = await _ensure_profile(
            session,
            user_id=uid,
            email="user@example.com",
            settings=settings,
        )
    assert row.status == "pending"


@pytest.mark.asyncio
async def test_resend_helpers_noop_when_queue_off() -> None:
    settings = _settings(
        feature_signup_queue=False,
        resend_api_key="re_test",
        resend_from_email="OpenAgents <noreply@example.com>",
    )
    with patch("openagents_api.email.send_email", new=AsyncMock()) as send:
        await notify_user_approved(user_email="a@example.com", settings=settings)
        await notify_user_rejected(user_email="a@example.com", settings=settings)
        await notify_admins_pending_signup(
            admin_emails=["admin@example.com"],
            user_email="a@example.com",
            display_name="A",
            settings=settings,
        )
        send.assert_not_called()


@pytest.mark.asyncio
async def test_resend_helpers_send_when_queue_on() -> None:
    settings = _settings(
        feature_signup_queue=True,
        resend_api_key="re_test",
        resend_from_email="OpenAgents <noreply@example.com>",
    )
    with patch("openagents_api.email.send_email", new=AsyncMock(return_value=True)) as send:
        await notify_user_approved(user_email="a@example.com", settings=settings)
        assert send.await_count == 1
