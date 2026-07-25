"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { cn } from "@/lib/utils";

type GridCell = {
  id: string;
  x: number;
  y: number;
  blinkDelay: number;
  fadeDelay: number;
  initialOpacity: number;
  color: string | null;
};

export type ImageLoaderProps = {
  /** When omitted, stays in the blinking grid “generating” state. */
  src?: string | null;
  alt?: string;
  gridSize?: number;
  cellShape?: "circle" | "square";
  cellGap?: number;
  cellColor?: string;
  blinkSpeed?: number;
  transitionDuration?: number;
  fadeOutDuration?: number;
  loadingDelay?: number;
  onLoad?: () => void;
  className?: string;
  /** Status label under the grid while waiting for `src`. */
  statusText?: string;
};

/**
 * Pixel-grid loader for image generation: blink → sample colors → reveal image.
 * Without `src`, keeps blinking (in-progress generation).
 */
export function ImageLoader({
  src = null,
  alt = "",
  gridSize = 14,
  cellShape = "square",
  cellGap = 10,
  cellColor = "#94a3b8",
  blinkSpeed = 1800,
  transitionDuration = 500,
  fadeOutDuration = 600,
  loadingDelay = 400,
  onLoad,
  className,
  statusText = "",
}: ImageLoaderProps) {
  const reactId = useId().replace(/:/g, "");
  const animName = `oa-img-blink-${reactId}`;

  const [isLoading, setIsLoading] = useState(true);
  const [showImage, setShowImage] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [isFadingOut, setIsFadingOut] = useState(false);
  const [gridCells, setGridCells] = useState<GridCell[]>([]);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const processedSrcRef = useRef<string | null>(null);
  const loadStartTimeRef = useRef(0);
  const timersRef = useRef<number[]>([]);

  const clearTimers = () => {
    for (const id of timersRef.current) window.clearTimeout(id);
    timersRef.current = [];
  };

  useEffect(() => {
    loadStartTimeRef.current = Date.now();
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) {
        setSize({ width: Math.round(width), height: Math.round(height) });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (size.width === 0 || size.height === 0) return;
    const cellWithGap = gridSize + cellGap;
    const cols = Math.ceil(size.width / cellWithGap) + 1;
    const rows = Math.ceil(size.height / cellWithGap) + 1;
    const cells: GridCell[] = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        cells.push({
          id: `${row}-${col}`,
          x: col * cellWithGap,
          y: row * cellWithGap,
          blinkDelay: Math.random() * blinkSpeed,
          fadeDelay: Math.random() * fadeOutDuration,
          initialOpacity: Math.random() * 0.7 + 0.3,
          color: null,
        });
      }
    }
    setGridCells(cells);
  }, [size.width, size.height, gridSize, cellGap, blinkSpeed, fadeOutDuration]);

  // Reset when waiting for a new generation (no src yet).
  useEffect(() => {
    if (src) return;
    clearTimers();
    processedSrcRef.current = null;
    loadStartTimeRef.current = Date.now();
    setIsLoading(true);
    setShowImage(false);
    setIsTransitioning(false);
    setIsFadingOut(false);
  }, [src]);

  const sampleColorFromRegion = useCallback(
    (
      canvas: HTMLCanvasElement,
      x: number,
      y: number,
      w: number,
      h: number
    ): string => {
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return cellColor;
      const sx = Math.max(0, Math.min(canvas.width - 1, Math.floor(x)));
      const sy = Math.max(0, Math.min(canvas.height - 1, Math.floor(y)));
      const sw = Math.max(1, Math.min(canvas.width - sx, Math.floor(w)));
      const sh = Math.max(1, Math.min(canvas.height - sy, Math.floor(h)));
      try {
        const imageData = ctx.getImageData(sx, sy, sw, sh);
        const data = imageData.data;
        let r = 0;
        let g = 0;
        let b = 0;
        let count = 0;
        for (let i = 0; i < data.length; i += 16) {
          r += data[i]!;
          g += data[i + 1]!;
          b += data[i + 2]!;
          count++;
        }
        if (!count) return cellColor;
        return `rgb(${Math.round(r / count)}, ${Math.round(g / count)}, ${Math.round(b / count)})`;
      } catch {
        return cellColor;
      }
    },
    [cellColor]
  );

  const processImage = useCallback(
    (img: HTMLImageElement, currentGridCells: GridCell[], source: string) => {
      if (processedSrcRef.current === source || currentGridCells.length === 0) {
        return;
      }
      processedSrcRef.current = source;

      const doProcess = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx || !img.naturalWidth) {
          setIsLoading(false);
          setShowImage(true);
          onLoad?.();
          return;
        }
        ctx.drawImage(img, 0, 0);
        const scaleX = img.naturalWidth / Math.max(size.width, 1);
        const scaleY = img.naturalHeight / Math.max(size.height, 1);
        const updatedCells = currentGridCells.map((cell) => ({
          ...cell,
          color: sampleColorFromRegion(
            canvas,
            cell.x * scaleX,
            cell.y * scaleY,
            gridSize * scaleX,
            gridSize * scaleY
          ),
        }));
        setGridCells(updatedCells);
        setIsLoading(false);
        setIsTransitioning(true);

        timersRef.current.push(
          window.setTimeout(() => setShowImage(true), transitionDuration)
        );
        timersRef.current.push(
          window.setTimeout(() => {
            setIsTransitioning(false);
            setIsFadingOut(true);
          }, transitionDuration)
        );
        onLoad?.();
      };

      const elapsed = Date.now() - loadStartTimeRef.current;
      const remaining = Math.max(0, loadingDelay - elapsed);
      timersRef.current.push(window.setTimeout(doProcess, remaining));
    },
    [
      size.width,
      size.height,
      gridSize,
      transitionDuration,
      loadingDelay,
      sampleColorFromRegion,
      onLoad,
    ]
  );

  useEffect(() => {
    if (!src || gridCells.length === 0) return;
    const img = imageRef.current;
    if (!img) return;

    if (img.complete && img.naturalWidth > 0) {
      processImage(img, gridCells, src);
      return;
    }
    const handleLoad = () => processImage(img, gridCells, src);
    img.addEventListener("load", handleLoad);
    return () => img.removeEventListener("load", handleLoad);
  }, [src, gridCells, processImage]);

  useEffect(() => () => clearTimers(), []);

  const getCellStyle = (cell: GridCell): CSSProperties => {
    const base: CSSProperties = {
      position: "absolute",
      left: cell.x,
      top: cell.y,
      willChange: "opacity, background-color, width, height, left, top",
    };

    if (isLoading) {
      return {
        ...base,
        animation: `${animName} ${blinkSpeed}ms infinite`,
        animationDelay: `${cell.blinkDelay}ms`,
        animationFillMode: "backwards",
        backgroundColor: cellColor,
        width: gridSize,
        height: gridSize,
        opacity: cell.initialOpacity,
      };
    }

    if (isTransitioning) {
      return {
        ...base,
        backgroundColor: cell.color || cellColor,
        transition: `background-color ${transitionDuration}ms ease, width ${transitionDuration}ms ease, height ${transitionDuration}ms ease, left ${transitionDuration}ms ease, top ${transitionDuration}ms ease, opacity ${transitionDuration}ms ease`,
        width: gridSize + cellGap,
        height: gridSize + cellGap,
        left: cell.x - cellGap / 2,
        top: cell.y - cellGap / 2,
        opacity: 1,
        animation: "none",
      };
    }

    if (isFadingOut) {
      return {
        ...base,
        backgroundColor: cell.color || cellColor,
        opacity: 0,
        transition: `opacity ${fadeOutDuration}ms ease`,
        transitionDelay: `${cell.fadeDelay}ms`,
        width: gridSize + cellGap,
        height: gridSize + cellGap,
        left: cell.x - cellGap / 2,
        top: cell.y - cellGap / 2,
      };
    }

    return base;
  };

  return (
    <div className={cn("relative h-full w-full", className)}>
      <style>{`
        @keyframes ${animName} {
          0%, 100% { opacity: 0.25; }
          50% { opacity: 0.95; }
        }
      `}</style>

      <div
        ref={containerRef}
        className="relative h-full w-full overflow-hidden bg-muted/40"
      >
        {gridCells.length > 0 ? (
          <div className="pointer-events-none absolute inset-0 z-10">
            {gridCells.map((cell) => (
              <div
                key={cell.id}
                className={cellShape === "circle" ? "rounded-full" : "rounded-sm"}
                style={getCellStyle(cell)}
              />
            ))}
          </div>
        ) : null}

        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            ref={imageRef}
            src={src}
            alt={alt}
            className="absolute inset-0 z-0 h-full w-full object-cover"
            style={{
              opacity: showImage ? 1 : 0,
              transition: "opacity 300ms ease",
            }}
          />
        ) : null}

        {!src && statusText ? (
          <p className="pointer-events-none absolute inset-x-0 bottom-3 z-20 text-center text-xs text-muted-foreground">
            {statusText}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export default ImageLoader;
