"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { cn } from "@/lib/utils";
import { frameUrls } from "@/lib/sprite-catalog";

type SpritePlayerProps = {
  /** Folder under /public, e.g. "/sprites/idle" — used when frameSrcs omitted */
  srcBase?: string;
  frameCount?: number;
  /** Explicit frame URLs (wins over srcBase). Order = playback order. */
  frameSrcs?: string[];
  /** Milliseconds per frame */
  frameMs?: number;
  /** Controlled frame index (0-based). When set with onFrameChange, parent owns the index. */
  frame?: number;
  playing?: boolean;
  loop?: boolean;
  pixelated?: boolean;
  /** Bump to restart from frame 0 without remounting / reloading images */
  replayNonce?: number;
  className?: string;
  imgClassName?: string;
  style?: CSSProperties;
  alt?: string;
  onFrameChange?: (frame: number) => void;
  /** Fired once when a non-looping sequence reaches the last frame */
  onComplete?: () => void;
};

/**
 * Hard-frame sprite player: all frames stay mounted; CSS opacity swaps
 * the active one with no transition (cleaner for pixel art than crossfade).
 */
export function SpritePlayer({
  srcBase = "",
  frameCount = 12,
  frameSrcs,
  frameMs = 180,
  frame: controlledFrame,
  playing = true,
  loop = true,
  pixelated = true,
  replayNonce = 0,
  className,
  imgClassName,
  style,
  alt = "",
  onFrameChange,
  onComplete,
}: SpritePlayerProps) {
  const frames = useMemo(
    () =>
      frameSrcs && frameSrcs.length > 0
        ? frameSrcs
        : frameUrls(srcBase, frameCount),
    [frameSrcs, srcBase, frameCount],
  );
  const total = frames.length;
  const isControlled = controlledFrame !== undefined;
  const [internalFrame, setInternalFrame] = useState(0);
  const [ready, setReady] = useState(false);

  const active = isControlled
    ? Math.min(Math.max(controlledFrame, 0), Math.max(total - 1, 0))
    : internalFrame;

  const activeRef = useRef(active);
  const onFrameChangeRef = useRef(onFrameChange);
  const onCompleteRef = useRef(onComplete);
  const completedRef = useRef(false);
  activeRef.current = active;
  onFrameChangeRef.current = onFrameChange;
  onCompleteRef.current = onComplete;

  // New frame list → reload images
  useEffect(() => {
    setInternalFrame(0);
    setReady(false);
    completedRef.current = false;
  }, [frames]);

  // Same clip replay (e.g. work folder picked again) — no image reload
  useEffect(() => {
    if (replayNonce === 0) return;
    completedRef.current = false;
    if (!isControlled) setInternalFrame(0);
    else onFrameChangeRef.current?.(0);
  }, [replayNonce, isControlled]);

  useEffect(() => {
    if (!frames.length) {
      setReady(true);
      return;
    }
    let cancelled = false;
    let loaded = 0;
    const images = frames.map((src) => {
      const img = new window.Image();
      let counted = false;
      const done = () => {
        if (cancelled || counted) return;
        counted = true;
        loaded += 1;
        // Start after the first frame so webp batches don't stall the whole clip
        if (loaded === 1) setReady(true);
      };
      img.onload = img.onerror = done;
      img.src = src;
      // Cached webp/png may already be complete before handlers attach
      if (img.complete) done();
      return img;
    });
    return () => {
      cancelled = true;
      images.forEach((img) => {
        img.onload = null;
        img.onerror = null;
      });
    };
  }, [frames]);

  useEffect(() => {
    if (!playing || !ready || total === 0) return;

    const id = window.setInterval(() => {
      const prev = activeRef.current;
      const next = prev + 1;

      if (next >= total) {
        if (loop) {
          if (isControlled) onFrameChangeRef.current?.(0);
          else setInternalFrame(0);
          return;
        }
        if (!completedRef.current) {
          completedRef.current = true;
          queueMicrotask(() => onCompleteRef.current?.());
        }
        return;
      }

      if (isControlled) onFrameChangeRef.current?.(next);
      else setInternalFrame(next);
    }, Math.max(16, frameMs));

    return () => window.clearInterval(id);
  }, [isControlled, playing, ready, frameMs, total, loop]);

  return (
    <div
      className={cn("relative overflow-hidden", className)}
      style={style}
      aria-hidden={alt ? undefined : true}
      data-ready={ready || undefined}
    >
      {frames.map((src, i) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={src}
          src={src}
          alt={i === active ? alt : ""}
          draggable={false}
          className={cn(
            "pointer-events-none absolute inset-0 m-auto h-full w-auto max-w-full object-contain transition-none",
            i === active ? "opacity-100" : "opacity-0",
            pixelated && "[image-rendering:pixelated]",
            imgClassName,
          )}
        />
      ))}
    </div>
  );
}
