"use client";

import { useMemo, useState } from "react";
import { Copy, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SkillDialog,
  type SkillDialogMode,
} from "@/components/workspace/skill-dialog";
import { useApp } from "@/lib/app-state";
import { skillIconComponent } from "@/lib/agent-icons";

type LibrarySkillRow = {
  kind: "library";
  key: string;
  slug: string;
  name: string;
  description?: string;
  icon?: string;
  source: "builtin" | "user";
};

type AgentSkillRow = {
  kind: "agent";
  key: string;
  slug: string;
  name: string;
  description?: string;
  icon?: string;
  agentSlug: string;
  agentName: string;
  agentSource: "builtin" | "user";
};

type SkillRow = LibrarySkillRow | AgentSkillRow;

export function SkillsPane() {
  const {
    skills,
    agents,
    duplicateSkill,
    deleteUserSkill,
    fetchAgentDetail,
    updateUserAgent,
  } = useApp();
  const [busy, setBusy] = useState(false);
  const [deleteSlug, setDeleteSlug] = useState<string | null>(null);
  const [agentSkillDelete, setAgentSkillDelete] = useState<{
    agentSlug: string;
    skillSlug: string;
    name: string;
  } | null>(null);
  const [dialog, setDialog] = useState<{
    mode: SkillDialogMode;
    slug?: string | null;
    agentSlug?: string | null;
  } | null>(null);

  const rows = useMemo(() => {
    const library: LibrarySkillRow[] = skills.map((s) => ({
      kind: "library" as const,
      key: `library-${s.source}-${s.slug}`,
      slug: s.slug,
      name: s.name,
      description: s.description,
      icon: s.icon,
      source: s.source,
    }));
    const agentScoped: AgentSkillRow[] = [];
    for (const agent of agents) {
      for (const s of agent.skills || []) {
        if (!s.slug) continue;
        agentScoped.push({
          kind: "agent",
          key: `agent-${agent.slug}-${s.slug}`,
          slug: s.slug,
          name: s.name || s.slug,
          description: s.description,
          icon: s.icon,
          agentSlug: agent.slug,
          agentName: agent.name,
          agentSource: agent.source,
        });
      }
    }
    return { library, agentScoped };
  }, [skills, agents]);

  const openRow = (row: SkillRow) => {
    if (row.kind === "agent") {
      setDialog({
        mode: row.agentSource === "user" ? "edit" : "view",
        slug: row.slug,
        agentSlug: row.agentSlug,
      });
      return;
    }
    setDialog({
      mode: row.source === "user" ? "edit" : "view",
      slug: row.slug,
      agentSlug: null,
    });
  };

  return (
    <>
      <div className="flex h-full flex-col bg-background">
        <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-6">
          <h1 className="text-sm font-semibold tracking-tight">Skills</h1>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setDialog({ mode: "create" })}
          >
            <Plus className="size-3.5" />
            New
          </Button>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-6">
            {rows.library.length === 0 && rows.agentScoped.length === 0 ? (
              <p className="text-sm text-muted-foreground">No skills yet.</p>
            ) : (
              <>
                <section className="flex flex-col gap-2">
                  <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Library
                  </h2>
                  {rows.library.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No library skills yet. Use New or /create-skill.
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {rows.library.map((s) => {
                        const SkillIcon = skillIconComponent(s.icon);
                        return (
                          <li key={s.key}>
                            <div className="group flex w-full items-center gap-1 rounded-md transition hover:bg-muted">
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => openRow(s)}
                                className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left text-sm"
                                title={s.description || s.name}
                              >
                                <SkillIcon className="size-4 shrink-0 text-muted-foreground" />
                                <span className="min-w-0 flex-1 truncate">
                                  {s.name}
                                </span>
                                <span className="shrink-0 text-xs text-muted-foreground">
                                  {s.source === "builtin" ? "Built-in" : "Custom"}
                                </span>
                              </button>
                              <DropdownMenu>
                                <DropdownMenuTrigger className="mr-2 inline-flex size-7 items-center justify-center rounded-md opacity-0 hover:bg-background group-hover:opacity-100">
                                  <MoreHorizontal className="size-3.5" />
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem
                                    onClick={() =>
                                      setDialog({
                                        mode: "view",
                                        slug: s.slug,
                                      })
                                    }
                                  >
                                    <Pencil className="size-3.5" />
                                    View
                                  </DropdownMenuItem>
                                  {s.source === "user" && (
                                    <DropdownMenuItem
                                      onClick={() =>
                                        setDialog({
                                          mode: "edit",
                                          slug: s.slug,
                                        })
                                      }
                                    >
                                      <Pencil className="size-3.5" />
                                      Edit
                                    </DropdownMenuItem>
                                  )}
                                  <DropdownMenuItem
                                    onClick={() => {
                                      void (async () => {
                                        setBusy(true);
                                        try {
                                          const dup = await duplicateSkill(s.slug);
                                          if (dup) {
                                            setDialog({
                                              mode: "edit",
                                              slug: dup.slug,
                                            });
                                          }
                                        } finally {
                                          setBusy(false);
                                        }
                                      })();
                                    }}
                                  >
                                    <Copy className="size-3.5" />
                                    Duplicate
                                  </DropdownMenuItem>
                                  {s.source === "user" && (
                                    <DropdownMenuItem
                                      variant="destructive"
                                      onClick={() => setDeleteSlug(s.slug)}
                                    >
                                      <Trash2 className="size-3.5" />
                                      Delete
                                    </DropdownMenuItem>
                                  )}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>

                {rows.agentScoped.length > 0 ? (
                  <section className="flex flex-col gap-2">
                    <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Agent skills
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      Playbooks on an agent. Custom agents can edit or delete
                      these; built-in agent skills are read-only.
                    </p>
                    <ul className="flex flex-col gap-1">
                      {rows.agentScoped.map((s) => {
                        const SkillIcon = skillIconComponent(s.icon);
                        return (
                          <li key={s.key}>
                            <div className="group flex w-full items-center gap-1 rounded-md transition hover:bg-muted">
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => openRow(s)}
                                className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left text-sm"
                                title={s.description || s.name}
                              >
                                <SkillIcon className="size-4 shrink-0 text-muted-foreground" />
                                <span className="min-w-0 flex-1 truncate">
                                  {s.name}
                                </span>
                                <span className="shrink-0 truncate text-xs text-muted-foreground">
                                  {s.agentName}
                                </span>
                              </button>
                              <DropdownMenu>
                                <DropdownMenuTrigger className="mr-2 inline-flex size-7 items-center justify-center rounded-md opacity-0 hover:bg-background group-hover:opacity-100">
                                  <MoreHorizontal className="size-3.5" />
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem
                                    onClick={() =>
                                      setDialog({
                                        mode: "view",
                                        slug: s.slug,
                                        agentSlug: s.agentSlug,
                                      })
                                    }
                                  >
                                    <Pencil className="size-3.5" />
                                    View
                                  </DropdownMenuItem>
                                  {s.agentSource === "user" && (
                                    <>
                                      <DropdownMenuItem
                                        onClick={() =>
                                          setDialog({
                                            mode: "edit",
                                            slug: s.slug,
                                            agentSlug: s.agentSlug,
                                          })
                                        }
                                      >
                                        <Pencil className="size-3.5" />
                                        Edit
                                      </DropdownMenuItem>
                                      <DropdownMenuItem
                                        variant="destructive"
                                        onClick={() =>
                                          setAgentSkillDelete({
                                            agentSlug: s.agentSlug,
                                            skillSlug: s.slug,
                                            name: s.name,
                                          })
                                        }
                                      >
                                        <Trash2 className="size-3.5" />
                                        Delete
                                      </DropdownMenuItem>
                                    </>
                                  )}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ) : null}
              </>
            )}
          </div>
        </ScrollArea>
      </div>

      <SkillDialog
        open={dialog != null}
        mode={dialog?.mode ?? "create"}
        slug={dialog?.slug}
        agentSlug={dialog?.agentSlug}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        onSaved={(savedSlug, savedMode) => {
          if (savedMode === "create") {
            setDialog({ mode: "edit", slug: savedSlug });
          }
        }}
      />

      <Dialog
        open={deleteSlug != null}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleteSlug(null);
        }}
      >
        <DialogContent showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>Delete skill?</DialogTitle>
            <DialogDescription>
              This permanently deletes the user skill{" "}
              <span className="font-medium text-foreground">{deleteSlug}</span>.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setDeleteSlug(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy || !deleteSlug}
              onClick={() => {
                void (async () => {
                  if (!deleteSlug) return;
                  setBusy(true);
                  try {
                    await deleteUserSkill(deleteSlug);
                    setDeleteSlug(null);
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              {busy ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={agentSkillDelete != null}
        onOpenChange={(open) => {
          if (!open && !busy) setAgentSkillDelete(null);
        }}
      >
        <DialogContent showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>Delete agent skill?</DialogTitle>
            <DialogDescription>
              This removes{" "}
              <span className="font-medium text-foreground">
                {agentSkillDelete?.name || "this skill"}
              </span>{" "}
              from the agent. It is not a library skill.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setAgentSkillDelete(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy || !agentSkillDelete}
              onClick={() => {
                void (async () => {
                  if (!agentSkillDelete) return;
                  setBusy(true);
                  try {
                    const detail = await fetchAgentDetail(
                      agentSkillDelete.agentSlug
                    );
                    if (!detail) throw new Error("Could not load agent");
                    const nextSkills = (detail.skills || [])
                      .filter((s) => s.slug !== agentSkillDelete.skillSlug)
                      .map((s) => ({
                        slug: s.slug,
                        name: s.name,
                        description: s.description,
                        content: s.content,
                        icon: s.icon,
                      }));
                    await updateUserAgent(agentSkillDelete.agentSlug, {
                      skills: nextSkills,
                    });
                    setAgentSkillDelete(null);
                  } catch (err) {
                    console.error("Failed to delete agent skill:", err);
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              {busy ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
