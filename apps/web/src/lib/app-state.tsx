"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useAccountStatus } from "@/lib/account-status";
import { useAuth } from "@/lib/auth-context";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

/** Set by AuthBridge so API calls attach the Supabase JWT. */
let authAccessToken: string | null = null;
let authUserId: string | null = null;

export function setApiAuth(token: string | null, userId: string | null) {
  authAccessToken = token;
  authUserId = userId;
}

export type SidebarTab = "chats" | "agents" | "skills" | "mcp" | "files";

function parseSidebarTab(raw: string | null): SidebarTab | null {
  if (
    raw === "files" ||
    raw === "agents" ||
    raw === "skills" ||
    raw === "mcp" ||
    raw === "chats"
  ) {
    return raw;
  }
  return null;
}

function readUrlState(): {
  threadId: string | null;
  tab: SidebarTab;
  chatsLibraryOpen: boolean;
} {
  if (typeof window === "undefined") {
    return { threadId: null, tab: "chats", chatsLibraryOpen: false };
  }
  const params = new URLSearchParams(window.location.search);
  const tabParam = parseSidebarTab(params.get("tab"));
  // `?tab=chats` = full chat history in the middle; no tab = active conversation.
  if (tabParam === "chats") {
    return {
      threadId: params.get("thread"),
      tab: "chats",
      chatsLibraryOpen: true,
    };
  }
  if (tabParam) {
    return {
      threadId: params.get("thread"),
      tab: tabParam,
      chatsLibraryOpen: false,
    };
  }
  return {
    threadId: params.get("thread"),
    tab: "chats",
    chatsLibraryOpen: false,
  };
}

function writeUrlState(
  threadId: string | null,
  tab: SidebarTab,
  chatsLibraryOpen: boolean
) {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  if (threadId) params.set("thread", threadId);
  else params.delete("thread");
  if (tab === "files" || tab === "agents" || tab === "skills" || tab === "mcp") {
    params.set("tab", tab);
  } else if (tab === "chats" && chatsLibraryOpen) {
    params.set("tab", "chats");
  } else {
    params.delete("tab");
  }
  const qs = params.toString();
  const next = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  const current = `${window.location.pathname}${window.location.search}`;
  if (next !== current) {
    window.history.replaceState(null, "", next);
  }
}

export type Workspace = {
  id: string;
  name: string;
  agent_slug?: string;
  /** @deprecated Legacy API mirror; prefer agent_slug. */
  pack_slug?: string;
  uses_document?: boolean;
  agent_md?: string | null;
  soul_md?: string | null;
};

function normalizeWorkspace(ws: Workspace): Workspace {
  const agent_slug = ws.agent_slug || ws.pack_slug || "agent";
  return { ...ws, agent_slug, pack_slug: agent_slug };
}

export type Agent = {
  name: string;
  slug: string;
  description?: string;
  icon?: string;
  uses_document: boolean;
  source: "builtin" | "user";
  skills?: {
    slug: string;
    name?: string;
    description?: string;
    content?: string;
    icon?: string;
  }[];
  /** Library skill slugs rooted in this agent's system prompt. */
  predefined_skill_slugs?: string[];
  /** User MCP library server ids attached to this agent. */
  mcp_server_ids?: string[];
};

/** Full agent payload from GET/PATCH /api/agents/{slug}. */
export type AgentDetail = Agent & {
  agent_md?: string | null;
  soul_md?: string | null;
  system_prompt?: string | null;
  document_template_md?: string | null;
};

export type AgentSkillInput = {
  slug: string;
  name?: string;
  description?: string;
  content?: string;
  icon?: string;
};

export type AgentCreateInput = {
  name: string;
  description?: string;
  icon?: string;
  uses_document?: boolean;
  agent_md?: string;
  soul_md?: string;
  system_prompt?: string;
  document_template_md?: string;
  skills?: AgentSkillInput[];
  predefined_skill_slugs?: string[];
  mcp_server_ids?: string[];
  slug?: string;
};

export type AgentUpdateInput = {
  name?: string;
  description?: string;
  icon?: string;
  uses_document?: boolean;
  agent_md?: string;
  soul_md?: string;
  system_prompt?: string;
  document_template_md?: string;
  skills?: AgentSkillInput[];
  predefined_skill_slugs?: string[];
  mcp_server_ids?: string[];
};

export type Skill = {
  slug: string;
  name: string;
  description?: string;
  icon?: string;
  source: "builtin" | "user";
  content?: string | null;
};

export type SkillDetail = Skill & {
  content?: string | null;
};

export type SkillCreateInput = {
  name: string;
  description?: string;
  icon?: string;
  content?: string;
  slug?: string;
};

export type SkillUpdateInput = {
  name?: string;
  description?: string;
  icon?: string;
  content?: string;
};

export type McpServer = {
  id: string;
  slug: string;
  name: string;
  url: string;
  headers?: Record<string, string>;
  auth_mode: string;
  allowlist?: string[] | null;
  is_prebuilt: boolean;
  has_token: boolean;
  tool_names?: string[];
  last_tested_at?: string | null;
};

export type McpServerCreateInput = {
  name: string;
  url: string;
  token?: string | null;
  headers?: Record<string, string>;
  allowlist?: string[] | null;
  slug?: string;
  auth_mode?: string;
};

export type McpServerUpdateInput = {
  name?: string;
  url?: string;
  token?: string | null;
  headers?: Record<string, string>;
  allowlist?: string[] | null;
  auth_mode?: string;
  clear_token?: boolean;
};

export type McpServerDraft = {
  name: string;
  slug: string;
  url: string;
  token?: string | null;
  headers?: Record<string, string>;
  allowlist?: string[] | null;
};

export type Document = {
  id: string;
  workspace_id: string;
  path: string;
  title: string;
  content_md: string;
  updated_at: string;
};

/** Legacy thread metadata — all threads use the deep stack at `/agent`. */
export type AgentKind = "deep";

export type Thread = {
  id: string;
  workspace_id: string;
  title: string;
  model: string;
  /** Last agent selected in this chat. Falls back to built-in "agent" when missing. */
  agent_slug?: string | null;
  agent_kind?: AgentKind | string | null;
  active_document_id: string | null;
  usage?: {
    context_max?: number;
    context_used?: number;
    context_pct?: number;
    breakdown?: { id: string; label: string; tokens: number }[];
    session_tokens?: number;
    session_input_tokens?: number;
    session_output_tokens?: number;
    last_run_tokens?: number;
    /** Durable diagrams/ + other/ paths written during this thread's agent runs. */
    asset_paths?: string[];
  } | null;
  updated_at: string;
};

/** Built-in Auto Agent — used when a thread's agent was deleted. */
export const DEFAULT_AGENT_SLUG = "agent";

/** Resolve a stored slug against the current agent list; missing → Auto Agent. */
export function resolveThreadAgentSlug(
  slug: string | null | undefined,
  agents: { slug: string }[]
): string {
  const requested = (slug || "").trim() || DEFAULT_AGENT_SLUG;
  // Agents still loading — keep the stored slug rather than false-fallback.
  if (agents.length === 0) return requested;
  if (agents.some((a) => a.slug === requested)) return requested;
  if (agents.some((a) => a.slug === DEFAULT_AGENT_SLUG)) return DEFAULT_AGENT_SLUG;
  return agents[0]?.slug || DEFAULT_AGENT_SLUG;
}

export type SpendTotals = {
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  run_count: number;
  total_cost_usd?: number | null;
  /** Chat / LLM token spend (USD). */
  token_cost_usd?: number | null;
  /** Image / multimodal generation spend (USD). */
  multimodal_cost_usd?: number | null;
  last_run_tokens?: number;
  /** Lifetime cost cap (USD). Admins are exempt server-side. */
  spend_budget_usd?: number | null;
};

export type Suggestion = {
  id: string;
  document_id: string;
  kind: string;
  old_text: string;
  new_text: string;
  section_heading: string | null;
  status: string;
};

export type WorkspaceFile = {
  id: string;
  workspace_id: string;
  path: string;
  kind: string;
  content_md: string;
  updated_at: string;
};

/** Durable binary figure under diagrams/ or other/ (Garage / local assets store). */
export type WorkspaceAsset = {
  path: string;
  filename: string;
  size: number;
  content_type: string;
};

/** Chat attachment upload under uploads/ (Garage / local uploads store). */
export type WorkspaceUpload = {
  path: string;
  filename: string;
  size: number;
  content_type: string;
};

/** What the right pane is editing (document vs persona vs workspace file). */
export type EditorTarget =
  | { type: "document" }
  | { type: "persona"; key: "agent" | "soul" }
  | { type: "workspace_file"; id: string };

export type ChatToolPart = {
  type: string;
  state:
    | "input-streaming"
    | "input-available"
    | "output-available"
    | "output-error";
  toolCallId?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  errorText?: string;
};

/** Ordered assistant turn segments (text ↔ tools interleaved as streamed). */
export type ChatContentPart =
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: ChatToolPart }
  | { kind: "reasoning"; text: string; streaming?: boolean }
  | {
      kind: "clarifying_question";
      questions: {
        id: string;
        question: string;
        options: {
          label: string;
          description?: string;
          recommended?: boolean;
        }[];
        context?: string;
      }[];
      toolCallId?: string;
      submitted?: boolean;
      /** @deprecated legacy single-question shape */
      question?: string;
      options?: {
        label: string;
        description?: string;
        recommended?: boolean;
      }[];
      context?: string;
      answeredLabel?: string;
    };

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  tools?: ChatToolPart[];
  /** Chronological parts; prefer over tools-then-content when present. */
  parts?: ChatContentPart[];
  /** Legacy single blob; prefer `parts` with kind "reasoning". */
  reasoning?: string;
  /** Files / skills shown above the user bubble (not inlined in content). */
  attachments?: {
    id: string;
    kind: "document" | "file" | "skill" | "upload";
    label: string;
    path?: string;
    description?: string;
    size?: number;
  }[];
};

/** Text selected in the document editor and attached to the next chat message. */
export type QuotedSelection = {
  text: string;
  documentId: string;
};

/** Resolve display order for an assistant message. */
export function getMessageParts(m: ChatMessage): ChatContentPart[] {
  if (m.parts?.length) return m.parts;
  const parts: ChatContentPart[] = [];
  // Legacy: one reasoning blob before tools/text.
  if (m.reasoning?.trim()) {
    parts.push({ kind: "reasoning", text: m.reasoning });
  }
  if (m.tools?.length) {
    for (const tool of m.tools) parts.push({ kind: "tool", tool });
  }
  if (m.content) parts.push({ kind: "text", text: m.content });
  return parts;
}

type AppState = {
  workspace: Workspace | null;
  documents: Document[];
  workspaceFiles: WorkspaceFile[];
  workspaceAssets: WorkspaceAsset[];
  workspaceUploads: WorkspaceUpload[];
  agents: Agent[];
  threads: Thread[];
  activeThreadId: string | null;
  activeDocumentId: string | null;
  editorTarget: EditorTarget;
  setEditorTarget: (target: EditorTarget) => void;
  /** Left sidebar menu: Chats, Agents, Skills, MCP, or Files. */
  sidebarTab: SidebarTab;
  setSidebarTab: (tab: SidebarTab) => void;
  /** When true with sidebarTab "chats", middle panel shows the full chat history list. */
  chatsLibraryOpen: boolean;
  setChatsLibraryOpen: (open: boolean) => void;
  refreshAgents: () => Promise<void>;
  selectWorkspaceAgent: (slug: string) => Promise<void>;
  /** Persist agent on the active thread (and as workspace default for new chats). */
  setThreadAgent: (slug: string) => Promise<void>;
  /** Agent slug for the active thread / draft, with deleted-agent fallback. */
  activeAgentSlug: string;
  fetchAgentDetail: (slug: string) => Promise<AgentDetail | null>;
  createUserAgent: (input: AgentCreateInput) => Promise<AgentDetail | null>;
  updateUserAgent: (
    slug: string,
    patch: AgentUpdateInput
  ) => Promise<AgentDetail | null>;
  /** @deprecated Prefer createUserAgent via the new-agent wizard. */
  createBlankAgent: () => Promise<Agent | null>;
  duplicateAgent: (slug: string) => Promise<Agent | null>;
  deleteUserAgent: (slug: string) => Promise<void>;
  skills: Skill[];
  refreshSkills: () => Promise<void>;
  fetchSkillDetail: (slug: string) => Promise<SkillDetail | null>;
  createUserSkill: (input: SkillCreateInput) => Promise<SkillDetail | null>;
  updateUserSkill: (
    slug: string,
    patch: SkillUpdateInput
  ) => Promise<SkillDetail | null>;
  duplicateSkill: (slug: string) => Promise<Skill | null>;
  deleteUserSkill: (slug: string) => Promise<void>;
  mcpServers: McpServer[];
  refreshMcpServers: () => Promise<void>;
  createMcpServer: (input: McpServerCreateInput) => Promise<McpServer | null>;
  updateMcpServer: (
    id: string,
    patch: McpServerUpdateInput
  ) => Promise<McpServer | null>;
  deleteMcpServer: (id: string) => Promise<void>;
  testMcpServer: (input: McpServerCreateInput & { auth_mode?: string }) => Promise<{
    ok: boolean;
    tool_names: string[];
    error?: string | null;
  }>;
  parseMcpServerRaw: (raw: unknown) => Promise<McpServerDraft[]>;
  setupMcpChat: (
    message: string,
    history: { role: string; content: string }[]
  ) => Promise<{
    reply: string;
    draft?: McpServerDraft | null;
    saved?: McpServer | null;
    tool_names?: string[];
    error?: string | null;
  } | null>;
  messages: ChatMessage[];
  suggestions: Suggestion[];
  models: {
    id: string;
    label: string;
    context_window?: number;
    price_input_per_m?: number | null;
    price_output_per_m?: number | null;
    reasoning?: string | null;
    reasoning_efforts?: string[] | null;
    reasoning_mode?: "efforts" | "toggle" | "none" | string | null;
  }[];
  /** Lifetime token spend for the user (not reduced when threads are deleted). */
  accountSpend: SpendTotals;
  setAccountSpend: Dispatch<SetStateAction<SpendTotals>>;
  loading: boolean;
  /** True while switching conversations (messages + linked document loading). */
  threadLoading: boolean;
  /** Selection from the editor to attach to the next chat message. */
  quotedSelection: QuotedSelection | null;
  setQuotedSelection: (quote: QuotedSelection | null) => void;
  clearQuotedSelection: () => void;
  refreshAll: () => Promise<void>;
  setActiveThread: (id: string) => Promise<void>;
  setActiveDocument: (id: string) => void | Promise<void>;
  updateDocumentContent: (id: string, content_md: string) => Promise<void>;
  updatePersona: (patch: { agent_md?: string; soul_md?: string }) => Promise<void>;
  updateWorkspaceFile: (id: string, content_md: string) => Promise<void>;
  refreshWorkspaceFiles: () => Promise<void>;
  refreshWorkspaceAssets: () => Promise<void>;
  refreshWorkspaceUploads: () => Promise<void>;
  /** Reload document + research files for the active thread (after agent runs). */
  refreshThreadArtifacts: () => Promise<void>;
  createThread: () => Promise<Thread | null>;
  /** Clear the chat UI to a blank draft — no server thread until the first message. */
  startNewChat: () => void;
  /** Register a callback invoked whenever a new chat draft starts (e.g. close document panel). */
  setOnNewChat: (fn: (() => void) | null) => void;
  renameThread: (id: string, title: string) => Promise<void>;
  deleteThread: (id: string) => Promise<void>;
  createDocument: (title?: string) => Promise<void>;
  decideSuggestion: (id: string, action: "accept" | "reject") => Promise<void>;
  acceptAllSuggestions: () => Promise<void>;
  setThreadModel: (model: string) => void;
  /** Model selected on a blank draft chat (before a thread exists). */
  draftModel: string | null;
  /** Last model the user picked — reused for new chats. */
  preferredModel: string | null;
  /** Agent selected on a blank draft chat (before a thread exists). */
  draftAgentSlug: string | null;
  updateThreadUsage: (
    threadId: string,
    usage: NonNullable<Thread["usage"]>
  ) => void;
  appendMessage: (msg: ChatMessage) => void;
  persistMessage: (
    threadId: string,
    msg: {
      role: string;
      content: string;
      tools?: ChatToolPart[];
      parts?: ChatContentPart[];
      reasoning?: string;
      attachments?: ChatMessage["attachments"];
    }
  ) => Promise<ChatMessage>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  refreshSuggestions: () => Promise<void>;
  ingestLiveSuggestion: (value: {
    kind?: string;
    old_text?: string;
    new_text?: string;
    section_heading?: string;
    rationale?: string;
  }) => void;
  /** Agent created a document on demand for this chat. */
  ingestDocumentCreated: (value: {
    id?: string;
    path?: string;
    title?: string;
    content_md?: string;
  }) => void;
  /** Apply auto-accepted AI additions to the active document (no Accept/Reject). */
  applyLiveDocumentContent: (contentMd: string) => void;
  apiUrl: string;
  userId: string;
  /** Deep agent run endpoint prefix (POST /agent/{thread_id}). */
  agentKind: AgentKind;
  /** Absolute path prefix for the AG-UI agent run endpoint. */
  agentRunPath: string;
};

const Ctx = createContext<AppState | null>(null);

function authHeaders(extra?: HeadersInit): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authAccessToken) {
    headers.Authorization = `Bearer ${authAccessToken}`;
  } else if (authUserId) {
    headers["X-User-Id"] = authUserId;
  }
  return { ...headers, ...(extra || {}) };
}

/** Auth headers for fetch calls outside `api()` (uploads, AG-UI, settings). */
export function getAuthHeaders(extra?: HeadersInit): HeadersInit {
  const headers: Record<string, string> = {};
  if (authAccessToken) {
    headers.Authorization = `Bearer ${authAccessToken}`;
  } else if (authUserId) {
    headers["X-User-Id"] = authUserId;
  }
  return { ...headers, ...(extra || {}) };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: authHeaders(init?.headers),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "network error";
    throw new Error(
      `Cannot reach API at ${API_URL}${path} (${detail}). Is the API running on port 8000?`
    );
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  return res.json() as Promise<T>;
}

type ApiMessage = {
  id: string;
  role: string;
  content: string;
  meta?: {
    tools?: ChatToolPart[];
    parts?: ChatContentPart[];
    reasoning?: string;
    attachments?: ChatMessage["attachments"];
  } | null;
  thread_title?: string | null;
};

function mapApiMessage(m: ApiMessage): ChatMessage {
  return {
    id: m.id,
    role: m.role as ChatMessage["role"],
    content: m.content,
    tools: m.meta?.tools,
    parts: m.meta?.parts,
    reasoning: m.meta?.reasoning,
    attachments: m.meta?.attachments,
  };
}

function sortThreadsByRecent(threads: Thread[]): Thread[] {
  return [...threads].sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  );
}

function threadMatchesKind(_thread: Thread, _agentKind: AgentKind): boolean {
  // Kind filtering is currently disabled; keep the signature for call sites.
  void _thread;
  void _agentKind;
  return true;
}

/** Bump a thread to the top as the most recently edited (live sidebar order). */
function touchThread(threads: Thread[], threadId: string, patch?: Partial<Thread>): Thread[] {
  const now = new Date().toISOString();
  const next = threads.map((t) =>
    t.id === threadId ? { ...t, ...patch, updated_at: now } : t
  );
  const idx = next.findIndex((t) => t.id === threadId);
  if (idx <= 0) return next;
  const [item] = next.splice(idx, 1);
  return [item, ...next];
}

export function AppProvider({
  children,
  agentKind = "deep",
}: {
  children: React.ReactNode;
  agentKind?: AgentKind;
}) {
  const { ready: authReady, accessToken, user } = useAuth();
  const { ready: accountReady, status: accountStatus, isAdmin } = useAccountStatus();
  const userId = user?.id ?? "";
  const accountActive =
    isAdmin || accountStatus?.status === "active";
  // Keep API auth headers in sync during render so effects never race ahead of the JWT.
  setApiAuth(accessToken, userId || null);
  const agentRunPath = "/agent";
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([]);
  const [workspaceAssets, setWorkspaceAssets] = useState<WorkspaceAsset[]>([]);
  const [workspaceUploads, setWorkspaceUploads] = useState<WorkspaceUpload[]>(
    []
  );
  const [agents, setAgents] = useState<Agent[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [editorTarget, setEditorTarget] = useState<EditorTarget>({ type: "document" });
  const [sidebarTab, setSidebarTabState] = useState<SidebarTab>(() => readUrlState().tab);
  const [chatsLibraryOpen, setChatsLibraryOpenState] = useState(
    () => readUrlState().chatsLibraryOpen
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [models, setModels] = useState<
    {
      id: string;
      label: string;
      context_window?: number;
      price_input_per_m?: number | null;
      price_output_per_m?: number | null;
      reasoning?: string | null;
      reasoning_efforts?: string[] | null;
      reasoning_mode?: "efforts" | "toggle" | "none" | string | null;
    }[]
  >([]);
  const [accountSpend, setAccountSpend] = useState<SpendTotals>({
    total_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    run_count: 0,
    total_cost_usd: null,
    token_cost_usd: null,
    multimodal_cost_usd: null,
    last_run_tokens: 0,
    spend_budget_usd: 5,
  });
  const [loading, setLoading] = useState(true);
  const [threadLoading, setThreadLoading] = useState(false);
  const [quotedSelection, setQuotedSelectionState] = useState<QuotedSelection | null>(
    null
  );
  /** Model chosen while on a blank draft (no thread yet). */
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [preferredModel, setPreferredModel] = useState<string | null>(null);
  /** Agent chosen while on a blank draft (no thread yet). */
  const [draftAgentSlug, setDraftAgentSlug] = useState<string | null>(null);

  // Keep refs in sync so long-running send()/stream handlers never see a stale id
  // (e.g. new chat starts with null, then createThread assigns a document).
  const activeDocumentIdRef = useRef<string | null>(null);
  const activeThreadIdRef = useRef<string | null>(null);
  const workspaceRef = useRef<Workspace | null>(null);
  activeDocumentIdRef.current = activeDocumentId;
  activeThreadIdRef.current = activeThreadId;
  workspaceRef.current = workspace;
  /** After first bootstrap, never flash the full-page loader (it unmounts chat mid-stream). */
  const hasBootstrappedRef = useRef(false);
  const bootstrappedUserIdRef = useRef<string | null>(null);
  const bootstrappedAgentKindRef = useRef(agentKind);

  const setQuotedSelection = useCallback((quote: QuotedSelection | null) => {
    setQuotedSelectionState(quote);
  }, []);

  const clearQuotedSelection = useCallback(() => {
    setQuotedSelectionState(null);
  }, []);

  const onNewChatRef = useRef<(() => void) | null>(null);
  const setOnNewChat = useCallback((fn: (() => void) | null) => {
    onNewChatRef.current = fn;
  }, []);

  const setSidebarTab = useCallback((tab: SidebarTab) => {
    setSidebarTabState(tab);
    if (tab !== "chats") {
      setChatsLibraryOpenState(false);
    }
  }, []);

  const setChatsLibraryOpen = useCallback((open: boolean) => {
    setChatsLibraryOpenState(open);
    if (open) setSidebarTabState("chats");
  }, []);

  const refreshSuggestions = useCallback(async () => {
    const docId = activeDocumentIdRef.current;
    if (!docId) {
      setSuggestions([]);
      return;
    }
    try {
      const rows = await api<Suggestion[]>(`/documents/${docId}/suggestions`);
      setSuggestions(rows);
    } catch (err) {
      console.error("Failed to refresh suggestions:", err);
    }
  }, []);

  const refreshWorkspaceFiles = useCallback(async () => {
    if (!workspace) {
      setWorkspaceFiles([]);
      return;
    }
    try {
      const rows = await api<WorkspaceFile[]>(`/api/workspaces/${workspace.id}/files`);
      setWorkspaceFiles(rows);
    } catch (err) {
      console.error("Failed to refresh workspace files:", err);
    }
  }, [workspace]);

  const refreshWorkspaceAssets = useCallback(async () => {
    if (!workspace) {
      setWorkspaceAssets([]);
      return;
    }
    try {
      const rows = await api<WorkspaceAsset[]>(
        `/api/workspaces/${workspace.id}/assets`
      );
      setWorkspaceAssets(rows);
    } catch (err) {
      console.error("Failed to refresh workspace assets:", err);
    }
  }, [workspace]);

  const refreshWorkspaceUploads = useCallback(async () => {
    if (!workspace) {
      setWorkspaceUploads([]);
      return;
    }
    try {
      const rows = await api<WorkspaceUpload[]>(
        `/api/workspaces/${workspace.id}/uploads`
      );
      setWorkspaceUploads(rows);
    } catch (err) {
      console.error("Failed to refresh workspace uploads:", err);
    }
  }, [workspace]);

  const refreshActiveDocument = useCallback(async () => {
    const docId = activeDocumentIdRef.current;
    if (!docId) return;
    try {
      const doc = await api<Document>(`/api/documents/${docId}`);
      setDocuments((prev) => {
        const exists = prev.some((d) => d.id === doc.id);
        if (!exists) return [...prev, doc];
        // Don't clobber a richer live apply with a shorter stale server snapshot
        // (can race if refresh runs before persist finishes).
        return prev.map((d) => {
          if (d.id !== doc.id) return d;
          const local = d.content_md || "";
          const remote = doc.content_md || "";
          if (local.length > remote.length + 20) {
            return d;
          }
          return doc;
        });
      });
    } catch (err) {
      console.error("Failed to refresh active document:", err);
    }
  }, []);

  /** Reload document + workspace files for the artifacts panel after an agent run. */
  const refreshThreadArtifacts = useCallback(async () => {
    const ws = workspaceRef.current;
    const threadId = activeThreadIdRef.current;
    const reloadDocsAndThread = async () => {
      if (!ws) return;
      try {
        const docs = await api<Document[]>(`/api/workspaces/${ws.id}/documents`);
        setDocuments(docs);
        if (threadId) {
          const ths = await api<Thread[]>(`/api/workspaces/${ws.id}/threads`);
          const live = ths.find((t) => t.id === threadId);
          if (live) {
            setThreads((prev) =>
              prev.map((t) =>
                t.id === live.id
                  ? {
                      ...t,
                      active_document_id: live.active_document_id,
                      title: live.title,
                      model: live.model,
                      updated_at: live.updated_at,
                    }
                  : t
              )
            );
            if (live.active_document_id) {
              setActiveDocumentId(live.active_document_id);
            }
          }
        }
      } catch (err) {
        console.error("Failed to refresh documents/thread:", err);
      }
    };
    await Promise.all([
      reloadDocsAndThread(),
      refreshWorkspaceFiles(),
      refreshWorkspaceAssets(),
      refreshWorkspaceUploads(),
      refreshActiveDocument(),
      refreshSuggestions(),
    ]);
  }, [
    refreshWorkspaceFiles,
    refreshWorkspaceAssets,
    refreshWorkspaceUploads,
    refreshActiveDocument,
    refreshSuggestions,
  ]);

  /** Agent created an empty document on demand — wire it into the open chat. */
  const ingestDocumentCreated = useCallback(
    (value: {
      id?: string;
      path?: string;
      title?: string;
      content_md?: string;
    }) => {
      const id = (value.id || "").trim();
      if (!id) return;
      const wsId = workspaceRef.current?.id || "";
      const row: Document = {
        id,
        workspace_id: wsId,
        path: value.path || `document-${id.slice(0, 8)}.md`,
        title: value.title || "Document",
        content_md: value.content_md || "",
        updated_at: new Date().toISOString(),
      };
      setDocuments((prev) =>
        prev.some((d) => d.id === row.id) ? prev : [...prev, row]
      );
      setActiveDocumentId(row.id);
      setEditorTarget({ type: "document" });
      const tid = activeThreadIdRef.current;
      if (tid) {
        setThreads((prev) =>
          prev.map((t) =>
            t.id === tid ? { ...t, active_document_id: row.id } : t
          )
        );
      }
    },
    []
  );

  const ingestLiveSuggestion = useCallback(
    (value: {
      kind?: string;
      old_text?: string;
      new_text?: string;
      section_heading?: string;
      rationale?: string;
    }) => {
      const docId = activeDocumentIdRef.current;
      if (!docId) return;
      const kind = value.kind || "patch";
      const optimistic: Suggestion = {
        id: `live-${crypto.randomUUID()}`,
        document_id: docId,
        kind,
        old_text: value.old_text || "",
        new_text: value.new_text || "",
        section_heading: value.section_heading || null,
        status: "pending",
      };
      setSuggestions((prev) => {
        // Same section rewrite supersedes older pending ones (avoid stacked reviews).
        const heading = (optimistic.section_heading || "").trim().toLowerCase();
        let next = prev;
        if (kind === "section" && heading) {
          next = prev.filter(
            (s) =>
              !(
                s.status === "pending" &&
                s.kind === "section" &&
                (s.section_heading || "").trim().toLowerCase() === heading
              )
          );
        }
        // Dedupe identical pending payloads while streaming
        const dup = next.some(
          (s) =>
            s.status === "pending" &&
            s.kind === optimistic.kind &&
            s.old_text === optimistic.old_text &&
            s.new_text === optimistic.new_text &&
            s.section_heading === optimistic.section_heading
        );
        if (dup) return next;
        return [...next, optimistic];
      });
    },
    []
  );

  const applyLiveDocumentContent = useCallback((contentMd: string) => {
    const docId = activeDocumentIdRef.current;
    if (!docId) return;
    setDocuments((prev) =>
      prev.map((d) => (d.id === docId ? { ...d, content_md: contentMd } : d))
    );
  }, []);

  const refreshAll = useCallback(async () => {
    // Full-page "Loading workspace…" unmounts ChatPane and kills live stream UI.
    // Only show it on the first bootstrap (or after sign-out).
    const showFullLoader = !hasBootstrappedRef.current;
    if (showFullLoader) setLoading(true);
    try {
      const modelList = await api<
        {
          id: string;
          label: string;
          context_window?: number;
          price_input_per_m?: number | null;
          price_output_per_m?: number | null;
          reasoning?: string | null;
          reasoning_efforts?: string[] | null;
          reasoning_mode?: "efforts" | "toggle" | "none" | string | null;
        }[]
      >("/api/models");
      setModels(modelList);
      const enabledIds = new Set(modelList.map((m) => m.id));
      const fallbackModel = modelList[0]?.id || null;

      try {
        const settings = await api<{
          spend_totals?: SpendTotals;
          spend_budget_usd?: number | null;
          preferred_model?: string | null;
        }>("/api/settings");
        const preferred = settings.preferred_model || null;
        if (preferred && enabledIds.has(preferred)) {
          setPreferredModel(preferred);
        } else if (fallbackModel) {
          // Old preferred (e.g. GLM Base) no longer enabled — snap to current Base.
          setPreferredModel(fallbackModel);
          if (preferred && preferred !== fallbackModel) {
            void api("/api/settings", {
              method: "PATCH",
              body: JSON.stringify({ preferred_model: fallbackModel }),
            }).catch(() => {});
          }
        }
        if (settings.spend_totals || settings.spend_budget_usd != null) {
          setAccountSpend({
            total_tokens: settings.spend_totals?.total_tokens ?? 0,
            input_tokens: settings.spend_totals?.input_tokens ?? 0,
            output_tokens: settings.spend_totals?.output_tokens ?? 0,
            run_count: settings.spend_totals?.run_count ?? 0,
            total_cost_usd: settings.spend_totals?.total_cost_usd ?? null,
            token_cost_usd: settings.spend_totals?.token_cost_usd ?? null,
            multimodal_cost_usd:
              settings.spend_totals?.multimodal_cost_usd ?? null,
            last_run_tokens: settings.spend_totals?.last_run_tokens ?? 0,
            spend_budget_usd: settings.spend_budget_usd ?? 5,
          });
        }
      } catch (err) {
        console.error("Failed to load spend totals:", err);
      }

      try {
        const packList = await api<Agent[]>("/api/agents");
        setAgents(packList);
      } catch (err) {
        console.error("Failed to load agents:", err);
        setAgents([]);
      }

      try {
        const skillList = await api<Skill[]>("/api/skills");
        setSkills(skillList);
      } catch (err) {
        console.error("Failed to load skills:", err);
        setSkills([]);
      }

      try {
        const mcpList = await api<McpServer[]>("/api/mcp-servers");
        setMcpServers(mcpList);
      } catch (err) {
        console.error("Failed to load MCP servers:", err);
        setMcpServers([]);
      }

      let workspaces = await api<Workspace[]>("/api/workspaces");
      if (workspaces.length === 0) {
        const created = await api<Workspace>("/api/workspaces", {
          method: "POST",
          body: JSON.stringify({ name: "My workspace" }),
        });
        workspaces = [created];
      }
      const ws = workspaces[0];
      setWorkspace(normalizeWorkspace(ws));

      const docs = await api<Document[]>(`/api/workspaces/${ws.id}/documents`);
      const ths = await api<Thread[]>(`/api/workspaces/${ws.id}/threads`);
      setDocuments(docs);
      setThreads(
        sortThreadsByRecent(ths.filter((t) => threadMatchesKind(t, agentKind)))
      );
      try {
        const files = await api<WorkspaceFile[]>(`/api/workspaces/${ws.id}/files`);
        setWorkspaceFiles(files);
      } catch (err) {
        console.error("Failed to load workspace files:", err);
        setWorkspaceFiles([]);
      }
      try {
        const assets = await api<WorkspaceAsset[]>(`/api/workspaces/${ws.id}/assets`);
        setWorkspaceAssets(assets);
      } catch (err) {
        console.error("Failed to load workspace assets:", err);
        setWorkspaceAssets([]);
      }
      try {
        const uploads = await api<WorkspaceUpload[]>(
          `/api/workspaces/${ws.id}/uploads`
        );
        setWorkspaceUploads(uploads);
      } catch (err) {
        console.error("Failed to load workspace uploads:", err);
        setWorkspaceUploads([]);
      }

      const {
        threadId: urlThreadId,
        tab: urlTab,
        chatsLibraryOpen: urlChatsLibrary,
      } = readUrlState();
      setSidebarTabState(urlTab);
      setChatsLibraryOpenState(urlChatsLibrary);

      const kindThreads = ths.filter((t) => threadMatchesKind(t, agentKind));
      // No ?thread= means a blank new-chat draft — do not auto-open the latest thread.
      // If ?thread= is present but missing (deleted / wrong kind), fall back to latest.
      const thread = urlThreadId
        ? (kindThreads.find((t) => t.id === urlThreadId) ?? kindThreads[0])
        : undefined;
      // Only load the thread's linked doc — never fall back to another document.
      const docId = thread?.active_document_id ?? null;
      setActiveThreadId(thread?.id ?? null);
      setActiveDocumentId(docId);
      setEditorTarget({ type: "document" });
      if (!docId) setSuggestions([]);

      if (thread) {
        const msgs = await api<ApiMessage[]>(`/api/threads/${thread.id}/messages`);
        setMessages(msgs.map(mapApiMessage));
      } else {
        setMessages([]);
      }
      if (docId) {
        try {
          const doc = await api<Document>(`/api/documents/${docId}`);
          setDocuments((prev) => {
            const exists = prev.some((d) => d.id === doc.id);
            return exists ? prev.map((d) => (d.id === doc.id ? doc : d)) : [...prev, doc];
          });
          const rows = await api<Suggestion[]>(`/documents/${docId}/suggestions`);
          setSuggestions(rows);
        } catch (err) {
          console.error("Failed to load document for initial thread:", err);
        }
      }
      hasBootstrappedRef.current = true;
      bootstrappedUserIdRef.current = userId || null;
      bootstrappedAgentKindRef.current = agentKind;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Expected when account is not yet approved — AccountGate handles UX.
      if (!msg.includes("account_not_active")) {
        console.error("Failed to load app data from API:", err);
      }
    } finally {
      setLoading(false);
    }
  }, [agentKind, userId]);

  useEffect(() => {
    if (!authReady) return;
    if (!userId) {
      // Signed out — allow a full loader on the next sign-in.
      hasBootstrappedRef.current = false;
      bootstrappedUserIdRef.current = null;
      setLoading(false);
      return;
    }
    // Pending / rejected / disabled accounts cannot call require_active_user APIs.
    if (!accountReady || !accountActive) {
      setLoading(false);
      return;
    }
    // JWT refresh changes accessToken but not userId. Re-bootstrap only when the
    // signed-in user or agent kind changes — otherwise the full-page loader
    // unmounts ChatPane and live streaming state is lost.
    // Auth headers are already updated each render via setApiAuth(accessToken, …).
    if (
      hasBootstrappedRef.current &&
      bootstrappedUserIdRef.current === userId &&
      bootstrappedAgentKindRef.current === agentKind
    ) {
      return;
    }
    void refreshAll();
  }, [authReady, accountReady, accountActive, userId, agentKind, refreshAll]);

  // Keep thread + sidebar menu in the URL so refresh restores the same place.
  useEffect(() => {
    if (loading) return;
    writeUrlState(activeThreadId, sidebarTab, chatsLibraryOpen);
  }, [activeThreadId, sidebarTab, chatsLibraryOpen, loading]);

  useEffect(() => {
    void refreshSuggestions();
  }, [refreshSuggestions]);

  const loadDocumentForThread = useCallback(async (docId: string | null | undefined) => {
    if (!docId) {
      activeDocumentIdRef.current = null;
      setActiveDocumentId(null);
      setSuggestions([]);
      return;
    }
    activeDocumentIdRef.current = docId;
    setActiveDocumentId(docId);
    try {
      const doc = await api<Document>(`/api/documents/${docId}`);
      setDocuments((prev) => {
        const exists = prev.some((d) => d.id === doc.id);
        return exists ? prev.map((d) => (d.id === doc.id ? doc : d)) : [...prev, doc];
      });
      const rows = await api<Suggestion[]>(`/documents/${docId}/suggestions`);
      setSuggestions(rows);
    } catch (err) {
      console.error("Failed to refresh document for thread:", err);
    }
  }, []);

  const setActiveThread = useCallback(
    async (id: string) => {
      setChatsLibraryOpenState(false);
      setSidebarTabState("chats");
      if (activeThreadIdRef.current === id) return;

      activeThreadIdRef.current = id;
      setActiveThreadId(id);
      setThreadLoading(true);
      setMessages([]);
      setDraftModel(null);
      setDraftAgentSlug(null);
      setQuotedSelectionState(null);
      setEditorTarget({ type: "document" });
      const thread = threads.find((t) => t.id === id);
      const docId = thread?.active_document_id ?? null;
      // Switch document immediately so the previous chat's content doesn't linger.
      // No linked doc → clear the editor (do not keep showing another thread's document).
      activeDocumentIdRef.current = docId;
      setActiveDocumentId(docId);
      if (!docId) setSuggestions([]);

      // If this chat's agent was deleted, fall back to Auto Agent and persist.
      if (thread && agents.length > 0) {
        const storedSlug = thread.agent_slug || DEFAULT_AGENT_SLUG;
        const resolvedSlug = resolveThreadAgentSlug(storedSlug, agents);
        if (resolvedSlug !== storedSlug) {
          setThreads((prev) =>
            prev.map((t) =>
              t.id === id ? { ...t, agent_slug: resolvedSlug } : t
            )
          );
          void api(`/api/threads/${id}`, {
            method: "PATCH",
            body: JSON.stringify({ agent_slug: resolvedSlug }),
          }).catch((err) =>
            console.error("Failed to reset missing thread agent:", err)
          );
        }
      }

      try {
        const msgsPromise = api<ApiMessage[]>(`/api/threads/${id}/messages`);
        await loadDocumentForThread(docId);
        const msgs = await msgsPromise;
        if (activeThreadIdRef.current !== id) return;
        setMessages(msgs.map(mapApiMessage));
      } finally {
        if (activeThreadIdRef.current === id) {
          setThreadLoading(false);
        }
      }
    },
    [threads, agents, loadDocumentForThread]
  );

  // Heal active thread after agents load (or after a delete) if its agent is gone.
  useEffect(() => {
    if (!activeThreadId || agents.length === 0) return;
    const thread = threads.find((t) => t.id === activeThreadId);
    if (!thread) return;
    const stored = thread.agent_slug || DEFAULT_AGENT_SLUG;
    const resolved = resolveThreadAgentSlug(stored, agents);
    if (resolved === stored) return;
    setThreads((prev) =>
      prev.map((t) =>
        t.id === activeThreadId ? { ...t, agent_slug: resolved } : t
      )
    );
    void api(`/api/threads/${activeThreadId}`, {
      method: "PATCH",
      body: JSON.stringify({ agent_slug: resolved }),
    }).catch((err) =>
      console.error("Failed to reset missing thread agent:", err)
    );
  }, [agents, activeThreadId, threads]);

  const updateDocumentContent = useCallback(async (id: string, content_md: string) => {
    const updated = await api<Document>(`/api/documents/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ content_md }),
    });
    setDocuments((prev) => prev.map((d) => (d.id === id ? updated : d)));
    const rows = await api<Suggestion[]>(`/documents/${id}/suggestions`);
    setSuggestions(rows);
  }, []);

  const startNewChat = useCallback(() => {
    onNewChatRef.current?.();
    activeThreadIdRef.current = null;
    activeDocumentIdRef.current = null;
    setChatsLibraryOpenState(false);
    setSidebarTabState("chats");
    setActiveThreadId(null);
    setThreadLoading(false);
    setMessages([]);
    setQuotedSelectionState(null);
    setActiveDocumentId(null);
    setSuggestions([]);
    setEditorTarget({ type: "document" });
  }, []);

  const createThread = useCallback(async (): Promise<Thread | null> => {
    if (!workspace) return null;
    const enabledIds = new Set(models.map((m) => m.id));
    const model =
      (draftModel && enabledIds.has(draftModel) && draftModel) ||
      (preferredModel && enabledIds.has(preferredModel) && preferredModel) ||
      models[0]?.id ||
      "";
    if (!model) return null;
    const agentSlug = resolveThreadAgentSlug(
      draftAgentSlug || workspace.agent_slug,
      agents
    );
    // New chats start without a document; one is created when needed.
    const thread = await api<Thread>(`/api/workspaces/${workspace.id}/threads`, {
      method: "POST",
      body: JSON.stringify({
        title: "New chat",
        model,
        agent_slug: agentSlug,
        agent_kind: agentKind,
      }),
    });
    setThreads((prev) => {
      const fresh = { ...thread, updated_at: new Date().toISOString() };
      return [fresh, ...prev.filter((t) => t.id !== thread.id)];
    });
    activeThreadIdRef.current = thread.id;
    setActiveThreadId(thread.id);
    setQuotedSelectionState(null);
    setDraftModel(null);
    setDraftAgentSlug(null);
    setPreferredModel(model);
    setEditorTarget({ type: "document" });
    // Same path as setActiveThread so Artifacts picks up the new document immediately.
    await loadDocumentForThread(thread.active_document_id);
    return thread;
  }, [
    workspace,
    draftModel,
    preferredModel,
    draftAgentSlug,
    agents,
    models,
    loadDocumentForThread,
    agentKind,
  ]);

  const renameThread = useCallback(async (id: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    const updated = await api<Thread>(`/api/threads/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: trimmed.slice(0, 60) }),
    });
    setThreads((prev) => touchThread(prev, id, { title: updated.title }));
  }, []);

  const deleteThread = useCallback(
    async (id: string) => {
      const thread = threads.find((t) => t.id === id);
      const result = await api<{ ok: boolean; deleted_document_id: string | null }>(
        `/api/threads/${id}`,
        { method: "DELETE" }
      );

      const remaining = threads.filter((t) => t.id !== id);
      setThreads(remaining);

      if (result.deleted_document_id) {
        setDocuments((prev) => prev.filter((d) => d.id !== result.deleted_document_id));
      }

      if (activeThreadId === id) {
        if (remaining.length > 0) {
          await setActiveThread(remaining[0].id);
        } else {
          // Last chat removed — show a blank draft (create on first send).
          startNewChat();
        }
      } else if (
        thread?.active_document_id &&
        result.deleted_document_id === activeDocumentId
      ) {
        setActiveDocumentId(null);
        setSuggestions([]);
      }
    },
    [threads, activeThreadId, activeDocumentId, setActiveThread, startNewChat]
  );

  const createDocument = useCallback(
    async (title = "Document") => {
      if (!workspace) return;
      const doc = await api<Document>(`/api/workspaces/${workspace.id}/documents`, {
        method: "POST",
        body: JSON.stringify({
          title,
          path: `${title.toLowerCase().replace(/\s+/g, "-")}-${Date.now().toString(36)}.md`,
          use_default_template: false,
          content_md: "",
        }),
      });
      setDocuments((prev) => [...prev, doc]);
      setActiveDocumentId(doc.id);
      setEditorTarget({ type: "document" });
      if (activeThreadId) {
        const updated = await api<Thread>(`/api/threads/${activeThreadId}`, {
          method: "PATCH",
          body: JSON.stringify({ active_document_id: doc.id }),
        });
        setThreads((prev) =>
          prev.map((t) =>
            t.id === updated.id
              ? { ...t, active_document_id: updated.active_document_id, title: updated.title, model: updated.model }
              : t
          )
        );
      }
    },
    [workspace, activeThreadId]
  );

  const setActiveDocument = useCallback(
    async (id: string) => {
      setActiveDocumentId(id);
      setEditorTarget({ type: "document" });
      setQuotedSelectionState(null);
      await loadDocumentForThread(id);
      if (activeThreadId) {
        try {
          const updated = await api<Thread>(`/api/threads/${activeThreadId}`, {
            method: "PATCH",
            body: JSON.stringify({ active_document_id: id }),
          });
          setThreads((prev) =>
            prev.map((t) =>
              t.id === updated.id
                ? {
                    ...t,
                    active_document_id: updated.active_document_id,
                    title: updated.title,
                    model: updated.model,
                  }
                : t
            )
          );
        } catch (err) {
          console.error("Failed to link document to thread:", err);
        }
      }
    },
    [activeThreadId, loadDocumentForThread]
  );

  const updatePersona = useCallback(
    async (patch: { agent_md?: string; soul_md?: string }) => {
      if (!workspace) return;
      const updated = await api<Workspace>(`/api/workspaces/${workspace.id}/persona`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      setWorkspace(normalizeWorkspace(updated));
    },
    [workspace]
  );

  const updateWorkspaceFile = useCallback(
    async (id: string, content_md: string) => {
      if (!workspace) return;
      const updated = await api<WorkspaceFile>(
        `/api/workspaces/${workspace.id}/files/${id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ content_md }),
        }
      );
      setWorkspaceFiles((prev) => prev.map((f) => (f.id === id ? updated : f)));
    },
    [workspace]
  );

  const decideSuggestion = useCallback(
    async (id: string, action: "accept" | "reject") => {
      if (id.startsWith("live-")) {
        // Optimistic stream ids — wait for end-of-run refresh before deciding.
        return;
      }
      await api(`/suggestions/${id}/decide`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      if (activeDocumentId) {
        const doc = await api<Document>(`/api/documents/${activeDocumentId}`);
        setDocuments((prev) => prev.map((d) => (d.id === doc.id ? doc : d)));
        await refreshSuggestions();
      }
    },
    [activeDocumentId, refreshSuggestions]
  );

  const acceptAllSuggestions = useCallback(async () => {
    if (!activeDocumentId) return;
    await api(`/documents/${activeDocumentId}/suggestions/accept-all`, { method: "POST" });
    const doc = await api<Document>(`/api/documents/${activeDocumentId}`);
    setDocuments((prev) => prev.map((d) => (d.id === doc.id ? doc : d)));
    await refreshSuggestions();
  }, [activeDocumentId, refreshSuggestions]);

  const setThreadModel = useCallback(
    (model: string) => {
      setPreferredModel(model);
      // Remember across new chats / reloads.
      void api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ preferred_model: model }),
      }).catch((err) => console.error("Failed to save preferred model:", err));

      if (!activeThreadId) {
        setDraftModel(model);
        return;
      }
      setThreads((prev) =>
        prev.map((t) => (t.id === activeThreadId ? { ...t, model } : t))
      );
      void api(`/api/threads/${activeThreadId}`, {
        method: "PATCH",
        body: JSON.stringify({ model }),
      }).catch((err) => console.error("Failed to update thread model:", err));
    },
    [activeThreadId]
  );

  const updateThreadUsage = useCallback(
    (threadId: string, usage: NonNullable<Thread["usage"]>) => {
      setThreads((prev) =>
        prev.map((t) => {
          if (t.id !== threadId) return t;
          return {
            ...t,
            usage: {
              ...(t.usage || {}),
              ...usage,
              // Keep prior asset_paths unless this patch explicitly sets them.
              asset_paths: usage.asset_paths ?? t.usage?.asset_paths,
            },
          };
        })
      );
    },
    []
  );

  const refreshAgents = useCallback(async () => {
    try {
      const packList = await api<Agent[]>("/api/agents");
      setAgents(packList);
    } catch (err) {
      console.error("Failed to load agents:", err);
    }
  }, []);

  const selectWorkspaceAgent = useCallback(async (slug: string) => {
    const ws = workspaceRef.current;
    if (!ws) {
      throw new Error("Workspace is not loaded yet — cannot select an agent.");
    }
    const updated = await api<Workspace>(`/api/workspaces/${ws.id}`, {
      method: "PATCH",
      body: JSON.stringify({ agent_slug: slug }),
    });
    setWorkspace(normalizeWorkspace(updated));
    if (updated.uses_document) {
      const docs = await api<Document[]>(`/api/workspaces/${ws.id}/documents`);
      setDocuments(docs);
    }
  }, []);

  /** Persist workspace default for new chats — no document reload side effects. */
  const rememberPreferredAgent = useCallback(async (slug: string) => {
    const ws = workspaceRef.current;
    if (!ws) return;
    try {
      const updated = await api<Workspace>(`/api/workspaces/${ws.id}`, {
        method: "PATCH",
        body: JSON.stringify({ agent_slug: slug }),
      });
      setWorkspace(normalizeWorkspace(updated));
    } catch (err) {
      console.error("Failed to save preferred agent:", err);
    }
  }, []);

  const setThreadAgent = useCallback(
    async (slug: string) => {
      const resolved = resolveThreadAgentSlug(slug, agents);
      // Capture before any await — switching chats mid-request must not lose the id.
      const threadId = activeThreadIdRef.current;

      if (!threadId) {
        // Blank draft: remember for the upcoming new chat only.
        setDraftAgentSlug(resolved);
        await rememberPreferredAgent(resolved);
        return;
      }

      setDraftAgentSlug(null);
      // Optimistic per-thread update so the picker switches immediately.
      setThreads((prev) =>
        prev.map((t) => (t.id === threadId ? { ...t, agent_slug: resolved } : t))
      );

      try {
        const updated = await api<Thread>(`/api/threads/${threadId}`, {
          method: "PATCH",
          body: JSON.stringify({ agent_slug: resolved }),
        });
        const saved = updated.agent_slug || resolved;
        setThreads((prev) =>
          prev.map((t) => (t.id === threadId ? { ...t, agent_slug: saved } : t))
        );
        // Preferred for *new* chats only — must not drive the open thread's picker.
        void rememberPreferredAgent(saved);
      } catch (err) {
        console.error("Failed to update thread agent:", err);
        throw err;
      }
    },
    [agents, rememberPreferredAgent]
  );

  const activeAgentSlug = useMemo(() => {
    // Open thread → always that thread's stored agent (never workspace "latest").
    if (activeThreadId) {
      const thread = threads.find((t) => t.id === activeThreadId);
      return resolveThreadAgentSlug(
        thread?.agent_slug ?? DEFAULT_AGENT_SLUG,
        agents
      );
    }
    // Draft chat → draft pick, else workspace default for new chats.
    return resolveThreadAgentSlug(
      draftAgentSlug || workspace?.agent_slug || DEFAULT_AGENT_SLUG,
      agents
    );
  }, [
    activeThreadId,
    threads,
    agents,
    draftAgentSlug,
    workspace?.agent_slug,
  ]);

  const fetchAgentDetail = useCallback(
    async (slug: string): Promise<AgentDetail | null> => {
      try {
        return await api<AgentDetail>(`/api/agents/${encodeURIComponent(slug)}`);
      } catch (err) {
        console.error("Failed to load agent:", err);
        return null;
      }
    },
    []
  );

  const createUserAgent = useCallback(
    async (input: AgentCreateInput): Promise<AgentDetail | null> => {
      try {
        const created = await api<AgentDetail>("/api/agents", {
          method: "POST",
          body: JSON.stringify({
            name: input.name,
            description: input.description ?? "",
            icon: input.icon ?? "",
            uses_document: input.uses_document ?? false,
            agent_md: input.agent_md ?? "",
            soul_md: input.soul_md ?? "",
            system_prompt: input.system_prompt ?? "",
            document_template_md: input.document_template_md ?? "",
            skills: input.skills ?? [],
            predefined_skill_slugs: input.predefined_skill_slugs ?? [],
            mcp_server_ids: input.mcp_server_ids ?? [],
            ...(input.slug ? { slug: input.slug } : {}),
          }),
        });
        await refreshAgents();
        return created;
      } catch (err) {
        console.error("Failed to create agent:", err);
        return null;
      }
    },
    [refreshAgents]
  );

  const updateUserAgent = useCallback(
    async (
      slug: string,
      patch: AgentUpdateInput
    ): Promise<AgentDetail | null> => {
      try {
        const updated = await api<AgentDetail>(
          `/api/agents/${encodeURIComponent(slug)}`,
          {
            method: "PATCH",
            body: JSON.stringify(patch),
          }
        );
        await refreshAgents();
        return updated;
      } catch (err) {
        console.error("Failed to update agent:", err);
        return null;
      }
    },
    [refreshAgents]
  );

  const createBlankAgent = useCallback(async (): Promise<Agent | null> => {
    return createUserAgent({
      name: "Untitled agent",
      description: "",
      uses_document: false,
      agent_md: "# Untitled agent\n\nYou help the user with their workflow.\n",
    });
  }, [createUserAgent]);

  const duplicateAgent = useCallback(
    async (slug: string): Promise<Agent | null> => {
      try {
        const created = await api<Agent>(`/api/agents/${slug}/duplicate`, {
          method: "POST",
        });
        await refreshAgents();
        return created;
      } catch (err) {
        console.error("Failed to duplicate agent:", err);
        return null;
      }
    },
    [refreshAgents]
  );

  const deleteUserAgent = useCallback(
    async (slug: string) => {
      await api(`/api/agents/${slug}`, { method: "DELETE" });
      await refreshAgents();
      // Threads that pointed at the deleted agent fall back to Auto Agent.
      const affected = threads.filter((t) => t.agent_slug === slug);
      if (affected.length > 0) {
        setThreads((prev) =>
          prev.map((t) =>
            t.agent_slug === slug ? { ...t, agent_slug: DEFAULT_AGENT_SLUG } : t
          )
        );
        await Promise.all(
          affected.map((t) =>
            api(`/api/threads/${t.id}`, {
              method: "PATCH",
              body: JSON.stringify({ agent_slug: DEFAULT_AGENT_SLUG }),
            }).catch((err) =>
              console.error("Failed to reset thread agent after delete:", err)
            )
          )
        );
      }
      if (draftAgentSlug === slug) {
        setDraftAgentSlug(DEFAULT_AGENT_SLUG);
      }
      if (workspace?.agent_slug === slug) {
        await selectWorkspaceAgent(DEFAULT_AGENT_SLUG);
      }
    },
    [
      refreshAgents,
      selectWorkspaceAgent,
      workspace?.agent_slug,
      threads,
      draftAgentSlug,
    ]
  );

  const refreshSkills = useCallback(async () => {
    try {
      const skillList = await api<Skill[]>("/api/skills");
      setSkills(skillList);
    } catch (err) {
      console.error("Failed to load skills:", err);
    }
  }, []);

  const fetchSkillDetail = useCallback(
    async (slug: string): Promise<SkillDetail | null> => {
      try {
        return await api<SkillDetail>(`/api/skills/${encodeURIComponent(slug)}`);
      } catch (err) {
        console.error("Failed to load skill:", err);
        return null;
      }
    },
    []
  );

  const createUserSkill = useCallback(
    async (input: SkillCreateInput): Promise<SkillDetail | null> => {
      try {
        const created = await api<SkillDetail>("/api/skills", {
          method: "POST",
          body: JSON.stringify(input),
        });
        await refreshSkills();
        return created;
      } catch (err) {
        console.error("Failed to create skill:", err);
        return null;
      }
    },
    [refreshSkills]
  );

  const updateUserSkill = useCallback(
    async (
      slug: string,
      patch: SkillUpdateInput
    ): Promise<SkillDetail | null> => {
      try {
        const updated = await api<SkillDetail>(
          `/api/skills/${encodeURIComponent(slug)}`,
          {
            method: "PATCH",
            body: JSON.stringify(patch),
          }
        );
        await refreshSkills();
        return updated;
      } catch (err) {
        console.error("Failed to update skill:", err);
        return null;
      }
    },
    [refreshSkills]
  );

  const duplicateSkill = useCallback(
    async (slug: string): Promise<Skill | null> => {
      try {
        const created = await api<Skill>(`/api/skills/${slug}/duplicate`, {
          method: "POST",
        });
        await refreshSkills();
        return created;
      } catch (err) {
        console.error("Failed to duplicate skill:", err);
        return null;
      }
    },
    [refreshSkills]
  );

  const deleteUserSkill = useCallback(
    async (slug: string) => {
      await api(`/api/skills/${slug}`, { method: "DELETE" });
      await refreshSkills();
      // Agents may have dropped this slug from predefined_skill_slugs.
      await refreshAgents();
    },
    [refreshSkills, refreshAgents]
  );

  const refreshMcpServers = useCallback(async () => {
    try {
      const mcpList = await api<McpServer[]>("/api/mcp-servers");
      setMcpServers(mcpList);
    } catch (err) {
      console.error("Failed to load MCP servers:", err);
    }
  }, []);

  const createMcpServer = useCallback(
    async (input: McpServerCreateInput): Promise<McpServer | null> => {
      try {
        const created = await api<McpServer>("/api/mcp-servers", {
          method: "POST",
          body: JSON.stringify(input),
        });
        await refreshMcpServers();
        return created;
      } catch (err) {
        console.error("Failed to create MCP server:", err);
        throw err;
      }
    },
    [refreshMcpServers]
  );

  const updateMcpServer = useCallback(
    async (
      id: string,
      patch: McpServerUpdateInput
    ): Promise<McpServer | null> => {
      try {
        const updated = await api<McpServer>(
          `/api/mcp-servers/${encodeURIComponent(id)}`,
          {
            method: "PATCH",
            body: JSON.stringify(patch),
          }
        );
        await refreshMcpServers();
        return updated;
      } catch (err) {
        console.error("Failed to update MCP server:", err);
        throw err;
      }
    },
    [refreshMcpServers]
  );

  const deleteMcpServer = useCallback(
    async (id: string) => {
      await api(`/api/mcp-servers/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      await refreshMcpServers();
      await refreshAgents();
    },
    [refreshMcpServers, refreshAgents]
  );

  const testMcpServer = useCallback(
    async (input: McpServerCreateInput & { auth_mode?: string }) => {
      return await api<{
        ok: boolean;
        tool_names: string[];
        error?: string | null;
      }>("/api/mcp-servers/test", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    []
  );

  const parseMcpServerRaw = useCallback(async (raw: unknown) => {
    const res = await api<{ drafts: McpServerDraft[] }>("/api/mcp-servers/parse", {
      method: "POST",
      body: JSON.stringify({ raw }),
    });
    return res.drafts || [];
  }, []);

  const setupMcpChat = useCallback(
    async (
      message: string,
      history: { role: string; content: string }[]
    ) => {
      try {
        const res = await api<{
          reply: string;
          draft?: McpServerDraft | null;
          saved?: McpServer | null;
          tool_names?: string[];
          error?: string | null;
        }>("/api/mcp-servers/setup-chat", {
          method: "POST",
          body: JSON.stringify({ message, history }),
        });
        if (res?.saved) {
          await refreshMcpServers();
        }
        return res;
      } catch (err) {
        console.error("MCP setup chat failed:", err);
        return null;
      }
    },
    [refreshMcpServers]
  );

  const persistMessage = useCallback(
    async (
      threadId: string,
      msg: {
        role: string;
        content: string;
        tools?: ChatToolPart[];
        parts?: ChatContentPart[];
        reasoning?: string;
        attachments?: ChatMessage["attachments"];
      }
    ): Promise<ChatMessage> => {
      // Move this convo to the top immediately (don't wait on title AI / network).
      setThreads((prev) => touchThread(prev, threadId));

      const meta =
        msg.tools?.length ||
        msg.parts?.length ||
        msg.reasoning ||
        msg.attachments?.length
          ? {
              ...(msg.tools?.length ? { tools: msg.tools } : {}),
              ...(msg.parts?.length ? { parts: msg.parts } : {}),
              ...(msg.reasoning ? { reasoning: msg.reasoning } : {}),
              ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
            }
          : null;
      const saved = await api<ApiMessage>(`/api/threads/${threadId}/messages`, {
        method: "POST",
        body: JSON.stringify({
          role: msg.role,
          content: msg.content,
          meta,
        }),
      });
      const mapped = mapApiMessage(saved);
      if (saved.thread_title) {
        setThreads((prev) => touchThread(prev, threadId, { title: saved.thread_title! }));
      }
      setMessages((prev) => {
        // Replace optimistic temp message with persisted one when content+role match at end
        const idx = [...prev]
          .reverse()
          .findIndex((m) => m.role === mapped.role && m.content === mapped.content && m.id.startsWith("temp-"));
        if (idx === -1) {
          // If already appended without temp id, swap last matching optimistic
          const last = prev[prev.length - 1];
          if (last && last.role === mapped.role && last.content === mapped.content) {
            return [...prev.slice(0, -1), mapped];
          }
          return [...prev, mapped];
        }
        const realIdx = prev.length - 1 - idx;
        const next = [...prev];
        next[realIdx] = mapped;
        return next;
      });
      return mapped;
    },
    []
  );

  const value = useMemo<AppState>(
    () => ({
      workspace,
      documents,
      workspaceFiles,
      workspaceAssets,
      workspaceUploads,
      agents,
      threads,
      activeThreadId,
      activeDocumentId,
      editorTarget,
      setEditorTarget,
      sidebarTab,
      setSidebarTab,
      chatsLibraryOpen,
      setChatsLibraryOpen,
      refreshAgents,
      selectWorkspaceAgent,
      setThreadAgent,
      activeAgentSlug,
      fetchAgentDetail,
      createUserAgent,
      updateUserAgent,
      createBlankAgent,
      duplicateAgent,
      deleteUserAgent,
      skills,
      refreshSkills,
      fetchSkillDetail,
      createUserSkill,
      updateUserSkill,
      duplicateSkill,
      deleteUserSkill,
      mcpServers,
      refreshMcpServers,
      createMcpServer,
      updateMcpServer,
      deleteMcpServer,
      testMcpServer,
      parseMcpServerRaw,
      setupMcpChat,
      messages,
      suggestions,
      models,
      accountSpend,
      setAccountSpend,
      loading,
      threadLoading,
      quotedSelection,
      setQuotedSelection,
      clearQuotedSelection,
      refreshAll,
      setActiveThread,
      setActiveDocument,
      updateDocumentContent,
      updatePersona,
      updateWorkspaceFile,
      refreshWorkspaceFiles,
      refreshWorkspaceAssets,
      refreshWorkspaceUploads,
      refreshThreadArtifacts,
      createThread,
      startNewChat,
      setOnNewChat,
      renameThread,
      deleteThread,
      createDocument,
      decideSuggestion,
      acceptAllSuggestions,
      setThreadModel,
      draftModel,
      preferredModel,
      draftAgentSlug,
      updateThreadUsage,
      appendMessage: (msg) => setMessages((prev) => [...prev, msg]),
      persistMessage,
      setMessages,
      refreshSuggestions,
      ingestLiveSuggestion,
      ingestDocumentCreated,
      applyLiveDocumentContent,
      apiUrl: API_URL,
      userId,
      agentKind,
      agentRunPath,
    }),
    [
      workspace,
      documents,
      workspaceFiles,
      workspaceAssets,
      workspaceUploads,
      agents,
      threads,
      activeThreadId,
      activeDocumentId,
      editorTarget,
      sidebarTab,
      setSidebarTab,
      chatsLibraryOpen,
      setChatsLibraryOpen,
      refreshAgents,
      selectWorkspaceAgent,
      setThreadAgent,
      activeAgentSlug,
      fetchAgentDetail,
      createUserAgent,
      updateUserAgent,
      createBlankAgent,
      duplicateAgent,
      deleteUserAgent,
      skills,
      refreshSkills,
      fetchSkillDetail,
      createUserSkill,
      updateUserSkill,
      duplicateSkill,
      deleteUserSkill,
      mcpServers,
      refreshMcpServers,
      createMcpServer,
      updateMcpServer,
      deleteMcpServer,
      testMcpServer,
      parseMcpServerRaw,
      setupMcpChat,
      messages,
      suggestions,
      models,
      accountSpend,
      setAccountSpend,
      loading,
      threadLoading,
      quotedSelection,
      setQuotedSelection,
      clearQuotedSelection,
      refreshAll,
      setActiveThread,
      setActiveDocument,
      updateDocumentContent,
      refreshWorkspaceAssets,
      refreshWorkspaceUploads,
      updatePersona,
      updateWorkspaceFile,
      refreshWorkspaceFiles,
      refreshThreadArtifacts,
      createThread,
      startNewChat,
      setOnNewChat,
      renameThread,
      deleteThread,
      createDocument,
      decideSuggestion,
      acceptAllSuggestions,
      setThreadModel,
      draftModel,
      preferredModel,
      draftAgentSlug,
      updateThreadUsage,
      persistMessage,
      refreshSuggestions,
      ingestLiveSuggestion,
      ingestDocumentCreated,
      applyLiveDocumentContent,
      userId,
      agentKind,
      agentRunPath,
    ]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
