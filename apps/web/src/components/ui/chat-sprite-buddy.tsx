"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SpritePlayer } from "@/components/ui/sprite-player";
import {
  DEFAULT_SPRITE_SCALE,
  buildChatSpritePools,
  pickIdleClip,
  pickWorkClip,
  spriteBoxForVariant,
  type ChatSpriteClip,
  type ChatSpritePools,
} from "@/lib/chat-sprite-pools";
import { cn } from "@/lib/utils";

const SLOW_MS = 250;

type ChatSpriteBuddyProps = {
  /** hero = empty-state; perched = sits on composer */
  variant?: "hero" | "perched";
  /** When true (AI streaming), play work* folders; otherwise idle rules */
  playful?: boolean;
  className?: string;
};

export function ChatSpriteBuddy({
  variant = "hero",
  playful = false,
  className,
}: ChatSpriteBuddyProps) {
  const [pools, setPools] = useState<ChatSpritePools | null>(null);
  const [clip, setClip] = useState<ChatSpriteClip | null>(null);
  const [replayNonce, setReplayNonce] = useState(0);
  const poolsRef = useRef<ChatSpritePools | null>(null);
  const clipIdRef = useRef<string | null>(null);
  const playfulRef = useRef(playful);
  playfulRef.current = playful;
  poolsRef.current = pools;

  const box = useMemo(
    () =>
      spriteBoxForVariant(
        variant,
        clip?.scale ?? DEFAULT_SPRITE_SCALE,
      ),
    [variant, clip?.scale],
  );

  const playNext = useCallback((streaming: boolean) => {
    const p = poolsRef.current;
    if (!p) return;
    const next = streaming ? pickWorkClip(p) : pickIdleClip(p);
    if (!next) return;

    // Same folder again: restart in place (keeps webp/png decoded in memory)
    if (clipIdRef.current === next.id) {
      setReplayNonce((n) => n + 1);
      return;
    }
    clipIdRef.current = next.id;
    setClip(next);
    setReplayNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/sprites", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as {
          sequences?: Array<{ id: string; srcBase: string; frames: string[] }>;
          chat?: ChatSpritePools;
        };
        if (cancelled) return;
        // Prefer live folder scan so scale is always derived from folder names
        const nextPools = buildChatSpritePools(data.sequences ?? []);
        setPools(nextPools);
      } catch {
        // leave empty
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Start / switch when pools load or streaming toggles
  useEffect(() => {
    if (!pools) return;
    clipIdRef.current = null; // force clip swap when mode changes
    playNext(playful);
  }, [playful, pools, playNext]);

  const sizeStyle = {
    height: box.height,
    width: box.width,
  } as const;

  if (!clip?.frames.length) {
    return (
      <div className={cn(className)} style={sizeStyle} aria-hidden />
    );
  }

  return (
    <SpritePlayer
      frameSrcs={clip.frames}
      frameCount={clip.frames.length}
      frameMs={SLOW_MS}
      loop={false}
      replayNonce={replayNonce}
      onComplete={() => {
        playNext(playfulRef.current);
      }}
      className={cn(className)}
      style={sizeStyle}
      alt=""
    />
  );
}
