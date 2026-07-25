"use client";

import { useEffect, useState } from "react";
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
import { useApp, type SkillDetail } from "@/lib/app-state";
import {
  AGENT_ICON_OPTIONS,
  DEFAULT_SKILL_ICON,
  isAgentIconId,
  type AgentIconId,
} from "@/lib/agent-icons";
import { cn } from "@/lib/utils";

export type SkillDialogMode = "create" | "edit" | "view";

type SkillDialogProps = {
  open: boolean;
  mode: SkillDialogMode;
  /** Required when mode is "edit" or "view". */
  slug?: string | null;
  /**
   * When set, load/save this skill on the agent's scoped playbooks instead of
   * the library `/api/skills` list.
   */
  agentSlug?: string | null;
  onOpenChange: (open: boolean) => void;
  onSaved?: (slug: string, mode: SkillDialogMode) => void;
};

function defaultSkillContent(name: string, description: string = "") {
  const title = name.trim() || "Untitled skill";
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "untitled-skill";
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

## Examples

Add a concrete example if it helps.
`;
}

export function SkillDialog({
  open,
  mode,
  slug,
  agentSlug,
  onOpenChange,
  onSaved,
}: SkillDialogProps) {
  const {
    createUserSkill,
    updateUserSkill,
    fetchSkillDetail,
    fetchAgentDetail,
    updateUserAgent,
    agents,
  } = useApp();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState<AgentIconId>(DEFAULT_SKILL_ICON);
  const [content, setContent] = useState(defaultSkillContent("Untitled skill"));
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agentIsUser =
    !agentSlug ||
    agents.find((a) => a.slug === agentSlug)?.source === "user";
  const readOnly =
    mode === "view" || (Boolean(agentSlug) && !agentIsUser);

  useEffect(() => {
    if (!open) return;
    setError(null);

    if (mode === "create") {
      setName("");
      setDescription("");
      setIcon(DEFAULT_SKILL_ICON);
      setContent(defaultSkillContent("Untitled skill"));
      setLoading(false);
      return;
    }

    if (!slug) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        if (agentSlug) {
          const agent = await fetchAgentDetail(agentSlug);
          if (cancelled) return;
          const scoped = agent?.skills?.find((s) => s.slug === slug);
          if (!scoped) {
            setError("Could not load this agent skill.");
            return;
          }
          applyDetail({
            slug: scoped.slug,
            name: scoped.name || scoped.slug,
            description: scoped.description || "",
            icon: scoped.icon || "",
            source: "user",
            content: scoped.content || "",
          });
          return;
        }
        const detail = await fetchSkillDetail(slug);
        if (cancelled) return;
        if (!detail) {
          setError("Could not load this skill.");
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
  }, [open, mode, slug, agentSlug, fetchSkillDetail, fetchAgentDetail]);

  function applyDetail(detail: SkillDetail) {
    setName(detail.name || "");
    setDescription(detail.description || "");
    setIcon(
      detail.icon && isAgentIconId(detail.icon)
        ? detail.icon
        : DEFAULT_SKILL_ICON
    );
    setContent(
      detail.content ||
        defaultSkillContent(detail.name || "Skill", detail.description || "")
    );
  }

  async function handleSubmit() {
    setBusy(true);
    setError(null);
    try {
      if (mode === "create") {
        const created = await createUserSkill({
          name: name.trim() || "Untitled skill",
          description: description.trim(),
          icon,
          content: content.trim() || defaultSkillContent(name, description),
        });
        if (!created) {
          setError("Failed to create skill.");
          return;
        }
        onSaved?.(created.slug, "create");
        onOpenChange(false);
        return;
      }
      if (mode === "view" || readOnly) {
        onOpenChange(false);
        return;
      }
      if (!slug) {
        setError("Missing skill slug.");
        return;
      }

      if (agentSlug) {
        const detail = await fetchAgentDetail(agentSlug);
        if (!detail) {
          setError("Could not load agent.");
          return;
        }
        const nextSkills = (detail.skills || []).map((s) =>
          s.slug === slug
            ? {
                slug: s.slug,
                name: name.trim() || s.name || s.slug,
                description: description.trim(),
                icon,
                content: content.trim(),
              }
            : {
                slug: s.slug,
                name: s.name,
                description: s.description,
                content: s.content,
                icon: s.icon,
              }
        );
        const updated = await updateUserAgent(agentSlug, { skills: nextSkills });
        if (!updated) {
          setError("Failed to save agent skill.");
          return;
        }
        onSaved?.(slug, "edit");
        onOpenChange(false);
        return;
      }

      const updated = await updateUserSkill(slug, {
        name: name.trim() || "Untitled skill",
        description: description.trim(),
        icon,
        content: content.trim(),
      });
      if (!updated) {
        setError("Failed to save skill.");
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
    mode === "create"
      ? "New skill"
      : mode === "view"
        ? name || "Skill"
        : "Edit skill";
  const descriptionText =
    mode === "create"
      ? "Author a SKILL.md playbook the agent can load on demand. Start from create-skill if you want a guided checklist."
      : agentSlug
        ? mode === "view"
          ? "Agent-scoped playbook (not a library Skill)."
          : "Update this agent-scoped playbook. Changes apply on the next agent turn."
        : mode === "view"
          ? "Built-in skills are read-only. Duplicate to customize."
          : "Update this library skill. Changes apply on the next agent turn.";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[min(90vh,42rem)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
        showCloseButton={!busy}
      >
        <DialogHeader className="shrink-0 border-b px-4 py-3 pr-12 text-left">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{descriptionText}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading skill…</p>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="skill-name" className="text-sm font-medium">
                  Name
                </label>
                <Input
                  id="skill-name"
                  value={name}
                  onChange={(e) => {
                    const next = e.target.value;
                    setName(next);
                    if (
                      mode === "create" &&
                      content ===
                        defaultSkillContent(name || "Untitled skill", description)
                    ) {
                      setContent(
                        defaultSkillContent(next || "Untitled skill", description)
                      );
                    }
                  }}
                  placeholder="e.g. Research synthesis"
                  disabled={busy || readOnly}
                  autoFocus={!readOnly}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="skill-description" className="text-sm font-medium">
                  Description
                </label>
                <Input
                  id="skill-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Short blurb for when to load this skill"
                  disabled={busy || readOnly}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Icon</span>
                <div
                  className="grid grid-cols-5 gap-1.5 sm:grid-cols-10"
                  role="radiogroup"
                  aria-label="Skill icon"
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
                        disabled={busy || readOnly}
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

              <div className="flex flex-col gap-1.5">
                <label htmlFor="skill-content" className="text-sm font-medium">
                  SKILL.md
                </label>
                <Textarea
                  id="skill-content"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  disabled={busy || readOnly}
                  className="max-h-[min(50vh,24rem)] min-h-40 overflow-y-auto font-mono text-xs"
                />
              </div>

              {error ? (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
          )}
        </div>

        <DialogFooter className="mx-0 mb-0 shrink-0">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {readOnly ? "Close" : "Cancel"}
          </Button>
          {!readOnly && (
            <Button
              type="button"
              disabled={busy || loading}
              onClick={() => void handleSubmit()}
            >
              {busy
                ? mode === "create"
                  ? "Creating…"
                  : "Saving…"
                : mode === "create"
                  ? "Create skill"
                  : "Save"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
