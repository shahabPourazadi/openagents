"use client";

import { useState } from "react";
import { MessageSquare, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { useApp } from "@/lib/app-state";
import { cn } from "@/lib/utils";

function formatChatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

export function ChatsPane() {
  const {
    threads,
    activeThreadId,
    setActiveThread,
    renameThread,
    deleteThread,
  } = useApp();
  const [renameTarget, setRenameTarget] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const openRename = (id: string, title: string) => {
    setRenameTarget({ id, title });
    setRenameValue(title);
  };

  const commitRename = async () => {
    if (!renameTarget) return;
    const next = renameValue.trim();
    if (!next || next === renameTarget.title) {
      setRenameTarget(null);
      return;
    }
    setRenameBusy(true);
    try {
      await renameThread(renameTarget.id, next);
      setRenameTarget(null);
    } finally {
      setRenameBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      await deleteThread(deleteTarget.id);
      setDeleteTarget(null);
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <>
      <div className="flex h-full flex-col bg-background">
        <div className="flex h-12 shrink-0 items-center border-b px-6">
          <h1 className="text-sm font-semibold tracking-tight">Chats</h1>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-6">
            {threads.length === 0 ? (
              <p className="text-sm text-muted-foreground">No chats yet.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {threads.map((t) => (
                  <li key={t.id}>
                    <div
                      className={cn(
                        "group flex w-full items-center gap-1 rounded-md transition hover:bg-muted",
                        activeThreadId === t.id && "bg-muted"
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => void setActiveThread(t.id)}
                        onDoubleClick={() => openRename(t.id, t.title)}
                        className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left text-sm"
                      >
                        <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{t.title}</span>
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {formatChatTime(t.updated_at)}
                        </span>
                      </button>
                      <DropdownMenu>
                        <DropdownMenuTrigger className="mr-2 inline-flex size-7 items-center justify-center rounded-md opacity-0 hover:bg-background group-hover:opacity-100">
                          <MoreHorizontal className="size-3.5" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => openRename(t.id, t.title)}
                          >
                            <Pencil className="size-3.5" />
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() =>
                              setDeleteTarget({ id: t.id, title: t.title })
                            }
                          >
                            <Trash2 className="size-3.5" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </ScrollArea>
      </div>

      <Dialog
        open={renameTarget != null}
        onOpenChange={(open) => {
          if (!open && !renameBusy) setRenameTarget(null);
        }}
      >
        <DialogContent showCloseButton={!renameBusy}>
          <DialogHeader>
            <DialogTitle>Rename conversation</DialogTitle>
            <DialogDescription>
              Choose a short title for this chat.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commitRename();
              }
            }}
            maxLength={60}
            autoFocus
            disabled={renameBusy}
            aria-label="Conversation title"
          />
          <DialogFooter>
            <Button
              variant="outline"
              disabled={renameBusy}
              onClick={() => setRenameTarget(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={renameBusy || !renameValue.trim()}
              onClick={() => void commitRename()}
            >
              {renameBusy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget != null}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) setDeleteTarget(null);
        }}
      >
        <DialogContent showCloseButton={!deleteBusy}>
          <DialogHeader>
            <DialogTitle>Delete conversation?</DialogTitle>
            <DialogDescription>
              This will permanently delete{" "}
              <span className="font-medium text-foreground">
                {deleteTarget?.title || "this conversation"}
              </span>{" "}
              and its linked document if nothing else uses it. This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={deleteBusy}
              onClick={() => setDeleteTarget(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteBusy}
              onClick={() => void confirmDelete()}
            >
              {deleteBusy ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
