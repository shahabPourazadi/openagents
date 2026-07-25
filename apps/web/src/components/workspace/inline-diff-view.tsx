"use client";

import { useMemo, useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import type { Components } from "react-markdown";
import type { Suggestion } from "@/lib/app-state";
import { buildInlineDiffPreview, splitMarkers } from "@/lib/inline-diff";
import { Markdown } from "@/components/ui/markdown";
import { cn } from "@/lib/utils";

type Props = {
  contentMd: string;
  suggestions: Suggestion[];
  onAccept: (id: string) => void | Promise<void>;
  onReject: (id: string) => void | Promise<void>;
};

function InlineActions({
  suggestionId,
  onAccept,
  onReject,
  busy,
  disabled,
}: {
  suggestionId: string;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  busy: "accept" | "reject" | null;
  disabled: boolean;
}) {
  return (
    <span
      className="not-typeset ml-1 inline-flex translate-y-[-1px] items-center gap-0.5 align-middle"
      contentEditable={false}
    >
      <button
        type="button"
        title="Accept change"
        aria-label="Accept change"
        disabled={disabled}
        className={cn(
          "inline-flex size-5 items-center justify-center rounded-full",
          "bg-emerald-600 text-white shadow-sm hover:bg-emerald-700",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500",
          "disabled:pointer-events-none disabled:opacity-50"
        )}
        onClick={() => onAccept(suggestionId)}
      >
        {busy === "accept" ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <Check className="size-3 stroke-[3]" />
        )}
      </button>
      <button
        type="button"
        title="Reject change"
        aria-label="Reject change"
        disabled={disabled}
        className={cn(
          "inline-flex size-5 items-center justify-center rounded-full",
          "border border-red-300 bg-white text-red-600 shadow-sm hover:bg-red-50",
          "dark:border-red-800 dark:bg-background dark:hover:bg-red-950/40",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400",
          "disabled:pointer-events-none disabled:opacity-50"
        )}
        onClick={() => onReject(suggestionId)}
      >
        {busy === "reject" ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <X className="size-3 stroke-[3]" />
        )}
      </button>
    </span>
  );
}

/** Prefer block layout for multi-line / heading / list markdown chunks. */
function isBlockMarkdown(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.includes("\n")) return true;
  return /^(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|\|)/.test(t);
}

const INLINE_MD_COMPONENTS: Partial<Components> = {
  p: ({ children }) => <>{children}</>,
};

function DiffMarkdown({
  text,
  inline,
}: {
  text: string;
  inline?: boolean;
}) {
  if (!text) return null;
  if (inline) {
    return (
      <Markdown className="inline [&>*]:inline" components={INLINE_MD_COMPONENTS}>
        {text}
      </Markdown>
    );
  }
  return <Markdown>{text}</Markdown>;
}

/**
 * Review preview: same underlying .md, rendered (typeset) with red/green + ✓/✕.
 * Does not mutate the stored document — display only.
 */
export function InlineDiffView({ contentMd, suggestions, onAccept, onReject }: Props) {
  const [busy, setBusy] = useState<{
    id: string;
    action: "accept" | "reject";
  } | null>(null);
  const preview = useMemo(
    () => buildInlineDiffPreview(contentMd, suggestions),
    [contentMd, suggestions]
  );
  const parts = useMemo(() => splitMarkers(preview), [preview]);

  const run = async (id: string, action: "accept" | "reject") => {
    if (busy) return;
    setBusy({ id, action });
    try {
      if (action === "accept") await onAccept(id);
      else await onReject(id);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
      <div className="typeset typeset-docs max-w-[40em]">
        {parts.map((part, i) => {
          if (part.type === "del") {
            const block = isBlockMarkdown(part.text);
            if (block) {
              return (
                <div
                  key={i}
                  className={cn(
                    "diff-box my-1 rounded border border-red-200/80 bg-red-50/90 px-1.5 py-0.5",
                    "text-[0.95em] leading-snug text-red-900 **:text-inherit",
                    "[&_p]:my-0.5 [&_h1]:my-1 [&_h1]:text-[1.15em]",
                    "[&_h2]:my-1 [&_h2]:text-[1.1em] [&_h3]:my-0.5 [&_h3]:text-[1.05em]",
                    "[&_h4]:my-0.5 [&_h5]:my-0.5 [&_h6]:my-0.5",
                    "[&_:first-child]:mt-0 [&_:last-child]:mb-0",
                    "dark:border-red-900/60 dark:bg-red-950/45 dark:text-red-100"
                  )}
                >
                  <DiffMarkdown text={part.text} />
                </div>
              );
            }
            return (
              <span
                key={i}
                className={cn(
                  "rounded-sm bg-red-100/90 px-0.5 text-red-800",
                  "dark:bg-red-950/55 dark:text-red-200"
                )}
              >
                <DiffMarkdown text={part.text} inline />
              </span>
            );
          }

          if (part.type === "ins") {
            const block = isBlockMarkdown(part.text);
            if (block) {
              return (
                <div
                  key={i}
                  className={cn(
                    "diff-box my-1 rounded border border-emerald-200/80 bg-emerald-50/90 px-1.5 py-0.5",
                    "text-[0.95em] leading-snug text-emerald-950 **:text-inherit",
                    "[&_p]:my-0.5 [&_h1]:my-1 [&_h1]:text-[1.15em]",
                    "[&_h2]:my-1 [&_h2]:text-[1.1em] [&_h3]:my-0.5 [&_h3]:text-[1.05em]",
                    "[&_h4]:my-0.5 [&_h5]:my-0.5 [&_h6]:my-0.5",
                    "[&_:first-child]:mt-0 [&_:last-child]:mb-0",
                    "dark:border-emerald-900/50 dark:bg-emerald-950/45 dark:text-emerald-50"
                  )}
                >
                  <DiffMarkdown text={part.text} />
                </div>
              );
            }
            return (
              <span
                key={i}
                className={cn(
                  "rounded-sm bg-emerald-100/90 px-0.5 text-emerald-950",
                  "dark:bg-emerald-950/55 dark:text-emerald-100"
                )}
              >
                <DiffMarkdown text={part.text} inline />
              </span>
            );
          }

          if (part.type === "act") {
            const itemBusy =
              busy?.id === part.suggestionId ? busy.action : null;
            return (
              <InlineActions
                key={i}
                suggestionId={part.suggestionId}
                busy={itemBusy}
                disabled={busy != null}
                onAccept={(id) => void run(id, "accept")}
                onReject={(id) => void run(id, "reject")}
              />
            );
          }

          // Unchanged regions — render as markdown (not raw source)
          if (!part.text) return null;
          return (
            <DiffMarkdown
              key={i}
              text={part.text}
              inline={!isBlockMarkdown(part.text)}
            />
          );
        })}
      </div>
    </div>
  );
}
