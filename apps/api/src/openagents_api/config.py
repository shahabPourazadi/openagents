from __future__ import annotations

import os
from functools import lru_cache
from typing import Self

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_AUTH_MODES = frozenset({"none", "supabase"})


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "OpenAgents API"
    api_cors_origins: str = "http://localhost:3000"
    # local = Mac/dev. production = Docker/VPS (also auto-detected via COOLIFY_*).
    app_env: str = "local"

    supabase_url: str = "https://base.example.com"
    supabase_anon_key: str = ""
    supabase_service_role_key: str = ""
    supabase_jwt_secret: str = "super-secret-jwt-token-with-at-least-32-characters-long"

    openrouter_api_key: str = ""
    # Any pydantic-ai model id works when provider env keys are set
    # (e.g. openrouter:…, openai:…, ollama:…). OpenRouter-specific routing
    # applies only when the id starts with ``openrouter:``.
    default_model: str = "openrouter:z-ai/glm-5.2"
    # Firecrawl MCP (search / scrape / crawl). Used when MCP_SERVERS_JSON is unset.
    firecrawl_api_key: str = ""
    # Optional JSON array of MCP servers (see mcp_toolsets.py). When set, replaces
    # the default Firecrawl-only entry.
    mcp_servers_json: str = ""
    # Fernet key (url-safe base64) or any passphrase used to encrypt user MCP tokens.
    # When empty, derived from supabase_jwt_secret.
    mcp_secrets_key: str = ""
    # Override built-in agents directory (default: repo agents/).
    agents_dir: str = ""
    # Legacy alias for agents_dir.
    packs_dir: str = ""
    # Override built-in library skills directory (default: repo skills/).
    skills_dir: str = ""

    logfire_token: str = ""
    logfire_enabled: bool = False

    # Langfuse (OpenTelemetry backend).
    langfuse_enabled: bool = False
    langfuse_public_key: str = ""
    langfuse_secret_key: str = ""
    langfuse_base_url: str = "https://tele.example.com"
    # OTLP base, e.g. https://tele.example.com/api/public/otel
    langfuse_otel_endpoint: str = ""

    # Deep agent kill switch (POST /agent/{thread_id}).
    deep_agent_enabled: bool = True

    # Deep-agent filesystem/execute backend: local (host) or docker (isolated).
    # Prod should set AGENT_SANDBOX=docker. Soft-degrades to filesystem-only if
    # the concurrency slot is busy or Docker fails to start (never host execute).
    agent_sandbox: str = "local"
    # Whether the execute/shell tool is offered when a sandbox is available.
    agent_execute: bool = True
    # Max concurrent Docker sandboxes (raise later or swap to Daytona/Modal).
    agent_sandbox_max_concurrent: int = 1
    # Image for DockerSandbox (build apps/api/docker/agent-sandbox.Dockerfile).
    agent_sandbox_image: str = "openagents-agent-sandbox:latest"

    # Default per-user lifetime spend cap (USD) until a payment gateway exists.
    default_spend_budget_usd: float = 5.0

    workspace_tmp_root: str = "/tmp/openagents-workspaces"
    code_interpreter_timeout_s: int = 30
    # Fallback if local/production URLs are unset.
    database_url: str = "sqlite+aiosqlite:///./openagents.db"
    # Optional overrides for local tunnel vs Docker DNS Postgres.
    database_url_local: str = ""
    database_url_production: str = ""

    # Auth: none (open/single-user, X-User-Id) | supabase (JWT).
    # When AUTH_MODE is unset, derive from deprecated AUTH_BYPASS
    # (true → none, false → supabase). AUTH_MODE wins when set.
    auth_mode: str = "none"
    # Deprecated alias for AUTH_MODE. Prefer AUTH_MODE=none|supabase.
    auth_bypass: bool = True

    # When False (default), new users auto-activate; signup queue + Resend
    # approve/reject mail are off. When True, honor system_settings.signup_mode.
    feature_signup_queue: bool = False

    templates_dir: str = ""
    # LiteParse OCR language for deep-agent document parsing (en, fr, de, …).
    liteparse_ocr_language: str = "en"

    # S3-compatible storage for deep-agent binary uploads (optional — local disk fallback).
    openagents_s3_endpoint: str = ""
    openagents_s3_region: str = "garage"
    openagents_s3_bucket: str = ""
    openagents_s3_access_key_id: str = ""
    openagents_s3_secret_access_key: str = ""
    openagents_s3_force_path_style: bool = True
    # Base64 AES-256 key for SSE-C. When set, objects are encrypted at rest.
    openagents_s3_sse_c_key_base64: str = ""

    # Resend (optional; used when FEATURE_SIGNUP_QUEUE=true).
    resend_api_key: str = ""
    resend_from_email: str = ""

    @model_validator(mode="after")
    def _resolve_auth_mode(self) -> Self:
        """AUTH_MODE env / explicit kwargs win; else derive from auth_bypass."""
        if "auth_mode" in self.model_fields_set:
            mode = (self.auth_mode or "none").strip().lower()
            if mode not in _AUTH_MODES:
                mode = "none" if self.auth_bypass else "supabase"
            object.__setattr__(self, "auth_mode", mode)
            return self
        object.__setattr__(self, "auth_mode", "none" if self.auth_bypass else "supabase")
        return self

    @property
    def auth_is_open(self) -> bool:
        """True when auth_mode is none (local single-user / bypass)."""
        return self.auth_mode == "none"

    @property
    def is_production(self) -> bool:
        env = (self.app_env or "local").strip().lower()
        if env in {"production", "prod", "coolify"}:
            return True
        # Coolify injects these into containers.
        if os.getenv("COOLIFY_RESOURCE_UUID") or os.getenv("COOLIFY_CONTAINER_NAME"):
            return True
        return False

    @property
    def resolved_database_url(self) -> str:
        """Pick Postgres URL for the current runtime (local tunnel vs Docker DNS)."""
        if self.is_production:
            url = (self.database_url_production or self.database_url or "").strip()
        else:
            url = (self.database_url_local or self.database_url or "").strip()
        return url or "sqlite+aiosqlite:///./openagents.db"

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.api_cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
