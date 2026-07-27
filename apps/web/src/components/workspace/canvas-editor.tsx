"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import dynamic from "next/dynamic";
import { Download, Image as ImageIcon } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Canvas } from "@/lib/app-state";

import "@excalidraw/excalidraw/index.css";

const Excalidraw = dynamic(
  async () => (await import("@excalidraw/excalidraw")).Excalidraw,
  { ssr: false, loading: () => <CanvasLoading /> }
);

type ExcalidrawAPI = {
  getSceneElements: () => readonly unknown[];
  getAppState: () => Record<string, unknown>;
  getFiles: () => Record<string, unknown>;
  updateScene: (scene: {
    elements?: unknown[];
    appState?: Record<string, unknown>;
    files?: Record<string, unknown>;
  }) => void;
};

function CanvasLoading() {
  return (
    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
      Loading canvas…
    </div>
  );
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

type CanvasEditorProps = {
  canvas: Canvas;
  collapsed?: boolean;
  onSceneChange: (scene_json: Record<string, unknown>) => void;
};

export function CanvasEditor({
  canvas,
  collapsed = false,
  onSceneChange,
}: CanvasEditorProps) {
  const apiRef = useRef<ExcalidrawAPI | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const applyingRemote = useRef(false);
  const [ready, setReady] = useState(false);

  // Remount only on AI/remote updates (remote_rev), not local autosave.
  const sceneKey = `${canvas.id}:${canvas.remote_rev ?? 0}`;

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  const scheduleSave = useCallback(
    (elements: readonly unknown[], appState: Record<string, unknown>, files: Record<string, unknown>) => {
      if (applyingRemote.current) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        onSceneChange({
          type: "excalidraw",
          version: 2,
          source: "openagents",
          elements: elements as unknown[],
          appState: {
            viewBackgroundColor:
              (appState.viewBackgroundColor as string) || "#ffffff",
          },
          files,
        });
      }, 600);
    },
    [onSceneChange]
  );

  const exportExcalidraw = useCallback(() => {
    const api = apiRef.current;
    const scene = {
      type: "excalidraw",
      version: 2,
      source: "openagents",
      elements: api ? api.getSceneElements() : canvas.scene_json.elements || [],
      appState: api
        ? { viewBackgroundColor: api.getAppState().viewBackgroundColor }
        : canvas.scene_json.appState || {},
      files: api ? api.getFiles() : canvas.scene_json.files || {},
    };
    const blob = new Blob([JSON.stringify(scene, null, 2)], {
      type: "application/json",
    });
    const safe = (canvas.title || "canvas").replace(/[^\w.-]+/g, "_");
    downloadBlob(blob, `${safe}.excalidraw`);
  }, [canvas]);

  const exportPng = useCallback(async () => {
    const api = apiRef.current;
    if (!api) return;
    const { exportToBlob } = await import("@excalidraw/excalidraw");
    const blob = await exportToBlob({
      elements: api.getSceneElements() as never,
      appState: api.getAppState() as never,
      files: api.getFiles() as never,
      mimeType: "image/png",
    });
    const safe = (canvas.title || "canvas").replace(/[^\w.-]+/g, "_");
    downloadBlob(blob, `${safe}.png`);
  }, [canvas.title]);

  if (collapsed) {
    return <div className="flex-1" aria-hidden />;
  }

  const initialElements = Array.isArray(canvas.scene_json.elements)
    ? canvas.scene_json.elements
    : [];
  const initialAppState =
    typeof canvas.scene_json.appState === "object" && canvas.scene_json.appState
      ? (canvas.scene_json.appState as Record<string, unknown>)
      : { viewBackgroundColor: "#ffffff" };
  const initialFiles =
    typeof canvas.scene_json.files === "object" && canvas.scene_json.files
      ? (canvas.scene_json.files as Record<string, unknown>)
      : {};

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="pointer-events-none absolute right-3 top-2 z-10 flex gap-1">
        <ExportIconButton label="Download .excalidraw" onClick={exportExcalidraw}>
          <Download className="size-3.5" />
        </ExportIconButton>
        <ExportIconButton label="Download PNG" onClick={() => void exportPng()}>
          <ImageIcon className="size-3.5" />
        </ExportIconButton>
      </div>
      <div className="min-h-0 flex-1 [&_.excalidraw]:h-full [&_.excalidraw]:w-full">
        <Excalidraw
          key={sceneKey}
          excalidrawAPI={(api) => {
            apiRef.current = api as unknown as ExcalidrawAPI;
            setReady(true);
          }}
          initialData={{
            elements: initialElements as never,
            appState: {
              ...initialAppState,
              collaborators: undefined,
            } as never,
            files: initialFiles as never,
            scrollToContent: true,
          }}
          onChange={(elements, appState, files) => {
            if (!ready) return;
            scheduleSave(
              elements,
              appState as unknown as Record<string, unknown>,
              files as unknown as Record<string, unknown>
            );
          }}
        />
      </div>
    </div>
  );
}

function ExportIconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        aria-label={label}
        onClick={onClick}
        className="pointer-events-auto inline-flex size-7 items-center justify-center rounded-md border border-border bg-secondary text-secondary-foreground shadow-sm hover:bg-muted"
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
