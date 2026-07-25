"""Tools for editing the active user Agent from chat."""

from __future__ import annotations

from typing import Any

from pydantic_ai import RunContext

from openagents_api.agents import AgentError, validate_agent_draft


USER_AGENT_EDIT_NOTE = (
    "You are running as a user-authored Agent. When the user asks you to "
    "change how you behave, update your agent definition with "
    "read_active_user_agent / update_active_user_agent (name, description, "
    "agent_md, soul_md, uses_document). Do not invent a new agent slug — edit "
    "this one. For larger redesigns they can also switch to the Agent Builder agent."
)


def _workspace_agent_slug(ws: Any) -> str:
    return (
        getattr(ws, "agent_slug", None) or getattr(ws, "pack_slug", None) or ""
    ).strip()


async def read_active_user_agent(ctx: RunContext[Any]) -> str:
    """Return the active user agent definition (markdown fields) for review/editing."""
    owner_id = getattr(ctx.deps, "user_id", None) or ""
    workspace_id = getattr(ctx.deps, "workspace_id", None)
    if not owner_id or workspace_id is None:
        return "error: missing user or workspace on deps"

    from openagents_api.db import SessionLocal
    from openagents_api.models import UserAgent, Workspace
    from sqlalchemy import select

    async with SessionLocal() as session:
        ws = await session.get(Workspace, workspace_id)
        if ws is None:
            return "error: workspace not found"
        slug = _workspace_agent_slug(ws)
        if not slug:
            return "error: workspace has no agent selected"
        result = await session.execute(
            select(UserAgent).where(UserAgent.owner_id == owner_id, UserAgent.slug == slug)
        )
        row = result.scalar_one_or_none()
        if row is None:
            return (
                f"error: {slug!r} is not a user agent (built-ins are read-only). "
                "Switch to Agent Builder to author a new agent, or duplicate this one first."
            )
        skills = row.skills_json if isinstance(row.skills_json, list) else []
        skill_lines = (
            ", ".join(
                str(s.get("slug") or s.get("name") or "?")
                for s in skills
                if isinstance(s, dict)
            )
            or "(none)"
        )
        return (
            f"slug: {row.slug}\n"
            f"name: {row.name}\n"
            f"description: {row.description or ''}\n"
            f"uses_document: {row.uses_document}\n"
            f"skills: {skill_lines}\n"
            f"\n--- agent.md ---\n{row.agent_md or ''}\n"
            f"\n--- soul.md ---\n{row.soul_md or ''}\n"
            f"\n--- system_prompt.md ---\n{row.system_prompt or ''}\n"
        )


async def update_active_user_agent(
    ctx: RunContext[Any],
    name: str | None = None,
    description: str | None = None,
    agent_md: str | None = None,
    soul_md: str | None = None,
    system_prompt: str | None = None,
    uses_document: bool | None = None,
) -> str:
    """Update fields on the active user agent. Omit a field to leave it unchanged."""
    owner_id = getattr(ctx.deps, "user_id", None) or ""
    workspace_id = getattr(ctx.deps, "workspace_id", None)
    if not owner_id or workspace_id is None:
        return "error: missing user or workspace on deps"

    from openagents_api.db import SessionLocal
    from openagents_api.models import UserAgent, Workspace
    from sqlalchemy import select

    async with SessionLocal() as session:
        ws = await session.get(Workspace, workspace_id)
        if ws is None:
            return "error: workspace not found"
        slug = _workspace_agent_slug(ws)
        if not slug:
            return "error: workspace has no agent selected"
        result = await session.execute(
            select(UserAgent).where(UserAgent.owner_id == owner_id, UserAgent.slug == slug)
        )
        row = result.scalar_one_or_none()
        if row is None:
            return (
                f"error: {slug!r} is not a user agent (built-ins are read-only). "
                "Duplicate it or use Agent Builder."
            )

        if name is not None:
            row.name = name.strip() or row.name
        if description is not None:
            row.description = description
        if agent_md is not None:
            row.agent_md = agent_md
        if soul_md is not None:
            row.soul_md = soul_md
        if system_prompt is not None:
            row.system_prompt = system_prompt
        if uses_document is not None:
            row.uses_document = uses_document

        try:
            validate_agent_draft(
                name=row.name,
                agent_md=row.agent_md,
                uses_document=row.uses_document,
                skills=row.skills_json if isinstance(row.skills_json, list) else [],
            )
        except AgentError as exc:
            await session.rollback()
            return f"error: {exc}"

        await session.commit()
        updated_slug = row.slug
        updated_name = row.name

    ui_events = getattr(ctx.deps, "ui_events", None)
    if ui_events is not None:
        from ag_ui.core import CustomEvent, EventType

        await ui_events.put(
            CustomEvent(
                type=EventType.CUSTOM,
                name="agents_changed",
                value={
                    "slug": updated_slug,
                    "name": updated_name,
                    "action": "updated",
                },
            )
        )

    return (
        f"Updated user agent {updated_slug!r} ({updated_name}). "
        "Changes apply on the next agent turn."
    )


# Legacy aliases for in-flight model tool calls.
read_active_user_pack = read_active_user_agent
update_active_user_pack = update_active_user_agent
USER_PACK_EDIT_NOTE = USER_AGENT_EDIT_NOTE

USER_AGENT_TOOLS = [
    read_active_user_agent,
    update_active_user_agent,
]
USER_PACK_TOOLS = USER_AGENT_TOOLS
