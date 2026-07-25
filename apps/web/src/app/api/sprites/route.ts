import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { buildChatSpritePools } from "@/lib/chat-sprite-pools";

export const dynamic = "force-dynamic";

export type SpriteFolderSequence = {
  id: string;
  label: string;
  srcBase: string;
  /** Public URLs sorted by filename — delete/rename files and refresh to reorder */
  frames: string[];
  frameCount: number;
  group: string;
};

function naturalCmp(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function groupForId(id: string): string {
  const lower = id.toLowerCase();
  if (lower.includes("idle") || lower.includes("work")) return "chat";
  if (id === "walk") return "3.0";
  if (id.startsWith("v4-")) return "4.0";
  if (id.startsWith("v25-")) return "2.5";
  if (id.startsWith("v2-")) return "2.0";
  return "other";
}

function labelForId(id: string): string {
  if (id === "idle") return "Idle / blink";
  if (id === "walk") return "Walk";
  if (id.startsWith("v4-")) return `v4 · ${id.slice(3)}`;
  if (id.startsWith("v25-")) return `v2.5 · ${id.slice(4)}`;
  if (id.startsWith("v2-")) return `v2 · ${id.slice(3)}`;
  return id.replace(/_/g, " ");
}

export async function GET() {
  const root = path.join(process.cwd(), "public", "sprites");
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return NextResponse.json({ sequences: [] as SpriteFolderSequence[] });
  }

  const sequences: SpriteFolderSequence[] = [];

  for (const name of entries.sort(naturalCmp)) {
    const dir = path.join(root, name);
    const st = await stat(dir).catch(() => null);
    if (!st?.isDirectory()) continue;

    // Accept webp / png / jpg (webp preferred for chat sprites)
    const files = (await readdir(dir))
      .filter((f) => /\.(webp|png|jpe?g)$/i.test(f) && !f.startsWith("_"))
      .sort(naturalCmp);

    if (!files.length) continue;

    const srcBase = `/sprites/${name}`;
    sequences.push({
      id: name,
      label: labelForId(name),
      srcBase,
      frames: files.map((f) => `${srcBase}/${f}`),
      frameCount: files.length,
      group: groupForId(name),
    });
  }

  // Prefer newer packs first in UI grouping later; keep stable id order here
  sequences.sort((a, b) => naturalCmp(a.id, b.id));

  const chat = buildChatSpritePools(sequences);

  return NextResponse.json(
    { sequences, chat, scannedAt: new Date().toISOString() },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
