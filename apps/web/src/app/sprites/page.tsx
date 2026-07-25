"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SpritePlayer } from "@/components/ui/sprite-player";
import { SPEED_PRESETS } from "@/lib/sprite-catalog";
import { cn } from "@/lib/utils";
import type { SpriteFolderSequence } from "@/app/api/sprites/route";

type BgMode = "checker" | "light" | "dark" | "muted";

const BG_CLASS: Record<BgMode, string> = {
  checker:
    "bg-[length:16px_16px] bg-[linear-gradient(45deg,#e5e5e5_25%,transparent_25%),linear-gradient(-45deg,#e5e5e5_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#e5e5e5_75%),linear-gradient(-45deg,transparent_75%,#e5e5e5_75%)] bg-[position:0_0,0_8px,8px_-8px,-8px_0] bg-white",
  light: "bg-white",
  dark: "bg-neutral-900",
  muted: "bg-muted",
};

const GROUP_ORDER = ["chat", "4.0", "3.0", "2.5", "2.0", "other"] as const;
const GROUP_LABEL: Record<string, string> = {
  chat: "Chat (idle* / work*)",
  "4.0": "Sprite 4.0 (5×5 — folder-driven)",
  "3.0": "Sprite 3.0",
  "2.5": "Sprite 2.5",
  "2.0": "Sprites 2.0",
  other: "Other",
};

export default function SpritePlaygroundPage() {
  const [sequences, setSequences] = useState<SpriteFolderSequence[]>([]);
  const [scannedAt, setScannedAt] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [sequenceId, setSequenceId] = useState<string>("");
  const [frameMs, setFrameMs] = useState(180);
  const [playing, setPlaying] = useState(true);
  const [loop, setLoop] = useState(true);
  const [pixelated, setPixelated] = useState(true);
  const [scale, setScale] = useState(1.25);
  const [bg, setBg] = useState<BgMode>("checker");
  const [frame, setFrame] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  const [cacheBust, setCacheBust] = useState(0);

  const reload = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await fetch(`/api/sprites?t=${Date.now()}`, {
        cache: "no-store",
      });
      const data = (await res.json()) as {
        sequences: SpriteFolderSequence[];
        scannedAt?: string;
      };
      setSequences(data.sequences ?? []);
      setScannedAt(data.scannedAt ?? null);
      setCacheBust(Date.now());
      setSequenceId((prev) => {
        const ids = new Set((data.sequences ?? []).map((s) => s.id));
        if (prev && ids.has(prev)) return prev;
        const prefer =
          data.sequences?.find((s) => s.group === "4.0") ??
          data.sequences?.[0];
        return prefer?.id ?? "";
      });
      setFrame(0);
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const sequence = useMemo(
    () => sequences.find((s) => s.id === sequenceId) ?? sequences[0] ?? null,
    [sequences, sequenceId],
  );

  const frameSrcs = useMemo(() => {
    if (!sequence) return [];
    const q = cacheBust ? `?v=${cacheBust}` : "";
    return sequence.frames.map((f) => `${f}${q}`);
  }, [sequence, cacheBust]);

  const frameCount = frameSrcs.length;
  const displayH = Math.round(110 * scale);
  const displayW = Math.round(110 * scale);

  const onPickSequence = useCallback((id: string) => {
    setSequenceId(id);
    setFrame(0);
    setScrubbing(false);
    setPlaying(true);
  }, []);

  const step = useCallback(
    (delta: number) => {
      if (!frameCount) return;
      setScrubbing(true);
      setPlaying(false);
      setFrame((f) => {
        const next = f + delta;
        if (next < 0) return loop ? frameCount - 1 : 0;
        if (next >= frameCount) return loop ? 0 : frameCount - 1;
        return next;
      });
    },
    [loop, frameCount],
  );

  const fps = (1000 / Math.max(16, frameMs)).toFixed(1);
  const grouped = useMemo(() => {
    const map = new Map<string, SpriteFolderSequence[]>();
    for (const g of GROUP_ORDER) map.set(g, []);
    for (const s of sequences) {
      const g = map.has(s.group) ? s.group : "other";
      map.get(g)!.push(s);
    }
    return GROUP_ORDER.map((g) => [g, map.get(g) ?? []] as const).filter(
      ([, list]) => list.length > 0,
    );
  }, [sequences]);

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
          <Link
            href="/"
            className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            App
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="text-sm font-semibold tracking-tight">
              Sprite playground
            </h1>
            <p className="truncate text-xs text-muted-foreground">
              Folder-driven frames · webp / png / jpg · rename/delete then refresh
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void reload()}
            disabled={loadingList}
          >
            <RefreshCw
              className={cn("size-3.5", loadingList && "animate-spin")}
            />
            Rescan folders
          </Button>
        </div>
      </header>

      <main className="mx-auto grid max-w-5xl gap-6 px-4 py-6 lg:grid-cols-[1fr_340px]">
        <section className="space-y-4">
          <div
            className={cn(
              "flex min-h-70 items-center justify-center rounded-2xl border border-border p-6",
              BG_CLASS[bg],
            )}
          >
            {sequence && frameCount > 0 ? (
              <SpritePlayer
                key={`${sequence.id}-${cacheBust}`}
                frameSrcs={frameSrcs}
                frameMs={frameMs}
                playing={playing && !scrubbing}
                loop={loop}
                pixelated={pixelated}
                frame={frame}
                onFrameChange={setFrame}
                style={{ width: displayW, height: displayH }}
                className="transition-[width,height] duration-150"
                alt={`${sequence.label} animation`}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                {loadingList ? "Scanning…" : "No sprite folders found"}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {sequence?.label ?? "—"} · frame{" "}
              <span className="font-mono text-foreground">
                {frameCount ? `${frame + 1}/${frameCount}` : "0/0"}
              </span>{" "}
              · {fps} fps
            </span>
            <span className="font-mono">{sequence?.srcBase}</span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setScrubbing(false);
                setPlaying((p) => !p);
              }}
            >
              {playing && !scrubbing ? (
                <Pause className="size-3.5" />
              ) : (
                <Play className="size-3.5" />
              )}
              {playing && !scrubbing ? "Pause" : "Play"}
            </Button>
            <Button variant="outline" size="sm" onClick={() => step(-1)}>
              <SkipBack className="size-3.5" />
              Prev
            </Button>
            <Button variant="outline" size="sm" onClick={() => step(1)}>
              Next
              <SkipForward className="size-3.5" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setFrame(0);
                setScrubbing(false);
                setPlaying(true);
              }}
            >
              <RotateCcw className="size-3.5" />
              Restart
            </Button>
          </div>

          <label className="block space-y-1.5">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Scrub frame</span>
              <span className="font-mono">{frameCount ? frame + 1 : 0}</span>
            </div>
            <input
              type="range"
              min={0}
              max={Math.max(0, frameCount - 1)}
              value={frameCount ? frame : 0}
              disabled={!frameCount}
              onChange={(e) => {
                setScrubbing(true);
                setPlaying(false);
                setFrame(Number(e.target.value));
              }}
              className="w-full accent-foreground"
            />
          </label>

          {sequence ? (
            <div className="rounded-xl border border-border bg-card p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h2 className="text-sm font-medium">Frame files (playback order)</h2>
                <span className="text-[11px] text-muted-foreground">
                  {scannedAt
                    ? `scanned ${new Date(scannedAt).toLocaleTimeString()}`
                    : null}
                </span>
              </div>
              <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
                Edit{" "}
                <code className="rounded bg-muted px-1">
                  apps/web/public{sequence.srcBase}/
                </code>
                — rename to reorder, delete to remove. Then hit{" "}
                <strong>Rescan folders</strong> (or refresh).
              </p>
              <ol className="max-h-40 space-y-0.5 overflow-y-auto font-mono text-[11px] text-muted-foreground">
                {sequence.frames.map((f, i) => (
                  <li
                    key={f}
                    className={cn(
                      "rounded px-1.5 py-0.5",
                      i === frame && "bg-muted text-foreground",
                    )}
                  >
                    {i + 1}. {f.split("/").pop()}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </section>

        <aside className="space-y-5 rounded-2xl border border-border bg-card p-4">
          <ControlBlock title="Sequence">
            {grouped.map(([group, list]) => (
              <div key={group} className="mb-3">
                <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {GROUP_LABEL[group] ?? group}
                </p>
                <div className="flex max-h-36 flex-wrap gap-1.5 overflow-y-auto">
                  {list.map((s) => (
                    <Chip
                      key={s.id}
                      active={sequence?.id === s.id}
                      onClick={() => onPickSequence(s.id)}
                    >
                      {s.label}
                      <span className="opacity-60"> · {s.frameCount}</span>
                    </Chip>
                  ))}
                </div>
              </div>
            ))}
          </ControlBlock>

          <ControlBlock title="Speed">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {SPEED_PRESETS.map((p) => (
                <Chip
                  key={p.id}
                  active={frameMs === p.frameMs}
                  onClick={() => setFrameMs(p.frameMs)}
                >
                  {p.label}
                </Chip>
              ))}
            </div>
            <label className="block space-y-1.5">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>ms / frame</span>
                <span className="font-mono text-foreground">{frameMs}</span>
              </div>
              <input
                type="range"
                min={40}
                max={800}
                step={10}
                value={frameMs}
                onChange={(e) => setFrameMs(Number(e.target.value))}
                className="w-full accent-foreground"
              />
            </label>
          </ControlBlock>

          <ControlBlock title="Display">
            <label className="block space-y-1.5">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Scale</span>
                <span className="font-mono text-foreground">
                  {scale.toFixed(2)}×
                </span>
              </div>
              <input
                type="range"
                min={0.5}
                max={3}
                step={0.05}
                value={scale}
                onChange={(e) => setScale(Number(e.target.value))}
                className="w-full accent-foreground"
              />
            </label>

            <p className="mt-3 mb-1.5 text-xs text-muted-foreground">
              Background
            </p>
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  ["checker", "Checker"],
                  ["light", "Light"],
                  ["dark", "Dark"],
                  ["muted", "Muted"],
                ] as const
              ).map(([id, label]) => (
                <Chip key={id} active={bg === id} onClick={() => setBg(id)}>
                  {label}
                </Chip>
              ))}
            </div>

            <div className="mt-3 space-y-2">
              <ToggleRow
                label="Pixelated rendering"
                checked={pixelated}
                onChange={setPixelated}
              />
              <ToggleRow label="Loop" checked={loop} onChange={setLoop} />
            </div>
          </ControlBlock>
        </aside>
      </main>
    </div>
  );
}

function ControlBlock({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h2 className="mb-2 text-sm font-medium">{title}</h2>
      {children}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs transition-colors",
        active
          ? "border-foreground bg-foreground text-background"
          : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-3.5 accent-foreground"
      />
    </label>
  );
}
