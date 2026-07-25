"""Resend email helper (optional signup-queue notifications)."""

from __future__ import annotations

import logging

import httpx

from openagents_api.config import Settings, get_settings

_log = logging.getLogger(__name__)


def _signup_queue_enabled(settings: Settings | None = None) -> bool:
    return bool((settings or get_settings()).feature_signup_queue)


async def send_email(
    *,
    to: list[str] | str,
    subject: str,
    html: str,
    text: str | None = None,
    settings: Settings | None = None,
) -> bool:
    """Send via Resend. Soft-fails (logs) when not configured."""
    s = settings or get_settings()
    api_key = (s.resend_api_key or "").strip()
    from_addr = (s.resend_from_email or "").strip()
    recipients = [t.strip() for t in (to if isinstance(to, list) else [to]) if t and t.strip()]
    if not api_key or not from_addr or not recipients:
        _log.warning(
            "email skipped (resend not configured or no recipients): subject=%s to=%s",
            subject,
            recipients,
        )
        return False

    payload: dict = {
        "from": from_addr,
        "to": recipients,
        "subject": subject,
        "html": html,
    }
    if text:
        payload["text"] = text

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                "https://api.resend.com/emails",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
        if resp.status_code >= 400:
            _log.error("resend error %s: %s", resp.status_code, resp.text)
            return False
        return True
    except Exception:
        _log.exception("resend send failed")
        return False


async def notify_admins_pending_signup(
    *,
    admin_emails: list[str],
    user_email: str,
    display_name: str | None,
    settings: Settings | None = None,
) -> None:
    if not _signup_queue_enabled(settings):
        return
    name = (display_name or "").strip() or user_email
    subject = f"[OpenAgents] Pending signup: {name}"
    html = (
        f"<p><strong>{name}</strong> ({user_email}) confirmed their email and is waiting "
        f"for admin approval.</p>"
        f"<p>Open the OpenAgents admin panel to approve or reject.</p>"
    )
    await send_email(to=admin_emails, subject=subject, html=html, settings=settings)


async def notify_user_approved(
    *,
    user_email: str,
    settings: Settings | None = None,
) -> None:
    if not _signup_queue_enabled(settings):
        return
    await send_email(
        to=user_email,
        subject="[OpenAgents] Your account has been approved",
        html=(
            "<p>Your OpenAgents account has been approved. You can sign in and start using the app.</p>"
        ),
        settings=settings,
    )


async def notify_user_rejected(
    *,
    user_email: str,
    settings: Settings | None = None,
) -> None:
    if not _signup_queue_enabled(settings):
        return
    await send_email(
        to=user_email,
        subject="[OpenAgents] Account request update",
        html=(
            "<p>Your OpenAgents signup request was not approved. "
            "Contact the OpenAgents team if you believe this is a mistake.</p>"
        ),
        settings=settings,
    )
