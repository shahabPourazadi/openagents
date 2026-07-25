"use client";

import { useState } from "react";
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
import { AgentDialog, type AgentDialogMode } from "@/components/workspace/agent-dialog";
import { useApp } from "@/lib/app-state";
import { agentIconComponent } from "@/lib/agent-icons";
import { cn } from "@/lib/utils";

export function AgentsPane() {
  const {
    agents,
    activeAgentSlug,
    setThreadAgent,
    duplicateAgent,
    deleteUserAgent,
  } = useApp();
  const [busy, setBusy] = useState(false);
  const [deleteSlug, setDeleteSlug] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{
    mode: AgentDialogMode;
    slug?: string | null;
  } | null>(null);

  return (
    <>
      <div className="flex h-full flex-col bg-background">
        <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-6">
          <h1 className="text-sm font-semibold tracking-tight">Agents</h1>
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
            {agents.length === 0 ? (
              <p className="text-sm text-muted-foreground">No agents yet.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {agents.map((p) => {
                  const AgentIcon = agentIconComponent(p.icon);
                  const skillCount = p.skills?.length ?? 0;
                  return (
                    <li key={`${p.source}-${p.slug}`}>
                      <div
                        className={cn(
                          "group flex w-full items-center gap-1 rounded-md transition hover:bg-muted",
                          activeAgentSlug === p.slug && "bg-muted"
                        )}
                      >
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            setDialog({ mode: "view", slug: p.slug })
                          }
                          className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left text-sm"
                          title={p.description || p.name}
                        >
                          <AgentIcon className="size-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate">{p.name}</span>
                          {skillCount > 0 ? (
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {skillCount} skill{skillCount === 1 ? "" : "s"}
                            </span>
                          ) : null}
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {p.source === "builtin" ? "Built-in" : "Custom"}
                          </span>
                        </button>
                        <DropdownMenu>
                          <DropdownMenuTrigger className="mr-2 inline-flex size-7 items-center justify-center rounded-md opacity-0 hover:bg-background group-hover:opacity-100">
                            <MoreHorizontal className="size-3.5" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() =>
                                setDialog({ mode: "view", slug: p.slug })
                              }
                            >
                              <Pencil className="size-3.5" />
                              View
                            </DropdownMenuItem>
                            {p.source === "user" && (
                              <DropdownMenuItem
                                onClick={() =>
                                  setDialog({ mode: "edit", slug: p.slug })
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
                                    const dup = await duplicateAgent(p.slug);
                                    if (dup) {
                                      await setThreadAgent(dup.slug);
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
                            {p.source === "user" && (
                              <DropdownMenuItem
                                variant="destructive"
                                onClick={() => setDeleteSlug(p.slug)}
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
          </div>
        </ScrollArea>
      </div>

      <AgentDialog
        open={dialog != null}
        mode={dialog?.mode ?? "create"}
        slug={dialog?.slug}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        onRequestEdit={(editSlug) => {
          setDialog({ mode: "edit", slug: editSlug });
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
            <DialogTitle>Delete agent?</DialogTitle>
            <DialogDescription>
              This permanently deletes the user agent{" "}
              <span className="font-medium text-foreground">{deleteSlug}</span>.
              Workspaces using it should switch to another agent.
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
                    await deleteUserAgent(deleteSlug);
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
    </>
  );
}
