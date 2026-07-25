export type SpriteSequence = {
  id: string;
  label: string;
  /** Path under /public, e.g. "/sprites/idle" */
  srcBase: string;
  frameCount: number;
  /** When set, playback uses these URLs instead of srcBase/1.png… */
  frameSrcs?: string[];
  group: "4.0" | "3.0" | "2.5" | "2.0";
  note?: string;
};

/** Static catalog for docs / fallbacks. Chat buddy scans public/sprites via API. */
export const SPRITE_SEQUENCES: SpriteSequence[] = [
  {
    id: "idle",
    label: "Idle / blink",
    srcBase: "/sprites/idle",
    frameCount: 12,
    group: "3.0",
    note: "Sprite 3.0 — soft idle",
  },
  {
    id: "walk",
    label: "Walk",
    srcBase: "/sprites/walk",
    frameCount: 12,
    group: "3.0",
    note: "Sprite 3.0 — walk cycle",
  },
  {
    id: "v25-01",
    label: "v2.5 · 01 Work / sleep",
    srcBase: "/sprites/v25-01",
    frameCount: 16,
    group: "2.5",
  },
  {
    id: "v25-02",
    label: "v2.5 · 02",
    srcBase: "/sprites/v25-02",
    frameCount: 16,
    group: "2.5",
  },
  {
    id: "v25-03",
    label: "v2.5 · 03",
    srcBase: "/sprites/v25-03",
    frameCount: 16,
    group: "2.5",
  },
  {
    id: "v25-04",
    label: "v2.5 · 04",
    srcBase: "/sprites/v25-04",
    frameCount: 16,
    group: "2.5",
  },
  {
    id: "v25-05",
    label: "v2.5 · 05 Build",
    srcBase: "/sprites/v25-05",
    frameCount: 16,
    group: "2.5",
  },
  {
    id: "v25-06",
    label: "v2.5 · 06 Cart",
    srcBase: "/sprites/v25-06",
    frameCount: 16,
    group: "2.5",
  },
  {
    id: "v25-07",
    label: "v2.5 · 07",
    srcBase: "/sprites/v25-07",
    frameCount: 16,
    group: "2.5",
  },
  {
    id: "v25-08",
    label: "v2.5 · 08",
    srcBase: "/sprites/v25-08",
    frameCount: 16,
    group: "2.5",
  },
  {
    id: "v25-09",
    label: "v2.5 · 09",
    srcBase: "/sprites/v25-09",
    frameCount: 16,
    group: "2.5",
  },
  {
    id: "v2-01",
    label: "v2 · 01 Walk",
    srcBase: "/sprites/v2-01",
    frameCount: 16,
    group: "2.0",
  },
  {
    id: "v2-02",
    label: "v2 · 02",
    srcBase: "/sprites/v2-02",
    frameCount: 16,
    group: "2.0",
  },
  {
    id: "v2-03",
    label: "v2 · 03",
    srcBase: "/sprites/v2-03",
    frameCount: 16,
    group: "2.0",
  },
  {
    id: "v2-04",
    label: "v2 · 04",
    srcBase: "/sprites/v2-04",
    frameCount: 16,
    group: "2.0",
  },
  {
    id: "v2-05",
    label: "v2 · 05",
    srcBase: "/sprites/v2-05",
    frameCount: 16,
    group: "2.0",
  },
  {
    id: "v2-06",
    label: "v2 · 06",
    srcBase: "/sprites/v2-06",
    frameCount: 16,
    group: "2.0",
  },
  {
    id: "v2-07",
    label: "v2 · 07",
    srcBase: "/sprites/v2-07",
    frameCount: 16,
    group: "2.0",
  },
  {
    id: "v2-08",
    label: "v2 · 08",
    srcBase: "/sprites/v2-08",
    frameCount: 16,
    group: "2.0",
  },
  {
    id: "v2-09",
    label: "v2 · 09 Idle dust",
    srcBase: "/sprites/v2-09",
    frameCount: 16,
    group: "2.0",
  },
  {
    id: "v2-10",
    label: "v2 · 10",
    srcBase: "/sprites/v2-10",
    frameCount: 16,
    group: "2.0",
  },
  {
    id: "v2-11",
    label: "v2 · 11",
    srcBase: "/sprites/v2-11",
    frameCount: 16,
    group: "2.0",
  },
  {
    id: "v2-12",
    label: "v2 · 12",
    srcBase: "/sprites/v2-12",
    frameCount: 16,
    group: "2.0",
  },
  {
    id: "v2-13",
    label: "v2 · 13 Computer",
    srcBase: "/sprites/v2-13",
    frameCount: 16,
    group: "2.0",
  },
  {
    id: "v2-14",
    label: "v2 · 14",
    srcBase: "/sprites/v2-14",
    frameCount: 16,
    group: "2.0",
  },
];

export const SPEED_PRESETS = [
  { id: "fast", label: "Fast", frameMs: 120 },
  { id: "mid", label: "Mid", frameMs: 180 },
  { id: "slow", label: "Slow", frameMs: 250 },
  { id: "slower", label: "Slower", frameMs: 400 },
] as const;

export function getSpriteSequence(id: string): SpriteSequence {
  return SPRITE_SEQUENCES.find((s) => s.id === id) ?? SPRITE_SEQUENCES[0];
}

/** Numbered frames: 1.webp / 1.png / … — prefer explicit frameSrcs from /api/sprites. */
export function frameUrls(
  srcBase: string,
  frameCount: number,
  ext: "webp" | "png" | "jpg" | "jpeg" = "webp",
): string[] {
  return Array.from(
    { length: frameCount },
    (_, i) => `${srcBase}/${i + 1}.${ext}`,
  );
}
