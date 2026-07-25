"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDefaultLayout, usePanelRef } from "react-resizable-panels";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { AppProvider, useApp, type AgentKind } from "@/lib/app-state";
import { LeftSidebar } from "@/components/workspace/left-sidebar";
import { ChatPane } from "@/components/workspace/chat-pane";
import { ChatsPane } from "@/components/workspace/chats-pane";
import { AgentsPane } from "@/components/workspace/agents-pane";
import { SkillsPane } from "@/components/workspace/skills-pane";
import { McpPane } from "@/components/workspace/mcp-pane";
import { FilesPane } from "@/components/workspace/files-pane";
import { EditorPane } from "@/components/workspace/editor-pane";
import { DotmSquare1 } from "@/components/ui/dotm-square-1";
import { cn } from "@/lib/utils";

const RIGHT_COLLAPSED_PX = 0;
const LAYOUT_ID = "openagents-workspace-panels-v2";
/** Session key for the user's preferred editor width while the panel stays open. */
const RIGHT_SIZE_SESSION_KEY = "openagents-editor-panel-size";

/** Avoid SSR crash: useDefaultLayout defaults `storage` to `localStorage`. */
const panelLayoutStorage = {
  getItem(name: string) {
    try {
      return window.localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem(name: string, value: string) {
    try {
      window.localStorage.setItem(name, value);
    } catch {
      // ignore quota / private mode
    }
  },
};

function ShellInner() {
  const { loading } = useApp();
  const rightPanelRef = usePanelRef();
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(true);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (loading || !mounted) {
    return (
      <div
        className="flex h-svh items-center justify-center gap-2 bg-background text-sm text-muted-foreground"
        style={{ ["--color-dot-on" as string]: "currentColor" }}
      >
        <DotmSquare1
          size={20}
          dotSize={3}
          speed={1.1}
          pattern="full"
          colorPreset="solid-theme"
          animated
          opacityBase={0.12}
          opacityMid={0.42}
          opacityPeak={1}
          ariaLabel="Loading workspace"
        />
        Loading workspace…
      </div>
    );
  }

  return (
    <WorkspacePanels
      rightPanelRef={rightPanelRef}
      leftCollapsed={leftCollapsed}
      setLeftCollapsed={setLeftCollapsed}
      rightCollapsed={rightCollapsed}
      setRightCollapsed={setRightCollapsed}
    />
  );
}

function WorkspacePanels({
  rightPanelRef,
  leftCollapsed,
  setLeftCollapsed,
  rightCollapsed,
  setRightCollapsed,
}: {
  rightPanelRef: ReturnType<typeof usePanelRef>;
  leftCollapsed: boolean;
  setLeftCollapsed: (v: boolean) => void;
  rightCollapsed: boolean;
  setRightCollapsed: (v: boolean) => void;
}) {
  const { setOnNewChat, sidebarTab, chatsLibraryOpen, workspace } = useApp();
  const usesDocument = workspace?.uses_document !== false;
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: LAYOUT_ID,
    panelIds: ["chat", "right"],
    storage: panelLayoutStorage,
  });

  /** After close, next Artifacts open uses a fresh equal split (not the last drag size). */
  const resetToEqualOnOpenRef = useRef(true);
  /** Temporary CSS transition for programmatic open/close (not while dragging). */
  const [layoutAnimating, setLayoutAnimating] = useState(false);
  const layoutAnimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const beginLayoutAnimation = useCallback(() => {
    setLayoutAnimating(true);
    if (layoutAnimTimerRef.current) clearTimeout(layoutAnimTimerRef.current);
    layoutAnimTimerRef.current = setTimeout(() => {
      setLayoutAnimating(false);
      layoutAnimTimerRef.current = null;
    }, 320);
  }, []);

  useEffect(() => {
    return () => {
      if (layoutAnimTimerRef.current) clearTimeout(layoutAnimTimerRef.current);
    };
  }, []);

  const openDocumentPanel = useCallback(() => {
    const right = rightPanelRef.current;
    if (!right) return;

    let target = 50;

    // Only restore a resized width if the panel was never closed this session.
    if (!resetToEqualOnOpenRef.current) {
      try {
        const saved = sessionStorage.getItem(RIGHT_SIZE_SESSION_KEY);
        if (saved) {
          const n = Number(saved);
          if (Number.isFinite(n) && n >= 20) target = n;
        }
      } catch {
        // ignore
      }
    }

    resetToEqualOnOpenRef.current = false;
    beginLayoutAnimation();
    // Double rAF: wait until the transition class is painted, then resize.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        right.resize(`${target}%`);
        setRightCollapsed(false);
      });
    });
  }, [rightPanelRef, beginLayoutAnimation, setRightCollapsed]);

  const closeDocumentPanel = useCallback(() => {
    // Next Artifacts click starts equal again.
    resetToEqualOnOpenRef.current = true;
    try {
      sessionStorage.removeItem(RIGHT_SIZE_SESSION_KEY);
    } catch {
      // ignore
    }
    beginLayoutAnimation();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        rightPanelRef.current?.collapse();
        setRightCollapsed(true);
      });
    });
  }, [rightPanelRef, beginLayoutAnimation, setRightCollapsed]);

  const onRightResize = useCallback(() => {
    const right = rightPanelRef.current;
    if (!right) return;
    const collapsed = right.isCollapsed();
    setRightCollapsed(collapsed);
    if (collapsed || resetToEqualOnOpenRef.current) return;
    // Remember desired width while the editor stays open.
    try {
      sessionStorage.setItem(
        RIGHT_SIZE_SESSION_KEY,
        String(right.getSize().asPercentage)
      );
    } catch {
      // ignore
    }
  }, [rightPanelRef, setRightCollapsed]);

  useEffect(() => {
    setOnNewChat(() => {
      closeDocumentPanel();
    });
    return () => setOnNewChat(null);
  }, [setOnNewChat, closeDocumentPanel]);

  useEffect(() => {
    if (!usesDocument) {
      closeDocumentPanel();
    }
  }, [usesDocument, closeDocumentPanel]);

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      setRightCollapsed(!!rightPanelRef.current?.isCollapsed());
    });
    return () => cancelAnimationFrame(id);
  }, [defaultLayout, rightPanelRef, setRightCollapsed]);

  const hasSavedLayout = defaultLayout != null;
  const panelTransitionClass = layoutAnimating
    ? "transition-[flex-grow] duration-300 ease-out"
    : undefined;

  let middlePanel;
  if (sidebarTab === "files") {
    middlePanel = <FilesPane />;
  } else if (sidebarTab === "agents") {
    middlePanel = <AgentsPane />;
  } else if (sidebarTab === "skills") {
    middlePanel = <SkillsPane />;
  } else if (sidebarTab === "mcp") {
    middlePanel = <McpPane />;
  } else if (sidebarTab === "chats" && chatsLibraryOpen) {
    middlePanel = <ChatsPane />;
  } else if (usesDocument) {
    middlePanel = (
      <ResizablePanelGroup
        orientation="horizontal"
        className="h-full"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
      >
        <ResizablePanel
          id="chat"
          defaultSize={hasSavedLayout ? undefined : "100%"}
          minSize={280}
          className={cn("min-w-0 overflow-hidden", panelTransitionClass)}
        >
          <ChatPane
            documentCollapsed={rightCollapsed}
            onOpenDocument={openDocumentPanel}
          />
        </ResizablePanel>
        <ResizableHandle
          withHandle
          className={
            rightCollapsed ? "pointer-events-none opacity-0" : undefined
          }
        />
        <ResizablePanel
          id="right"
          panelRef={rightPanelRef}
          collapsible
          collapsedSize={RIGHT_COLLAPSED_PX}
          defaultSize={hasSavedLayout ? undefined : 0}
          minSize={280}
          className={cn("min-w-0 overflow-hidden", panelTransitionClass)}
          onResize={onRightResize}
        >
          <EditorPane
            collapsed={rightCollapsed}
            onToggle={closeDocumentPanel}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    );
  } else {
    middlePanel = (
      <div className="h-full min-w-0 overflow-hidden">
        <ChatPane documentCollapsed onOpenDocument={() => {}} />
      </div>
    );
  }

  return (
    <div className="flex h-svh w-full overflow-hidden">
      <LeftSidebar
        collapsed={leftCollapsed}
        onToggle={() => setLeftCollapsed(!leftCollapsed)}
      />
      <div className="min-w-0 flex-1 overflow-hidden">{middlePanel}</div>
    </div>
  );
}

export function AppShell({
  agentKind = "deep",
}: {
  agentKind?: AgentKind;
}) {
  return (
    <AppProvider agentKind={agentKind}>
      <ShellInner />
    </AppProvider>
  );
}
