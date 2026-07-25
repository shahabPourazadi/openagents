"use client";

import { useMemo } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export type UsageBreakdownItem = {
  id: string;
  label: string;
  tokens: number;
};

export type ThreadUsage = {
  contextMax: number;
  contextUsed: number;
  contextPct: number;
  breakdown: UsageBreakdownItem[];
  /** Cumulative tokens billed this chat (input + output across runs). */
  sessionTokens: number;
  sessionInputTokens: number;
  sessionOutputTokens: number;
  lastRunTokens: number;
  lastRunRequests: number;
  lastRunCacheReadTokens: number;
};

export const EMPTY_USAGE: ThreadUsage = {
  contextMax: 1_000_000,
  contextUsed: 0,
  contextPct: 0,
  breakdown: [],
  sessionTokens: 0,
  sessionInputTokens: 0,
  sessionOutputTokens: 0,
  lastRunTokens: 0,
  lastRunRequests: 0,
  lastRunCacheReadTokens: 0,
};

const SEGMENT_COLORS = [
  "oklch(0.72 0.04 250)", // system — grey-blue
  "oklch(0.65 0.16 300)", // persona — purple
  "oklch(0.68 0.14 200)", // skills catalog — teal
  "oklch(0.70 0.15 175)", // loaded skills — cyan
  "oklch(0.75 0.08 80)", // memory — sand
  "oklch(0.72 0.14 145)", // document — green
  "oklch(0.72 0.14 55)", // tools — orange
  "oklch(0.72 0.12 230)", // conversation — light blue
  "oklch(0.70 0.12 330)", // cache — pink
];

const SEGMENT_COLOR_BY_ID: Record<string, string> = {
  summarization: "oklch(0.70 0.14 145)", // green — compressed history
  conversation: "oklch(0.72 0.12 230)",
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export { formatTokens, formatUsd };

function RadialRing({
  pct,
  size = 18,
  stroke = 2.5,
  className,
}: {
  pct: number;
  size?: number;
  stroke?: number;
  className?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.min(1, Math.max(0, pct));
  const offset = c * (1 - clamped);
  const hot = clamped >= 0.9;
  const warm = clamped >= 0.7;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={cn("-rotate-90", className)}
      aria-hidden
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        className="text-muted-foreground/25"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={offset}
        className={cn(
          hot
            ? "text-red-500"
            : warm
              ? "text-amber-500"
              : "text-foreground/70"
        )}
      />
    </svg>
  );
}

function SegmentedBar({
  breakdown,
  contextMax,
}: {
  breakdown: UsageBreakdownItem[];
  contextMax: number;
}) {
  const used = breakdown.reduce((s, b) => s + b.tokens, 0);
  const free = Math.max(0, contextMax - used);

  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
      {breakdown.map((item, i) => {
        if (item.tokens <= 0) return null;
        const width = (item.tokens / contextMax) * 100;
        const color =
          SEGMENT_COLOR_BY_ID[item.id] ??
          SEGMENT_COLORS[i % SEGMENT_COLORS.length];
        return (
          <div
            key={item.id}
            style={{
              width: `${width}%`,
              backgroundColor: color,
            }}
            title={`${item.label}: ${formatTokens(item.tokens)}`}
          />
        );
      })}
      {free > 0 ? (
        <div style={{ width: `${(free / contextMax) * 100}%` }} />
      ) : null}
    </div>
  );
}

type ContextUsageMeterProps = {
  usage: ThreadUsage;
  className?: string;
};

export function ContextUsageMeter({ usage, className }: ContextUsageMeterProps) {
  const pctLabel = Math.round(usage.contextPct * 100);

  const windowBreakdown = useMemo(
    () =>
      usage.breakdown.filter(
        (b) => b.tokens > 0 && b.id !== "cache_read" && b.id !== "cache_write"
      ),
    [usage.breakdown]
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "inline-flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground",
          className
        )}
        aria-label={`Context Usage ${pctLabel}% full. This chat ${formatTokens(usage.sessionTokens)} tokens.`}
      >
        <RadialRing pct={usage.contextPct} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-72 p-3"
      >
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <div className="text-sm font-medium text-foreground">Context Usage</div>
          <div className="text-xs tabular-nums text-muted-foreground">
            {pctLabel}% full
          </div>
        </div>
        <div className="mb-2 text-[11px] tabular-nums text-muted-foreground">
          ~{formatTokens(usage.contextUsed)} / {formatTokens(usage.contextMax)}
        </div>
        <SegmentedBar
          breakdown={windowBreakdown}
          contextMax={Math.max(usage.contextMax, 1)}
        />
        <ul className="mt-3 space-y-1.5">
          {windowBreakdown.map((item, i) => (
            <li
              key={item.id}
              className="flex items-center justify-between gap-2 text-xs"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className="size-2 shrink-0 rounded-[2px]"
                  style={{
                    backgroundColor:
                      SEGMENT_COLOR_BY_ID[item.id] ??
                      SEGMENT_COLORS[i % SEGMENT_COLORS.length],
                  }}
                />
                <span className="truncate text-muted-foreground">
                  {item.label}
                </span>
              </span>
              <span className="tabular-nums text-foreground">
                {formatTokens(item.tokens)}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-3 border-t border-border pt-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Tokens this chat</span>
            <span className="tabular-nums font-medium text-foreground">
              {formatTokens(usage.sessionTokens)}
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>
              prompt {formatTokens(usage.sessionInputTokens)} · reply{" "}
              {formatTokens(usage.sessionOutputTokens)}
            </span>
          </div>
          {(usage.lastRunRequests > 1 || usage.lastRunCacheReadTokens > 0) && (
            <div className="mt-1 text-[11px] leading-snug text-muted-foreground">
              {usage.lastRunRequests > 1
                ? `${usage.lastRunRequests} model calls`
                : null}
              {usage.lastRunRequests > 1 && usage.lastRunCacheReadTokens > 0
                ? " · "
                : null}
              {usage.lastRunCacheReadTokens > 0
                ? `cache hit ${formatTokens(usage.lastRunCacheReadTokens)}`
                : null}
            </div>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Hydrate UI state from Thread.usage stored in the API. */
export function usageFromStored(
  stored:
    | {
        context_max?: number;
        context_used?: number;
        context_pct?: number;
        breakdown?: UsageBreakdownItem[];
        session_tokens?: number;
        session_input_tokens?: number;
        session_output_tokens?: number;
        last_run_tokens?: number;
      }
    | null
    | undefined
): ThreadUsage {
  if (!stored) return EMPTY_USAGE;
  return {
    contextMax: stored.context_max ?? EMPTY_USAGE.contextMax,
    contextUsed: stored.context_used ?? 0,
    contextPct: stored.context_pct ?? 0,
    breakdown: stored.breakdown ?? [],
    sessionTokens: stored.session_tokens ?? 0,
    sessionInputTokens: stored.session_input_tokens ?? 0,
    sessionOutputTokens: stored.session_output_tokens ?? 0,
    lastRunTokens: stored.last_run_tokens ?? 0,
    lastRunRequests: 0,
    lastRunCacheReadTokens: 0,
  };
}

/** Merge a server `usage` CUSTOM event into thread usage state. */
export function applyUsageEvent(
  prev: ThreadUsage,
  value: {
    context_max?: number;
    context_used?: number;
    context_pct?: number;
    breakdown?: UsageBreakdownItem[];
    run?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
      requests?: number;
      cache_read_tokens?: number;
    };
    session?: {
      total_tokens?: number;
      input_tokens?: number;
      output_tokens?: number;
      last_run_tokens?: number;
    };
  }
): ThreadUsage {
  const input = value.run?.input_tokens ?? 0;
  const output = value.run?.output_tokens ?? 0;
  const total = value.run?.total_tokens ?? input + output;
  return {
    contextMax: value.context_max ?? prev.contextMax,
    contextUsed: value.context_used ?? prev.contextUsed,
    contextPct: value.context_pct ?? prev.contextPct,
    breakdown: value.breakdown?.length ? value.breakdown : prev.breakdown,
    // Prefer absolute session totals from the API (survives refresh without double-count).
    sessionTokens: value.session?.total_tokens ?? prev.sessionTokens + total,
    sessionInputTokens:
      value.session?.input_tokens ?? prev.sessionInputTokens + input,
    sessionOutputTokens:
      value.session?.output_tokens ?? prev.sessionOutputTokens + output,
    lastRunTokens: value.session?.last_run_tokens ?? total,
    lastRunRequests: value.run?.requests ?? prev.lastRunRequests,
    lastRunCacheReadTokens:
      value.run?.cache_read_tokens ?? prev.lastRunCacheReadTokens,
  };
}
