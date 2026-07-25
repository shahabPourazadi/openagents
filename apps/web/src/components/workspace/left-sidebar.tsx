"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {
  FileText,
  HatGlasses,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  PencilRuler,
  Plug,
  Plus,
  Settings,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { OpenAgentsLogo } from "@/components/ui/openagents-logo";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useApp } from "@/lib/app-state";
import { SettingsDialog } from "@/components/workspace/settings-dialog";
import { AgentDialog, type AgentDialogMode } from "@/components/workspace/agent-dialog";
import {
  SkillDialog,
  type SkillDialogMode,
} from "@/components/workspace/skill-dialog";
import {
  McpServerDialog,
  type McpDialogMode,
} from "@/components/workspace/mcp-server-dialog";
import { formatTokens, formatUsd } from "@/components/workspace/context-usage";
import type { McpServer } from "@/lib/app-state";

const THREAD_ROW_PX = 32;
const THREAD_MAX_VISIBLE = 6;

const sidebarVariants = {
  open: { width: "15rem" },
  closed: { width: "3.05rem" },
};

const contentVariants = {
  open: { display: "block", opacity: 1 },
  closed: { display: "block", opacity: 1 },
};

const variants = {
  open: {
    x: 0,
    opacity: 1,
    transition: {
      x: { stiffness: 1000, velocity: -100 },
    },
  },
  closed: {
    x: -20,
    opacity: 0,
    transition: {
      x: { stiffness: 100 },
    },
  },
};

const transitionProps = {
  type: "tween" as const,
  ease: "easeOut" as const,
  duration: 0.2,
  staggerChildren: 0.1,
};

const staggerVariants = {
  open: {
    transition: { staggerChildren: 0.03, delayChildren: 0.02 },
  },
  closed: {
    transition: { staggerChildren: 0.03, staggerDirection: -1 },
  },
};

type LeftSidebarProps = {
  collapsed?: boolean;
  onToggle?: () => void;
};

export function LeftSidebar({ collapsed = false, onToggle }: LeftSidebarProps) {
  const {
    threads,
    activeThreadId,
    sidebarTab,
    setSidebarTab,
    chatsLibraryOpen,
    setChatsLibraryOpen,
    setActiveThread,
    startNewChat,
    renameThread,
    deleteThread,
    accountSpend,
  } = useApp();

  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(
    null
  );
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(
    null
  );
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentDialog, setAgentDialog] = useState<{
    mode: AgentDialogMode;
    slug?: string | null;
  } | null>(null);
  const [skillDialog, setSkillDialog] = useState<{
    mode: SkillDialogMode;
    slug?: string | null;
    agentSlug?: string | null;
  } | null>(null);
  const [mcpDialog, setMcpDialog] = useState<{
    mode: McpDialogMode;
    server?: McpServer | null;
  } | null>(null);
  /** Only Chats expands a nested list in the sidebar. */
  const [chatsSectionOpen, setChatsSectionOpen] = useState(true);

  const isCollapsed = collapsed;
  const visibleThreadCount = Math.min(threads.length, THREAD_MAX_VISIBLE);
  const threadListHeight =
    threads.length === 0 ? 0 : visibleThreadCount * THREAD_ROW_PX;

  /** First click opens the middle list; click again toggles the nested sidebar list. */
  const openChatsSection = () => {
    if (sidebarTab === "chats" && chatsLibraryOpen) {
      setChatsSectionOpen((prev) => !prev);
      return;
    }
    setChatsLibraryOpen(true);
    setChatsSectionOpen(true);
  };

  const openAgentsSection = () => {
    setSidebarTab("agents");
  };

  const openSkillsSection = () => {
    setSidebarTab("skills");
  };

  const openMcpSection = () => {
    setSidebarTab("mcp");
  };

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
      <motion.div
        className="sidebar z-40 h-full shrink-0 border-r"
        initial={false}
        animate={isCollapsed ? "closed" : "open"}
        variants={sidebarVariants}
        transition={transitionProps}
      >
        <motion.div
          className="relative z-40 flex h-full shrink-0 flex-col bg-sidebar text-sidebar-foreground transition-all"
          variants={contentVariants}
        >
          <motion.div
            variants={staggerVariants}
            className="flex h-full flex-col"
            animate={isCollapsed ? "closed" : "open"}
          >
            <div className="flex grow flex-col items-center">
              <div className="flex h-[54px] w-full shrink-0 items-center p-2">
                {isCollapsed ? (
                  <Tooltip>
                    <TooltipTrigger
                      className="group relative inline-flex w-full items-center justify-center"
                      onClick={onToggle}
                      aria-label="Expand sidebar"
                    >
                      <span className="text-base font-bold tracking-tight transition-opacity group-hover:opacity-0">
                        OA
                      </span>
                      <span className="absolute inset-0 inline-flex items-center justify-center rounded-md opacity-0 transition-opacity hover:bg-sidebar-accent group-hover:opacity-100">
                        <PanelLeftOpen className="size-4" />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="right">Expand</TooltipContent>
                  </Tooltip>
                ) : (
                  <div className="flex w-full items-center justify-between gap-1">
                    <motion.div
                      variants={variants}
                      className="min-w-0 overflow-hidden px-1"
                    >
                      <OpenAgentsLogo
                        variant="wide"
                        className="h-[22px] w-auto max-w-full"
                      />
                    </motion.div>
                    <Tooltip>
                      <TooltipTrigger
                        className="inline-flex shrink-0"
                        onClick={onToggle}
                        aria-label="Collapse sidebar"
                      >
                        <span className="inline-flex size-8 items-center justify-center rounded-md hover:bg-sidebar-accent">
                          <PanelLeftClose className="size-4" />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="right">Collapse</TooltipContent>
                    </Tooltip>
                  </div>
                )}
              </div>

              <div className="flex h-full w-full flex-col">
                <div className="flex grow flex-col gap-3 p-2">
                  <div
                    className={cn(
                      "flex flex-col",
                      isCollapsed ? "gap-3" : "gap-1"
                    )}
                  >
                    {isCollapsed && (
                      <Tooltip>
                        <TooltipTrigger
                          className="inline-flex w-full items-center justify-center"
                          onClick={() => {
                            startNewChat();
                          }}
                          aria-label="New chat"
                        >
                          <span className="inline-flex size-8 items-center justify-center rounded-md transition hover:bg-muted hover:text-primary">
                            <Plus className="size-4" />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="right">New chat</TooltipContent>
                      </Tooltip>
                    )}
                    <div className="flex w-full items-center gap-0.5">
                      <button
                        type="button"
                        onClick={openChatsSection}
                        title={isCollapsed ? "Chats" : undefined}
                        className={cn(
                          "flex h-8 min-w-0 flex-1 flex-row items-center rounded-md px-2 py-1.5 transition hover:bg-muted hover:text-primary",
                          sidebarTab === "chats" && "bg-muted text-primary"
                        )}
                      >
                        <MessageSquare className="size-4 shrink-0" />
                        <motion.div variants={variants} className="overflow-hidden">
                          {!isCollapsed && (
                            <span className="ml-2 text-[14px] font-medium leading-none">
                              Chats
                            </span>
                          )}
                        </motion.div>
                      </button>
                      <motion.div variants={variants}>
                        {!isCollapsed && (
                          <button
                            type="button"
                            onClick={() => {
                              startNewChat();
                            }}
                            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                            aria-label="New chat"
                          >
                            <Plus className="size-3.5" />
                          </button>
                        )}
                      </motion.div>
                    </div>

                    {!isCollapsed && chatsSectionOpen && threads.length > 0 && (
                      <motion.div variants={variants} className="overflow-hidden">
                        <div className="pl-2">
                          <ScrollArea
                            className="w-full"
                            style={{ height: threadListHeight }}
                          >
                            <div className="flex flex-col gap-0.5 pr-1">
                              {threads.map((t) => (
                                <div
                                  key={t.id}
                                  className={cn(
                                    "group flex h-8 items-center gap-0.5 rounded-md hover:bg-muted",
                                    activeThreadId === t.id &&
                                      sidebarTab === "chats" &&
                                      !chatsLibraryOpen &&
                                      "bg-muted"
                                  )}
                                >
                                  <button
                                    type="button"
                                    onClick={() => void setActiveThread(t.id)}
                                    onDoubleClick={() => openRename(t.id, t.title)}
                                    className="min-w-0 flex-1 truncate px-2 py-1.5 text-left"
                                  >
                                    <span
                                      className={cn(
                                        "text-[14px] font-small leading-none text-muted-foreground",
                                        activeThreadId === t.id &&
                                          sidebarTab === "chats" &&
                                          !chatsLibraryOpen &&
                                          "text-foreground"
                                      )}
                                    >
                                      {t.title}
                                    </span>
                                  </button>
                                  <DropdownMenu>
                                    <DropdownMenuTrigger className="mr-0.5 inline-flex size-6 items-center justify-center rounded-md opacity-0 hover:bg-background group-hover:opacity-100">
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
                                          setDeleteTarget({
                                            id: t.id,
                                            title: t.title,
                                          })
                                        }
                                      >
                                        <Trash2 className="size-3.5" />
                                        Delete
                                      </DropdownMenuItem>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                </div>
                              ))}
                            </div>
                          </ScrollArea>
                        </div>
                      </motion.div>
                    )}
                  </div>

                  <div className="flex flex-col gap-1">
                    <div className="flex w-full items-center gap-0.5 px-0">
                      <button
                        type="button"
                        onClick={openAgentsSection}
                        title={isCollapsed ? "Agents" : undefined}
                        className={cn(
                          "flex h-8 min-w-0 flex-1 flex-row items-center rounded-md px-2 py-1.5 transition hover:bg-muted hover:text-primary",
                          sidebarTab === "agents" && "bg-muted text-primary"
                        )}
                      >
                        <HatGlasses className="size-4 shrink-0" />
                        <motion.div variants={variants} className="overflow-hidden">
                          {!isCollapsed && (
                            <span className="ml-2 text-[14px] font-medium leading-none">
                              Agents
                            </span>
                          )}
                        </motion.div>
                      </button>
                      <motion.div variants={variants}>
                        {!isCollapsed && (
                          <button
                            type="button"
                            onClick={() => setAgentDialog({ mode: "create" })}
                            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                            aria-label="Create new agent"
                          >
                            <Plus className="size-3.5" />
                          </button>
                        )}
                      </motion.div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-1">
                    <div className="flex w-full items-center gap-0.5 px-0">
                      <button
                        type="button"
                        onClick={openSkillsSection}
                        title={isCollapsed ? "Skills" : undefined}
                        className={cn(
                          "flex h-8 min-w-0 flex-1 flex-row items-center rounded-md px-2 py-1.5 transition hover:bg-muted hover:text-primary",
                          sidebarTab === "skills" && "bg-muted text-primary"
                        )}
                      >
                        <PencilRuler className="size-4 shrink-0" />
                        <motion.div variants={variants} className="overflow-hidden">
                          {!isCollapsed && (
                            <span className="ml-2 text-[14px] font-medium leading-none">
                              Skills
                            </span>
                          )}
                        </motion.div>
                      </button>
                      <motion.div variants={variants}>
                        {!isCollapsed && (
                          <button
                            type="button"
                            onClick={() => setSkillDialog({ mode: "create" })}
                            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                            aria-label="Create new skill"
                          >
                            <Plus className="size-3.5" />
                          </button>
                        )}
                      </motion.div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-1">
                    <div className="flex w-full items-center gap-0.5 px-0">
                      <button
                        type="button"
                        onClick={openMcpSection}
                        title={isCollapsed ? "MCP" : undefined}
                        className={cn(
                          "flex h-8 min-w-0 flex-1 flex-row items-center rounded-md px-2 py-1.5 transition hover:bg-muted hover:text-primary",
                          sidebarTab === "mcp" && "bg-muted text-primary"
                        )}
                      >
                        <Plug className="size-4 shrink-0" />
                        <motion.div variants={variants} className="overflow-hidden">
                          {!isCollapsed && (
                            <span className="ml-2 text-[14px] font-medium leading-none">
                              MCP
                            </span>
                          )}
                        </motion.div>
                      </button>
                      <motion.div variants={variants}>
                        {!isCollapsed && (
                          <button
                            type="button"
                            onClick={() => setMcpDialog({ mode: "create" })}
                            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                            aria-label="Add MCP server"
                          >
                            <Plus className="size-3.5" />
                          </button>
                        )}
                      </motion.div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setSidebarTab("files")}
                    title={isCollapsed ? "Files" : undefined}
                    className={cn(
                      "flex h-8 w-full flex-row items-center rounded-md px-2 py-1.5 transition hover:bg-muted hover:text-primary",
                      sidebarTab === "files" && "bg-muted text-primary"
                    )}
                  >
                    <FileText className="size-4 shrink-0" />
                    <motion.div variants={variants} className="overflow-hidden">
                      {!isCollapsed && (
                        <span className="ml-2 text-sm font-medium">Files</span>
                      )}
                    </motion.div>
                  </button>
                </div>

                <div className="flex flex-col gap-1 p-2">
                  <motion.div variants={variants} className="overflow-hidden">
                    {!isCollapsed && (
                      <div className="space-y-0.5 px-2 py-1">
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <span>Tokens spent</span>
                          <span className="tabular-nums font-medium text-foreground">
                            {formatTokens(accountSpend.total_tokens)}
                          </span>
                        </div>
                        <Tooltip>
                          <TooltipTrigger
                            className="flex w-full cursor-default items-center justify-between text-xs text-muted-foreground"
                            render={<div />}
                          >
                            <span>Cost</span>
                            <span className="text-xs tabular-nums font-medium text-foreground">
                              {formatUsd(accountSpend.total_cost_usd)}
                              {accountSpend.spend_budget_usd != null ? (
                                <span className="text-xs text-muted-foreground">
                                  {" "}
                                  / {formatUsd(accountSpend.spend_budget_usd)}
                                </span>
                              ) : null}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent
                            side="top"
                            className="flex max-w-56 flex-col gap-1 bg-foreground py-2 text-background"
                          >
                            <div className="flex w-full justify-between gap-4">
                              <span>Tokens</span>
                              <span className="tabular-nums">
                                {formatUsd(
                                  accountSpend.token_cost_usd ??
                                    (accountSpend.multimodal_cost_usd != null
                                      ? Math.max(
                                          0,
                                          (accountSpend.total_cost_usd ?? 0) -
                                            (accountSpend.multimodal_cost_usd ??
                                              0)
                                        )
                                      : accountSpend.total_cost_usd)
                                )}
                              </span>
                            </div>
                            <div className="flex w-full justify-between gap-4">
                              <span>Image generation</span>
                              <span className="tabular-nums">
                                {formatUsd(
                                  accountSpend.multimodal_cost_usd ?? 0
                                )}
                              </span>
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    )}
                  </motion.div>
                  <button
                    type="button"
                    onClick={() => setSettingsOpen(true)}
                    title={isCollapsed ? "Settings" : undefined}
                    className="mt-auto flex h-8 w-full flex-row items-center rounded-md px-2 py-1.5 transition hover:bg-muted hover:text-primary"
                  >
                    <Settings className="size-4 shrink-0" />
                    <motion.div variants={variants} className="overflow-hidden">
                      {!isCollapsed && (
                        <span className="ml-2 text-sm font-medium">Settings</span>
                      )}
                    </motion.div>
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      </motion.div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

      <AgentDialog
        open={agentDialog != null}
        mode={agentDialog?.mode ?? "create"}
        slug={agentDialog?.slug}
        onOpenChange={(open) => {
          if (!open) setAgentDialog(null);
        }}
        onRequestEdit={(editSlug) => {
          setAgentDialog({ mode: "edit", slug: editSlug });
        }}
        onSaved={(savedSlug, savedMode) => {
          // After create, open the editor so the user can refine immediately.
          if (savedMode === "create") {
            setAgentDialog({ mode: "edit", slug: savedSlug });
          }
        }}
      />

      <SkillDialog
        open={skillDialog != null}
        mode={skillDialog?.mode ?? "create"}
        slug={skillDialog?.slug}
        agentSlug={skillDialog?.agentSlug}
        onOpenChange={(open) => {
          if (!open) setSkillDialog(null);
        }}
        onSaved={(savedSlug, savedMode) => {
          if (savedMode === "create") {
            setSkillDialog({ mode: "edit", slug: savedSlug });
          }
        }}
      />

      <McpServerDialog
        open={mcpDialog != null}
        mode={mcpDialog?.mode ?? "create"}
        server={mcpDialog?.server}
        onOpenChange={(open) => {
          if (!open) setMcpDialog(null);
        }}
      />

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
              and its linked document if nothing else uses it. This cannot be undone.
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
