/** Folder-driven chat sprite pools — add a folder under public/sprites to opt in. */

export type ChatSpriteClip = {
  id: string;
  srcBase: string;
  frames: string[];
  /** From folder suffix, e.g. work_drum_1.5 → 1.5; default 1.25 */
  scale: number;
};

export type ChatSpritePools = {
  /** Preferred idle (~65%) — folder id `idle_breath` (ignores scale suffix) */
  idleBreath: ChatSpriteClip | null;
  /** Other folders whose name contains "idle" (excludes breath); share ~35% */
  idleOthers: ChatSpriteClip[];
  /** Folders whose name contains "work" — used while AI is streaming */
  work: ChatSpriteClip[];
};

const BREATH_BASE_ID = "idle_breath";
const IDLE_WEIGHT = 0.65;
/** Used when folder name has no trailing scale, e.g. idle_breath */
export const DEFAULT_SPRITE_SCALE = 1.25;

/**
 * Trailing `_1.5` / `_2` in the folder name sets display scale.
 * Examples: work_drum_1.5 → 1.5, idle_time → 1.25 (default)
 */
export function parseSpriteScale(folderId: string): number {
  const m = folderId.match(/_(\d+(?:\.\d+)?)$/);
  if (!m) return DEFAULT_SPRITE_SCALE;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0 || n > 8) return DEFAULT_SPRITE_SCALE;
  return n;
}

/** Strip trailing `_1.5` scale suffix for role matching. */
export function spriteFolderBaseId(folderId: string): string {
  return folderId.replace(/_(\d+(?:\.\d+)?)$/, "");
}

function hasIdle(id: string) {
  return spriteFolderBaseId(id).toLowerCase().includes("idle");
}

function hasWork(id: string) {
  return spriteFolderBaseId(id).toLowerCase().includes("work");
}

function isBreath(id: string) {
  return spriteFolderBaseId(id).toLowerCase() === BREATH_BASE_ID;
}

function pickUniform<T>(items: T[]): T | null {
  if (items.length === 0) return null;
  return items[Math.floor(Math.random() * items.length)] ?? null;
}

export function buildChatSpritePools(
  sequences: Array<{ id: string; srcBase: string; frames: string[] }>,
): ChatSpritePools {
  const clips: ChatSpriteClip[] = sequences
    .filter((s) => s.frames.length > 0)
    .map((s) => ({
      id: s.id,
      srcBase: s.srcBase,
      frames: s.frames,
      scale: parseSpriteScale(s.id),
    }));

  const idleBreath = clips.find((c) => isBreath(c.id)) ?? null;
  const idleOthers = clips.filter((c) => hasIdle(c.id) && !isBreath(c.id));
  const work = clips.filter((c) => hasWork(c.id));

  return { idleBreath, idleOthers, work };
}

/** Idle: breath 65%; remaining 35% split equally across other idle* folders. */
export function pickIdleClip(pools: ChatSpritePools): ChatSpriteClip | null {
  const { idleBreath, idleOthers } = pools;
  if (idleBreath && Math.random() < IDLE_WEIGHT) return idleBreath;
  const other = pickUniform(idleOthers);
  if (other) return other;
  return idleBreath;
}

/** Streaming/work: equal chance among folders with "work" in the name. */
export function pickWorkClip(pools: ChatSpritePools): ChatSpriteClip | null {
  return pickUniform(pools.work) ?? pickIdleClip(pools);
}

/**
 * Pixel box at the given folder scale.
 * Sizes are calibrated so scale 1.25 matches the previous default look;
 * perched stays ~half of hero (composer downsize).
 */
export function spriteBoxForVariant(
  variant: "hero" | "perched",
  scale: number = DEFAULT_SPRITE_SCALE,
): { height: number; width: number } {
  const s = Number.isFinite(scale) && scale > 0 ? scale : DEFAULT_SPRITE_SCALE;
  // At scale 1.0 — hero was h-16 w-36 and perched ~half at default 1.25
  const hero = { height: 64 / DEFAULT_SPRITE_SCALE, width: 144 / DEFAULT_SPRITE_SCALE };
  const perched = {
    height: 32 / DEFAULT_SPRITE_SCALE,
    width: 72 / DEFAULT_SPRITE_SCALE,
  };
  const base = variant === "perched" ? perched : hero;
  return {
    height: Math.round(base.height * s * 100) / 100,
    width: Math.round(base.width * s * 100) / 100,
  };
}
