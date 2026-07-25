"""Seed sample workspaces for the open-auth demo user when the DB is empty."""

from __future__ import annotations

import logging

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from openagents_api.config import Settings, get_settings
from openagents_api.models import Document, Thread, Workspace
from openagents_api.agents import list_builtin_agents, load_agent
from openagents_api.workspace_files import seed_default_memory_files

_log = logging.getLogger(__name__)

# Matches AUTH_MODE=none default (X-User-Id / auth.get_current_user).
DEMO_OWNER_ID = "dev-user"


async def seed_demo_workspaces_if_empty(
    session: AsyncSession,
    *,
    owner_id: str = DEMO_OWNER_ID,
    settings: Settings | None = None,
) -> int:
    """Create one workspace per built-in agent when ``owner_id`` has none.

    Idempotent: no-op if the user already has any workspace.
    Returns the number of workspaces created.
    """
    cfg = settings or get_settings()
    existing = await session.scalar(
        select(func.count()).select_from(Workspace).where(Workspace.owner_id == owner_id)
    )
    if existing and int(existing) > 0:
        return 0

    manifests = list_builtin_agents()
    if not manifests:
        _log.warning("demo seed skipped: no built-in agents found")
        return 0

    created = 0
    for manifest in manifests:
        try:
            pack = load_agent(manifest.slug)
        except Exception:
            _log.exception("demo seed: skip pack %s", manifest.slug)
            continue

        ws = Workspace(
            owner_id=owner_id,
            name=f"Demo — {pack.manifest.name}",
            agent_slug=pack.slug,
            agent_md=None,
            soul_md=None,
        )
        session.add(ws)
        await session.flush()

        active_doc_id = None
        if pack.manifest.uses_document:
            doc = Document(
                workspace_id=ws.id,
                path="document.md",
                title=pack.manifest.name,
                content_md=pack.document_template_md or "",
            )
            session.add(doc)
            await session.flush()
            active_doc_id = doc.id

        session.add(
            Thread(
                workspace_id=ws.id,
                title="New chat",
                active_document_id=active_doc_id,
                model=pack.manifest.default_model or cfg.default_model,
            )
        )
        await seed_default_memory_files(session, ws.id)
        created += 1

    if created:
        await session.commit()
        _log.info("demo seed: created %s workspace(s) for %s", created, owner_id)
    return created
