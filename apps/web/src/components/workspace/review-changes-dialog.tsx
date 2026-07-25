"use client";

import { useState } from "react";
import { Check, GitPullRequestArrow, Loader2, X } from "lucide-react";
import type { Suggestion } from "@/lib/app-state";
import { diffTexts, type DiffSegment } from "@/lib/text-diff";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

function DiffLine({
  segments,
  mode,
}: {
  segments: DiffSegment[];
  mode: "old" | "new";
}) {
  const filtered =
    mode === "old"
      ? segments.filter((s) => s.type !== "insert")
      : segments.filter((s) => s.type !== "delete");

  if (filtered.length === 0) return null;

  return (
    <pre
      className={cn(
        "max-h-36 overflow-auto whitespace-pre-wrap rounded-md p-2 text-[11px] leading-relaxed",
        mode === "old"
          ? "mb-1.5 bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-200"
          : "bg-emerald-50 text-emerald-950 dark:bg-emerald-950/40 dark:text-emerald-100"
      )}
    >
      <span
        className={cn(
          "font-semibold",
          mode === "old"
            ? "text-red-700 dark:text-red-300"
            : "text-emerald-700 dark:text-emerald-300"
        )}
      >
        {mode === "old" ? "− " : "+ "}
      </span>
      {filtered.map((seg, i) => {
        if (seg.type === "equal") {
          return (
            <span key={i} className="opacity-55">
              {seg.text}
            </span>
          );
        }
        return (
          <mark
            key={i}
            className={cn(
              "rounded-sm px-0.5 font-medium",
              mode === "old"
                ? "bg-red-200/90 text-red-950 dark:bg-red-800/70 dark:text-red-50"
                : "bg-emerald-200/90 text-emerald-950 dark:bg-emerald-800/70 dark:text-emerald-50"
            )}
          >
            {seg.text}
          </mark>
        );
      })}
    </pre>
  );
}

function PatchDiffPreview({ oldText, newText }: { oldText: string; newText: string }) {
  const segments = diffTexts(oldText, newText);
  const hasDelete = segments.some((s) => s.type === "delete");
  const hasInsert = segments.some((s) => s.type === "insert");

  return (
    <>
      {hasDelete || oldText ? <DiffLine segments={segments} mode="old" /> : null}
      {hasInsert || newText ? <DiffLine segments={segments} mode="new" /> : null}
    </>
  );
}

type BusyState =
  | { kind: "all" }
  | { kind: "item"; id: string; action: "accept" | "reject" }
  | null;

type Props = {
  suggestions: Suggestion[];
  onAccept: (id: string) => void | Promise<void>;
  onReject: (id: string) => void | Promise<void>;
  onAcceptAll: () => void | Promise<void>;
};

export function ReviewChangesDialog({
  suggestions,
  onAccept,
  onReject,
  onAcceptAll,
}: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<BusyState>(null);
  const count = suggestions.length;
  if (count === 0) return null;

  const anyBusy = busy != null;

  const runItem = async (id: string, action: "accept" | "reject") => {
    if (anyBusy) return;
    setBusy({ kind: "item", id, action });
    try {
      if (action === "accept") await onAccept(id);
      else await onReject(id);
      if (count <= 1) setOpen(false);
    } finally {
      setBusy(null);
    }
  };

  const runAcceptAll = async () => {
    if (anyBusy) return;
    setBusy({ kind: "all" });
    try {
      await onAcceptAll();
      setOpen(false);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-8 gap-1.5"
        onClick={() => setOpen(true)}
      >
        <GitPullRequestArrow className="size-3.5" />
        Review AI changes
        <Badge variant="secondary" className="ml-0.5 h-5 px-1.5 text-[10px]">
          {count}
        </Badge>
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (anyBusy) return;
          setOpen(next);
        }}
      >
        <DialogContent
          className="flex max-h-[min(85vh,40rem)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
          showCloseButton={!anyBusy}
        >
          <DialogHeader className="shrink-0 border-b px-4 py-3 pr-12 text-left">
            <DialogTitle className="text-base">Review AI changes</DialogTitle>
            <DialogDescription className="text-xs">
              {count} pending change{count === 1 ? "" : "s"}. Accept or reject here, or use ✓ / ✕
              inline in the document.
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
            <div className="flex flex-col gap-3">
              {suggestions.map((s, i) => {
                const itemBusy =
                  busy?.kind === "item" && busy.id === s.id ? busy.action : null;
                return (
                  <article
                    key={s.id}
                    className={cn(
                      "rounded-lg border bg-background p-3 shadow-xs",
                      anyBusy && !itemBusy && "opacity-60"
                    )}
                  >
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="wrap-break-word text-sm font-medium capitalize">
                          {s.kind}
                          {s.section_heading ? ` · ${s.section_heading}` : ""}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          Change #{i + 1}
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button
                          size="sm"
                          className="h-7 gap-1 bg-emerald-600 px-2 hover:bg-emerald-700"
                          disabled={anyBusy}
                          onClick={() => void runItem(s.id, "accept")}
                        >
                          {itemBusy === "accept" ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Check className="size-3.5" />
                          )}
                          Accept
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1 px-2 text-red-600"
                          disabled={anyBusy}
                          onClick={() => void runItem(s.id, "reject")}
                        >
                          {itemBusy === "reject" ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <X className="size-3.5" />
                          )}
                          Reject
                        </Button>
                      </div>
                    </div>

                    {s.kind === "patch" && (s.old_text || s.new_text) ? (
                      <PatchDiffPreview oldText={s.old_text} newText={s.new_text} />
                    ) : (
                      <>
                        {s.old_text ? (
                          <pre className="mb-1.5 max-h-36 overflow-auto whitespace-pre-wrap rounded-md bg-red-50 p-2 text-[11px] leading-relaxed text-red-900 dark:bg-red-950/40 dark:text-red-200">
                            <span className="font-semibold text-red-700 dark:text-red-300">
                              −{" "}
                            </span>
                            {s.old_text}
                          </pre>
                        ) : null}
                        {s.new_text ? (
                          <pre className="max-h-36 overflow-auto whitespace-pre-wrap rounded-md bg-emerald-50 p-2 text-[11px] leading-relaxed text-emerald-950 dark:bg-emerald-950/40 dark:text-emerald-100">
                            <span className="font-semibold text-emerald-700 dark:text-emerald-300">
                              +{" "}
                            </span>
                            {s.new_text}
                          </pre>
                        ) : null}
                      </>
                    )}
                  </article>
                );
              })}
            </div>
          </div>

          {count > 1 && (
            <div className="flex shrink-0 items-center justify-end gap-2 border-t px-4 py-3">
              <Button
                size="sm"
                variant="outline"
                disabled={anyBusy}
                onClick={() => void runAcceptAll()}
              >
                {busy?.kind === "all" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : null}
                {busy?.kind === "all" ? "Accepting…" : `Accept all (${count})`}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
