"use client";

import { useState } from "react";
import { BookOpen, MoreHorizontal, Pencil, Plus, Trash2, Plug } from "lucide-react";
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
  McpServerDialog,
  type McpDialogMode,
} from "@/components/workspace/mcp-server-dialog";
import { useApp, type McpServer } from "@/lib/app-state";

export function McpPane() {
  const { mcpServers, deleteMcpServer } = useApp();
  const [busy, setBusy] = useState(false);
  const [deleteMcpId, setDeleteMcpId] = useState<string | null>(null);
  const [mcpDialog, setMcpDialog] = useState<{
    mode: McpDialogMode;
    server?: McpServer | null;
  } | null>(null);

  return (
    <>
      <div className="flex h-full flex-col bg-background">
        <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-6">
          <h1 className="text-sm font-semibold tracking-tight">MCP</h1>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setMcpDialog({ mode: "create" })}
          >
            <Plus className="size-3.5" />
            New
          </Button>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-6">
            <section className="flex flex-col gap-2">
              <p className="text-sm text-muted-foreground">
                Connect HTTP/SSE Model Context Protocol servers as tools for your
                agents. Skills are separate — they are playbooks, not tools.
              </p>
              <p className="text-xs text-muted-foreground">
                <BookOpen className="mr-1 inline size-3.5 align-text-bottom" />
                MCP lets agents call external tools over HTTP. Full guide:{" "}
                <code className="text-[11px]">docs/mcp.md</code> in the repo.
              </p>
            </section>

            <section className="flex flex-col gap-2">
              <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Your servers
              </h2>
              {mcpServers.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No MCP servers yet. Use New to add one (fields, paste JSON, or
                  set up with AI).
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {mcpServers.map((s) => (
                    <li key={s.id}>
                      <div className="group flex w-full items-center gap-1 rounded-md transition hover:bg-muted">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            setMcpDialog({ mode: "edit", server: s })
                          }
                          className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left text-sm"
                          title={s.url}
                        >
                          <Plug className="size-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate">
                            {s.name}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {s.is_prebuilt
                              ? "Prebuilt"
                              : s.has_token
                                ? "Token"
                                : s.auth_mode}
                          </span>
                        </button>
                        <DropdownMenu>
                          <DropdownMenuTrigger className="mr-2 inline-flex size-7 items-center justify-center rounded-md opacity-0 hover:bg-background group-hover:opacity-100">
                            <MoreHorizontal className="size-3.5" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() =>
                                setMcpDialog({ mode: "edit", server: s })
                              }
                            >
                              <Pencil className="size-3.5" />
                              Edit
                            </DropdownMenuItem>
                            {!s.is_prebuilt ? (
                              <DropdownMenuItem
                                variant="destructive"
                                onClick={() => setDeleteMcpId(s.id)}
                              >
                                <Trash2 className="size-3.5" />
                                Delete
                              </DropdownMenuItem>
                            ) : null}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="flex flex-col gap-2 border-t pt-4">
              <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                How it works
              </h2>
              <ul className="list-disc space-y-1.5 pl-4 text-sm text-muted-foreground">
                <li>
                  Add a server with form fields, paste JSON, or Set up with AI.
                  Only HTTP/SSE URLs are supported (no local command/stdio).
                </li>
                <li>
                  Test runs connect + list tools. Save is allowed only after a
                  successful test. Tokens are encrypted at rest.
                </li>
                <li>
                  OpenRouter is prebuilt. Auth defaults to your Settings
                  OpenRouter key; you can override with a dedicated token.
                </li>
                <li>
                  Attach servers per agent in the agent editor (MCP servers
                  checkboxes). Platform MCP (e.g. Firecrawl from env) still
                  merges when MCP tools are enabled.
                </li>
              </ul>
              <p className="text-xs text-muted-foreground">
                Full reference: see <code className="text-[11px]">docs/mcp.md</code>{" "}
                in the repo.
              </p>
            </section>
          </div>
        </ScrollArea>
      </div>

      <McpServerDialog
        open={mcpDialog != null}
        mode={mcpDialog?.mode ?? "create"}
        server={mcpDialog?.server}
        onOpenChange={(open) => {
          if (!open) setMcpDialog(null);
        }}
      />

      <Dialog
        open={deleteMcpId != null}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleteMcpId(null);
        }}
      >
        <DialogContent showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>Delete MCP server?</DialogTitle>
            <DialogDescription>
              This removes the server from your library. Agents that attached it
              will stop receiving its tools.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setDeleteMcpId(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy || !deleteMcpId}
              onClick={() => {
                void (async () => {
                  if (!deleteMcpId) return;
                  setBusy(true);
                  try {
                    await deleteMcpServer(deleteMcpId);
                    setDeleteMcpId(null);
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
