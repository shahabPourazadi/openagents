"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ImageLoader } from "@/components/ui/image-loading";
import { getAuthHeaders } from "@/lib/app-state";
import { resolveWorkspaceMediaUrl } from "@/lib/workspace-media";
import { cn } from "@/lib/utils";

export {
  isToolMediaGallerySource,
  looksLikeFileReadTool,
  looksLikeImageGenerationTool,
} from "@/lib/tool-media";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
/** Matches previous `max-h-72` preview height. */
const PREVIEW_MAX_HEIGHT_PX = 288;

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

function AuthAssetImage({
  path,
  workspaceId,
  className,
  alt,
  /** Pixel-grid reveal when the image first resolves (main preview). */
  reveal = false,
  onNaturalSize,
}: {
  path: string;
  workspaceId: string;
  className?: string;
  alt: string;
  reveal?: boolean;
  onNaturalSize?: (size: { width: number; height: number }) => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const onNaturalSizeRef = useRef(onNaturalSize);
  onNaturalSizeRef.current = onNaturalSize;

  useEffect(() => {
    let revoke: string | null = null;
    let cancelled = false;
    setSrc(null);
    void (async () => {
      const url = await resolveWorkspaceMediaUrl(path, workspaceId);
      if (cancelled) {
        if (url.startsWith("blob:")) URL.revokeObjectURL(url);
        return;
      }
      revoke = url.startsWith("blob:") ? url : null;
      setSrc(url);
    })();
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [path, workspaceId]);

  useEffect(() => {
    if (!src) return;
    const img = new window.Image();
    img.onload = () => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        onNaturalSizeRef.current?.({
          width: img.naturalWidth,
          height: img.naturalHeight,
        });
      }
    };
    img.src = src;
  }, [src]);

  if (!src) {
    if (reveal) {
      return (
        <ImageLoader
          className={className}
          statusText=""
          gridSize={12}
          cellGap={8}
          cellShape="square"
        />
      );
    }
    return <div className={cn("animate-pulse bg-muted", className)} aria-hidden />;
  }

  if (reveal) {
    return (
      <ImageLoader
        src={src}
        alt={alt}
        className={className}
        gridSize={12}
        cellGap={8}
        cellShape="square"
        loadingDelay={300}
        statusText=""
      />
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} className={className} />
  );
}

async function downloadAsset(workspaceId: string, path: string) {
  const q = new URLSearchParams({ path });
  const res = await fetch(
    `${API_URL}/api/workspaces/${workspaceId}/assets/content?${q}`,
    { headers: getAuthHeaders() }
  );
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = basename(path);
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function previewFrameStyle(aspect: number | null): CSSProperties {
  // Default square while loading / generating.
  const ratio = aspect && aspect > 0 ? aspect : 1;
  const idealWidth = Math.round(PREVIEW_MAX_HEIGHT_PX * ratio);
  return {
    // Prefer max-h-72; width follows aspect. If max-width clamps, height shrinks.
    width: idealWidth,
    maxWidth: "100%",
    height: "auto",
    maxHeight: PREVIEW_MAX_HEIGHT_PX,
    aspectRatio: `${ratio}`,
  };
}

export function ToolMediaGallery({
  workspaceId,
  images,
  files,
  loading = false,
  className,
}: {
  workspaceId: string;
  images: string[];
  files?: string[];
  /** Show reserved placeholder while generation is in progress. */
  loading?: boolean;
  className?: string;
}) {
  const [selected, setSelected] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [aspectByPath, setAspectByPath] = useState<Record<string, number>>({});

  const imagesKey = images.join("\0");
  useEffect(() => {
    setSelected(0);
  }, [imagesKey]);

  const showPlaceholder = loading && images.length === 0;
  const activePath = images[selected] ?? images[0];
  const activeAspect = activePath ? aspectByPath[activePath] ?? null : null;

  if (!showPlaceholder && images.length === 0 && !(files && files.length)) {
    return null;
  }

  return (
    <div className={cn("space-y-2", className)}>
      {(showPlaceholder || images.length > 0) && (
        <div className="flex gap-2">
          <div
            className="relative overflow-hidden rounded-xl bg-muted/60"
            style={previewFrameStyle(showPlaceholder ? 1 : activeAspect)}
          >
            {showPlaceholder ? (
              <ImageLoader
                className="h-full w-full"
                gridSize={14}
                cellGap={10}
                cellShape="square"
                blinkSpeed={1800}
                statusText=""
              />
            ) : activePath ? (
              <>
                <AuthAssetImage
                  path={activePath}
                  workspaceId={workspaceId}
                  alt={basename(activePath)}
                  className="h-full w-full object-cover"
                  reveal
                  onNaturalSize={({ width, height }) => {
                    if (height <= 0) return;
                    const next = width / height;
                    setAspectByPath((prev) =>
                      prev[activePath] === next
                        ? prev
                        : { ...prev, [activePath]: next }
                    );
                  }}
                />
                <div className="absolute bottom-2 right-2 z-20">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-8 gap-1.5 bg-background/90 shadow-sm"
                    disabled={downloading}
                    onClick={() => {
                      setDownloading(true);
                      void downloadAsset(workspaceId, activePath)
                        .catch((err) => {
                          console.error(err);
                          window.alert(
                            err instanceof Error ? err.message : "Download failed"
                          );
                        })
                        .finally(() => setDownloading(false));
                    }}
                  >
                    <Download className="size-3.5" />
                    Download
                  </Button>
                </div>
              </>
            ) : null}
          </div>

          {images.length > 1 ? (
            <div className="flex max-h-72 w-14 shrink-0 flex-col gap-1.5 overflow-y-auto">
              {images.map((path, i) => (
                <button
                  key={path}
                  type="button"
                  onClick={() => setSelected(i)}
                  className={cn(
                    "overflow-hidden rounded-md border bg-muted/40 aspect-square",
                    i === selected
                      ? "border-foreground/40 ring-1 ring-foreground/20"
                      : "border-transparent opacity-80 hover:opacity-100"
                  )}
                >
                  <AuthAssetImage
                    path={path}
                    workspaceId={workspaceId}
                    alt={basename(path)}
                    className="h-full w-full object-cover"
                  />
                </button>
              ))}
            </div>
          ) : null}
        </div>
      )}

      {files && files.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {files.map((path) => (
            <button
              key={path}
              type="button"
              className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted/50"
              onClick={() => {
                void downloadAsset(workspaceId, path).catch((err) => {
                  console.error(err);
                  window.alert(
                    err instanceof Error ? err.message : "Download failed"
                  );
                });
              }}
              title={path}
            >
              <Download className="size-3 shrink-0 opacity-60" />
              <span className="truncate">{basename(path)}</span>
            </button>
          ))}
        </div>
      ) : null}

      {activePath && !showPlaceholder ? (
        <p className="truncate text-[11px] text-muted-foreground" title={activePath}>
          {activePath}
        </p>
      ) : null}
    </div>
  );
}
