"use client";

import { X } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  fileExt,
  formatStyleForChip,
} from "@/components/workspace/file-format-style";
import type { MentionChip } from "@/components/workspace/composer-mentions";
import { cn } from "@/lib/utils";

export type PendingUpload = {
  id: string;
  label: string;
};

/** Stem for display; extension is shown separately as a badge. */
export function attachmentDisplayName(label: string): string {
  const base = label.trim().split(/[/\\]/).pop() || label.trim();
  const ext = fileExt(base);
  if (!ext) return base;
  return base.slice(0, -(ext.length + 1)) || base;
}

export function AttachmentFileSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "relative flex h-30 w-27 shrink-0 flex-col justify-between rounded-2xl bg-muted/80 p-2.5",
        className
      )}
      aria-hidden
    >
      <div className="space-y-2">
        <Skeleton className="h-2.5 w-[85%] rounded-full" />
        <Skeleton className="h-2.5 w-[65%] rounded-full" />
      </div>
      <Skeleton className="h-5 w-8 rounded-md" />
    </div>
  );
}

export function AttachmentFileCard({
  chip,
  onSelect,
  onRemove,
  className,
}: {
  chip: MentionChip;
  onSelect?: (chip: MentionChip) => void;
  onRemove?: (id: string) => void;
  className?: string;
}) {
  const style = formatStyleForChip(chip);
  const name = attachmentDisplayName(chip.label);
  const extLabel = style.label.toUpperCase();
  const interactive = !!onSelect;

  return (
    <div className={cn("group relative", className)}>
      <button
        type="button"
        disabled={!interactive}
        onClick={() => onSelect?.(chip)}
        title={chip.label}
        className={cn(
          "flex h-30 w-27 shrink-0 flex-col justify-between rounded-2xl border border-border bg-background p-2.5 text-left shadow-xs transition-colors",
          interactive && "hover:bg-muted/40 cursor-pointer",
          !interactive && "cursor-default"
        )}
      >
        <span className="line-clamp-4 wrap-break-word text-[12px] font-medium leading-snug text-foreground">
          {name}
        </span>
        <span className="inline-flex w-fit items-center rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {extLabel}
        </span>
      </button>
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove ${chip.label}`}
          className="absolute -top-1.5 -right-1.5 inline-flex size-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(chip.id);
          }}
        >
          <X className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

export function AttachmentCardRow({
  chips,
  pending,
  onSelect,
  onRemove,
  align = "start",
  className,
}: {
  chips: MentionChip[];
  pending?: PendingUpload[];
  onSelect?: (chip: MentionChip) => void;
  onRemove?: (id: string) => void;
  align?: "start" | "end";
  className?: string;
}) {
  if (!chips.length && !pending?.length) return null;
  return (
    <div
      className={cn(
        "flex flex-wrap gap-2",
        align === "end" ? "justify-end" : "justify-start",
        className
      )}
    >
      {chips.map((chip) => (
        <AttachmentFileCard
          key={`${chip.kind}:${chip.id}`}
          chip={chip}
          onSelect={onSelect}
          onRemove={onRemove}
        />
      ))}
      {pending?.map((p) => (
        <AttachmentFileSkeleton key={p.id} />
      ))}
    </div>
  );
}
