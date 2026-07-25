from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import Depends, Header, HTTPException
from jose import JWTError, jwt
from sqlalchemy.ext.asyncio import AsyncSession

from openagents_api.config import Settings, get_settings
from openagents_api.db import get_session
from openagents_api.models import Profile

_log = logging.getLogger(__name__)


@dataclass
class AuthUser:
    id: str
    email: str | None = None
    role: str = "user"
    status: str = "active"
    display_name: str | None = None


def _db_unavailable(exc: BaseException) -> HTTPException:
    _log.warning("database unavailable during auth: %s", exc)
    return HTTPException(
        status_code=503,
        detail=(
            "Database unavailable. For local dev, start the Postgres tunnel: "
            "./scripts/supabase-db-tunnel.sh"
        ),
    )


async def _ensure_profile(
    session: AsyncSession,
    *,
    user_id: str,
    email: str | None,
    default_status: str | None = None,
    settings: Settings | None = None,
) -> Profile:
    try:
        uid = uuid.UUID(user_id)
    except ValueError:
        # Dev bypass ids like "dev-user" — ephemeral, no DB row.
        raise HTTPException(status_code=401, detail="Invalid user id") from None

    cfg = settings or get_settings()
    try:
        row = await session.get(Profile, uid)
        if row:
            dirty = False
            if email and row.email != email:
                row.email = email
                dirty = True
            # Queue off: activate any leftover pending rows.
            if not cfg.feature_signup_queue and row.status == "pending":
                row.status = "active"
                dirty = True
            if dirty:
                await session.commit()
            return row

        status = default_status
        if status is None:
            if not cfg.feature_signup_queue:
                status = "active"
            else:
                from openagents_api.company_config import ensure_system_settings

                settings_row = await ensure_system_settings(session)
                status = (
                    "active" if settings_row.signup_mode == "auto_approve" else "pending"
                )

        row = Profile(
            id=uid,
            email=email,
            display_name=(email.split("@")[0] if email else None),
            role="user",
            status=status,
        )
        session.add(row)
        await session.commit()
        await session.refresh(row)
        return row
    except HTTPException:
        raise
    except Exception as exc:
        raise _db_unavailable(exc) from exc


async def get_current_user(
    authorization: str | None = Header(default=None),
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
    settings: Settings = Depends(get_settings),
    session: AsyncSession = Depends(get_session),
) -> AuthUser:
    if settings.auth_is_open:
        uid = x_user_id or "dev-user"
        email = "dev@localhost"
        # Open mode: treat as active admin for local tooling unless a real UUID profile exists.
        try:
            profile = await _ensure_profile(
                session,
                user_id=uid,
                email=email,
                default_status="active",
                settings=settings,
            )
            return AuthUser(
                id=str(profile.id),
                email=profile.email or email,
                role=profile.role or "admin",
                status=profile.status or "active",
                display_name=profile.display_name,
            )
        except HTTPException as exc:
            if exc.status_code == 401:
                return AuthUser(id=uid, email=email, role="admin", status="active")
            raise

    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")

    token = authorization.removeprefix("Bearer ").strip()
    try:
        payload = jwt.decode(
            token,
            settings.supabase_jwt_secret,
            algorithms=["HS256"],
            options={"verify_aud": False},
        )
    except JWTError as exc:
        raise HTTPException(status_code=401, detail="Invalid token") from exc

    sub = payload.get("sub")
    if not sub:
        raise HTTPException(status_code=401, detail="Token missing sub")

    email = payload.get("email")
    profile = await _ensure_profile(
        session,
        user_id=str(sub),
        email=email if isinstance(email, str) else None,
        settings=settings,
    )
    return AuthUser(
        id=str(profile.id),
        email=profile.email or (email if isinstance(email, str) else None),
        role=profile.role or "user",
        status=profile.status or "pending",
        display_name=profile.display_name,
    )


async def require_active_user(user: AuthUser = Depends(get_current_user)) -> AuthUser:
    if user.role == "admin":
        return user
    if user.status != "active":
        raise HTTPException(
            status_code=403,
            detail={"code": "account_not_active", "status": user.status},
        )
    return user


async def require_admin(user: AuthUser = Depends(get_current_user)) -> AuthUser:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    return user


async def maybe_notify_pending(
    session: AsyncSession,
    profile: Profile,
    *,
    settings: Settings,
) -> None:
    """Send admin alert once when a pending user first hits the API."""
    if not settings.feature_signup_queue:
        return
    if profile.status != "pending" or profile.pending_notified_at is not None:
        return
    from sqlalchemy import select

    from openagents_api.email import notify_admins_pending_signup
    from openagents_api.models import Profile as ProfileModel

    result = await session.execute(
        select(ProfileModel).where(ProfileModel.role == "admin")
    )
    admins = list(result.scalars())
    emails = [a.email for a in admins if a.email]
    if emails:
        await notify_admins_pending_signup(
            admin_emails=emails,
            user_email=profile.email or str(profile.id),
            display_name=profile.display_name,
            settings=settings,
        )
    profile.pending_notified_at = datetime.now(timezone.utc)
    await session.commit()
