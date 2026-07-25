"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { cn } from "@/lib/utils";

export type TocHeading = {
  id: string;
  level: number;
  title: string;
};

/** How many headings to show in the map at once. */
const WINDOW_SIZE = 10;

/** Minimal editor surface needed for the document map. */
type DocumentMapEditor = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  forEachBlock: (callback: (block: any) => boolean) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onChange: (callback: (...args: any[]) => void) => () => void;
  setTextCursorPosition: (
    target: string,
    placement?: "start" | "end"
  ) => void;
};

function inlineContentToText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((node) => {
      if (!node || typeof node !== "object") return "";
      const n = node as { type?: string; text?: string };
      return n.type === "text" && typeof n.text === "string" ? n.text : "";
    })
    .join("");
}

/** Collect heading blocks from a BlockNote document (document order). */
export function extractHeadings(editor: DocumentMapEditor): TocHeading[] {
  const items: TocHeading[] = [];
  editor.forEachBlock((block) => {
    if (block.type === "heading") {
      const level =
        typeof block.props.level === "number" ? block.props.level : 1;
      const title = inlineContentToText(block.content).trim() || "Untitled";
      items.push({ id: block.id, level, title });
    }
    return true;
  });
  return items;
}

/** Slice ~WINDOW_SIZE headings centered on the active one. */
export function visibleWindow(
  headings: TocHeading[],
  activeId: string | null,
  size = WINDOW_SIZE
): TocHeading[] {
  if (headings.length <= size) return headings;

  let activeIndex = headings.findIndex((h) => h.id === activeId);
  if (activeIndex < 0) activeIndex = 0;

  const half = Math.floor(size / 2);
  let start = activeIndex - half;
  let end = start + size;

  if (start < 0) {
    start = 0;
    end = size;
  } else if (end > headings.length) {
    end = headings.length;
    start = headings.length - size;
  }

  return headings.slice(start, end);
}

function lineWidth(level: number): string {
  if (level <= 1) return "1.5rem";
  if (level === 2) return "1rem";
  return "0.625rem";
}

function lineIndent(level: number): string {
  if (level <= 1) return "0";
  if (level === 2) return "0.4rem";
  return "0.8rem";
}

function headingsEqual(a: TocHeading[], b: TocHeading[]) {
  if (a.length !== b.length) return false;
  return a.every(
    (item, i) =>
      item.id === b[i]?.id &&
      item.level === b[i]?.level &&
      item.title === b[i]?.title
  );
}

type DocumentMapProps = {
  editor: DocumentMapEditor;
  scrollContainerRef: RefObject<HTMLElement | null>;
  className?: string;
};

/**
 * Notion-style document map: indented lines for headings that expand
 * into a clickable table of contents on hover.
 *
 * Mini rail shows a sliding window of ~10 headings around the current
 * scroll position. Hover popup lists the full TOC (scrollable if long).
 */
export function DocumentMap({
  editor,
  scrollContainerRef,
  className,
}: DocumentMapProps) {
  const [headings, setHeadings] = useState<TocHeading[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const headingsRef = useRef(headings);
  const popupListRef = useRef<HTMLUListElement>(null);
  headingsRef.current = headings;

  const refresh = useCallback(() => {
    const next = extractHeadings(editor);
    // Keep last headings if a mid-update pass briefly returns empty.
    if (next.length === 0 && headingsRef.current.length > 0) return;
    setHeadings((prev) => (headingsEqual(prev, next) ? prev : next));
  }, [editor]);

  useEffect(() => {
    refresh();
    return editor.onChange(() => {
      refresh();
    });
  }, [editor, refresh]);

  const updateActive = useCallback(() => {
    const container = scrollContainerRef.current;
    const list = headingsRef.current;
    if (!container || list.length === 0) {
      setActiveId(null);
      return;
    }

    const containerTop = container.getBoundingClientRect().top;
    const offset = 64;
    let next: string | null = list[0]?.id ?? null;

    for (const heading of list) {
      const el = container.querySelector<HTMLElement>(
        `[data-id="${heading.id}"]`
      );
      if (!el) continue;
      const top = el.getBoundingClientRect().top - containerTop;
      if (top <= offset) next = heading.id;
      else break;
    }

    setActiveId((prev) => (prev === next ? prev : next));
  }, [scrollContainerRef]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    updateActive();
    container.addEventListener("scroll", updateActive, { passive: true });
    return () => container.removeEventListener("scroll", updateActive);
  }, [scrollContainerRef, updateActive, headings]);

  const visible = useMemo(
    () => visibleWindow(headings, activeId, WINDOW_SIZE),
    [headings, activeId]
  );

  // Keep the active item in view inside the full-list popup.
  useEffect(() => {
    if (!activeId || !popupListRef.current) return;
    const item = popupListRef.current.querySelector<HTMLElement>(
      `[data-toc-id="${activeId}"]`
    );
    item?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const scrollTo = (id: string) => {
    const container = scrollContainerRef.current;
    const el = container?.querySelector<HTMLElement>(`[data-id="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    try {
      editor.setTextCursorPosition(id, "start");
    } catch {
      // Block may have been removed mid-click.
    }
  };

  if (headings.length === 0) return null;

  return (
    <nav
      aria-label="Document outline"
      className={cn(
        "group/toc pointer-events-auto absolute top-1/2 right-3 z-30 -translate-y-1/2",
        className
      )}
    >
      {/* In-flow mini lines — sliding window of ~10 */}
      <ul className="flex w-8 flex-col items-end gap-2.5 py-1 pr-1">
        {visible.map((heading) => {
          const active = heading.id === activeId;
          return (
            <li key={heading.id} className="flex w-full justify-end">
              <span
                aria-hidden
                className={cn(
                  "block h-[3px] rounded-full transition-colors duration-150",
                  active ? "bg-foreground" : "bg-foreground/50"
                )}
                style={{
                  width: lineWidth(heading.level),
                  marginRight: lineIndent(heading.level),
                }}
              />
            </li>
          );
        })}
      </ul>

      {/* Overlay panel — full TOC */}
      <div
        className={cn(
          "absolute top-1/2 right-0 z-10 w-56 max-h-[min(70vh,24rem)] -translate-y-1/2 overflow-y-auto rounded-md",
          "bg-background/95 p-1.5 shadow-md ring-1 ring-border backdrop-blur-sm",
          "invisible opacity-0 transition-opacity duration-150",
          "group-hover/toc:visible group-hover/toc:opacity-100",
          "group-focus-within/toc:visible group-focus-within/toc:opacity-100"
        )}
      >
        <ul ref={popupListRef} className="flex flex-col gap-0.5">
          {headings.map((heading) => {
            const active = heading.id === activeId;
            return (
              <li key={heading.id} data-toc-id={heading.id}>
                <button
                  type="button"
                  onClick={() => scrollTo(heading.id)}
                  className={cn(
                    "flex w-full rounded-sm px-1.5 py-1 text-left text-xs leading-snug transition-colors",
                    "hover:bg-muted",
                    active
                      ? "font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  style={{
                    paddingLeft: `${0.375 + Math.max(0, heading.level - 1) * 0.65}rem`,
                  }}
                >
                  <span className="truncate">{heading.title}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
