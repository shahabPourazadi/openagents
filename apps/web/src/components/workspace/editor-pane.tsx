"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import { MantineProvider } from "@mantine/core";
import { filterSuggestionItems } from "@blocknote/core";
import {
  FormattingToolbar,
  FormattingToolbarController,
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
  getFormattingToolbarItems,
  useCreateBlockNote,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import "@mantine/core/styles.css";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  getAuthHeaders,
  getMessageParts,
  useApp,
  type Document,
  type WorkspaceFile,
} from "@/lib/app-state";
import {
  editorSchema,
  promoteMermaidCodeBlocks,
} from "@/lib/editor-schema";
import { DocumentMap } from "@/components/workspace/document-map";
import { FileExpandButton } from "@/components/workspace/file-expand-button";
import { InlineDiffView } from "@/components/workspace/inline-diff-view";
import { ExportDocumentButton } from "@/components/workspace/export-document-button";
import { CanvasEditor } from "@/components/workspace/canvas-editor";
import { insertMermaidSlashItem } from "@/components/workspace/mermaid-editor-block";
import { ReviewChangesDialog } from "@/components/workspace/review-changes-dialog";
import { AssetPreview } from "@/components/workspace/asset-preview";
import {
  collectWorkspaceAssetPaths,
  resolveWorkspaceMediaUrl,
} from "@/lib/workspace-media";
import {
  FileTreeFromItems,
  type FileTreeNodeData,
} from "@/components/ui/file-tree";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

function EditorFormattingToolbar() {
  return (
    <FormattingToolbar>
      {...getFormattingToolbarItems()}
      <FileExpandButton key="fileExpandButton" />
    </FormattingToolbar>
  );
}

type EditorPaneProps = {
  onToggle?: () => void;
  /** When true, the document panel is collapsed — skip mounting BlockNote (no TipTap view). */
  collapsed?: boolean;
};

type PaneMode = "document" | "canvas" | "resources";

type ResourceItem =
  | {
      kind: "document";
      id: string;
      label: string;
      section: "document";
    }
  | {
      kind: "workspace_file";
      id: string;
      label: string;
      section: "research";
    }
  | { kind: "asset"; path: string; label: string; section: "assets" }
  | {
      kind: "upload";
      path: string;
      label: string;
      contentType: string;
      filename: string;
      section: "uploads";
    };

function artifactLabel(path: string) {
  return path
    .replace(/^research\/[^/]+\//, "")
    .replace(/^(research|memory)\//, "");
}

function resourceKey(item: ResourceItem) {
  if (item.kind === "document") return `doc-${item.id}`;
  if (item.kind === "workspace_file") return `file-${item.id}`;
  if (item.kind === "asset") return `asset-${item.path}`;
  return `upload-${item.path}`;
}

/** Nest asset paths like diagrams/foo.png into folder → file nodes. */
function buildPathTree(
  folderId: string,
  folderLabel: string,
  files: { nodeId: string; path: string; label: string }[]
): FileTreeNodeData | null {
  if (files.length === 0) return null;

  type Branch = {
    id: string;
    label: string;
    children: Map<string, Branch>;
    file?: { nodeId: string; label: string };
  };

  const root: Branch = {
    id: folderId,
    label: folderLabel,
    children: new Map(),
  };

  for (const file of files) {
    const segments = file.path.split("/").filter(Boolean);
    const name = segments.pop() || file.label;
    let cursor = root;
    for (const segment of segments) {
      const childId = `${cursor.id}/${segment}`;
      let next = cursor.children.get(segment);
      if (!next) {
        next = { id: childId, label: segment, children: new Map() };
        cursor.children.set(segment, next);
      }
      cursor = next;
    }
    cursor.children.set(name, {
      id: file.nodeId,
      label: file.label || name,
      children: new Map(),
      file: { nodeId: file.nodeId, label: file.label || name },
    });
  }

  const toNode = (branch: Branch): FileTreeNodeData => {
    if (branch.file) {
      return { id: branch.file.nodeId, label: branch.file.label };
    }
    return {
      id: branch.id,
      label: branch.label,
      children: [...branch.children.values()].map(toNode),
    };
  };

  return toNode(root);
}

function isImageUpload(contentType: string, filename: string): boolean {
  if (contentType.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|svg|bmp|tiff?)$/i.test(filename);
}

function isPdfUpload(contentType: string, filename: string): boolean {
  if (contentType === "application/pdf") return true;
  return /\.pdf$/i.test(filename);
}

function isTextUpload(contentType: string, filename: string): boolean {
  if (contentType.startsWith("text/")) return true;
  return /\.(txt|md|csv|json|xml|html?|log)$/i.test(filename);
}

function MarkdownSideEditor({
  title,
  subtitle,
  initialValue,
  onSave,
  onToggle,
}: {
  title: string;
  subtitle: string;
  initialValue: string;
  onSave: (content: string) => Promise<void>;
  onToggle?: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setValue(initialValue);
    setDirty(false);
  }, [initialValue, title]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 px-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{title}</div>
          <div className="text-[11px] capitalize text-muted-foreground">{subtitle}</div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="secondary"
            disabled={!dirty || saving}
            onClick={() => {
              setSaving(true);
              void onSave(value)
                .then(() => setDirty(false))
                .finally(() => setSaving(false));
            }}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
          <Tooltip>
            <TooltipTrigger
              className="inline-flex"
              onClick={onToggle}
              aria-label="Collapse artifacts"
            >
              <span className="inline-flex size-8 items-center justify-center rounded-md hover:bg-muted">
                <X className="size-4" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">Collapse</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <textarea
        className="min-h-0 flex-1 resize-none border-t bg-background px-4 py-3 font-mono text-sm outline-none"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setDirty(true);
        }}
        spellCheck={false}
      />
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-7 shrink-0 items-center rounded-md px-2 text-xs font-medium transition-colors",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

function UploadPreview({
  path,
  workspaceId,
  contentType,
  filename,
}: {
  path: string;
  workspaceId: string;
  contentType: string;
  filename: string;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [textBody, setTextBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let revoke: string | null = null;
    let cancelled = false;
    void (async () => {
      setError(null);
      setBlobUrl(null);
      setTextBody(null);
      try {
        const q = new URLSearchParams({ path });
        const res = await fetch(
          `${API_URL}/api/workspaces/${workspaceId}/uploads/content?${q}`,
          { headers: getAuthHeaders() }
        );
        if (!res.ok) {
          throw new Error((await res.text()) || `Failed (${res.status})`);
        }
        if (isTextUpload(contentType, filename)) {
          const text = await res.text();
          if (!cancelled) setTextBody(text);
        } else {
          const blob = await res.blob();
          if (cancelled) return;
          const url = URL.createObjectURL(blob);
          revoke = url;
          setBlobUrl(url);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load upload");
        }
      }
    })();
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [path, workspaceId, contentType, filename]);

  if (error) {
    return <p className="p-6 text-sm text-destructive">{error}</p>;
  }
  if (textBody != null) {
    return (
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap wrap-break-word p-4 font-mono text-xs leading-relaxed">
        {textBody}
      </pre>
    );
  }
  if (!blobUrl) {
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  }
  if (isImageUpload(contentType, filename)) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={blobUrl}
          alt={filename}
          className="max-h-full max-w-full rounded-md object-contain"
        />
      </div>
    );
  }
  if (isPdfUpload(contentType, filename)) {
    return (
      <iframe
        title={filename}
        src={blobUrl}
        className="min-h-0 flex-1 w-full bg-background"
      />
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm text-muted-foreground">
        Preview is not available for this file type.
      </p>
      <a
        href={blobUrl}
        download={filename}
        className="inline-flex h-8 items-center justify-center rounded-lg border border-border bg-background px-3 text-sm hover:bg-muted"
      >
        Download
      </a>
    </div>
  );
}

function CollapseButton({ onToggle }: { onToggle?: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        className="inline-flex"
        onClick={onToggle}
        aria-label="Collapse artifacts"
      >
        <span className="inline-flex size-8 items-center justify-center rounded-md hover:bg-muted">
          <X className="size-4" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">Collapse</TooltipContent>
    </Tooltip>
  );
}

function DocumentBody({
  doc,
  collapsed,
  readOnly = false,
}: {
  doc: Document;
  collapsed: boolean;
  /** Resources side view — preview only, no edits or suggestion review. */
  readOnly?: boolean;
}) {
  const { suggestions, decideSuggestion } = useApp();
  const pending = useMemo(
    () => suggestions.filter((s) => s.status === "pending"),
    [suggestions]
  );
  const showInlineDiff = !readOnly && pending.length > 0;

  return (
    <div className="relative min-h-0 flex-1">
      {!collapsed && !showInlineDiff ? (
        <LiveBlockNoteEditor
          key={`${doc.id}:${readOnly ? "ro" : "rw"}`}
          docId={doc.id}
          contentMd={doc.content_md}
          readOnly={readOnly}
        />
      ) : null}

      {showInlineDiff && !collapsed ? (
        <div className="absolute inset-0 flex min-h-0 flex-col bg-background">
          <InlineDiffView
            contentMd={doc.content_md}
            suggestions={pending}
            onAccept={(id) => decideSuggestion(id, "accept")}
            onReject={(id) => decideSuggestion(id, "reject")}
          />
        </div>
      ) : null}
    </div>
  );
}

function WorkspaceFileBody({
  file,
  collapsed = false,
  readOnly = false,
}: {
  file: WorkspaceFile;
  collapsed?: boolean;
  readOnly?: boolean;
}) {
  return (
    <div className="relative min-h-0 flex-1">
      {!collapsed ? (
        <LiveWorkspaceFileEditor
          key={`${file.id}:${readOnly ? "ro" : "rw"}`}
          fileId={file.id}
          contentMd={file.content_md}
          readOnly={readOnly}
        />
      ) : null}
    </div>
  );
}

function DocumentPaneSkeleton({ onToggle }: { onToggle?: () => void }) {
  return (
    <div className="flex h-full flex-col" aria-busy aria-label="Loading document">
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 px-3">
        <div className="flex items-center gap-2">
          <Skeleton className="h-7 w-36" />
          <Skeleton className="h-7 w-16" />
          <Skeleton className="h-7 w-20" />
        </div>
        <div className="flex items-center gap-1">
          <Skeleton className="size-7 rounded-md" />
          {onToggle ? <CollapseButton onToggle={onToggle} /> : null}
        </div>
      </div>
      <div className="flex-1 space-y-3 overflow-hidden px-6 py-4">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-[94%]" />
        <Skeleton className="h-4 w-[88%]" />
        <Skeleton className="mt-4 h-4 w-full" />
        <Skeleton className="h-4 w-[90%]" />
        <Skeleton className="h-4 w-[76%]" />
        <Skeleton className="mt-4 h-4 w-full" />
        <Skeleton className="h-4 w-[82%]" />
        <Skeleton className="h-4 w-[95%]" />
        <Skeleton className="h-4 w-[60%]" />
      </div>
    </div>
  );
}

/** Right-pane editor: document and Resources file tree. */
function ArtifactsEditor({ onToggle, collapsed = false }: EditorPaneProps) {
  const {
    threads,
    activeThreadId,
    documents,
    canvases,
    activeDocumentId,
    activeCanvasId,
    workspaceFiles,
    workspaceAssets,
    workspaceUploads,
    workspace,
    messages,
    editorTarget,
    setEditorTarget,
    suggestions,
    decideSuggestion,
    acceptAllSuggestions,
    refreshThreadArtifacts,
    updateCanvasScene,
    threadLoading,
  } = useApp();

  const usesDocument = workspace?.uses_document !== false;
  const usesCanvas = Boolean(workspace?.uses_canvas);

  const [paneMode, setPaneMode] = useState<PaneMode>("document");
  const [selectedResourceKey, setSelectedResourceKey] = useState<string | null>(
    null
  );

  const thread = useMemo(
    () => threads.find((t) => t.id === activeThreadId) ?? null,
    [threads, activeThreadId]
  );

  const threadDocId = thread?.active_document_id ?? activeDocumentId;
  const threadDoc = useMemo(
    () => documents.find((d) => d.id === threadDocId) ?? null,
    [documents, threadDocId]
  );
  const threadCanvasId = thread?.active_canvas_id ?? activeCanvasId;
  const threadCanvas = useMemo(
    () => canvases.find((c) => c.id === threadCanvasId) ?? null,
    [canvases, threadCanvasId]
  );

  // If the thread has a document id but we don't have it loaded yet (common right
  // after createThread on a new chat), pull artifacts without requiring a sidebar click.
  useEffect(() => {
    if (!threadDocId && !threadCanvasId) return;
    if (threadDocId && !documents.some((d) => d.id === threadDocId)) {
      void refreshThreadArtifacts();
      return;
    }
    if (threadCanvasId && !canvases.some((c) => c.id === threadCanvasId)) {
      void refreshThreadArtifacts();
    }
  }, [threadDocId, threadCanvasId, documents, canvases, refreshThreadArtifacts]);

  const hasDocument = Boolean(usesDocument && (threadDoc || threadDocId));
  /** Canvas tab is available whenever the agent enables it (scene created on demand). */
  const hasCanvas = usesCanvas;
  const hasCanvasContent = Boolean(threadCanvas || threadCanvasId);

  /** Upload paths attached on messages in this thread (workspace store is global). */
  const threadUploadPaths = useMemo(() => {
    const paths = new Set<string>();
    for (const m of messages) {
      for (const a of m.attachments ?? []) {
        if (a.kind === "upload" && a.path) paths.add(a.path);
      }
    }
    return paths;
  }, [messages]);

  /**
   * Assets tied to this thread: paths persisted from agent runs, document embeds,
   * and paths mentioned in chat/tool calls (so Resources shows new figures
   * before they're embedded via suggest_*).
   */
  const threadAssetPaths = useMemo(() => {
    const paths = new Set<string>();
    const collect = (text: string | null | undefined) => {
      for (const p of collectWorkspaceAssetPaths(text)) paths.add(p);
    };
    for (const p of thread?.usage?.asset_paths ?? []) {
      if (typeof p === "string" && p) paths.add(p);
    }
    collect(threadDoc?.content_md);
    const researchPrefix = activeThreadId
      ? `research/${activeThreadId}/`
      : null;
    for (const file of workspaceFiles) {
      if (
        researchPrefix &&
        file.kind === "research" &&
        file.path.startsWith(researchPrefix)
      ) {
        collect(file.content_md);
      }
    }
    for (const m of messages) {
      collect(m.content);
      for (const part of getMessageParts(m)) {
        if (part.kind === "text") {
          collect(part.text);
          continue;
        }
        if (part.kind !== "tool") continue;
        collect(JSON.stringify(part.tool.input ?? {}));
        collect(JSON.stringify(part.tool.output ?? {}));
        collect(part.tool.errorText);
      }
    }
    return paths;
  }, [
    thread?.usage?.asset_paths,
    threadDoc,
    workspaceFiles,
    activeThreadId,
    messages,
  ]);

  const resourceItems = useMemo((): ResourceItem[] => {
    const items: ResourceItem[] = [];

    if (threadDoc) {
      items.push({
        kind: "document",
        id: threadDoc.id,
        label: threadDoc.title || "Document",
        section: "document",
      });
    } else if (threadDocId) {
      items.push({
        kind: "document",
        id: threadDocId,
        label: "Document",
        section: "document",
      });
    }

    for (const a of workspaceAssets) {
      if (!threadAssetPaths.has(a.path)) continue;
      items.push({
        kind: "asset",
        path: a.path,
        label: a.filename || a.path.split("/").pop() || a.path,
        section: "assets",
      });
    }

    const researchPrefix = activeThreadId
      ? `research/${activeThreadId}/`
      : null;
    if (researchPrefix) {
      for (const file of workspaceFiles) {
        if (file.kind !== "research" || !file.path.startsWith(researchPrefix)) {
          continue;
        }
        items.push({
          kind: "workspace_file",
          id: file.id,
          label: artifactLabel(file.path) || file.path,
          section: "research",
        });
      }
    }

    for (const u of workspaceUploads) {
      if (!threadUploadPaths.has(u.path)) continue;
      items.push({
        kind: "upload",
        path: u.path,
        label: u.filename || u.path.replace(/^uploads\//, ""),
        contentType: u.content_type || "application/octet-stream",
        filename: u.filename,
        section: "uploads",
      });
    }

    return items;
  }, [
    threadDoc,
    threadDocId,
    workspaceAssets,
    workspaceUploads,
    workspaceFiles,
    activeThreadId,
    threadUploadPaths,
    threadAssetPaths,
  ]);

  const hasResources = resourceItems.length > 0;

  const itemByKey = useMemo(() => {
    const map = new Map<string, ResourceItem>();
    for (const item of resourceItems) map.set(resourceKey(item), item);
    return map;
  }, [resourceItems]);

  const treeItems = useMemo((): FileTreeNodeData[] => {
    const nodes: FileTreeNodeData[] = [];

    const documentItems = resourceItems.filter((i) => i.section === "document");
    if (documentItems.length) {
      nodes.push({
        id: "folder-document",
        label: "Document",
        children: documentItems.map((item) => ({
          id: resourceKey(item),
          label: item.label,
        })),
      });
    }

    const assets = resourceItems.filter(
      (i): i is Extract<ResourceItem, { kind: "asset" }> => i.kind === "asset"
    );
    const assetsTree = buildPathTree(
      "folder-assets",
      "Assets",
      assets.map((a) => ({
        nodeId: resourceKey(a),
        path: a.path,
        label: a.label,
      }))
    );
    if (assetsTree) nodes.push(assetsTree);

    const research = resourceItems.filter((i) => i.section === "research");
    if (research.length) {
      nodes.push({
        id: "folder-research",
        label: "Research",
        children: research.map((item) => ({
          id: resourceKey(item),
          label: item.label,
        })),
      });
    }

    const uploads = resourceItems.filter((i) => i.section === "uploads");
    if (uploads.length) {
      nodes.push({
        id: "folder-uploads",
        label: "Uploads",
        children: uploads.map((item) => ({
          id: resourceKey(item),
          label: item.label,
        })),
      });
    }

    return nodes;
  }, [resourceItems]);

  const defaultExpandedIds = useMemo(() => {
    const ids: string[] = [];
    const walk = (nodes: FileTreeNodeData[]) => {
      for (const node of nodes) {
        if (!node.children?.length) continue;
        ids.push(node.id);
        walk(node.children);
      }
    };
    walk(treeItems);
    return ids;
  }, [treeItems]);

  const selectedResource = useMemo((): ResourceItem | null => {
    if (!resourceItems.length) return null;
    if (selectedResourceKey) {
      return itemByKey.get(selectedResourceKey) ?? resourceItems[0] ?? null;
    }
    return resourceItems[0] ?? null;
  }, [resourceItems, selectedResourceKey, itemByKey]);

  // External editorTarget changes (e.g. chat opening the document after an
  // agent edit, or opening a research memo). Resources tab clicks do not sync
  // editorTarget, so this never fights local Resources navigation.
  useEffect(() => {
    if (editorTarget.type === "document") {
      setPaneMode("document");
      if (threadDocId) setSelectedResourceKey(`doc-${threadDocId}`);
      return;
    }
    if (editorTarget.type === "canvas") {
      setPaneMode("canvas");
      return;
    }
    if (editorTarget.type === "workspace_file") {
      const file = workspaceFiles.find((f) => f.id === editorTarget.id);
      if (!file) return;
      if (file.kind === "research") {
        setPaneMode("resources");
        setSelectedResourceKey(`file-${file.id}`);
      }
    }
  }, [editorTarget, workspaceFiles, threadDocId]);

  useEffect(() => {
    if (paneMode === "document" && !hasDocument) {
      if (hasCanvas) setPaneMode("canvas");
      else if (hasResources) setPaneMode("resources");
    } else if (paneMode === "canvas" && !hasCanvas) {
      if (hasDocument) setPaneMode("document");
      else if (hasResources) setPaneMode("resources");
    }
  }, [hasDocument, hasCanvas, hasResources, paneMode]);

  // Prefer canvas tab when the agent first creates/updates a board.
  useEffect(() => {
    if (editorTarget.type === "canvas" && hasCanvas) {
      setPaneMode("canvas");
    }
  }, [editorTarget, hasCanvas]);

  const openDocumentTab = () => {
    setPaneMode("document");
    setEditorTarget({ type: "document" });
    if (threadDocId) setSelectedResourceKey(`doc-${threadDocId}`);
  };

  const openCanvasTab = () => {
    setPaneMode("canvas");
    setEditorTarget({ type: "canvas" });
  };

  /** Local tab only — do not sync editorTarget (that was bouncing back to ID). */
  const openResources = () => {
    setPaneMode("resources");
    const item = selectedResource ?? resourceItems[0];
    if (item) setSelectedResourceKey(resourceKey(item));
  };

  /** Stay on Resources; preview in the side pane (including the document). */
  const selectResource = (item: ResourceItem) => {
    setPaneMode("resources");
    setSelectedResourceKey(resourceKey(item));
  };

  const pending = useMemo(
    () => suggestions.filter((s) => s.status === "pending"),
    [suggestions]
  );

  if (threadLoading && !collapsed && activeDocumentId) {
    return <DocumentPaneSkeleton onToggle={onToggle} />;
  }

  if (!hasDocument && !hasCanvas && !hasResources && !usesCanvas) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-12 shrink-0 items-center justify-end px-2">
          <CollapseButton onToggle={onToggle} />
        </div>
        <div className="flex flex-1 items-center justify-center px-4 text-center text-sm text-muted-foreground">
          No artifacts for this chat yet
        </div>
      </div>
    );
  }

  const showingDocument = paneMode === "document" && hasDocument;
  const showingCanvas = paneMode === "canvas" && hasCanvas;
  const activeFile =
    selectedResource?.kind === "workspace_file"
      ? (workspaceFiles.find((f) => f.id === selectedResource.id) ?? null)
      : null;
  const selectedDoc =
    selectedResource?.kind === "document"
      ? (documents.find((d) => d.id === selectedResource.id) ?? threadDoc)
      : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 px-3">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {hasDocument ? (
            <TabButton active={showingDocument} onClick={openDocumentTab}>
              Document
            </TabButton>
          ) : null}
          {hasCanvas ? (
            <TabButton active={showingCanvas} onClick={openCanvasTab}>
              Canvas
            </TabButton>
          ) : null}
          {hasResources ? (
            <TabButton
              active={paneMode === "resources"}
              onClick={openResources}
            >
              Resources
            </TabButton>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {showingDocument && threadDoc && pending.length > 0 ? (
            <ReviewChangesDialog
              suggestions={pending}
              onAccept={(id) => decideSuggestion(id, "accept")}
              onReject={(id) => decideSuggestion(id, "reject")}
              onAcceptAll={() => acceptAllSuggestions()}
            />
          ) : null}
          {showingDocument && threadDoc ? (
            <ExportDocumentButton
              title={threadDoc.title}
              contentMd={threadDoc.content_md}
            />
          ) : null}
          <CollapseButton onToggle={onToggle} />
        </div>
      </div>

      {showingDocument && threadDoc ? (
        <DocumentBody doc={threadDoc} collapsed={collapsed} />
      ) : showingDocument && threadDocId ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Loading document…
        </div>
      ) : showingCanvas && threadCanvas ? (
        <CanvasEditor
          canvas={threadCanvas}
          collapsed={collapsed}
          onSceneChange={(scene_json) => {
            void updateCanvasScene(threadCanvas.id, scene_json);
          }}
        />
      ) : showingCanvas && threadCanvasId ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Loading canvas…
        </div>
      ) : showingCanvas && !hasCanvasContent ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          Ask the agent to draw on the canvas — architecture, flowcharts,
          comparisons, or brainstorms.
        </div>
      ) : paneMode === "resources" ? (
        <div className="flex min-h-0 flex-1">
          <div className="w-[32%] min-w-28 max-w-48 shrink-0 overflow-auto border-r p-1.5">
            <FileTreeFromItems
              key={`resources-tree-${activeThreadId ?? "none"}`}
              className="w-full border-0"
              items={treeItems}
              defaultExpandedIds={defaultExpandedIds}
              selectedIds={
                selectedResource ? [resourceKey(selectedResource)] : []
              }
              selectionMode="single"
              truncate
              indentSize={14}
              onNodeClick={(nodeId) => {
                const item = itemByKey.get(nodeId);
                if (item) selectResource(item);
              }}
            />
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {selectedResource?.kind === "document" && selectedDoc ? (
              <DocumentBody
                doc={selectedDoc}
                collapsed={collapsed}
                readOnly
              />
            ) : selectedResource?.kind === "document" ? (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                Loading document…
              </div>
            ) : selectedResource?.kind === "workspace_file" && activeFile ? (
              <WorkspaceFileBody
                file={activeFile}
                collapsed={collapsed}
                readOnly
              />
            ) : selectedResource?.kind === "asset" && workspace?.id ? (
              <AssetPreview
                path={selectedResource.path}
                workspaceId={workspace.id}
              />
            ) : selectedResource?.kind === "upload" && workspace?.id ? (
              <UploadPreview
                path={selectedResource.path}
                workspaceId={workspace.id}
                contentType={selectedResource.contentType}
                filename={selectedResource.filename}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                Select a file
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Select an artifact
        </div>
      )}
    </div>
  );
}

function LiveBlockNoteEditor({
  docId,
  contentMd,
  readOnly = false,
}: {
  docId: string;
  contentMd: string;
  readOnly?: boolean;
}) {
  const { updateDocumentContent, setQuotedSelection, workspace } = useApp();
  const workspaceId = workspace?.id ?? null;

  const editor = useCreateBlockNote({
    schema: editorSchema,
    resolveFileUrl: (url) => resolveWorkspaceMediaUrl(url, workspaceId),
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const applyingRef = useRef(false);
  const lastMdRef = useRef<string>("");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadMarkdown = useCallback(
    async (md: string) => {
      // Cancel any pending autosave so an older buffer cannot overwrite a live AI apply.
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      applyingRef.current = true;
      try {
        const parsed = await editor.tryParseMarkdownToBlocks(md || "");
        const blocks = promoteMermaidCodeBlocks(parsed);
        editor.replaceBlocks(editor.document, blocks);
        lastMdRef.current = md || "";
      } finally {
        applyingRef.current = false;
        setReady(true);
      }
    },
    [editor]
  );

  useEffect(() => {
    lastMdRef.current = "";
    setReady(false);
    void loadMarkdown(contentMd);
    // Load once per mount (keyed by docId in parent). External content updates
    // while mounted are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, loadMarkdown]);

  useEffect(() => {
    if (!ready) return;
    if (contentMd === lastMdRef.current) return;
    void loadMarkdown(contentMd);
  }, [contentMd, loadMarkdown, ready]);

  useEffect(() => {
    if (!ready || readOnly) return;
    return editor.onChange(() => {
      if (applyingRef.current) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void (async () => {
          const md = await editor.blocksToMarkdownLossy(editor.document);
          if (md === lastMdRef.current) return;
          lastMdRef.current = md;
          await updateDocumentContent(docId, md);
        })();
      }, 600);
    });
  }, [editor, docId, updateDocumentContent, ready, readOnly]);

  useEffect(() => {
    if (!ready || readOnly) return;
    return editor.onSelectionChange(() => {
      if (applyingRef.current) return;
      const text = editor.getSelectedText()?.trim() ?? "";
      if (!text) return;
      setQuotedSelection({ text, documentId: docId });
    });
  }, [editor, docId, setQuotedSelection, ready, readOnly]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  if (!ready) {
    return (
      <div className="p-4 text-sm text-muted-foreground">Loading editor…</div>
    );
  }

  return (
    <div className="relative h-full min-h-0">
      <div ref={scrollRef} className="h-full min-h-0 overflow-auto">
        <BlockNoteView
          editor={editor}
          theme="light"
          className="h-full"
          slashMenu={false}
          formattingToolbar={false}
          editable={!readOnly}
        >
          {!readOnly ? (
            <>
              <FormattingToolbarController
                formattingToolbar={EditorFormattingToolbar}
              />
              <SuggestionMenuController
                triggerCharacter="/"
                getItems={async (query) =>
                  filterSuggestionItems(
                    [
                      ...getDefaultReactSlashMenuItems(editor),
                      insertMermaidSlashItem(editor),
                    ],
                    query
                  )
                }
              />
            </>
          ) : null}
        </BlockNoteView>
      </div>
      {!readOnly ? (
        <DocumentMap editor={editor} scrollContainerRef={scrollRef} />
      ) : null}
    </div>
  );
}

function LiveWorkspaceFileEditor({
  fileId,
  contentMd,
  readOnly = false,
}: {
  fileId: string;
  contentMd: string;
  readOnly?: boolean;
}) {
  const { updateWorkspaceFile, workspace } = useApp();
  const workspaceId = workspace?.id ?? null;

  const editor = useCreateBlockNote({
    schema: editorSchema,
    resolveFileUrl: (url) => resolveWorkspaceMediaUrl(url, workspaceId),
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const applyingRef = useRef(false);
  const lastMdRef = useRef<string>("");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadMarkdown = useCallback(
    async (md: string) => {
      applyingRef.current = true;
      try {
        const parsed = await editor.tryParseMarkdownToBlocks(md || "");
        const blocks = promoteMermaidCodeBlocks(parsed);
        editor.replaceBlocks(editor.document, blocks);
        lastMdRef.current = md || "";
      } finally {
        applyingRef.current = false;
        setReady(true);
      }
    },
    [editor]
  );

  useEffect(() => {
    lastMdRef.current = "";
    setReady(false);
    void loadMarkdown(contentMd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, loadMarkdown]);

  useEffect(() => {
    if (!ready) return;
    if (contentMd === lastMdRef.current) return;
    void loadMarkdown(contentMd);
  }, [contentMd, loadMarkdown, ready]);

  useEffect(() => {
    if (!ready || readOnly) return;
    return editor.onChange(() => {
      if (applyingRef.current) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void (async () => {
          const md = await editor.blocksToMarkdownLossy(editor.document);
          if (md === lastMdRef.current) return;
          lastMdRef.current = md;
          await updateWorkspaceFile(fileId, md);
        })();
      }, 600);
    });
  }, [editor, fileId, updateWorkspaceFile, ready, readOnly]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  if (!ready) {
    return (
      <div className="p-4 text-sm text-muted-foreground">Loading editor…</div>
    );
  }

  return (
    <div className="relative h-full min-h-0">
      <div ref={scrollRef} className="h-full min-h-0 overflow-auto">
        <BlockNoteView
          editor={editor}
          theme="light"
          className="h-full"
          slashMenu={false}
          formattingToolbar={false}
          editable={!readOnly}
        >
          {!readOnly ? (
            <>
              <FormattingToolbarController
                formattingToolbar={EditorFormattingToolbar}
              />
              <SuggestionMenuController
                triggerCharacter="/"
                getItems={async (query) =>
                  filterSuggestionItems(
                    [
                      ...getDefaultReactSlashMenuItems(editor),
                      insertMermaidSlashItem(editor),
                    ],
                    query
                  )
                }
              />
            </>
          ) : null}
        </BlockNoteView>
      </div>
      {!readOnly ? (
        <DocumentMap editor={editor} scrollContainerRef={scrollRef} />
      ) : null}
    </div>
  );
}

function EditorInner({ onToggle, collapsed }: EditorPaneProps) {
  const {
    workspaceFiles,
    workspace,
    editorTarget,
    updatePersona,
    updateWorkspaceFile,
  } = useApp();

  if (editorTarget.type === "persona") {
    return (
      <MarkdownSideEditor
        title={editorTarget.key === "agent" ? "agent.md" : "soul.md"}
        subtitle="Persona"
        initialValue={
          editorTarget.key === "agent"
            ? workspace?.agent_md || ""
            : workspace?.soul_md || ""
        }
        onSave={async (content) => {
          if (editorTarget.key === "agent") {
            await updatePersona({ agent_md: content });
          } else {
            await updatePersona({ soul_md: content });
          }
        }}
        onToggle={onToggle}
      />
    );
  }

  // Memory files stay as a simple editor (not thread artifacts).
  if (editorTarget.type === "workspace_file") {
    const file = workspaceFiles.find((f) => f.id === editorTarget.id);
    if (file?.kind === "memory") {
      return (
        <MarkdownSideEditor
          title={file.path}
          subtitle={file.kind}
          initialValue={file.content_md}
          onSave={(content) => updateWorkspaceFile(file.id, content)}
          onToggle={onToggle}
        />
      );
    }
  }

  return <ArtifactsEditor onToggle={onToggle} collapsed={collapsed} />;
}

export function EditorPane(props: EditorPaneProps) {
  return (
    <MantineProvider defaultColorScheme="light">
      <EditorInner {...props} />
    </MantineProvider>
  );
}
