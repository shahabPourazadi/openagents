from __future__ import annotations

import asyncio
import logging
import os
import shutil
import tempfile
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.responses import Response

from ag_ui.core import CustomEvent, EventType

from openagents_api.agent_runtime import merge_agent_runtime
from openagents_api.auth import AuthUser, require_active_user
from openagents_api.company_config import (
    ensure_system_settings,
    load_published_company_config,
    materialize_published_skills,
    merge_tool_groups,
)
from openagents_api.config import Settings, get_settings
from openagents_api.db import get_session
from openagents_api.deep_agent_builder import (
    DEEP_SYSTEM_INSTRUCTIONS,
    build_deep_agent,
    build_deep_deps,
)
from openagents_api.models import Document, Thread, UserSettings, Workspace
from openagents_api.agents import (
    DEFAULT_AGENT_SLUG,
    AgentError,
    materialize_agent_skills,
    resolve_agent,
    try_load_agent,
)
from openagents_api.sandbox import AgentBackendHandle, open_agent_backend
from openagents_api.schemas import SuggestionDecision, SuggestionOut
from openagents_api.suggestions import (
    AgentRunState,
    apply_suggestion,
    format_pending_changes_prompt,
    load_pending_changes_for_thread,
    persist_pending_suggestions,
)
from openagents_api.usage_tracking import build_usage_payload
from openagents_api.uploads import materialize_uploads
from openagents_api.workspace_files import (
    list_workspace_files,
    materialize_workspace_files,
    seed_default_memory_files,
    write_back_workspace_files,
)

_log = logging.getLogger(__name__)

try:
    from pydantic_ai.ui.ag_ui import AGUIAdapter
except ImportError:  # pragma: no cover
    AGUIAdapter = None  # type: ignore[misc, assignment]

try:
    from pydantic_ai_todo import Todo
except ImportError:  # pragma: no cover
    Todo = None  # type: ignore[misc, assignment]


def _maybe_sanitize_agui_event(
    event: Any,
    *,
    workspace_id: uuid.UUID | None = None,
    sandbox_dir: str | None = None,
    tool_names: dict[str, str] | None = None,
) -> Any:
    """Compact TOOL_CALL_RESULT events; promote inline images to durable Assets."""
    from openagents_api.tool_media import sanitize_tool_result_for_ui

    evt_type = getattr(event, "type", None)
    type_name = str(evt_type) if evt_type is not None else ""

    # Remember toolCallId → name so read_file results are not re-saved as new assets.
    if tool_names is not None and (
        evt_type == EventType.TOOL_CALL_START or type_name.endswith("TOOL_CALL_START")
    ):
        call_id = getattr(event, "tool_call_id", None) or getattr(
            event, "toolCallId", None
        )
        call_name = getattr(event, "tool_call_name", None) or getattr(
            event, "toolCallName", None
        )
        if isinstance(call_id, str) and isinstance(call_name, str) and call_id:
            tool_names[call_id] = call_name

    if evt_type != EventType.TOOL_CALL_RESULT and evt_type != "TOOL_CALL_RESULT":
        return event
    content = getattr(event, "content", None)
    if not isinstance(content, str):
        return event
    call_id = getattr(event, "tool_call_id", None) or getattr(
        event, "toolCallId", None
    )
    tool_name = (
        tool_names.get(call_id) if tool_names and isinstance(call_id, str) else None
    )
    sanitized = sanitize_tool_result_for_ui(
        content,
        workspace_id=workspace_id,
        sandbox_dir=sandbox_dir,
        tool_name=tool_name,
    )
    if sanitized == content:
        return event
    try:
        return event.model_copy(update={"content": sanitized})
    except Exception:
        try:
            object.__setattr__(event, "content", sanitized)
            return event
        except Exception:
            return event


async def _multiplex_ui_events(
    agent_stream: AsyncIterator[Any],
    ui_events: asyncio.Queue[Any],
    *,
    workspace_id: uuid.UUID | None = None,
    sandbox_dir: str | None = None,
) -> AsyncIterator[Any]:
    """Interleave agent AG-UI events with mid-tool progress events from tools.

    Nested agents (e.g. delegate_research) cannot surface tool calls on the parent
    AG-UI stream. Tools push CustomEvents onto ``ui_events``; this drain yields
    them while the parent tool is still running.
    """
    aiter = agent_stream.__aiter__()
    agent_task: asyncio.Task[Any] = asyncio.create_task(aiter.__anext__())
    ui_task: asyncio.Task[Any] = asyncio.create_task(ui_events.get())
    tool_names: dict[str, str] = {}
    try:
        while True:
            done, _ = await asyncio.wait(
                {agent_task, ui_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if ui_task in done:
                event = ui_task.result()
                if event is not None:
                    yield event
                ui_task = asyncio.create_task(ui_events.get())
            if agent_task in done:
                try:
                    event = agent_task.result()
                except StopAsyncIteration:
                    break
                yield _maybe_sanitize_agui_event(
                    event,
                    workspace_id=workspace_id,
                    sandbox_dir=sandbox_dir,
                    tool_names=tool_names,
                )
                agent_task = asyncio.create_task(aiter.__anext__())
    finally:
        agent_task.cancel()
        ui_task.cancel()
        for task in (agent_task, ui_task):
            try:
                await task
            except (asyncio.CancelledError, StopAsyncIteration):
                pass
        while not ui_events.empty():
            try:
                event = ui_events.get_nowait()
            except asyncio.QueueEmpty:
                break
            if event is not None:
                yield event



router = APIRouter()


async def _resolve_api_key(session: AsyncSession, user: AuthUser, settings: Settings) -> str:
    row = await session.get(UserSettings, user.id)
    if row and row.openrouter_api_key_enc:
        return row.openrouter_api_key_enc
    return settings.openrouter_api_key


def _materialize(
    ws: Workspace,
    docs: list[Document],
    files: list,
    settings: Settings,
    *,
    published_skills: list[tuple[str, str]] | None = None,
    pack: Any | None = None,
    library_skills: list[Any] | None = None,
    extra_agent_skills: list[Any] | None = None,
) -> str:
    parent = settings.workspace_tmp_root
    Path(parent).mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="openagents-ws-", dir=parent if Path(parent).exists() else None))
    # User persona extensions only — pack persona is injected via instructions.
    if ws.agent_md:
        (root / "agent.md").write_text(ws.agent_md, encoding="utf-8")
    if ws.soul_md:
        (root / "soul.md").write_text(ws.soul_md, encoding="utf-8")
    for doc in docs:
        path = root / doc.path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(doc.content_md, encoding="utf-8")
    materialize_workspace_files(root, files)
    materialize_uploads(ws.id, root)
    from openagents_api.workspace_assets import materialize_assets

    materialize_assets(ws.id, root)
    # Agent skills are the primary source; library + company skills merge on top.
    # materialize_agent_skills also pulls in other agents' playbooks for `/` load.
    if pack is not None:
        materialize_agent_skills(
            root, pack, extra_skills=extra_agent_skills or None
        )
        if published_skills:
            # Append company skills without wiping agent skills.
            skills_root = root / "skills"
            skills_root.mkdir(parents=True, exist_ok=True)
            for slug, content in published_skills:
                pack_dir = skills_root / slug
                pack_dir.mkdir(parents=True, exist_ok=True)
                (pack_dir / "SKILL.md").write_text(content, encoding="utf-8")
    elif published_skills is not None:
        materialize_published_skills(root, published_skills)
    else:
        templates = (
            Path(settings.templates_dir)
            if settings.templates_dir
            else Path(__file__).resolve().parents[4] / "templates"
        )
        skills_src = templates / "skills"
        if skills_src.exists():
            shutil.copytree(skills_src, root / "skills", dirs_exist_ok=True)

    # Sidebar library skills (builtin create-skill + user skills) — fill gaps only.
    if library_skills:
        from openagents_api.skills_library import materialize_library_skills

        materialize_library_skills(root, library_skills, overwrite=False)
    return str(root)


def _restore_todos(raw_todos: list[Any] | None) -> list[Any]:
    if not raw_todos or Todo is None:
        return []
    restored: list[Any] = []
    for raw in raw_todos:
        try:
            restored.append(Todo.model_validate(raw))
        except Exception:
            continue
    return restored


def _dump_todos(todos: list[Any] | None) -> list[dict[str, Any]]:
    if not todos:
        return []
    out: list[dict[str, Any]] = []
    for t in todos:
        if hasattr(t, "model_dump"):
            out.append(t.model_dump())
        elif isinstance(t, dict):
            out.append(t)
    return out


def _effort_settings_from_props(props: Any) -> dict[str, Any] | None:
    if not isinstance(props, dict):
        return None
    # Toggle-only models (e.g. MiniMax M3): on/off, no effort levels.
    if "reasoningEnabled" in props or "reasoning_enabled" in props:
        enabled = props.get("reasoningEnabled")
        if enabled is None:
            enabled = props.get("reasoning_enabled")
        return {"thinking": bool(enabled)}
    raw = props.get("reasoningEffort") or props.get("reasoning_effort")
    effort = str(raw).strip().lower().replace("_", "-") if raw is not None else ""
    if effort in ("x-high", "extra-high"):
        effort = "xhigh"
    if effort in ("off", "none", "disabled"):
        return {"thinking": False}
    if effort not in ("low", "medium", "high", "xhigh", "minimal", "max"):
        return None
    if effort == "max":
        return {"thinking": "xhigh"}
    return {"thinking": effort}


def _model_settings_for_run(model: str | None, props: Any) -> dict[str, Any] | None:
    """Merge per-model OpenRouter prefs (e.g. GLM→Together) with UI reasoning effort."""
    from openagents_api.model_settings import merge_model_settings, settings_for_model

    return merge_model_settings(settings_for_model(model), _effort_settings_from_props(props))


async def _run_deep_agent(
    *,
    thread_id: uuid.UUID,
    request: Request,
    user: AuthUser,
    session: AsyncSession,
    settings: Settings,
) -> Response:
    if AGUIAdapter is None:
        raise HTTPException(status_code=500, detail="AG-UI extras not installed")

    if not settings.deep_agent_enabled:
        raise HTTPException(status_code=503, detail="Deep agent is disabled")

    # Soft spend gate (no payment gateway yet) — applies to every account.
    from openagents_api.models import UserSettings
    from openagents_api.usage_tracking import (
        resolve_spend_budget_usd,
        spend_budget_exceeded,
        spent_usd,
    )

    settings_row = await session.get(UserSettings, user.id)
    budget = resolve_spend_budget_usd(
        getattr(settings_row, "spend_budget_usd", None) if settings_row else None,
        default=float(settings.default_spend_budget_usd),
    )
    totals = getattr(settings_row, "spend_totals", None) if settings_row else None
    if spend_budget_exceeded(totals, budget):
        spent = spent_usd(totals)
        raise HTTPException(
            status_code=402,
            detail={
                "code": "spend_budget_exceeded",
                "message": (
                    "You've reached your usage budget. "
                    "Contact an admin to increase it."
                ),
                "spent_usd": round(spent, 4),
                "budget_usd": round(budget, 4),
            },
        )

    thread = await session.get(Thread, thread_id)
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")

    ws = await session.get(Workspace, thread.workspace_id)
    if not ws or ws.owner_id != user.id:
        raise HTTPException(status_code=404, detail="Workspace not found")

    docs_result = await session.execute(select(Document).where(Document.workspace_id == ws.id))
    docs = list(docs_result.scalars())
    await seed_default_memory_files(session, ws.id)
    await session.commit()
    files = await list_workspace_files(session, ws.id)
    active_doc = None
    if thread.active_document_id:
        active_doc = await session.get(Document, thread.active_document_id)

    api_key = await _resolve_api_key(session, user, settings)
    if api_key:
        os.environ["OPENROUTER_API_KEY"] = api_key

    # Refresh OpenRouter provider/ZDR prefs from admin catalog for this run.
    default_model = settings.default_model
    try:
        from openagents_api.model_catalog import load_model_catalog
        from openagents_api.model_settings import set_catalog_cache

        catalog = await load_model_catalog(session)
        set_catalog_cache(zdr_only=catalog.zdr_only, tiers=catalog.tiers)
        default_model = catalog.default_model_id()
    except Exception:
        pass

    company_cfg = await load_published_company_config(session)
    # Prefer the thread's last-selected agent; fall back to workspace, then Auto Agent.
    agent_slug = (
        getattr(thread, "agent_slug", None)
        or getattr(ws, "agent_slug", None)
        or DEFAULT_AGENT_SLUG
    ).strip() or DEFAULT_AGENT_SLUG
    try:
        pack = await resolve_agent(session, agent_slug, user.id)
    except AgentError:
        pack = try_load_agent(agent_slug)
    agent_slug = pack.slug or DEFAULT_AGENT_SLUG
    # Persist fallback when the stored slug was deleted / missing.
    if getattr(thread, "agent_slug", None) != agent_slug:
        thread.agent_slug = agent_slug
        await session.commit()
    # Pack owns persona + specialization; company tool_groups still apply.
    pack_tool_groups = merge_tool_groups(company_cfg.tool_groups)
    if pack.manifest.tool_groups:
        pack_tool_groups = merge_tool_groups(
            {**pack_tool_groups, **pack.manifest.tool_groups}
        )
    system_prompt = (pack.system_prompt or "").strip() or DEEP_SYSTEM_INSTRUCTIONS
    # Optional company skills on top of pack skills.
    published_skills = company_cfg.skills
    from openagents_api.skills_library import list_owner_library_skills

    library_skills = await list_owner_library_skills(session, user.id)
    from openagents_api.skills_library import (
        format_predefined_skills_prompt,
        resolve_predefined_library_skills,
    )
    from openagents_api.agents import _skills_from_json
    from openagents_api.models import UserAgent

    # Custom agents' playbooks (built-ins are merged inside materialize_agent_skills).
    extra_agent_skills: list[Any] = []
    user_agent_rows = await session.execute(
        select(UserAgent).where(UserAgent.owner_id == user.id)
    )
    for row in user_agent_rows.scalars():
        if getattr(pack, "slug", None) and row.slug == pack.slug:
            continue
        extra_agent_skills.extend(_skills_from_json(getattr(row, "skills_json", None)))

    # Auto Agent (slug "agent") roots every skill; other agents use their selection.
    predefined_slugs = getattr(pack, "predefined_skill_slugs", None)
    if pack.slug == DEFAULT_AGENT_SLUG:
        from openagents_api.skills_library import list_all_attachable_skill_slugs

        predefined_slugs = await list_all_attachable_skill_slugs(session, user.id)
    predefined_resolved = await resolve_predefined_library_skills(
        session,
        user.id,
        predefined_slugs,
    )
    predefined_skills_text = format_predefined_skills_prompt(predefined_resolved)

    workspace_dir = _materialize(
        ws,
        docs,
        files,
        settings,
        published_skills=published_skills,
        pack=pack,
        library_skills=library_skills,
        extra_agent_skills=extra_agent_skills,
    )
    ui_events: asyncio.Queue[Any] = asyncio.Queue()

    pending_changes = await load_pending_changes_for_thread(
        session,
        thread_id=thread.id,
        workspace_id=ws.id,
        active_document_id=active_doc.id if active_doc else None,
    )
    pending_changes_text = format_pending_changes_prompt(pending_changes)

    resolved_model = thread.model or pack.manifest.default_model or default_model

    state = AgentRunState(
        user_id=user.id,
        workspace_id=ws.id,
        thread_id=thread.id,
        document_id=active_doc.id if active_doc else None,
        document_md=active_doc.content_md if active_doc else "",
        document_path=active_doc.path if active_doc else "",
        uses_document=bool(pack.manifest.uses_document),
        openrouter_api_key=api_key,
        model=resolved_model,
        workspace_dir=workspace_dir,
        pending_changes=pending_changes,
        pending_changes_text=pending_changes_text,
        agent_md=ws.agent_md or "",
        soul_md=ws.soul_md or "",
        company_agent_md=pack.agent_md,
        company_soul_md=pack.soul_md,
        predefined_skills_text=predefined_skills_text,
        ui_events=ui_events,
    )

    restored_todos = _restore_todos(thread.todos)
    backend_handle: AgentBackendHandle | None = None

    skills_root = Path(workspace_dir) / "skills"
    try:
        sys_row = await ensure_system_settings(session)
        agent_runtime = merge_agent_runtime(
            getattr(sys_row, "agent_runtime", None), settings
        )
        backend_handle = await open_agent_backend(workspace_dir, agent_runtime)
        if backend_handle.degraded:
            _log.warning(
                "Deep agent soft-degraded (no shell) for thread %s — "
                "sandbox busy or unavailable",
                thread.id,
            )
        from openagents_api.mcp_library import (
            resolve_all_user_mcp_configs,
            resolve_user_mcp_configs,
        )

        # Auto Agent attaches every library MCP; other agents use mcp_server_ids.
        if pack.slug == DEFAULT_AGENT_SLUG:
            user_mcp_configs = await resolve_all_user_mcp_configs(
                session, settings, user.id
            )
        else:
            user_mcp_configs = await resolve_user_mcp_configs(
                session,
                settings,
                user.id,
                getattr(pack, "mcp_server_ids", None),
            )
        agent = build_deep_agent(
            state.model,
            system_prompt=system_prompt,
            tool_groups=pack_tool_groups,
            skill_directories=[str(skills_root)] if skills_root.is_dir() else None,
            include_execute=agent_runtime.execute,
            safety=agent_runtime.safety,
            agent_slug=agent_slug,
            agent_source=getattr(pack, "source", None),
            user_mcp_configs=user_mcp_configs,
        )
        deep_deps = build_deep_deps(
            state, backend_handle=backend_handle, todos=restored_todos
        )
    except Exception:
        if backend_handle is not None:
            await backend_handle.aclose()
        shutil.rmtree(workspace_dir, ignore_errors=True)
        raise
    run_deps = deep_deps
    system_instructions = system_prompt

    def get_todos() -> list[Any]:
        return list(deep_deps.todos or [])

    async def on_complete(result):  # type: ignore[no-untyped-def]
        """Persist suggestions + usage, then stream a usage CustomEvent for the chat UI."""
        from openagents_api.db import SessionLocal
        from openagents_api.usage_tracking import merge_spend_totals, merge_thread_usage

        payload = None
        try:
            async with SessionLocal() as persist_session:
                # Deep agent copies document_md onto OpenAgentsDeepDeps at start; tools mutate
                # run_deps.document_md. Sync back so auto-applied additions are saved.
                # (pending is already shared by reference.)
                live_md = getattr(run_deps, "document_md", None)
                if isinstance(live_md, str):
                    state.document_md = live_md
                await persist_pending_suggestions(persist_session, state)
                try:
                    await write_back_workspace_files(
                        persist_session, state.workspace_id, workspace_dir
                    )
                except Exception:
                    _log.exception("write_back_workspace_files failed")
                asset_paths_written: list[str] = []
                try:
                    from openagents_api.workspace_assets import write_back_workspace_assets

                    asset_paths_written = write_back_workspace_assets(
                        state.workspace_id, workspace_dir
                    )
                    if asset_paths_written:
                        _log.info(
                            "Persisted %s workspace asset(s) for %s",
                            len(asset_paths_written),
                            state.workspace_id,
                        )
                except Exception:
                    _log.exception("write_back_workspace_assets failed")
                try:
                    thread_row = await persist_session.get(Thread, state.thread_id)
                    if thread_row is not None:
                        thread_row.todos = _dump_todos(get_todos())

                    built = build_usage_payload(
                        state=state,
                        usage=result.usage,
                        messages=list(result.all_messages()),
                        system_instructions=system_instructions,
                    )
                    built["agent_kind"] = "deep"
                    if thread_row is not None:
                        prev_paths = []
                        if isinstance(thread_row.usage, dict):
                            raw_paths = thread_row.usage.get("asset_paths")
                            if isinstance(raw_paths, list):
                                prev_paths = [p for p in raw_paths if isinstance(p, str)]
                        merged_paths = list(dict.fromkeys([*prev_paths, *asset_paths_written]))
                        stored = merge_thread_usage(thread_row.usage, built)
                        if merged_paths:
                            stored["asset_paths"] = merged_paths
                        thread_row.usage = stored
                        built["session"] = {
                            "total_tokens": stored["session_tokens"],
                            "input_tokens": stored["session_input_tokens"],
                            "output_tokens": stored["session_output_tokens"],
                            "last_run_tokens": stored["last_run_tokens"],
                        }
                        if merged_paths:
                            built["asset_paths"] = merged_paths

                    settings_row = await persist_session.get(UserSettings, state.user_id)
                    if settings_row is None:
                        settings_row = UserSettings(user_id=state.user_id)
                        persist_session.add(settings_row)
                    spend = merge_spend_totals(settings_row.spend_totals, built)
                    settings_row.spend_totals = spend
                    built["account"] = {
                        "total_tokens": spend["total_tokens"],
                        "input_tokens": spend["input_tokens"],
                        "output_tokens": spend["output_tokens"],
                        "run_count": spend["run_count"],
                        "total_cost_usd": spend.get("total_cost_usd"),
                        "token_cost_usd": spend.get("token_cost_usd"),
                        "multimodal_cost_usd": spend.get("multimodal_cost_usd"),
                        "last_run_tokens": spend["last_run_tokens"],
                    }

                    await persist_session.commit()
                    payload = built
                except Exception:
                    try:
                        thread_row = await persist_session.get(Thread, state.thread_id)
                        if thread_row is not None:
                            thread_row.todos = _dump_todos(get_todos())
                        await persist_session.commit()
                    except Exception:
                        pass
                    payload = None
        finally:
            if backend_handle is not None:
                try:
                    await backend_handle.aclose()
                except Exception:
                    _log.exception("Failed to close agent backend handle")
            shutil.rmtree(workspace_dir, ignore_errors=True)

        if payload is not None:
            yield CustomEvent(type=EventType.CUSTOM, name="usage", value=payload)

    from pydantic import ValidationError

    try:
        adapter = await AGUIAdapter.from_request(request, agent=agent)
    except ValidationError as e:
        if backend_handle is not None:
            await backend_handle.aclose()
        shutil.rmtree(workspace_dir, ignore_errors=True)
        return Response(
            content=e.json(),
            media_type="application/json",
            status_code=422,
        )
    except Exception:
        if backend_handle is not None:
            await backend_handle.aclose()
        shutil.rmtree(workspace_dir, ignore_errors=True)
        raise

    model_settings = _model_settings_for_run(
        state.model, adapter.run_input.forwarded_props
    )

    from openagents_api.langfuse_otel import langfuse_trace_baggage

    async def _stream_with_langfuse_user():
        # Baggage must wrap run_stream + consume so every span (incl. root)
        # gets langfuse.user.id / session.id (Logfire copies baggage → attrs).
        with langfuse_trace_baggage(
            user_id=user.id,
            session_id=str(thread_id),
        ):
            agent_stream = adapter.run_stream(
                deps=run_deps,
                on_complete=on_complete,
                model_settings=model_settings,
            )
            async for event in _multiplex_ui_events(
                agent_stream,
                ui_events,
                workspace_id=state.workspace_id,
                sandbox_dir=workspace_dir,
            ):
                yield event

    return adapter.streaming_response(_stream_with_langfuse_user())


@router.post("/agent/{thread_id}")
async def run_agent(
    thread_id: uuid.UUID,
    request: Request,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> Response:
    return await _run_deep_agent(
        thread_id=thread_id,
        request=request,
        user=user,
        session=session,
        settings=settings,
    )


@router.post("/v2/agent/{thread_id}")
async def run_deep_agent_alias(
    thread_id: uuid.UUID,
    request: Request,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> Response:
    """Backwards-compat alias during migration from /v2/agent to /agent."""
    return await _run_deep_agent(
        thread_id=thread_id,
        request=request,
        user=user,
        session=session,
        settings=settings,
    )


@router.get("/documents/{document_id}/suggestions", response_model=list[SuggestionOut])
async def list_suggestions(
    document_id: uuid.UUID,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> list:
    from openagents_api.models import Suggestion

    doc = await session.get(Document, document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    ws = await session.get(Workspace, doc.workspace_id)
    if not ws or ws.owner_id != user.id:
        raise HTTPException(status_code=404, detail="Not found")
    result = await session.execute(
        select(Suggestion)
        .where(Suggestion.document_id == document_id, Suggestion.status == "pending")
        .order_by(Suggestion.created_at)
    )
    return list(result.scalars())


@router.post("/suggestions/{suggestion_id}/decide", response_model=SuggestionOut)
async def decide_suggestion(
    suggestion_id: uuid.UUID,
    body: SuggestionDecision,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
):
    from openagents_api.models import Suggestion

    suggestion = await session.get(Suggestion, suggestion_id)
    if not suggestion:
        raise HTTPException(status_code=404, detail="Suggestion not found")
    doc = await session.get(Document, suggestion.document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    ws = await session.get(Workspace, doc.workspace_id)
    if not ws or ws.owner_id != user.id:
        raise HTTPException(status_code=404, detail="Not found")

    accept = body.action.lower() == "accept"
    await apply_suggestion(session, suggestion, accept=accept)
    await session.refresh(suggestion)
    return suggestion


@router.post("/documents/{document_id}/suggestions/accept-all")
async def accept_all(
    document_id: uuid.UUID,
    user: AuthUser = Depends(require_active_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    from openagents_api.models import Suggestion

    doc = await session.get(Document, document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    ws = await session.get(Workspace, doc.workspace_id)
    if not ws or ws.owner_id != user.id:
        raise HTTPException(status_code=404, detail="Not found")

    result = await session.execute(
        select(Suggestion).where(
            Suggestion.document_id == document_id, Suggestion.status == "pending"
        )
    )
    for s in result.scalars():
        await apply_suggestion(session, s, accept=True)
    return {"ok": True}
