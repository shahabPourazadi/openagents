"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Loader2,
  MessageSquarePlus,
  PencilRuler,
  Plug,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getAuthHeaders, useApp, type AgentDetail } from "@/lib/app-state";
import {
  DEFAULT_AGENT_ICON,
  DEFAULT_SKILL_ICON,
  AGENT_ICON_OPTIONS,
  isAgentIconId,
  skillIconComponent,
  type AgentIconId,
} from "@/lib/agent-icons";
import { cn } from "@/lib/utils";

type PredefinedSkillOption = {
  slug: string;
  name: string;
  description?: string;
  icon?: string;
  /** Where the skill is defined (library vs an agent playbook). */
  origin: "library" | "agent";
  agentName?: string;
};

export type AgentDialogMode = "create" | "edit" | "view";

type AgentScopedSkill = {
  slug: string;
  name?: string;
  description?: string;
  content?: string;
  icon?: string;
};

function slugifySkill(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64) || "skill"
  );
}

function defaultScopedSkillContent(name: string, description = "") {
  const title = name.trim() || "Untitled skill";
  const slug = slugifySkill(title);
  const desc =
    description.trim() ||
    `Playbook for ${title}. Use when the user asks for this workflow.`;
  return `---
name: ${slug}
description: ${desc}
---

# ${title}

## Instructions

Describe the workflow the agent should follow.
`;
}

type AgentDialogProps = {
  open: boolean;
  mode: AgentDialogMode;
  /** Required when mode is "edit" or "view". */
  slug?: string | null;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful create or save. */
  onSaved?: (slug: string, mode: AgentDialogMode) => void;
  /** Switch from view → edit (parent owns mode state). */
  onRequestEdit?: (slug: string) => void;
};

function defaultAgentMd(name: string) {
  const title = name.trim() || "Untitled agent";
  return `# ${title}\n\nYou help the user with their workflow.\n`;
}

export function AgentDialog({
  open,
  mode,
  slug,
  onOpenChange,
  onSaved,
  onRequestEdit,
}: AgentDialogProps) {
  const {
    apiUrl,
    createUserAgent,
    updateUserAgent,
    fetchAgentDetail,
    selectWorkspaceAgent,
    startNewChat,
    skills,
    agents,
    mcpServers,
    refreshSkills,
    refreshMcpServers,
  } = useApp();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState<AgentIconId>(DEFAULT_AGENT_ICON);
  const [usesDocument, setUsesDocument] = useState(false);
  const [usesCanvas, setUsesCanvas] = useState(false);
  const [source, setSource] = useState<"builtin" | "user">("user");
  const [predefinedSkillSlugs, setPredefinedSkillSlugs] = useState<string[]>([]);
  const [mcpServerIds, setMcpServerIds] = useState<string[]>([]);
  const [agentSkills, setAgentSkills] = useState<AgentScopedSkill[]>([]);
  const [agentMd, setAgentMd] = useState(defaultAgentMd("Untitled agent"));
  const [soulMd, setSoulMd] = useState("");
  const [busy, setBusy] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skillPreview, setSkillPreview] = useState<AgentScopedSkill | null>(null);
  const [skillEditor, setSkillEditor] = useState<{
    mode: "add" | "edit";
    originalSlug?: string;
    name: string;
    description: string;
    content: string;
    icon: AgentIconId;
  } | null>(null);

  const readOnly = mode === "view";
  const canEditSkills = mode === "create" || (mode === "edit" && source === "user");
  /** Built-in default agent — has access to every skill and MCP. */
  const isAutoAgent = slug === "agent";

  /** Same universe as sidebar Skills: library + unique agent playbooks. */
  const predefinedSkillOptions = useMemo(() => {
    const bySlug = new Map<string, PredefinedSkillOption>();
    for (const s of skills) {
      if (!s.slug) continue;
      bySlug.set(s.slug, {
        slug: s.slug,
        name: s.name || s.slug,
        description: s.description,
        icon: s.icon,
        origin: "library",
      });
    }
    for (const agent of agents) {
      for (const s of agent.skills || []) {
        if (!s.slug || bySlug.has(s.slug)) continue;
        bySlug.set(s.slug, {
          slug: s.slug,
          name: s.name || s.slug,
          description: s.description,
          icon: s.icon,
          origin: "agent",
          agentName: agent.name,
        });
      }
    }
    return Array.from(bySlug.values()).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    );
  }, [skills, agents]);

  useEffect(() => {
    if (!open) return;
    void refreshSkills();
  }, [open, refreshSkills]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSkillPreview(null);
    setSkillEditor(null);

    function applyDetail(detail: AgentDetail) {
      setName(detail.name || "");
      setDescription(detail.description || "");
      setIcon(
        detail.icon && isAgentIconId(detail.icon) ? detail.icon : DEFAULT_AGENT_ICON
      );
      setUsesDocument(Boolean(detail.uses_document));
      setUsesCanvas(Boolean(detail.uses_canvas));
      setSource(detail.source === "builtin" ? "builtin" : "user");
      setPredefinedSkillSlugs(
        Array.isArray(detail.predefined_skill_slugs)
          ? detail.predefined_skill_slugs.filter(Boolean)
          : []
      );
      setMcpServerIds(
        Array.isArray(detail.mcp_server_ids)
          ? detail.mcp_server_ids.filter(Boolean)
          : []
      );
      void refreshMcpServers();
      setAgentSkills(
        Array.isArray(detail.skills)
          ? detail.skills.map((s) => ({
              slug: s.slug,
              name: s.name,
              description: s.description,
              content: s.content,
              icon: s.icon,
            }))
          : []
      );
      setAgentMd(detail.agent_md || defaultAgentMd(detail.name || "Agent"));
      setSoulMd(detail.soul_md || "");
    }

    if (mode === "create") {
      setName("");
      setDescription("");
      setIcon(DEFAULT_AGENT_ICON);
      setUsesDocument(false);
      setUsesCanvas(false);
      setSource("user");
      setPredefinedSkillSlugs([]);
      setMcpServerIds([]);
      setAgentSkills([]);
      setAgentMd(defaultAgentMd("Untitled agent"));
      setSoulMd("");
      void refreshMcpServers();
      setLoading(false);
      return;
    }

    if (!slug) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const detail = await fetchAgentDetail(slug);
        if (cancelled) return;
        if (!detail) {
          setError("Could not load this agent.");
          return;
        }
        applyDetail(detail);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, mode, slug, fetchAgentDetail, refreshMcpServers]);

  function toggleMcpServer(id: string) {
    setMcpServerIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  function togglePredefinedSkill(skillSlug: string) {
    setPredefinedSkillSlugs((prev) =>
      prev.includes(skillSlug)
        ? prev.filter((s) => s !== skillSlug)
        : [...prev, skillSlug]
    );
  }

  async function handleEnhance() {
    setEnhancing(true);
    setError(null);
    try {
      const res = await fetch(`${apiUrl}/api/agents/enhance-agent-md`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getAuthHeaders(),
        },
        body: JSON.stringify({
          draft: agentMd,
          name: name.trim() || "Untitled agent",
          description: description.trim(),
          uses_document: usesDocument,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        let detail = text || res.statusText;
        try {
          const parsed = JSON.parse(text) as { detail?: string };
          if (parsed.detail) detail = parsed.detail;
        } catch {
          /* keep text */
        }
        throw new Error(detail);
      }
      const data = (await res.json()) as { agent_md: string };
      if (!data.agent_md?.trim()) {
        throw new Error("Enhancement returned empty instructions.");
      }
      setAgentMd(data.agent_md);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to enhance instructions.");
    } finally {
      setEnhancing(false);
    }
  }

  async function handleStartChat() {
    if (!slug) return;
    setBusy(true);
    setError(null);
    try {
      await selectWorkspaceAgent(slug);
      startNewChat();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start chat.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit() {
    if (mode === "view") {
      onOpenChange(false);
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required.");
      return;
    }
    const instructions = agentMd.trim() || defaultAgentMd(trimmed);
    setBusy(true);
    setError(null);
    try {
      const skillsPayload = agentSkills.map((s) => ({
        slug: s.slug,
        name: s.name || s.slug,
        description: s.description || "",
        content: s.content || "",
        icon: s.icon || "",
      }));

      if (mode === "create") {
        const created = await createUserAgent({
          name: trimmed,
          description: description.trim(),
          icon,
          uses_document: usesDocument,
          uses_canvas: usesCanvas,
          agent_md: instructions,
          soul_md: soulMd.trim(),
          skills: skillsPayload,
          predefined_skill_slugs: predefinedSkillSlugs,
          mcp_server_ids: mcpServerIds,
        });
        if (!created) {
          setError("Failed to create agent.");
          return;
        }
        await selectWorkspaceAgent(created.slug);
        onSaved?.(created.slug, "create");
        return;
      }

      if (!slug) {
        setError("Missing agent slug.");
        return;
      }
      const updated = await updateUserAgent(slug, {
        name: trimmed,
        description: description.trim(),
        icon,
        uses_document: usesDocument,
        uses_canvas: usesCanvas,
        agent_md: instructions,
        soul_md: soulMd.trim(),
        skills: skillsPayload,
        predefined_skill_slugs: predefinedSkillSlugs,
        mcp_server_ids: mcpServerIds,
      });
      if (!updated) {
        setError("Failed to save agent.");
        return;
      }
      onSaved?.(updated.slug, "edit");
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const title =
    mode === "create" ? "New agent" : mode === "view" ? name || "Agent" : "Edit agent";
  const descriptionText =
    mode === "create"
      ? "Set the minimum so you can start chatting. You can refine later here, in chat, or with Agent Builder."
      : mode === "view"
        ? description || "Agent details and skills."
        : "Update this user agent. You can also ask the agent in chat to refine it, or use Agent Builder.";

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="flex max-h-[min(90vh,46rem)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
          showCloseButton={!busy}
        >
          <DialogHeader
            className={cn(
              "shrink-0 border-b px-4 py-3 text-left",
              mode === "view" ? "pr-20" : "pr-12"
            )}
          >
            <DialogTitle className="truncate">{title}</DialogTitle>
            <DialogDescription className="line-clamp-2">
              {descriptionText}
            </DialogDescription>
          </DialogHeader>
          {mode === "view" && slug ? (
            <Tooltip>
              <TooltipTrigger
                type="button"
                disabled={busy || loading}
                onClick={() => void handleStartChat()}
                aria-label="New chat with this agent"
                className="absolute top-2 right-11 z-10 inline-flex size-7 items-center justify-center rounded-[min(var(--radius-md),12px)] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
              >
                <MessageSquarePlus className="size-4" />
              </TooltipTrigger>
              <TooltipContent side="bottom">
                New chat with this agent
              </TooltipContent>
            </Tooltip>
          ) : null}

          <Tabs
            defaultValue="agent"
            className="flex min-h-0 flex-1 flex-col gap-0"
          >
            <div className="shrink-0 px-4 pt-1">
              <TabsList variant="line" size="sm" className="w-full">
                <TabsTrigger value="agent">
                  <Bot /> Agent
                </TabsTrigger>
                <TabsTrigger value="skills">
                  <PencilRuler /> Skills
                </TabsTrigger>
                <TabsTrigger value="mcp">
                  <Plug /> MCP
                </TabsTrigger>
              </TabsList>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
              {loading ? (
                <p className="text-sm text-muted-foreground">Loading agent…</p>
              ) : (
                <>
                  <TabsContent value="agent" className="mt-0 flex flex-col gap-3">
                  {mode !== "view" ? (
                    <>
                      <div className="flex flex-col gap-1.5">
                        <label htmlFor="pack-name" className="text-sm font-medium">
                          Name
                        </label>
                        <Input
                          id="pack-name"
                          value={name}
                          onChange={(e) => {
                            const next = e.target.value;
                            setName(next);
                            if (
                              mode === "create" &&
                              agentMd === defaultAgentMd(name || "Untitled agent")
                            ) {
                              setAgentMd(defaultAgentMd(next || "Untitled agent"));
                            }
                          }}
                          placeholder="e.g. Grant writer"
                          disabled={busy}
                          autoFocus
                        />
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <label
                          htmlFor="pack-description"
                          className="text-sm font-medium"
                        >
                          Description
                        </label>
                        <Input
                          id="pack-description"
                          value={description}
                          onChange={(e) => setDescription(e.target.value)}
                          placeholder="Short blurb for the agent list"
                          disabled={busy}
                        />
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <span className="text-sm font-medium">Icon</span>
                        <div
                          className="grid grid-cols-5 gap-1.5 sm:grid-cols-10"
                          role="radiogroup"
                          aria-label="Agent icon"
                        >
                          {AGENT_ICON_OPTIONS.map(({ id, label, Icon }) => {
                            const selected = icon === id;
                            return (
                              <button
                                key={id}
                                type="button"
                                role="radio"
                                aria-checked={selected}
                                aria-label={label}
                                title={label}
                                disabled={busy || enhancing}
                                onClick={() => setIcon(id)}
                                className={cn(
                                  "inline-flex size-8 items-center justify-center rounded-md border transition-colors",
                                  selected
                                    ? "border-foreground/30 bg-muted text-foreground"
                                    : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
                                )}
                              >
                                <Icon className="size-3.5" />
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <label className="flex cursor-pointer items-start gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="mt-0.5 size-4 rounded border-input"
                          checked={usesDocument}
                          onChange={(e) => setUsesDocument(e.target.checked)}
                          disabled={busy}
                        />
                        <span>
                          <span className="font-medium">Document editor</span>
                          <span className="block text-muted-foreground">
                            Show a markdown document pane with Accept/Reject
                            suggestions. Turn off to remove that feature for this
                            agent.
                          </span>
                        </span>
                      </label>

                      <label className="flex cursor-pointer items-start gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="mt-0.5 size-4 rounded border-input"
                          checked={usesCanvas}
                          onChange={(e) => setUsesCanvas(e.target.checked)}
                          disabled={busy}
                        />
                        <span>
                          <span className="font-medium">Excalidraw canvas</span>
                          <span className="block text-muted-foreground">
                            Show a live whiteboard in the Artifacts pane for
                            flowcharts, architecture, and brainstorming.
                          </span>
                        </span>
                      </label>

                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <label
                            htmlFor="pack-agent"
                            className="text-sm font-medium"
                          >
                            Agent instructions
                          </label>
                          <Tooltip>
                            <TooltipTrigger
                              type="button"
                              disabled={busy || enhancing || loading}
                              onClick={() => void handleEnhance()}
                              aria-label="Enhance agent instructions"
                              className="inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                            >
                              {enhancing ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <Sparkles className="size-3.5" />
                              )}
                              Enhance
                            </TooltipTrigger>
                            <TooltipContent side="top">
                              Rewrite your notes into a clear agent.md (role,
                              loop, tools, constraints)
                            </TooltipContent>
                          </Tooltip>
                        </div>
                        <Textarea
                          id="pack-agent"
                          value={agentMd}
                          onChange={(e) => setAgentMd(e.target.value)}
                          disabled={busy || enhancing}
                          className="min-h-28 font-mono text-xs"
                        />
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <label htmlFor="pack-soul" className="text-sm font-medium">
                          Tone{" "}
                          <span className="font-normal text-muted-foreground">
                            (optional)
                          </span>
                        </label>
                        <Textarea
                          id="pack-soul"
                          value={soulMd}
                          onChange={(e) => setSoulMd(e.target.value)}
                          disabled={busy || enhancing}
                          className="min-h-16 font-mono text-xs"
                          placeholder="Short personality / tone notes"
                        />
                      </div>

                      <p className="text-xs text-muted-foreground">
                        Prefer AI-guided authoring? Select{" "}
                        <span className="font-medium text-foreground">
                          Agent Builder
                        </span>{" "}
                        in the sidebar and chat — it can create or update agents
                        for you.
                      </p>
                    </>
                  ) : (
                    <div className="flex flex-col gap-2 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-muted-foreground">Source</span>
                        <span>
                          {source === "builtin" ? "Built-in" : "Custom"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-muted-foreground">
                          Document editor
                        </span>
                        <span>{usesDocument ? "On" : "Off"}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-muted-foreground">
                          Excalidraw canvas
                        </span>
                        <span>{usesCanvas ? "On" : "Off"}</span>
                      </div>
                      {agentMd.trim() ? (
                        <div className="flex flex-col gap-1.5 pt-1">
                          <span className="text-sm font-medium">Instructions</span>
                          <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 font-mono text-xs">
                            {agentMd}
                          </pre>
                        </div>
                      ) : null}
                    </div>
                  )}
                  </TabsContent>

                  <TabsContent value="skills" className="mt-0 flex flex-col gap-3">
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">Agent skills</span>
                      {canEditSkills ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={busy || enhancing}
                          onClick={() =>
                            setSkillEditor({
                              mode: "add",
                              name: "",
                              description: "",
                              content: defaultScopedSkillContent("Untitled skill"),
                              icon: DEFAULT_SKILL_ICON,
                            })
                          }
                        >
                          <Plus className="size-3.5" />
                          Add
                        </Button>
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Custom playbooks for this agent (Agent Builder or added
                      here). Separate from library Skills below.
                    </p>
                    {agentSkills.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No agent-scoped skills on this agent.
                      </p>
                    ) : (
                      <div className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-md border border-border p-1.5">
                        {agentSkills.map((s) => {
                          const SkillIcon = skillIconComponent(s.icon);
                          return (
                            <div
                              key={s.slug}
                              className="flex items-start gap-1 rounded-md hover:bg-muted/60"
                            >
                              <button
                                type="button"
                                onClick={() => {
                                  if (canEditSkills) {
                                    setSkillEditor({
                                      mode: "edit",
                                      originalSlug: s.slug,
                                      name: s.name || s.slug,
                                      description: s.description || "",
                                      content:
                                        s.content ||
                                        defaultScopedSkillContent(
                                          s.name || s.slug,
                                          s.description
                                        ),
                                      icon:
                                        s.icon && isAgentIconId(s.icon)
                                          ? s.icon
                                          : DEFAULT_SKILL_ICON,
                                    });
                                  } else {
                                    setSkillPreview(s);
                                  }
                                }}
                                className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-left text-sm"
                              >
                                <SkillIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate font-medium">
                                    {s.name || s.slug}
                                  </span>
                                  {s.description ? (
                                    <span className="block truncate text-[11px] text-muted-foreground">
                                      {s.description}
                                    </span>
                                  ) : null}
                                </span>
                              </button>
                              {canEditSkills ? (
                                <button
                                  type="button"
                                  aria-label={`Remove ${s.name || s.slug}`}
                                  disabled={busy || enhancing}
                                  onClick={() =>
                                    setAgentSkills((prev) =>
                                      prev.filter((x) => x.slug !== s.slug)
                                    )
                                  }
                                  className="mr-1 mt-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-destructive"
                                >
                                  <Trash2 className="size-3.5" />
                                </button>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium">Predefined skills</span>
                    <p className="text-xs text-muted-foreground">
                      {isAutoAgent
                        ? "Auto Agent has access to every skill in your library and agent playbooks. They are rooted in the system prompt automatically."
                        : (
                          <>
                            Selected skills are rooted in the system prompt. Library
                            and agent skills stay available on demand via{" "}
                            <span className="font-medium text-foreground">/</span> and{" "}
                            <code className="text-[11px]">skills/</code>.
                          </>
                        )}
                    </p>
                    {predefinedSkillOptions.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No skills yet. Create one under Skills in the sidebar.
                      </p>
                    ) : (
                      <div className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded-md border border-border p-1.5">
                        {predefinedSkillOptions.map((s) => {
                          const selected =
                            isAutoAgent || predefinedSkillSlugs.includes(s.slug);
                          const SkillIcon = skillIconComponent(s.icon);
                          if (readOnly && !selected) return null;
                          return (
                            <label
                              key={`${s.origin}-${s.slug}`}
                              className={cn(
                                "flex items-start gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                                readOnly || isAutoAgent
                                  ? "cursor-default"
                                  : "cursor-pointer",
                                selected ? "bg-muted" : "hover:bg-muted/60"
                              )}
                            >
                              {!readOnly && !isAutoAgent ? (
                                <input
                                  type="checkbox"
                                  className="mt-0.5 size-4 rounded border-input"
                                  checked={selected}
                                  onChange={() => togglePredefinedSkill(s.slug)}
                                  disabled={busy || enhancing}
                                />
                              ) : null}
                              <SkillIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                              <span className="min-w-0 flex-1">
                                <span className="flex items-baseline gap-1.5">
                                  <span className="truncate font-medium">
                                    {s.name}
                                  </span>
                                  {s.origin === "agent" && s.agentName ? (
                                    <span className="shrink-0 text-[10px] text-muted-foreground">
                                      {s.agentName}
                                    </span>
                                  ) : null}
                                </span>
                                {s.description ? (
                                  <span className="block truncate text-[11px] text-muted-foreground">
                                    {s.description}
                                  </span>
                                ) : null}
                              </span>
                            </label>
                          );
                        })}
                        {readOnly &&
                        !isAutoAgent &&
                        predefinedSkillSlugs.length === 0 ? (
                          <p className="px-2 py-1 text-xs text-muted-foreground">
                            None selected.
                          </p>
                        ) : null}
                      </div>
                    )}
                  </div>
                  </TabsContent>

                  <TabsContent value="mcp" className="mt-0 flex flex-col gap-3">
                  <div className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium">MCP servers</span>
                    <p className="text-xs text-muted-foreground">
                      {isAutoAgent
                        ? "Auto Agent has access to every MCP server in your library (plus platform MCP such as Firecrawl)."
                        : "Selected servers from your MCP library are available as tools on this agent (in addition to platform MCP such as Firecrawl)."}
                    </p>
                    {mcpServers.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No MCP servers yet. Add one under MCP in the sidebar.
                      </p>
                    ) : (
                      <div className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-md border border-border p-1.5">
                        {mcpServers.map((s) => {
                          const selected =
                            isAutoAgent || mcpServerIds.includes(s.id);
                          if (readOnly && !selected) return null;
                          return (
                            <label
                              key={s.id}
                              className={cn(
                                "flex items-start gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                                readOnly || isAutoAgent
                                  ? "cursor-default"
                                  : "cursor-pointer",
                                selected ? "bg-muted" : "hover:bg-muted/60"
                              )}
                            >
                              {!readOnly && !isAutoAgent ? (
                                <input
                                  type="checkbox"
                                  className="mt-0.5 size-4 rounded border-input"
                                  checked={selected}
                                  onChange={() => toggleMcpServer(s.id)}
                                  disabled={busy || enhancing}
                                />
                              ) : null}
                              <span className="min-w-0 flex-1">
                                <span className="truncate font-medium">
                                  {s.name}
                                </span>
                                <span className="block truncate text-[11px] text-muted-foreground">
                                  {s.is_prebuilt ? "Prebuilt · " : ""}
                                  {s.url}
                                </span>
                              </span>
                            </label>
                          );
                        })}
                        {readOnly &&
                        !isAutoAgent &&
                        mcpServerIds.length === 0 ? (
                          <p className="px-2 py-1 text-xs text-muted-foreground">
                            None selected.
                          </p>
                        ) : null}
                      </div>
                    )}
                  </div>
                  </TabsContent>

                  {error ? (
                    <p className="text-sm text-destructive" role="alert">
                      {error}
                    </p>
                  ) : null}
                </>
              )}
            </div>
          </Tabs>

          <DialogFooter className="mx-0 mb-0 shrink-0">
            <Button
              type="button"
              variant="outline"
              disabled={busy || enhancing}
              onClick={() => onOpenChange(false)}
            >
              {readOnly ? "Close" : "Cancel"}
            </Button>
            {mode === "view" && source === "user" && slug ? (
              <Button
                type="button"
                disabled={busy || loading}
                onClick={() => onRequestEdit?.(slug)}
              >
                Edit
              </Button>
            ) : null}
            {!readOnly ? (
              <Button
                type="button"
                disabled={busy || loading || enhancing}
                onClick={() => void handleSubmit()}
              >
                {busy
                  ? mode === "create"
                    ? "Creating…"
                    : "Saving…"
                  : mode === "create"
                    ? "Create agent"
                    : "Save"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={skillPreview != null}
        onOpenChange={(next) => {
          if (!next) setSkillPreview(null);
        }}
      >
        <DialogContent className="flex max-h-[min(90vh,42rem)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
          <DialogHeader className="shrink-0 border-b px-4 py-3 pr-12 text-left">
            <DialogTitle>
              {skillPreview?.name || skillPreview?.slug || "Skill"}
            </DialogTitle>
            <DialogDescription>
              {skillPreview?.description ||
                "Agent-scoped skill (not in the library Skills list)."}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
            <pre className="whitespace-pre-wrap font-mono text-xs">
              {skillPreview?.content?.trim() ||
                "No content available for this skill."}
            </pre>
          </div>
          <DialogFooter className="mx-0 mb-0 shrink-0">
            <Button type="button" variant="outline" onClick={() => setSkillPreview(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={skillEditor != null}
        onOpenChange={(next) => {
          if (!next) setSkillEditor(null);
        }}
      >
        <DialogContent className="flex max-h-[min(90vh,42rem)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
          <DialogHeader className="shrink-0 border-b px-4 py-3 pr-12 text-left">
            <DialogTitle>
              {skillEditor?.mode === "edit" ? "Edit agent skill" : "Add agent skill"}
            </DialogTitle>
            <DialogDescription>
              Custom playbook stored on this agent (not a library Skill).
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
            {skillEditor ? (
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="agent-skill-name" className="text-sm font-medium">
                    Name
                  </label>
                  <Input
                    id="agent-skill-name"
                    value={skillEditor.name}
                    onChange={(e) =>
                      setSkillEditor((prev) =>
                        prev
                          ? {
                              ...prev,
                              name: e.target.value,
                              content:
                                prev.mode === "add" &&
                                prev.content ===
                                  defaultScopedSkillContent(
                                    prev.name || "Untitled skill",
                                    prev.description
                                  )
                                  ? defaultScopedSkillContent(
                                      e.target.value || "Untitled skill",
                                      prev.description
                                    )
                                  : prev.content,
                            }
                          : prev
                      )
                    }
                    placeholder="e.g. Image brief"
                    autoFocus
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="agent-skill-description"
                    className="text-sm font-medium"
                  >
                    Description
                  </label>
                  <Input
                    id="agent-skill-description"
                    value={skillEditor.description}
                    onChange={(e) =>
                      setSkillEditor((prev) =>
                        prev ? { ...prev, description: e.target.value } : prev
                      )
                    }
                    placeholder="When to use this skill"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="agent-skill-content" className="text-sm font-medium">
                    SKILL.md
                  </label>
                  <Textarea
                    id="agent-skill-content"
                    value={skillEditor.content}
                    onChange={(e) =>
                      setSkillEditor((prev) =>
                        prev ? { ...prev, content: e.target.value } : prev
                      )
                    }
                    className="max-h-[min(50vh,24rem)] min-h-40 overflow-y-auto font-mono text-xs"
                  />
                </div>
              </div>
            ) : null}
          </div>
          <DialogFooter className="mx-0 mb-0 shrink-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => setSkillEditor(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (!skillEditor) return;
                const trimmed = skillEditor.name.trim() || "Untitled skill";
                let nextSlug =
                  skillEditor.mode === "edit" && skillEditor.originalSlug
                    ? skillEditor.originalSlug
                    : slugifySkill(trimmed);
                if (
                  skillEditor.mode === "add" ||
                  (skillEditor.mode === "edit" &&
                    skillEditor.originalSlug !== nextSlug)
                ) {
                  const taken = new Set(
                    agentSkills
                      .filter((s) => s.slug !== skillEditor.originalSlug)
                      .map((s) => s.slug)
                  );
                  let candidate = nextSlug;
                  let n = 2;
                  while (taken.has(candidate)) {
                    candidate = `${nextSlug}-${n}`;
                    n += 1;
                  }
                  nextSlug = candidate;
                }
                const nextSkill: AgentScopedSkill = {
                  slug: nextSlug,
                  name: trimmed,
                  description: skillEditor.description.trim(),
                  content:
                    skillEditor.content.trim() ||
                    defaultScopedSkillContent(
                      trimmed,
                      skillEditor.description
                    ),
                  icon: skillEditor.icon,
                };
                setAgentSkills((prev) => {
                  if (skillEditor.mode === "edit" && skillEditor.originalSlug) {
                    return prev.map((s) =>
                      s.slug === skillEditor.originalSlug ? nextSkill : s
                    );
                  }
                  return [...prev, nextSkill];
                });
                setSkillEditor(null);
              }}
            >
              {skillEditor?.mode === "edit" ? "Save skill" : "Add skill"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
