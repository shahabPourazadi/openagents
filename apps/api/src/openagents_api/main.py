from __future__ import annotations

import base64
import os
from contextlib import asynccontextmanager
from pathlib import Path

import logfire
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from openagents_api.admin_routes import router as admin_router
from openagents_api.agent_routes import router as agent_router
from openagents_api.config import Settings, get_settings
from openagents_api.db import init_db
from openagents_api.mcp_routes import router as mcp_router
from openagents_api.routers_api import router as api_router


def _configure_observability(settings: Settings) -> None:
    """Instrument via Logfire SDK; export spans to Langfuse and/or Logfire cloud."""
    use_langfuse = bool(
        settings.langfuse_enabled
        and settings.langfuse_public_key
        and settings.langfuse_secret_key
    )
    use_logfire = bool(settings.logfire_enabled or settings.logfire_token)

    if not use_langfuse and not use_logfire:
        return

    extra_processors = None
    if use_langfuse:
        from openagents_api.langfuse_otel import (
            LangfuseAttributeProcessor,
            patch_model_response_cost_for_openrouter,
        )

        otel_base = (settings.langfuse_otel_endpoint or "").strip().rstrip("/")
        if not otel_base:
            otel_base = f"{settings.langfuse_base_url.rstrip('/')}/api/public/otel"
        auth = base64.b64encode(
            f"{settings.langfuse_public_key}:{settings.langfuse_secret_key}".encode()
        ).decode()
        # Must be set before configure(); Logfire reads standard OTEL exporter env vars.
        os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"] = otel_base
        os.environ["OTEL_EXPORTER_OTLP_HEADERS"] = (
            f"Authorization=Basic {auth},x-langfuse-ingestion-version=4"
        )
        patch_model_response_cost_for_openrouter()
        extra_processors = [LangfuseAttributeProcessor()]

    # Attribute keys / LLM I/O that must not be redacted for Langfuse.
    # Logfire's default pattern list includes ``session``, which otherwise
    # blanks langfuse.session.id and any observation I/O that mentions "session"
    # (system text, tools, history) — Langfuse then shows "[Scrubbed…]".
    _KEEP_ATTR_KEYS = frozenset(
        {
            "langfuse.session.id",
            "session.id",
            "langfuse.user.id",
            "user.id",
            "langfuse.observation.input",
            "langfuse.observation.output",
            "prompt",
            "final_result",
            "all_messages_events",
            "pydantic_ai.all_messages",
            "gen_ai.input.messages",
            "gen_ai.output.messages",
            "gen_ai.tool.definitions",
            "gen_ai.system_instructions",
        }
    )

    def _keep_langfuse_trace_data(match: logfire.ScrubMatch):
        path = match.path or ()
        if len(path) >= 2 and path[0] == "attributes":
            key = str(path[1])
            if key in _KEEP_ATTR_KEYS or key.startswith("langfuse."):
                return match.value
            # Nested scrubbing inside kept attrs (path longer than 2).
            if any(str(path[1]) == k or str(path[1]).startswith(k) for k in _KEEP_ATTR_KEYS):
                return match.value
            # Word "session" inside other agent message/tool blobs.
            matched = ""
            try:
                matched = (match.pattern_match.group(0) or "").lower()
            except Exception:
                matched = ""
            if matched == "session" and (
                "message" in key
                or "prompt" in key
                or "tool" in key
                or key.startswith("gen_ai.")
            ):
                return match.value
        return None

    logfire.configure(
        token=settings.logfire_token or None,
        service_name="openagents-api",
        send_to_logfire="if-token-present" if use_logfire else False,
        inspect_arguments=False,
        additional_span_processors=extra_processors,
        scrubbing=logfire.ScrubbingOptions(callback=_keep_langfuse_trace_data),
    )
    logfire.instrument_pydantic_ai()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings = get_settings()
    # Resolve templates relative to monorepo root when running from apps/api
    if not settings.templates_dir:
        candidate = Path(__file__).resolve().parents[4] / "templates"
        if candidate.exists():
            settings.templates_dir = str(candidate)

    _configure_observability(settings)

    Path(settings.workspace_tmp_root).mkdir(parents=True, exist_ok=True)
    await init_db()
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title=settings.app_name, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins or ["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(api_router)
    app.include_router(mcp_router)
    app.include_router(admin_router)
    app.include_router(agent_router)
    return app


app = create_app()
