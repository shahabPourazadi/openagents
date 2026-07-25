"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  File,
  ImageIcon,
  Shield,
  Type,
  Video,
  Volume2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAuth } from "@/lib/auth-context";
import { useAccountStatus } from "@/lib/account-status";
import { appHomePath } from "@/lib/agent-routes";
import { cn } from "@/lib/utils";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

type ModelTier = {
  tier: string;
  enabled: boolean;
  label: string;
  model_slug: string;
  provider: string;
  allow_fallbacks: boolean;
  reasoning_mode?: "efforts" | "toggle" | "none" | string;
  reasoning_efforts: string[];
  context_window: number;
  price_input_per_m: number | null;
  price_output_per_m: number | null;
  supports_vision: boolean;
  input_modalities?: string[];
  output_modalities?: string[];
};

const MODALITY_META: Record<
  string,
  { label: string; icon: typeof Type; chip: string }
> = {
  text: {
    label: "Text",
    icon: Type,
    chip: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  },
  image: {
    label: "Image",
    icon: ImageIcon,
    chip: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  },
  video: {
    label: "Video",
    icon: Video,
    chip: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  },
  audio: {
    label: "Audio",
    icon: Volume2,
    chip: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  },
  file: {
    label: "File",
    icon: File,
    chip: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  },
};

function modalitiesForTier(tier: ModelTier): {
  inputs: string[];
  outputs: string[];
} {
  const inputs =
    tier.input_modalities?.length
      ? tier.input_modalities
      : tier.supports_vision
        ? ["text", "image"]
        : ["text"];
  const outputs = tier.output_modalities?.length
    ? tier.output_modalities
    : ["text"];
  return { inputs, outputs };
}

function ModalityIcon({ kind }: { kind: string }) {
  const meta = MODALITY_META[kind] || {
    label: kind,
    icon: File,
    chip: "bg-muted text-muted-foreground",
  };
  const Icon = meta.icon;
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        className={cn(
          "inline-flex size-7 items-center justify-center rounded-md",
          meta.chip
        )}
        aria-label={meta.label}
      >
        <Icon className="size-3.5" strokeWidth={2} />
      </TooltipTrigger>
      <TooltipContent side="top">{meta.label}</TooltipContent>
    </Tooltip>
  );
}

function ModalityRow({ tier }: { tier: ModelTier }) {
  const { inputs, outputs } = modalitiesForTier(tier);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Modalities
      </span>
      <div className="flex items-center gap-1">
        {inputs.map((m) => (
          <ModalityIcon key={`in-${m}`} kind={m} />
        ))}
      </div>
      <ArrowRight className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
      <div className="flex items-center gap-1">
        {outputs.map((m) => (
          <ModalityIcon key={`out-${m}`} kind={m} />
        ))}
      </div>
    </div>
  );
}

type AgentSafety = {
  filesystem_hooks: boolean;
  prompt_injection: boolean;
  secret_redaction: boolean;
  tool_guard: boolean;
};

type AgentRuntime = {
  sandbox: "local" | "docker" | string;
  execute: boolean;
  max_concurrent: number;
  image: string;
  safety: AgentSafety;
};

const AGENT_SAFETY_CONTROLS: {
  key: keyof AgentSafety;
  label: string;
  description: string;
}[] = [
  {
    key: "filesystem_hooks",
    label: "Filesystem security hooks",
    description:
      "Claude Code–style PRE/POST hooks that block destructive host patterns (rm -rf /, curl|bash, etc.).",
  },
  {
    key: "prompt_injection",
    label: "Prompt injection defense",
    description:
      "pydantic-ai-shields PromptInjection (medium sensitivity) on model I/O.",
  },
  {
    key: "secret_redaction",
    label: "Secret redaction",
    description:
      "Scrubs API keys and other secrets from tool/model traffic before they leave the run.",
  },
  {
    key: "tool_guard",
    label: "Tool guard",
    description:
      "ToolGuard shield. Execute is not blocked here — sandbox isolation is the gate.",
  },
];

type SystemSettings = {
  signup_mode: string;
  tool_groups: Record<string, boolean>;
  zdr_only: boolean;
  model_tiers: ModelTier[];
  agent_runtime: AgentRuntime;
  auth_mode?: string;
  feature_signup_queue?: boolean;
};

type PublicConfig = {
  auth_mode: string;
  feature_signup_queue: boolean;
};

type AdminUser = {
  id: string;
  email: string | null;
  display_name: string | null;
  role: string;
  status: string;
  created_at: string | null;
  spend_usd?: number;
  spend_budget_usd?: number;
};

type PromptDoc = {
  key: string;
  draft_content: string;
  published_content: string;
  has_unpublished_changes: boolean;
  published_at: string | null;
};

type SkillDoc = {
  slug: string;
  title: string;
  enabled: boolean;
  draft_content: string;
  published_content: string;
  has_unpublished_changes: boolean;
};

type AuditRow = {
  id: string;
  actor_id: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  created_at: string;
};

type Tab = "users" | "models" | "prompts" | "skills" | "tools" | "audit";

const TOOL_LABELS: Record<string, string> = {
  hitl: "HITL tools (ask_user, suggest_*, …)",
  firecrawl: "Firecrawl (search / scrape / crawl)",
  document_parse: "Document parse (LiteParse)",
  deep_builtins: "Deep builtins (plan, todo, subagents, filesystem, memory)",
};

const PROMPT_LABELS: Record<string, string> = {
  system_prompt: "System prompt",
  agent_md: "Company agent.md",
  soul_md: "Company soul.md",
};

export default function AdminPage() {
  const { accessToken, user } = useAuth();
  const { ready, isAdmin, status, refresh: refreshAccount } = useAccountStatus();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("users");
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [signupQueueEnabled, setSignupQueueEnabled] = useState(false);
  const [prompts, setPrompts] = useState<PromptDoc[]>([]);
  const [activePrompt, setActivePrompt] = useState("agent_md");
  const [promptDraft, setPromptDraft] = useState("");
  const [skills, setSkills] = useState<SkillDoc[]>([]);
  const [activeSkill, setActiveSkill] = useState<string | null>(null);
  const [skillDraft, setSkillDraft] = useState("");
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [modelDraft, setModelDraft] = useState<ModelTier[]>([]);
  const [zdrOnly, setZdrOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [budgetUser, setBudgetUser] = useState<AdminUser | null>(null);
  const [budgetDraft, setBudgetDraft] = useState("");
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [deleteUser, setDeleteUser] = useState<AdminUser | null>(null);

  const authHeaders = useCallback((): HeadersInit => {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (accessToken) h.Authorization = `Bearer ${accessToken}`;
    else if (user?.id) h["X-User-Id"] = user.id;
    return h;
  }, [accessToken, user?.id]);

  const api = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const res = await fetch(`${API_URL}${path}`, {
        ...init,
        headers: { ...authHeaders(), ...(init?.headers || {}) },
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || res.statusText);
      }
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    },
    [authHeaders]
  );

  const loadSettings = useCallback(async () => {
    const [s, cfg] = await Promise.all([
      api<SystemSettings>("/api/admin/settings"),
      fetch(`${API_URL}/api/config`)
        .then((r) => (r.ok ? (r.json() as Promise<PublicConfig>) : null))
        .catch(() => null),
    ]);
    setSettings(s);
    setZdrOnly(Boolean(s.zdr_only));
    setModelDraft(s.model_tiers || []);
    const queueOn = Boolean(
      cfg?.feature_signup_queue ?? s.feature_signup_queue ?? false
    );
    setSignupQueueEnabled(queueOn);
    if (queueOn) {
      setStatusFilter((prev) => (prev === "" ? "pending" : prev));
    }
  }, [api]);

  const loadUsers = useCallback(async () => {
    const q = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : "";
    setUsers(await api<AdminUser[]>(`/api/admin/users${q}`));
  }, [api, statusFilter]);

  const loadPrompts = useCallback(async () => {
    const rows = await api<PromptDoc[]>("/api/admin/prompts");
    setPrompts(rows);
  }, [api]);

  const loadSkills = useCallback(async () => {
    const rows = await api<SkillDoc[]>("/api/admin/skills");
    setSkills(rows);
    setActiveSkill((prev) => prev ?? rows[0]?.slug ?? null);
  }, [api]);

  const loadAudit = useCallback(async () => {
    setAudit(await api<AuditRow[]>("/api/admin/audit?limit=80"));
  }, [api]);

  useEffect(() => {
    if (!ready) return;
    if (!isAdmin) {
      router.replace(appHomePath());
      return;
    }
    // Wait for JWT so admin fetches aren't fired unauthenticated (empty state sticks).
    if (!accessToken && !user?.id) return;

    let cancelled = false;
    void (async () => {
      try {
        await Promise.all([
          loadSettings(),
          loadUsers(),
          loadPrompts(),
          loadSkills(),
          loadAudit(),
        ]);
      } catch (e) {
        if (!cancelled) {
          setMessage(e instanceof Error ? e.message : "Failed to load admin data");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    ready,
    isAdmin,
    accessToken,
    user?.id,
    router,
    loadSettings,
    loadUsers,
    loadPrompts,
    loadSkills,
    loadAudit,
  ]);

  useEffect(() => {
    const row = prompts.find((p) => p.key === activePrompt);
    setPromptDraft(row?.draft_content ?? "");
  }, [prompts, activePrompt]);

  useEffect(() => {
    const row = skills.find((s) => s.slug === activeSkill);
    setSkillDraft(row?.draft_content ?? "");
  }, [skills, activeSkill]);

  async function withBusy(fn: () => Promise<void>, ok?: string) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      if (ok) setMessage(ok);
      await refreshAccount();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  if (!ready || !isAdmin) {
    return (
      <div className="flex min-h-svh items-center justify-center text-sm text-muted-foreground">
        Loading admin…
      </div>
    );
  }

  const pendingBadge = signupQueueEnabled ? (status?.pending_count ?? 0) : 0;
  const currentPrompt = prompts.find((p) => p.key === activePrompt);
  const currentSkill = skills.find((s) => s.slug === activeSkill);

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
        <div className="flex items-center gap-3">
          <Shield className="size-5" />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Admin</h1>
            <p className="text-xs text-muted-foreground">
              Platform controls · {user?.email}
            </p>
          </div>
          {pendingBadge > 0 ? (
            <Badge variant="secondary">{pendingBadge} pending</Badge>
          ) : null}
        </div>
        <Link
          href={appHomePath()}
          className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[0.8rem] font-medium hover:bg-muted"
        >
          <ArrowLeft className="size-3.5" />
          Back to app
        </Link>
      </header>

      {message ? (
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">{message}</p>
      ) : null}

      <nav className="flex flex-wrap gap-1 border-b pb-2">
        {(
          [
            ["users", "Users"],
            ["models", "Models"],
            ["prompts", "Prompts"],
            ["skills", "Skills"],
            ["tools", "Tools"],
            ["audit", "Audit"],
          ] as const
        ).map(([id, label]) => (
          <Button
            key={id}
            size="sm"
            variant={tab === id ? "default" : "ghost"}
            onClick={() => setTab(id)}
          >
            {label}
            {id === "users" && pendingBadge > 0 ? ` (${pendingBadge})` : ""}
          </Button>
        ))}
      </nav>

      {tab === "users" ? (
        <section className="space-y-3">
          {signupQueueEnabled ? (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border p-4">
              <div className="flex-1">
                <p className="text-sm font-medium">Signup mode</p>
                <p className="text-xs text-muted-foreground">
                  Admin approve: email confirm → pending queue. Auto approve: email
                  confirm → active. Flipping to auto does not clear existing pending
                  users.
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant={
                    settings?.signup_mode === "admin_approve" ? "default" : "outline"
                  }
                  disabled={busy}
                  onClick={() =>
                    void withBusy(async () => {
                      setSettings(
                        await api<SystemSettings>("/api/admin/settings", {
                          method: "PATCH",
                          body: JSON.stringify({ signup_mode: "admin_approve" }),
                        })
                      );
                    }, "Signup mode: admin approve")
                  }
                >
                  Admin approve
                </Button>
                <Button
                  size="sm"
                  variant={
                    settings?.signup_mode === "auto_approve" ? "default" : "outline"
                  }
                  disabled={busy}
                  onClick={() =>
                    void withBusy(async () => {
                      setSettings(
                        await api<SystemSettings>("/api/admin/settings", {
                          method: "PATCH",
                          body: JSON.stringify({ signup_mode: "auto_approve" }),
                        })
                      );
                    }, "Signup mode: auto approve")
                  }
                >
                  Auto approve
                </Button>
              </div>
            </div>
          ) : (
            <p className="rounded-lg border border-dashed px-4 py-3 text-xs text-muted-foreground">
              Signup queue is off (FEATURE_SIGNUP_QUEUE). New users activate
              automatically. Enable the flag to manage pending approvals.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {(signupQueueEnabled
              ? ["pending", "active", "rejected", "disabled", ""]
              : ["active", "disabled", ""]
            ).map((s) => (
              <Button
                key={s || "all"}
                size="sm"
                variant={statusFilter === s ? "default" : "outline"}
                onClick={() => setStatusFilter(s)}
              >
                {s || "all"}
              </Button>
            ))}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void loadUsers()}>
              Refresh
            </Button>
          </div>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">User</th>
                  <th className="px-3 py-2 font-medium">Role</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Spend / Budget</th>
                  <th className="px-3 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-t">
                    <td className="px-3 py-2">
                      <div className="font-medium">{u.display_name || "—"}</div>
                      <div className="text-xs text-muted-foreground">{u.email}</div>
                    </td>
                    <td className="px-3 py-2">{u.role}</td>
                    <td className="px-3 py-2">{u.status}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="tabular-nums text-xs">
                          ${(u.spend_usd ?? 0).toFixed(2)} / $
                          {(u.spend_budget_usd ?? 5).toFixed(2)}
                        </span>
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busy}
                          onClick={() => {
                            setBudgetUser(u);
                            setBudgetDraft(String(u.spend_budget_usd ?? 5));
                            setBudgetError(null);
                          }}
                        >
                          Edit
                        </Button>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {signupQueueEnabled &&
                        u.role !== "admin" &&
                        u.status !== "active" ? (
                          <Button
                            size="xs"
                            disabled={busy}
                            onClick={() =>
                              void withBusy(async () => {
                                await api(`/api/admin/users/${u.id}/approve`, {
                                  method: "POST",
                                });
                                await loadUsers();
                              }, "Approved")
                            }
                          >
                            Approve
                          </Button>
                        ) : null}
                        {signupQueueEnabled &&
                        u.role !== "admin" &&
                        u.status !== "rejected" ? (
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={busy}
                            onClick={() =>
                              void withBusy(async () => {
                                await api(`/api/admin/users/${u.id}/reject`, {
                                  method: "POST",
                                });
                                await loadUsers();
                              }, "Rejected")
                            }
                          >
                            Reject
                          </Button>
                        ) : null}
                        {u.role !== "admin" && u.status !== "disabled" ? (
                          <Button
                            size="xs"
                            variant="destructive"
                            disabled={busy}
                            onClick={() =>
                              void withBusy(async () => {
                                await api(`/api/admin/users/${u.id}/disable`, {
                                  method: "POST",
                                });
                                await loadUsers();
                              }, "Disabled")
                            }
                          >
                            Disable
                          </Button>
                        ) : null}
                        {u.role !== "admin" ? (
                          <Button
                            size="xs"
                            variant="destructive"
                            disabled={busy}
                            onClick={() => setDeleteUser(u)}
                          >
                            Delete
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
                {users.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                      No users in this filter.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {tab === "models" ? (
        <section className="space-y-4">
          <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border px-4 py-3">
            <div>
              <p className="text-sm font-medium">ZDR only</p>
              <p className="text-xs text-muted-foreground">
                Route every OpenRouter request only to Zero Data Retention endpoints
                (<code className="text-[11px]">provider.zdr: true</code>).
              </p>
            </div>
            <input
              type="checkbox"
              className="size-4"
              checked={zdrOnly}
              disabled={busy}
              onChange={(e) => setZdrOnly(e.target.checked)}
            />
          </label>

          {modelDraft.map((tier, idx) => (
            <div key={tier.tier} className="space-y-3 rounded-lg border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold capitalize">{tier.tier}</p>
                  <Badge variant={tier.enabled ? "secondary" : "outline"}>
                    {tier.enabled ? "enabled" : "disabled"}
                  </Badge>
                </div>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={tier.enabled}
                    disabled={busy}
                    onChange={(e) => {
                      const next = [...modelDraft];
                      next[idx] = { ...tier, enabled: e.target.checked };
                      setModelDraft(next);
                    }}
                  />
                  Available in chat picker
                </label>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs">
                  <span className="text-muted-foreground">Label</span>
                  <Input
                    value={tier.label}
                    disabled={busy}
                    onChange={(e) => {
                      const next = [...modelDraft];
                      next[idx] = { ...tier, label: e.target.value };
                      setModelDraft(next);
                    }}
                  />
                </label>
                <label className="space-y-1 text-xs">
                  <span className="text-muted-foreground">
                    OpenRouter model slug
                  </span>
                  <Input
                    placeholder="minimax/minimax-m3"
                    value={tier.model_slug}
                    disabled={busy}
                    onChange={(e) => {
                      const next = [...modelDraft];
                      next[idx] = { ...tier, model_slug: e.target.value };
                      setModelDraft(next);
                    }}
                  />
                </label>
                <label className="space-y-1 text-xs">
                  <span className="text-muted-foreground">
                    Preferred provider (`auto` or slug, e.g. together)
                  </span>
                  <Input
                    placeholder="auto"
                    value={tier.provider}
                    disabled={busy}
                    onChange={(e) => {
                      const next = [...modelDraft];
                      next[idx] = { ...tier, provider: e.target.value };
                      setModelDraft(next);
                    }}
                  />
                </label>
                <label className="flex items-end gap-2 pb-2 text-xs">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={tier.allow_fallbacks}
                    disabled={busy}
                    onChange={(e) => {
                      const next = [...modelDraft];
                      next[idx] = { ...tier, allow_fallbacks: e.target.checked };
                      setModelDraft(next);
                    }}
                  />
                  Allow fallbacks when preferred provider is unavailable
                </label>
              </div>
              <div className="flex flex-col gap-2 border-t pt-3">
                <ModalityRow tier={tier} />
                <p className="text-xs text-muted-foreground">
                  Reasoning (from OpenRouter on save):{" "}
                  {tier.reasoning_mode === "toggle"
                    ? "on/off toggle"
                    : tier.reasoning_mode === "none"
                      ? "not supported"
                      : tier.reasoning_efforts?.length
                        ? tier.reasoning_efforts.join(", ")
                        : "none / not reported"}
                  {" · "}
                  Context:{" "}
                  {tier.context_window?.toLocaleString?.() ?? tier.context_window}
                  {tier.price_input_per_m != null
                    ? ` · $${tier.price_input_per_m}/$${tier.price_output_per_m} per 1M`
                    : ""}
                </p>
              </div>
            </div>
          ))}

          <Button
            disabled={busy || modelDraft.length === 0}
            onClick={() =>
              void withBusy(async () => {
                const updated = await api<SystemSettings>("/api/admin/settings", {
                  method: "PATCH",
                  body: JSON.stringify({
                    zdr_only: zdrOnly,
                    model_tiers: modelDraft.map((t) => ({
                      tier: t.tier,
                      enabled: t.enabled,
                      label: t.label,
                      model_slug: t.model_slug,
                      provider: t.provider || "auto",
                      allow_fallbacks: t.allow_fallbacks,
                    })),
                  }),
                });
                setSettings(updated);
                setZdrOnly(Boolean(updated.zdr_only));
                setModelDraft(updated.model_tiers || []);
              }, "Models saved (OpenRouter modalities / reasoning refreshed when needed)")
            }
          >
            Save models
          </Button>
        </section>
      ) : null}

      {tab === "prompts" ? (
        <section className="grid gap-4 md:grid-cols-[200px_1fr]">
          <div className="flex flex-col gap-1">
            {prompts.length === 0 ? (
              <p className="px-2 text-xs text-muted-foreground">Loading prompts…</p>
            ) : null}
            {prompts.map((p) => (
              <Button
                key={p.key}
                size="sm"
                variant={activePrompt === p.key ? "default" : "ghost"}
                className="justify-start"
                onClick={() => setActivePrompt(p.key)}
              >
                {PROMPT_LABELS[p.key] || p.key}
                {p.has_unpublished_changes ? " •" : ""}
              </Button>
            ))}
          </div>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Draft → Publish. Published content is used on the next v2 agent run.
              Users never see this content.
              {currentPrompt
                ? ` (${currentPrompt.draft_content.length.toLocaleString()} chars)`
                : ""}
              {currentPrompt?.has_unpublished_changes
                ? " Unpublished changes pending."
                : ""}
            </p>
            <Textarea
              className="min-h-[420px] font-mono text-xs field-sizing-fixed"
              value={promptDraft}
              onChange={(e) => setPromptDraft(e.target.value)}
              placeholder={
                prompts.length === 0
                  ? "Loading…"
                  : "Company prompt draft (seeded from templates on first load)"
              }
            />
            <div className="flex gap-2">
              <Button
                disabled={busy}
                onClick={() =>
                  void withBusy(async () => {
                    await api(`/api/admin/prompts/${activePrompt}`, {
                      method: "PATCH",
                      body: JSON.stringify({ draft_content: promptDraft }),
                    });
                    await loadPrompts();
                  }, "Draft saved")
                }
              >
                Save draft
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void withBusy(async () => {
                    await api(`/api/admin/prompts/${activePrompt}`, {
                      method: "PATCH",
                      body: JSON.stringify({ draft_content: promptDraft }),
                    });
                    await api(`/api/admin/prompts/${activePrompt}/publish`, {
                      method: "POST",
                    });
                    await loadPrompts();
                  }, "Published")
                }
              >
                Publish
              </Button>
            </div>
          </div>
        </section>
      ) : null}

      {tab === "skills" ? (
        <section className="grid gap-4 md:grid-cols-[220px_1fr]">
          <div className="flex flex-col gap-1">
            {skills.map((s) => (
              <Button
                key={s.slug}
                size="sm"
                variant={activeSkill === s.slug ? "default" : "ghost"}
                className="justify-start"
                onClick={() => setActiveSkill(s.slug)}
              >
                <span className="truncate">
                  {s.enabled ? "" : "(off) "}
                  {s.title}
                  {s.has_unpublished_changes ? " •" : ""}
                </span>
              </Button>
            ))}
          </div>
          <div className="space-y-3">
            {currentSkill ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    className="max-w-xs"
                    value={currentSkill.title}
                    onChange={(e) =>
                      setSkills((prev) =>
                        prev.map((s) =>
                          s.slug === currentSkill.slug
                            ? { ...s, title: e.target.value }
                            : s
                        )
                      )
                    }
                  />
                  <Button
                    size="sm"
                    variant={currentSkill.enabled ? "default" : "outline"}
                    disabled={busy}
                    onClick={() =>
                      void withBusy(async () => {
                        await api(`/api/admin/skills/${currentSkill.slug}`, {
                          method: "PATCH",
                          body: JSON.stringify({ enabled: !currentSkill.enabled }),
                        });
                        await loadSkills();
                      }, currentSkill.enabled ? "Skill disabled" : "Skill enabled")
                    }
                  >
                    {currentSkill.enabled ? "Enabled" : "Disabled"}
                  </Button>
                </div>
                <Textarea
                  className="min-h-[420px] font-mono text-xs field-sizing-fixed"
                  value={skillDraft}
                  onChange={(e) => setSkillDraft(e.target.value)}
                  placeholder="Skill SKILL.md draft"
                />
                <div className="flex gap-2">
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void withBusy(async () => {
                        await api(`/api/admin/skills/${currentSkill.slug}`, {
                          method: "PATCH",
                          body: JSON.stringify({
                            draft_content: skillDraft,
                            title: currentSkill.title,
                          }),
                        });
                        await loadSkills();
                      }, "Draft saved")
                    }
                  >
                    Save draft
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void withBusy(async () => {
                        await api(`/api/admin/skills/${currentSkill.slug}`, {
                          method: "PATCH",
                          body: JSON.stringify({
                            draft_content: skillDraft,
                            title: currentSkill.title,
                          }),
                        });
                        await api(`/api/admin/skills/${currentSkill.slug}/publish`, {
                          method: "POST",
                        });
                        await loadSkills();
                      }, "Published")
                    }
                  >
                    Publish
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No skills found.</p>
            )}
          </div>
        </section>
      ) : null}

      {tab === "tools" ? (
        <section className="space-y-6">
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Tool groups for the v2 agent. Changes apply on the next agent run.
            </p>
            {settings
              ? Object.keys(TOOL_LABELS).map((key) => (
                  <label
                    key={key}
                    className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border px-4 py-3"
                  >
                    <span className="text-sm">{TOOL_LABELS[key]}</span>
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={Boolean(settings.tool_groups[key])}
                      disabled={busy}
                      onChange={(e) =>
                        void withBusy(async () => {
                          const next = {
                            ...settings.tool_groups,
                            [key]: e.target.checked,
                          };
                          setSettings(
                            await api<SystemSettings>("/api/admin/settings", {
                              method: "PATCH",
                              body: JSON.stringify({ tool_groups: next }),
                            })
                          );
                        }, "Tool groups updated")
                      }
                    />
                  </label>
                ))
              : null}
          </div>

          {settings?.agent_runtime ? (
            <div className="space-y-3 border-t pt-4">
              <div>
                <h2 className="text-sm font-medium">Agent sandbox</h2>
                <p className="text-xs text-muted-foreground">
                  Overrides env defaults without redeploy. Docker needs the API
                  container to reach the Docker socket. Soft-degrades to
                  filesystem-only if the sandbox slot is busy.
                </p>
              </div>
              <label className="flex items-center justify-between gap-4 rounded-lg border px-4 py-3">
                <span className="text-sm">Sandbox mode</span>
                <select
                  className="rounded-md border bg-background px-2 py-1.5 text-sm"
                  value={settings.agent_runtime.sandbox}
                  disabled={busy}
                  onChange={(e) =>
                    void withBusy(async () => {
                      setSettings(
                        await api<SystemSettings>("/api/admin/settings", {
                          method: "PATCH",
                          body: JSON.stringify({
                            agent_runtime: { sandbox: e.target.value },
                          }),
                        })
                      );
                    }, "Sandbox mode updated")
                  }
                >
                  <option value="local">local (host)</option>
                  <option value="docker">docker (isolated)</option>
                </select>
              </label>
              <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border px-4 py-3">
                <span className="text-sm">Allow shell execute</span>
                <input
                  type="checkbox"
                  className="size-4"
                  checked={Boolean(settings.agent_runtime.execute)}
                  disabled={busy}
                  onChange={(e) =>
                    void withBusy(async () => {
                      setSettings(
                        await api<SystemSettings>("/api/admin/settings", {
                          method: "PATCH",
                          body: JSON.stringify({
                            agent_runtime: { execute: e.target.checked },
                          }),
                        })
                      );
                    }, "Execute setting updated")
                  }
                />
              </label>
              <label className="flex items-center justify-between gap-4 rounded-lg border px-4 py-3">
                <span className="text-sm">Max concurrent sandboxes</span>
                <input
                  type="number"
                  min={1}
                  className="w-20 rounded-md border bg-background px-2 py-1.5 text-sm"
                  value={settings.agent_runtime.max_concurrent}
                  disabled={busy}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (!Number.isFinite(n) || n < 1) return;
                    void withBusy(async () => {
                      setSettings(
                        await api<SystemSettings>("/api/admin/settings", {
                          method: "PATCH",
                          body: JSON.stringify({
                            agent_runtime: { max_concurrent: Math.floor(n) },
                          }),
                        })
                      );
                    }, "Concurrency updated");
                  }}
                />
              </label>
              <label className="flex flex-col gap-2 rounded-lg border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-sm">Docker image</span>
                <input
                  type="text"
                  className="w-full min-w-0 rounded-md border bg-background px-2 py-1.5 font-mono text-xs sm:max-w-md"
                  value={settings.agent_runtime.image}
                  disabled={busy}
                  onBlur={(e) => {
                    const image = e.target.value.trim();
                    if (!image || image === settings.agent_runtime.image) return;
                    void withBusy(async () => {
                      setSettings(
                        await api<SystemSettings>("/api/admin/settings", {
                          method: "PATCH",
                          body: JSON.stringify({
                            agent_runtime: { image },
                          }),
                        })
                      );
                    }, "Image updated");
                  }}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      agent_runtime: {
                        ...settings.agent_runtime,
                        image: e.target.value,
                      },
                    })
                  }
                />
              </label>

              <div className="space-y-3 border-t pt-4">
                <div>
                  <h2 className="text-sm font-medium">Safety &amp; guardrails</h2>
                  <p className="text-xs text-muted-foreground">
                    Deep-agent shields applied on every agent run. Defaults are
                    all enabled. Changes apply on the next agent turn (no
                    redeploy).
                  </p>
                </div>
                {AGENT_SAFETY_CONTROLS.map((item) => {
                  const safety = settings.agent_runtime.safety ?? {
                    filesystem_hooks: true,
                    prompt_injection: true,
                    secret_redaction: true,
                    tool_guard: true,
                  };
                  return (
                    <label
                      key={item.key}
                      className="flex cursor-pointer items-start justify-between gap-4 rounded-lg border px-4 py-3"
                    >
                      <span className="min-w-0">
                        <span className="block text-sm">{item.label}</span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {item.description}
                        </span>
                      </span>
                      <input
                        type="checkbox"
                        className="mt-1 size-4 shrink-0"
                        checked={Boolean(safety[item.key])}
                        disabled={busy}
                        onChange={(e) =>
                          void withBusy(async () => {
                            setSettings(
                              await api<SystemSettings>("/api/admin/settings", {
                                method: "PATCH",
                                body: JSON.stringify({
                                  agent_runtime: {
                                    safety: { [item.key]: e.target.checked },
                                  },
                                }),
                              })
                            );
                          }, `${item.label} updated`)
                        }
                      />
                    </label>
                  );
                })}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {tab === "audit" ? (
        <section className="overflow-x-auto rounded-lg border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Action</th>
                <th className="px-3 py-2 font-medium">Target</th>
                <th className="px-3 py-2 font-medium">Actor</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((a) => (
                <tr key={a.id} className="border-t">
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {new Date(a.created_at).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">{a.action}</td>
                  <td className="px-3 py-2 text-xs">
                    {a.target_type}
                    {a.target_id ? `:${a.target_id}` : ""}
                  </td>
                  <td className="px-3 py-2 text-xs font-mono">{a.actor_id.slice(0, 8)}…</td>
                </tr>
              ))}
              {audit.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
                    No audit events yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>
      ) : null}

      <Dialog
        open={budgetUser != null}
        onOpenChange={(open) => {
          if (!open) {
            setBudgetUser(null);
            setBudgetError(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit spend budget</DialogTitle>
            <DialogDescription>
              Lifetime OpenRouter cost cap for{" "}
              {budgetUser?.email || budgetUser?.display_name || "this user"}.
              Current spend: ${(budgetUser?.spend_usd ?? 0).toFixed(2)}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="budget-usd">
              Budget (USD)
            </label>
            <Input
              id="budget-usd"
              type="number"
              min={0}
              step={0.5}
              inputMode="decimal"
              value={budgetDraft}
              disabled={busy}
              onChange={(e) => {
                setBudgetDraft(e.target.value);
                setBudgetError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  (
                    document.getElementById("budget-save") as HTMLButtonElement | null
                  )?.click();
                }
              }}
            />
            {budgetError ? (
              <p className="text-sm text-destructive">{budgetError}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Default for new users is $5.00. Set higher to unlock more usage.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setBudgetUser(null);
                setBudgetError(null);
              }}
            >
              Cancel
            </Button>
            <Button
              id="budget-save"
              type="button"
              disabled={busy}
              onClick={() => {
                if (!budgetUser) return;
                const n = Number(budgetDraft);
                if (!Number.isFinite(n) || n < 0) {
                  setBudgetError("Enter a valid number ≥ 0");
                  return;
                }
                void withBusy(async () => {
                  await api(`/api/admin/users/${budgetUser.id}/budget`, {
                    method: "PATCH",
                    body: JSON.stringify({ spend_budget_usd: n }),
                  });
                  await loadUsers();
                  setBudgetUser(null);
                  setBudgetError(null);
                }, "Budget updated");
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteUser != null}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleteUser(null);
        }}
      >
        <DialogContent className="sm:max-w-md" showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>Delete user permanently?</DialogTitle>
            <DialogDescription>
              This will permanently delete{" "}
              <span className="font-medium text-foreground">
                {deleteUser?.email ||
                  deleteUser?.display_name ||
                  "this user"}
              </span>
              , their account, workspaces, chats, documents, uploads, and all
              related data. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setDeleteUser(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (!deleteUser) return;
                void withBusy(async () => {
                  await api(`/api/admin/users/${deleteUser.id}`, {
                    method: "DELETE",
                  });
                  setDeleteUser(null);
                  await loadUsers();
                }, "User deleted");
              }}
            >
              {busy ? "Deleting…" : "Delete forever"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
