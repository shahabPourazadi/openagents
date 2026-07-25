"""Tools registered only when the workspace agent is Agent Builder."""

from __future__ import annotations

from typing import Any

from pydantic_ai import RunContext

from openagents_api.agents import (
    AgentError,
    builtin_slug_exists,
    read_agent_dir_from_workspace,
    validate_agent_draft,
    validate_agent_slug,
)


async def validate_agent_draft_tool(
    ctx: RunContext[Any],
    slug: str,
) -> str:
    """Validate ``agents/<slug>/`` in the workspace before registering.

    Expects files written under agents/<slug>/: agent.yaml, agent.md, optional
    soul.md, system_prompt.md, skills/*/SKILL.md, templates/document.md.
    Legacy ``packs/<slug>/pack.yaml`` layouts are also accepted.
    """
    workspace_dir = getattr(ctx.deps, "workspace_dir", None) or ""
    if not workspace_dir:
        return "error: no workspace_dir on deps"
    try:
        draft = read_agent_dir_from_workspace(workspace_dir, slug)
        validate_agent_draft(
            name=draft["name"],
            agent_md=draft["agent_md"],
            uses_document=draft["uses_document"],
            skills=draft["skills"],
        )
    except AgentError as exc:
        return f"invalid: {exc}"
    return (
        f"ok: agents/{draft['slug']} looks valid "
        f"(uses_document={draft['uses_document']}, "
        f"skills={len(draft['skills'])}). "
        "Call register_agent_from_workspace to save it."
    )


async def register_agent_from_workspace(
    ctx: RunContext[Any],
    slug: str,
) -> str:
    """Read ``agents/<slug>/`` from the workspace and create a UserAgent for the owner.

    Overwrites an existing user agent with the same slug (same owner only).
    Cannot overwrite built-in agent slugs — choose a different slug.
    """
    workspace_dir = getattr(ctx.deps, "workspace_dir", None) or ""
    owner_id = getattr(ctx.deps, "user_id", None) or ""
    if not workspace_dir:
        return "error: no workspace_dir on deps"
    if not owner_id:
        return "error: no user_id on deps"

    try:
        slug = validate_agent_slug(slug)
        if builtin_slug_exists(slug):
            return (
                f"error: slug {slug!r} is a built-in agent. "
                "Use a different slug (e.g. append -custom)."
            )
        draft = read_agent_dir_from_workspace(workspace_dir, slug)
        validate_agent_draft(
            name=draft["name"],
            agent_md=draft["agent_md"],
            uses_document=draft["uses_document"],
            skills=draft["skills"],
        )
    except AgentError as exc:
        return f"error: {exc}"

    from openagents_api.db import SessionLocal
    from openagents_api.models import UserAgent
    from sqlalchemy import select

    async with SessionLocal() as session:
        result = await session.execute(
            select(UserAgent).where(
                UserAgent.owner_id == owner_id, UserAgent.slug == draft["slug"]
            )
        )
        row = result.scalar_one_or_none()
        existed = row is not None
        if row is None:
            row = UserAgent(owner_id=owner_id, slug=draft["slug"])
            session.add(row)
        row.name = draft["name"]
        row.description = draft["description"]
        row.icon = draft["icon"]
        row.uses_document = draft["uses_document"]
        row.agent_md = draft["agent_md"]
        row.soul_md = draft["soul_md"]
        row.system_prompt = draft["system_prompt"]
        row.document_template_md = draft["document_template_md"]
        row.skills_json = draft["skills"]
        from openagents_api.skills_library import normalize_skill_slugs

        row.predefined_skill_slugs = normalize_skill_slugs(
            draft.get("predefined_skill_slugs") or []
        )
        await session.commit()

    action = "Updated" if existed else "Registered"
    predefined = draft.get("predefined_skill_slugs") or []
    predefined_note = (
        f" Predefined library skills: {', '.join(predefined)}."
        if predefined
        else " No predefined library skills."
    )

    # Notify the web UI to refresh the Agents sidebar without a full page reload.
    ui_events = getattr(ctx.deps, "ui_events", None)
    if ui_events is not None:
        from ag_ui.core import CustomEvent, EventType

        await ui_events.put(
            CustomEvent(
                type=EventType.CUSTOM,
                name="agents_changed",
                value={
                    "slug": draft["slug"],
                    "name": draft["name"],
                    "action": "updated" if existed else "created",
                },
            )
        )

    return (
        f"{action} user agent {draft['slug']!r} "
        f"({draft['name']}).{predefined_note} Select it from the Agents sidebar "
        f"(or Edit in the agent menu)."
    )


# Legacy tool names kept as aliases for in-flight model calls during migration.
validate_pack_draft_tool = validate_agent_draft_tool
register_pack_from_workspace = register_agent_from_workspace

AGENT_BUILDER_TOOLS = [
    validate_agent_draft_tool,
    register_agent_from_workspace,
]
# Legacy alias
PACK_BUILDER_TOOLS = AGENT_BUILDER_TOOLS
