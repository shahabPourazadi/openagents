"use client";

import { useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  type MentionChip,
  OPENAGENTS_SKILLS,
} from "@/components/workspace/composer-mentions";
import { AttachmentCardRow } from "@/components/workspace/attachment-cards";
import { fileExt } from "@/components/workspace/file-format-style";
import { formatBytes, MAX_PREVIEW_BYTES } from "@/lib/upload-limits";
import { getAuthHeaders } from "@/lib/app-state";
import { cn } from "@/lib/utils";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

function isImageChip(chip: MentionChip): boolean {
  return ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff"].includes(
    fileExt(chip.path || chip.label)
  );
}

function isPdfChip(chip: MentionChip): boolean {
  return fileExt(chip.path || chip.label) === "pdf";
}

function isTextishChip(chip: MentionChip): boolean {
  return ["md", "markdown", "txt", "csv"].includes(
    fileExt(chip.path || chip.label)
  );
}

/** Text previews stay small; images/PDFs can be larger. */
function previewLimitFor(chip: MentionChip): number {
  if (isImageChip(chip) || isPdfChip(chip)) return 10 * 1024 * 1024;
  return MAX_PREVIEW_BYTES;
}

export function MessageAttachmentChips({
  attachments,
  onSelect,
}: {
  attachments: MentionChip[];
  onSelect: (chip: MentionChip) => void;
}) {
  return (
    <AttachmentCardRow
      className="max-w-[85%]"
      chips={attachments}
      onSelect={onSelect}
      align="end"
    />
  );
}

function TooLargePreview({
  chip,
  size,
  onDownload,
  downloading,
}: {
  chip: MentionChip;
  size: number | null;
  onDownload: () => void;
  downloading: boolean;
}) {
  const sizeLabel = size != null && size > 0 ? formatBytes(size) : null;
  return (
    <div className="flex min-h-64 flex-col items-center justify-center gap-4 px-6 py-10 text-center">
      <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
        {chip.label}
        {sizeLabel ? ` (${sizeLabel})` : ""} is too large to preview.
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-1.5"
        disabled={downloading}
        onClick={onDownload}
      >
        <Download className="size-3.5" />
        Download
      </Button>
    </div>
  );
}

export function AttachmentPreviewDialog({
  chip,
  workspaceId,
  open,
  onOpenChange,
  resolveTextPreview,
}: {
  chip: MentionChip | null;
  workspaceId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional resolver for workspace files / documents / skills. */
  resolveTextPreview?: (chip: MentionChip) => string | null;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [textBody, setTextBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tooLarge, setTooLarge] = useState(false);
  const [resolvedSize, setResolvedSize] = useState<number | null>(null);
  const [downloading, setDownloading] = useState(false);

  const uploadUrl = useMemo(() => {
    if (!chip?.path || !workspaceId || chip.kind !== "upload") return null;
    const q = new URLSearchParams({ path: chip.path });
    return `${API_URL}/api/workspaces/${workspaceId}/uploads/content?${q}`;
  }, [chip, workspaceId]);

  useEffect(() => {
    let revoke: string | null = null;
    let cancelled = false;

    async function load() {
      setError(null);
      setTextBody(null);
      setBlobUrl(null);
      setTooLarge(false);
      setResolvedSize(chip?.size ?? null);
      if (!chip || !open) return;

      if (chip.kind === "skill") {
        const skill = OPENAGENTS_SKILLS.find((s) => s.id === chip.id || s.label === chip.label);
        setTextBody(skill?.description || chip.description || "Skill playbook");
        return;
      }

      const limit = previewLimitFor(chip);

      const local = resolveTextPreview?.(chip);
      if (local != null) {
        const bytes = new TextEncoder().encode(local).length;
        setResolvedSize(chip.size ?? bytes);
        if (bytes > limit) {
          setTooLarge(true);
          return;
        }
        setTextBody(local);
        return;
      }

      if (!uploadUrl) {
        setTextBody(chip.path || chip.description || "No preview available.");
        return;
      }

      if (chip.size != null && chip.size > limit) {
        setTooLarge(true);
        setResolvedSize(chip.size);
        return;
      }

      setLoading(true);
      try {
        const res = await fetch(uploadUrl, {
          headers: getAuthHeaders(),
        });
        if (!res.ok) throw new Error(await res.text());
        const headerLen = Number(res.headers.get("content-length") || "");
        const knownSize =
          chip.size ?? (Number.isFinite(headerLen) && headerLen > 0 ? headerLen : null);
        if (knownSize != null) setResolvedSize(knownSize);
        if (knownSize != null && knownSize > limit) {
          if (!cancelled) setTooLarge(true);
          return;
        }

        if (isTextishChip(chip)) {
          const text = await res.text();
          const bytes = new TextEncoder().encode(text).length;
          if (!cancelled) {
            setResolvedSize(knownSize ?? bytes);
            if (bytes > limit) {
              setTooLarge(true);
            } else {
              setTextBody(text);
            }
          }
        } else {
          const blob = await res.blob();
          if (!cancelled) {
            setResolvedSize(knownSize ?? blob.size);
            if (blob.size > limit) {
              setTooLarge(true);
              return;
            }
            const url = URL.createObjectURL(blob);
            revoke = url;
            setBlobUrl(url);
          }
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load preview");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [chip, open, uploadUrl, resolveTextPreview]);

  const downloadFile = async () => {
    if (!chip) return;
    setDownloading(true);
    try {
      if (uploadUrl) {
        const res = await fetch(uploadUrl, { headers: getAuthHeaders() });
        if (!res.ok) throw new Error(await res.text());
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = chip.label;
        a.click();
        URL.revokeObjectURL(url);
        return;
      }
      const local = resolveTextPreview?.(chip);
      if (local != null) {
        const blob = new Blob([local], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = chip.label.endsWith(".md") ? chip.label : `${chip.label}.md`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "gap-0 overflow-hidden p-0 sm:max-w-2xl",
          tooLarge && "bg-muted/40"
        )}
        showCloseButton
      >
        <DialogHeader className="shrink-0 border-b px-4 py-3 pr-12 text-left">
          <DialogTitle className="truncate text-base">{chip?.label || "Attachment"}</DialogTitle>
          {!tooLarge ? (
            <DialogDescription className="truncate text-xs">
              {chip?.path || chip?.kind || "Preview"}
            </DialogDescription>
          ) : (
            <DialogDescription className="sr-only">
              File is too large to preview
            </DialogDescription>
          )}
        </DialogHeader>
        <div
          className={cn(
            "max-h-[70vh] overflow-auto",
            !tooLarge && "bg-background p-2"
          )}
        >
          {loading && (
            <p className="p-4 text-sm text-muted-foreground">Loading preview…</p>
          )}
          {error && <p className="p-4 text-sm text-destructive">{error}</p>}
          {!loading && !error && chip && tooLarge && (
            <TooLargePreview
              chip={chip}
              size={resolvedSize}
              onDownload={() => void downloadFile()}
              downloading={downloading}
            />
          )}
          {!loading && !error && !tooLarge && chip && textBody != null && (
            <pre className="whitespace-pre-wrap wrap-break-word p-3 font-mono text-xs leading-relaxed">
              {textBody}
            </pre>
          )}
          {!loading && !error && !tooLarge && chip && blobUrl && isImageChip(chip) && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={blobUrl}
              alt={chip.label}
              className="mx-auto max-h-[65vh] w-auto max-w-full rounded-md object-contain"
            />
          )}
          {!loading && !error && !tooLarge && chip && blobUrl && isPdfChip(chip) && (
            <iframe
              title={chip.label}
              src={blobUrl}
              className="h-[65vh] w-full rounded-md bg-background"
            />
          )}
          {!loading &&
            !error &&
            !tooLarge &&
            chip &&
            blobUrl &&
            !isImageChip(chip) &&
            !isPdfChip(chip) && (
              <div className="flex min-h-48 flex-col items-center justify-center gap-4 p-6 text-center">
                <p className="text-sm text-muted-foreground">
                  Preview is not available for this file type.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={downloading}
                  onClick={() => void downloadFile()}
                >
                  <Download className="size-3.5" />
                  Download
                </Button>
              </div>
            )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
