"use client";

import { useEffect, useState } from "react";
import { getAuthHeaders } from "@/lib/app-state";
import { resolveWorkspaceMediaUrl } from "@/lib/workspace-media";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

function isImageAsset(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|tiff?)$/i.test(path);
}

function isPdfAsset(path: string): boolean {
  return /\.pdf$/i.test(path);
}

function isTextAsset(path: string): boolean {
  return /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|xml|log)$/i.test(path);
}

/** Preview durable diagrams/ / other/ assets (images, text, PDF). */
export function AssetPreview({
  path,
  workspaceId,
}: {
  path: string;
  workspaceId: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [textBody, setTextBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let revoke: string | null = null;
    let cancelled = false;
    void (async () => {
      setError(null);
      setSrc(null);
      setTextBody(null);
      try {
        if (isTextAsset(path)) {
          const q = new URLSearchParams({ path });
          const res = await fetch(
            `${API_URL}/api/workspaces/${workspaceId}/assets/content?${q}`,
            { headers: getAuthHeaders() }
          );
          if (!res.ok) {
            throw new Error((await res.text()) || `Failed (${res.status})`);
          }
          const text = await res.text();
          if (!cancelled) setTextBody(text);
          return;
        }

        const url = await resolveWorkspaceMediaUrl(path, workspaceId);
        if (cancelled) {
          if (url.startsWith("blob:")) URL.revokeObjectURL(url);
          return;
        }
        revoke = url.startsWith("blob:") ? url : null;
        setSrc(url);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load asset");
        }
      }
    })();
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [path, workspaceId]);

  if (error) {
    return <p className="p-6 text-sm text-destructive">{error}</p>;
  }

  if (isTextAsset(path)) {
    if (textBody == null) {
      return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
    }
    return (
      <pre className="m-0 min-h-0 flex-1 overflow-auto whitespace-pre-wrap wrap-break-word p-4 font-mono text-xs leading-relaxed text-foreground">
        {textBody}
      </pre>
    );
  }

  if (!src) {
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  }

  if (isPdfAsset(path)) {
    return (
      <iframe
        title={path}
        src={src}
        className="min-h-0 w-full flex-1 border-0 bg-background"
      />
    );
  }

  if (isImageAsset(path)) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={path}
          className="max-h-full max-w-full rounded-md object-contain"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
      <p>Preview not available for this file type.</p>
      <a
        href={src}
        download={path.split("/").pop() || "download"}
        className="text-foreground underline underline-offset-2"
      >
        Download
      </a>
    </div>
  );
}
