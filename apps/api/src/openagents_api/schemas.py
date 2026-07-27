from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field, model_validator


class WorkspaceCreate(BaseModel):
    name: str = "My workspace"
    agent_slug: str = "agent"
    # Legacy alias accepted on create.
    pack_slug: str | None = None

    @model_validator(mode="after")
    def _prefer_agent_slug(self) -> "WorkspaceCreate":
        # Prefer agent_slug; accept legacy pack_slug when agent_slug left at default.
        if self.pack_slug is not None and self.pack_slug.strip() and self.agent_slug == "agent":
            object.__setattr__(self, "agent_slug", self.pack_slug.strip())
        return self


class WorkspaceUpdate(BaseModel):
    name: str | None = None
    agent_slug: str | None = None
    pack_slug: str | None = None

    @model_validator(mode="after")
    def _prefer_agent_slug(self) -> "WorkspaceUpdate":
        if self.agent_slug is None and self.pack_slug is not None:
            object.__setattr__(self, "agent_slug", self.pack_slug)
        return self


class WorkspaceOut(BaseModel):
    id: UUID
    name: str
    owner_id: str
    agent_slug: str = "agent"
    uses_document: bool = True
    uses_canvas: bool = False
    agent_md: str | None = None
    soul_md: str | None = None
    created_at: datetime
    # Legacy mirror for older clients.
    pack_slug: str = "agent"

    model_config = {"from_attributes": True}

    @model_validator(mode="after")
    def _mirror_slug(self) -> "WorkspaceOut":
        object.__setattr__(self, "pack_slug", self.agent_slug)
        return self


class AgentSkillOut(BaseModel):
    slug: str
    name: str = ""
    description: str = ""
    icon: str = ""
    content: str = ""


class SkillOut(BaseModel):
    slug: str
    name: str
    description: str = ""
    icon: str = ""
    source: str = "builtin"  # builtin | user
    content: str | None = None


class SkillCreate(BaseModel):
    name: str
    description: str = ""
    icon: str = ""
    content: str = ""
    slug: str | None = None


class SkillUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    icon: str | None = None
    content: str | None = None


class AgentOut(BaseModel):
    name: str
    slug: str
    description: str = ""
    icon: str = ""
    uses_document: bool = True
    uses_canvas: bool = False
    default_model: str | None = None
    source: str = "builtin"  # builtin | user
    agent_md: str | None = None
    soul_md: str | None = None
    system_prompt: str | None = None
    document_template_md: str | None = None
    skills: list[AgentSkillOut] = Field(default_factory=list)
    # Library skill slugs rooted in the system prompt (full library still available).
    predefined_skill_slugs: list[str] = Field(default_factory=list)
    # User MCP library server ids attached to this agent.
    mcp_server_ids: list[UUID] = Field(default_factory=list)


class AgentCreate(BaseModel):
    name: str
    description: str = ""
    icon: str = ""
    uses_document: bool = True
    uses_canvas: bool = False
    document_template_md: str = ""
    agent_md: str = ""
    soul_md: str = ""
    system_prompt: str = ""
    skills: list[AgentSkillOut] = Field(default_factory=list)
    predefined_skill_slugs: list[str] = Field(default_factory=list)
    mcp_server_ids: list[UUID] = Field(default_factory=list)
    slug: str | None = None


class AgentUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    icon: str | None = None
    uses_document: bool | None = None
    uses_canvas: bool | None = None
    document_template_md: str | None = None
    agent_md: str | None = None
    soul_md: str | None = None
    system_prompt: str | None = None
    skills: list[AgentSkillOut] | None = None
    predefined_skill_slugs: list[str] | None = None
    mcp_server_ids: list[UUID] | None = None


class AgentEnhanceAgentMd(BaseModel):
    """Rewrite rough notes into a best-practice agent.md."""

    draft: str = ""
    name: str = ""
    description: str = ""
    uses_document: bool = False
    uses_canvas: bool = False


class AgentEnhanceAgentMdOut(BaseModel):
    agent_md: str


class DocumentCreate(BaseModel):
    title: str = "Untitled"
    path: str = "document.md"
    use_default_template: bool = False
    content_md: str | None = None


class DocumentOut(BaseModel):
    id: UUID
    workspace_id: UUID
    path: str
    title: str
    content_md: str
    updated_at: datetime

    model_config = {"from_attributes": True}


class DocumentUpdate(BaseModel):
    title: str | None = None
    content_md: str | None = None
    path: str | None = None


class CanvasCreate(BaseModel):
    title: str = "Canvas"
    scene_json: dict | None = None


class CanvasOut(BaseModel):
    id: UUID
    workspace_id: UUID
    title: str
    scene_json: dict
    updated_at: datetime

    model_config = {"from_attributes": True}


class CanvasUpdate(BaseModel):
    title: str | None = None
    scene_json: dict | None = None


class ThreadCreate(BaseModel):
    title: str = "New chat"
    model: str | None = None
    agent_slug: str | None = None
    active_document_id: UUID | None = None
    active_canvas_id: UUID | None = None
    # "deep" (default) — legacy DB rows may still say "classic".
    agent_kind: str = "deep"


class ThreadUpdate(BaseModel):
    title: str | None = None
    model: str | None = None
    agent_slug: str | None = None
    active_document_id: UUID | None = None
    active_canvas_id: UUID | None = None


class ThreadOut(BaseModel):
    id: UUID
    workspace_id: UUID
    title: str
    model: str
    agent_slug: str = "agent"
    agent_kind: str = "deep"
    active_document_id: UUID | None
    active_canvas_id: UUID | None = None
    usage: dict | None = None
    updated_at: datetime

    model_config = {"from_attributes": True}


class MessageCreate(BaseModel):
    role: str
    content: str = ""
    meta: dict | None = None


class MessageOut(BaseModel):
    id: UUID
    role: str
    content: str
    meta: dict | None = None
    created_at: datetime
    thread_title: str | None = Field(
        default=None,
        description="Set when creating a message that auto-named the thread.",
    )

    model_config = {"from_attributes": True}


class SuggestionOut(BaseModel):
    id: UUID
    document_id: UUID
    kind: str
    old_text: str
    new_text: str
    section_heading: str | None
    status: str
    created_at: datetime

    model_config = {"from_attributes": True}


class SuggestionDecision(BaseModel):
    action: str = Field(description="accept | reject")


class PersonaUpdate(BaseModel):
    agent_md: str | None = None
    soul_md: str | None = None


class WorkspaceFileOut(BaseModel):
    id: UUID
    workspace_id: UUID
    path: str
    kind: str
    content_md: str
    updated_at: datetime

    model_config = {"from_attributes": True}


class WorkspaceFileUpdate(BaseModel):
    content_md: str | None = None
    path: str | None = None
    kind: str | None = None


class WorkspaceFileCreate(BaseModel):
    path: str
    kind: str = "other"
    content_md: str = ""


class UploadOut(BaseModel):
    path: str
    filename: str
    size: int
    content_type: str


class UploadPresignOut(BaseModel):
    url: str
    expires_in: int
    path: str


class SettingsUpdate(BaseModel):
    openrouter_api_key: str | None = None
    preferred_model: str | None = None


class ModelOption(BaseModel):
    id: str
    label: str
    context_window: int = 1_000_000
    # OpenRouter list prices ($ / 1M tokens) for the picker subtitle.
    price_input_per_m: float | None = None
    price_output_per_m: float | None = None
    # Human-readable reasoning effort levels supported by the model.
    reasoning: str | None = None
    # Effort ids accepted by OpenRouter / pydantic-ai `thinking`.
    reasoning_efforts: list[str] = []
    # efforts = level picker; toggle = on/off only (e.g. MiniMax M3); none = hide UI.
    reasoning_mode: str = "efforts"


class McpServerOut(BaseModel):
    id: str
    slug: str
    name: str
    url: str
    headers: dict[str, str] = Field(default_factory=dict)
    auth_mode: str = "token"
    allowlist: list[str] | None = None
    is_prebuilt: bool = False
    has_token: bool = False
    tool_names: list[str] = Field(default_factory=list)
    last_tested_at: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


class McpServerCreate(BaseModel):
    name: str
    url: str
    token: str | None = None
    headers: dict[str, str] = Field(default_factory=dict)
    allowlist: list[str] | None = None
    slug: str | None = None
    auth_mode: str = "token"


class McpServerUpdate(BaseModel):
    name: str | None = None
    url: str | None = None
    token: str | None = None
    headers: dict[str, str] | None = None
    allowlist: list[str] | None = None
    auth_mode: str | None = None
    clear_token: bool = False


class McpServerParseIn(BaseModel):
    raw: object


class McpServerDraftOut(BaseModel):
    name: str
    slug: str
    url: str
    token: str | None = None
    headers: dict[str, str] = Field(default_factory=dict)
    allowlist: list[str] | None = None


class McpServerTestIn(BaseModel):
    name: str = "MCP Server"
    url: str
    token: str | None = None
    headers: dict[str, str] = Field(default_factory=dict)
    allowlist: list[str] | None = None
    auth_mode: str = "token"
    slug: str | None = None


class McpServerTestOut(BaseModel):
    ok: bool
    tool_names: list[str] = Field(default_factory=list)
    error: str | None = None


class McpSetupChatIn(BaseModel):
    message: str
    history: list[dict[str, str]] = Field(default_factory=list)


class McpSetupChatOut(BaseModel):
    reply: str
    draft: McpServerDraftOut | None = None
    saved: McpServerOut | None = None
    tool_names: list[str] = Field(default_factory=list)
    error: str | None = None
