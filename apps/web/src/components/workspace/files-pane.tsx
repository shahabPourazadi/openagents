"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Download,
  FileText,
  ImageIcon,
  MessagesSquare,
  Paperclip,
  Pencil,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Markdown } from "@/components/ui/markdown";
import { AssetPreview } from "@/components/workspace/asset-preview";
import {
  getAuthHeaders,
  useApp,
  type Thread,
  type WorkspaceFile,
} from "@/lib/app-state";
import { cn } from "@/lib/utils";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

type FileSource =
  | { type: "persona"; key: "agent" | "soul" }
  | { type: "document"; id: string }
  | { type: "workspace_file"; id: string }
  | { type: "asset"; path: string }
  | { type: "upload"; path: string; contentType: string; filename: string };

type FileEntry = {
  id: string;
  label: string;
  category: string;
  content: string;
  source: FileSource;
  /** Image / binary asset preview. */
  assetPath?: string;
};

/** Best-effort thread for a Files entry (research path, document link, or asset usage). */
function resolveThreadIdForFile(
  entry: FileEntry,
  threads: Thread[],
  workspaceFiles: WorkspaceFile[]
): string | null {
  const { source } = entry;
  if (source.type === "workspace_file") {
    const file = workspaceFiles.find((f) => f.id === source.id);
    if (!file) return null;
    const researchMatch = file.path.match(/^research\/([^/]+)\//);
    if (researchMatch?.[1]) return researchMatch[1];
    return null;
  }
  if (source.type === "document") {
    return threads.find((t) => t.active_document_id === source.id)?.id ?? null;
  }
  if (source.type === "asset") {
    return (
      threads.find((t) => t.usage?.asset_paths?.includes(source.path))?.id ??
      null
    );
  }
  return null;
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
        if (!res.ok) throw new Error(await res.text() || `Failed (${res.status})`);
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
      <ScrollArea className="min-h-0 flex-1">
        <pre className="whitespace-pre-wrap wrap-break-word p-6 font-mono text-xs leading-relaxed">
          {textBody}
        </pre>
      </ScrollArea>
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

export function FilesPane() {
  const {
    workspace,
    documents,
    workspaceFiles,
    workspaceAssets,
    workspaceUploads,
    threads,
    updatePersona,
    updateDocumentContent,
    updateWorkspaceFile,
    setActiveThread,
    setSidebarTab,
  } = useApp();
  const [preview, setPreview] = useState<FileEntry | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const groups = useMemo(() => {
    const persona: FileEntry[] = [
      {
        id: "persona-agent",
        label: "agent.md",
        category: "Persona",
        content: workspace?.agent_md ?? "",
        source: { type: "persona", key: "agent" },
      },
      {
        id: "persona-soul",
        label: "soul.md",
        category: "Persona",
        content: workspace?.soul_md ?? "",
        source: { type: "persona", key: "soul" },
      },
    ];

    const memory: FileEntry[] = workspaceFiles
      .filter((f) => f.kind === "memory")
      .map((f) => ({
        id: f.id,
        label: f.path.replace(/^memory\//, ""),
        category: "Memory",
        content: f.content_md ?? "",
        source: { type: "workspace_file" as const, id: f.id },
      }));

    const documentEntries: FileEntry[] = documents.map((d) => ({
      id: d.id,
      label: d.path || d.title,
      category: "Documents",
      content: d.content_md ?? "",
      source: { type: "document" as const, id: d.id },
    }));

    const research: FileEntry[] = workspaceFiles
      .filter((f) => f.kind === "research")
      .map((f) => ({
        id: f.id,
        label: f.path.replace(/^research\//, ""),
        category: "Research",
        content: f.content_md ?? "",
        source: { type: "workspace_file" as const, id: f.id },
      }));

    const assets: FileEntry[] = workspaceAssets.map((a) => ({
      id: `asset:${a.path}`,
      label: a.path,
      category: "Assets",
      content: "",
      source: { type: "asset" as const, path: a.path },
      assetPath: a.path,
    }));

    const uploads: FileEntry[] = workspaceUploads.map((u) => ({
      id: `upload:${u.path}`,
      label: u.filename || u.path.replace(/^uploads\//, ""),
      category: "Uploads",
      content: "",
      source: {
        type: "upload" as const,
        path: u.path,
        contentType: u.content_type || "application/octet-stream",
        filename: u.filename,
      },
    }));

    return [
      { title: "Persona", items: persona },
      { title: "Memory", items: memory },
      { title: "Documents", items: documentEntries },
      { title: "Research", items: research },
      { title: "Assets", items: assets },
      { title: "Uploads", items: uploads },
    ].filter((g) => g.items.length > 0);
  }, [workspace, documents, workspaceFiles, workspaceAssets, workspaceUploads]);

  // Keep open preview in sync when underlying data updates after save.
  useEffect(() => {
    if (!preview || editing) return;
    const match = groups
      .flatMap((group) => group.items)
      .find((item) => item.id === preview.id);
    if (!match || match.content === preview.content) return;
    setPreview(match);
    setDraft(match.content);
  }, [groups, preview, editing]);

  const openFile = (item: FileEntry) => {
    setPreview(item);
    setDraft(item.content);
    setEditing(false);
  };

  const closeFile = () => {
    setPreview(null);
    setEditing(false);
    setDraft("");
    setSaving(false);
  };

  const isBinaryPreview =
    preview?.source.type === "asset" || preview?.source.type === "upload";

  const startEdit = () => {
    if (!preview || isBinaryPreview) return;
    setDraft(preview.content);
    setEditing(true);
  };

  const cancelEdit = () => {
    if (!preview) return;
    setDraft(preview.content);
    setEditing(false);
  };

  const saveEdit = async () => {
    if (!preview || isBinaryPreview) return;
    setSaving(true);
    try {
      const { source } = preview;
      if (source.type === "persona") {
        await updatePersona(
          source.key === "agent" ? { agent_md: draft } : { soul_md: draft }
        );
      } else if (source.type === "document") {
        await updateDocumentContent(source.id, draft);
      } else if (source.type === "workspace_file") {
        await updateWorkspaceFile(source.id, draft);
      }
      setPreview({ ...preview, content: draft });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const isAsset = preview?.source.type === "asset";
  const isUpload = preview?.source.type === "upload";

  const relatedThreadId = useMemo(() => {
    if (!preview) return null;
    return resolveThreadIdForFile(preview, threads, workspaceFiles);
  }, [preview, threads, workspaceFiles]);

  const downloadPreview = async () => {
    if (!preview || !workspace?.id || downloading) return;
    setDownloading(true);
    try {
      const { source, label, content } = preview;
      if (source.type === "asset") {
        const q = new URLSearchParams({ path: source.path });
        const res = await fetch(
          `${API_URL}/api/workspaces/${workspace.id}/assets/content?${q}`,
          { headers: getAuthHeaders() }
        );
        if (!res.ok) throw new Error(await res.text() || `Failed (${res.status})`);
        triggerBlobDownload(await res.blob(), label.split("/").pop() || label);
        return;
      }
      if (source.type === "upload") {
        const q = new URLSearchParams({ path: source.path });
        const res = await fetch(
          `${API_URL}/api/workspaces/${workspace.id}/uploads/content?${q}`,
          { headers: getAuthHeaders() }
        );
        if (!res.ok) throw new Error(await res.text() || `Failed (${res.status})`);
        triggerBlobDownload(
          await res.blob(),
          source.filename || label.split("/").pop() || label
        );
        return;
      }
      const filename = label.endsWith(".md") ? label : `${label}.md`;
      triggerBlobDownload(
        new Blob([content], { type: "text/markdown;charset=utf-8" }),
        filename
      );
    } catch (err) {
      console.error("Download failed:", err);
      window.alert(err instanceof Error ? err.message : "Failed to download file");
    } finally {
      setDownloading(false);
    }
  };

  const openRelatedThread = () => {
    if (!relatedThreadId) return;
    closeFile();
    setSidebarTab("chats");
    void setActiveThread(relatedThreadId);
  };

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center border-b px-6">
        <h1 className="text-sm font-semibold tracking-tight">Files</h1>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-6">
          {groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">No files yet.</p>
          ) : (
            groups.map((group) => (
              <section key={group.title} className="flex flex-col gap-2">
                <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {group.title}
                </h2>
                <ul className="flex flex-col gap-1">
                  {group.items.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => openFile(item)}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm",
                          "transition hover:bg-muted"
                        )}
                      >
                        {item.source.type === "asset" ? (
                          <ImageIcon className="size-4 shrink-0 text-muted-foreground" />
                        ) : item.source.type === "upload" ? (
                          <Paperclip className="size-4 shrink-0 text-muted-foreground" />
                        ) : (
                          <FileText className="size-4 shrink-0 text-muted-foreground" />
                        )}
                        <span className="truncate">{item.label}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </ScrollArea>

      <Dialog
        open={preview != null}
        onOpenChange={(open) => {
          if (!open) closeFile();
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="flex h-[90vh] max-h-[90vh] w-full max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
        >
          <DialogHeader className="flex shrink-0 flex-row items-center justify-between gap-3 border-b px-6 py-4 pr-36">
            <DialogTitle className="min-w-0 truncate">
              {preview?.label ?? "File"}
            </DialogTitle>
            {!editing ? (
              <div className="absolute top-2 right-2 flex items-center gap-0.5">
                <Tooltip>
                  <TooltipTrigger
                    className="inline-flex"
                    render={<span className="inline-flex" />}
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={isBinaryPreview}
                      onClick={startEdit}
                      aria-label="Edit file"
                    >
                      <Pencil className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Edit</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    className="inline-flex"
                    render={<span className="inline-flex" />}
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={downloading || !workspace?.id}
                      onClick={() => void downloadPreview()}
                      aria-label="Download file"
                    >
                      <Download className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Download</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    className="inline-flex"
                    render={<span className="inline-flex" />}
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={!relatedThreadId}
                      onClick={openRelatedThread}
                      aria-label="Open related thread"
                    >
                      <MessagesSquare className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {relatedThreadId ? "Open thread" : "No related thread"}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={closeFile}
                        aria-label="Close"
                      />
                    }
                  >
                    <X className="size-4" />
                  </TooltipTrigger>
                  <TooltipContent>Close</TooltipContent>
                </Tooltip>
              </div>
            ) : null}
          </DialogHeader>

          {editing ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="h-full min-h-0 flex-1 resize-none field-sizing-fixed md:text-sm"
                disabled={saving}
                aria-label="File content"
              />
              <div className="flex shrink-0 justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={saving}
                  onClick={cancelEdit}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  disabled={saving}
                  onClick={() => void saveEdit()}
                >
                  {saving ? "Saving…" : "Save"}
                </Button>
              </div>
            </div>
          ) : isAsset && preview?.assetPath && workspace?.id ? (
            <AssetPreview path={preview.assetPath} workspaceId={workspace.id} />
          ) : isUpload && preview?.source.type === "upload" && workspace?.id ? (
            <UploadPreview
              path={preview.source.path}
              workspaceId={workspace.id}
              contentType={preview.source.contentType}
              filename={preview.source.filename}
            />
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              <div className="typeset typeset-docs px-6 py-4 pb-8">
                <Markdown>
                  {preview?.content.trim() ? preview.content : "_Empty_"}
                </Markdown>
              </div>
            </ScrollArea>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
