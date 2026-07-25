"""Seed and sync helpers for workspace_files (memory / research)."""

from __future__ import annotations

import uuid
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from openagents_api.models import WorkspaceFile

DEFAULT_PREFERENCES = """# Preferences

- Preferred tone: clear and technical
- Prefer quantified claims over vague adjectives
- Ask before inventing missing facts
"""

DEFAULT_COMPANY = """# Company / context

- Organization:
- Domain / products:
- Confidentiality notes:
"""

WRITEBACK_PREFIXES = ("memory/", "research/")


def kind_for_path(path: str) -> str:
    if path.startswith("memory/"):
        return "memory"
    if path.startswith("research/"):
        return "research"
    return "other"


async def seed_default_memory_files(session: AsyncSession, workspace_id: uuid.UUID) -> None:
    existing = await session.execute(
        select(WorkspaceFile.path).where(WorkspaceFile.workspace_id == workspace_id)
    )
    paths = set(existing.scalars())
    seeds = [
        ("memory/preferences.md", "memory", DEFAULT_PREFERENCES),
        ("memory/company.md", "memory", DEFAULT_COMPANY),
    ]
    for path, kind, content in seeds:
        if path in paths:
            continue
        session.add(
            WorkspaceFile(
                workspace_id=workspace_id,
                path=path,
                kind=kind,
                content_md=content,
            )
        )


async def list_workspace_files(
    session: AsyncSession, workspace_id: uuid.UUID
) -> list[WorkspaceFile]:
    result = await session.execute(
        select(WorkspaceFile)
        .where(WorkspaceFile.workspace_id == workspace_id)
        .order_by(WorkspaceFile.path)
    )
    return list(result.scalars())


def materialize_workspace_files(root: Path, files: list[WorkspaceFile]) -> None:
    for wf in files:
        path = root / wf.path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(wf.content_md or "", encoding="utf-8")


async def write_back_workspace_files(
    session: AsyncSession,
    workspace_id: uuid.UUID,
    workspace_dir: str,
) -> int:
    """Upsert memory/research files from the temp workspace into the DB."""
    root = Path(workspace_dir)
    if not root.exists():
        return 0

    existing = {
        wf.path: wf
        for wf in await list_workspace_files(session, workspace_id)
    }
    written = 0
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        rel = str(path.relative_to(root)).replace("\\", "/")
        if not rel.startswith(WRITEBACK_PREFIXES):
            continue
        content = path.read_text(encoding="utf-8")
        kind = kind_for_path(rel)
        row = existing.get(rel)
        if row is None:
            row = WorkspaceFile(
                workspace_id=workspace_id,
                path=rel,
                kind=kind,
                content_md=content,
            )
            session.add(row)
            existing[rel] = row
            written += 1
        elif row.content_md != content:
            row.content_md = content
            row.kind = kind
            written += 1
    return written
