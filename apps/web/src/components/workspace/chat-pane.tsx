"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  ArrowUp,
  Check,
  CircleDollarSign,
  FileText,
  Lightbulb,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Square,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  PromptInput,
  PromptInputActions,
  PromptInputTextarea,
} from "@/components/ui/prompt-input";
import { ChatContainerContent, ChatContainerRoot } from "@/components/ui/chat-container";
import { Message, MessageContent } from "@/components/ui/message";
import { Markdown } from "@/components/ui/markdown";
import { ScrollButton } from "@/components/ui/scroll-button";
import { TextShimmer } from "@/components/ui/text-shimmer";
import { Skeleton } from "@/components/ui/skeleton";
import { type ToolPart } from "@/components/ui/tool";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ui/reasoning";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useApp, type ChatContentPart, type ChatToolPart, getMessageParts, getAuthHeaders } from "@/lib/app-state";
import {
  formatQuotedUserMessage,
  parseQuotedUserMessage,
} from "@/lib/quoted-selection";
import { cn } from "@/lib/utils";
import { agentIconComponent } from "@/lib/agent-icons";
import { ChatSpriteBuddy } from "@/components/ui/chat-sprite-buddy";
import {
  ClarifyingQuestionsDock,
  ClarifyingAnswersBubble,
  formatClarifyingAnswersBatch,
  parseClarifyingUserMessage,
  type ClarifyingAnswerValue,
  type ClarifyingOption,
  type ClarifyingQuestionItem,
  type ClarifyingSession,
} from "@/components/workspace/clarifying-question-card";
import {
  applyUsageEvent,
  ContextUsageMeter,
  EMPTY_USAGE,
  formatUsd,
  usageFromStored,
  type ThreadUsage,
} from "@/components/workspace/context-usage";
import {
  ToolSteps,
  WorkingShimmer,
} from "@/components/workspace/agent-activity";
import {
  AgentTodoList,
  buildTodoPlanSegments,
  isTodoTool,
  type TodoPlanSegment,
} from "@/components/workspace/agent-todo-list";
import {
  isToolMediaGallerySource,
  ToolMediaGallery,
} from "@/components/workspace/tool-media-gallery";
import { buildAgUiHistoryMessages } from "@/lib/ag-ui-history";
import { mergeToolMedia, parseToolMedia } from "@/lib/tool-media";
import {
  isToolResultError,
  toolResultErrorText,
} from "@/lib/tool-result-errors";
import {
  applyMentionSelection,
  ComposerMentionChips,
  ComposerMentionMenu,
  mergeSkillMentionOptions,
  detectActiveMention,
  filterMentionOptions,
  formatMentionsForSend,
  buildAgentTextFromAttachments,
  splitLegacyAttachmentBlock,
  removeMentionFromText,
  type ActiveMention,
  type MentionChip,
  type MentionOption,
} from "@/components/workspace/composer-mentions";
import type { PendingUpload } from "@/components/workspace/attachment-cards";
import {
  AttachmentPreviewDialog,
  MessageAttachmentChips,
} from "@/components/workspace/message-attachments";
import {
  UPLOAD_ACCEPT,
  validateUploadFile,
} from "@/lib/upload-limits";

/** OpenRouter / pydantic-ai thinking effort levels. */
type ReasoningEffort = "low" | "medium" | "high" | "max" | "xhigh";

const REASONING_EFFORT_META: Record<
  ReasoningEffort,
  { label: string; description: string }
> = {
  low: { label: "Low", description: "Light reasoning for simple tasks" },
  medium: { label: "Medium", description: "Balanced for most work" },
  high: { label: "High", description: "Deep reasoning for complex problems" },
  max: { label: "Max", description: "Maximum reasoning depth" },
  xhigh: { label: "Extra high", description: "Maximum reasoning for hard problems" },
};

const EFFORT_BAR_LEVEL: Record<ReasoningEffort, number> = {
  low: 1,
  medium: 2,
  high: 3,
  max: 4,
  xhigh: 5,
};

/** Fallback when the models API has no reasoning_efforts yet. */
const DEFAULT_REASONING_BY_MODEL: Record<string, ReasoningEffort[]> = {
  "openrouter:z-ai/glm-5.2": ["high", "xhigh"],
  "openrouter:anthropic/claude-sonnet-5": ["low", "medium", "high", "max", "xhigh"],
  "openrouter:openai/gpt-5.6-terra": ["low", "medium", "high", "xhigh"],
};

type ReasoningMode = "efforts" | "toggle" | "none";

type ModelReasoningInfo = {
  id: string;
  reasoning_efforts?: string[] | null;
  reasoning_mode?: string | null;
};

function reasoningModeForModel(
  modelId: string,
  models: ModelReasoningInfo[]
): ReasoningMode {
  const row = models.find((m) => m.id === modelId);
  const mode = (row?.reasoning_mode || "").toLowerCase();
  if (mode === "toggle" || mode === "none" || mode === "efforts") return mode;
  const efforts = row?.reasoning_efforts;
  if (Array.isArray(efforts) && efforts.length > 0) return "efforts";
  // Explicit empty efforts from catalog ⇒ on/off only (e.g. MiniMax M3).
  if (row && Array.isArray(efforts) && efforts.length === 0) return "toggle";
  if (DEFAULT_REASONING_BY_MODEL[modelId]) return "efforts";
  return "efforts";
}

function effortsForModel(
  modelId: string,
  models: ModelReasoningInfo[]
): ReasoningEffort[] {
  if (reasoningModeForModel(modelId, models) !== "efforts") return [];
  const fromApi = models.find((m) => m.id === modelId)?.reasoning_efforts;
  const raw =
    fromApi && fromApi.length > 0
      ? fromApi
      : DEFAULT_REASONING_BY_MODEL[modelId] || ["low", "medium", "high"];
  const allowed = new Set<string>(Object.keys(REASONING_EFFORT_META));
  return raw.filter((e): e is ReasoningEffort => allowed.has(e));
}

function clampEffort(
  value: ReasoningEffort,
  allowed: ReasoningEffort[]
): ReasoningEffort {
  if (allowed.includes(value)) return value;
  // Prefer medium, then high, then first available.
  if (allowed.includes("medium")) return "medium";
  if (allowed.includes("high")) return "high";
  return allowed[0] || "medium";
}

const STARTER_PROMPTS = [
  {
    label: "Start",
    prompt: "Help me get started with this workflow.",
    icon: Pencil,
  },
  {
    label: "Plan",
    prompt: "Outline a plan for what we should do next.",
    icon: Lightbulb,
  },
  {
    label: "Improve",
    prompt: "Review what we have so far and suggest improvements.",
    icon: Sparkles,
  },
  {
    label: "Research",
    prompt: "Help me research the key questions for this task.",
    icon: Search,
  },
] as const;

function timeGreeting() {
  const hour = new Date().getHours();
  if (hour >= 12 && hour < 18) return "Good afternoon";
  if (hour >= 18) return "Good evening";
  return "Good morning";
}

function EffortBars({
  level,
  className,
}: {
  level: ReasoningEffort;
  className?: string;
}) {
  const filled = EFFORT_BAR_LEVEL[level] ?? 2;
  const bars = 5;
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden
      className={cn("size-3.5 shrink-0", className)}
    >
      {Array.from({ length: bars }, (_, i) => (
        <rect
          key={i}
          x={1.5 + i * 2.8}
          y={13 - (i + 1) * 2.2}
          width="2"
          height={(i + 1) * 2.2}
          rx="0.4"
          className={i < filled ? "opacity-100" : "opacity-25"}
        />
      ))}
    </svg>
  );
}

type LivePart =
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: ToolPart & { argsText?: string; progress?: string[] } }
  | { kind: "reasoning"; text: string; streaming?: boolean }
  | {
      kind: "clarifying_question";
      questions: ClarifyingQuestionItem[];
      toolCallId?: string;
      submitted?: boolean;
    };

function isAskUserTool(tool: ToolPart | ChatToolPart): boolean {
  const bare = tool.type.includes("|")
    ? (tool.type.split("|").pop() ?? tool.type)
    : tool.type;
  return bare.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[\s-]+/g, "_").toLowerCase() ===
    "ask_user";
}

function parseClarifyingEvent(value: unknown): ClarifyingSession | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const toolCallId =
    typeof v.tool_call_id === "string"
      ? v.tool_call_id
      : typeof v.toolCallId === "string"
        ? v.toolCallId
        : undefined;

  const parseOptions = (raw: unknown): ClarifyingOption[] => {
    if (!Array.isArray(raw)) return [];
    const options: ClarifyingOption[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const o = item as Record<string, unknown>;
      const label = typeof o.label === "string" ? o.label.trim() : "";
      if (!label) continue;
      options.push({
        label,
        description: typeof o.description === "string" ? o.description : undefined,
        recommended: Boolean(o.recommended),
      });
    }
    return options.slice(0, 4);
  };

  const questions: ClarifyingQuestionItem[] = [];
  if (Array.isArray(v.questions)) {
    v.questions.forEach((item, i) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return;
      const q = item as Record<string, unknown>;
      const question = typeof q.question === "string" ? q.question.trim() : "";
      if (!question) return;
      const options = parseOptions(q.options);
      if (options.length < 2) return;
      questions.push({
        id:
          typeof q.id === "string" && q.id.trim()
            ? q.id.trim()
            : `q${i + 1}`,
        question,
        options,
        context: typeof q.context === "string" ? q.context : undefined,
      });
    });
  } else if (typeof v.question === "string" && v.question.trim()) {
    // Legacy single-question payload
    const options = parseOptions(v.options);
    if (options.length >= 2) {
      questions.push({
        id: "q1",
        question: v.question.trim(),
        options,
        context: typeof v.context === "string" ? v.context : undefined,
      });
    }
  }

  if (!questions.length) return null;
  return { questions: questions.slice(0, 4), toolCallId };
}

function sessionFromPart(
  part: Extract<ChatContentPart, { kind: "clarifying_question" }>
): ClarifyingSession | null {
  if (part.questions?.length) {
    return {
      questions: part.questions,
      toolCallId: part.toolCallId,
      submitted: part.submitted,
    };
  }
  if (part.question && part.options?.length) {
    return {
      questions: [
        {
          id: "q1",
          question: part.question,
          options: part.options,
          context: part.context,
        },
      ],
      toolCallId: part.toolCallId,
      submitted: Boolean(part.answeredLabel) || part.submitted,
    };
  }
  return null;
}

function appendTextDelta(parts: LivePart[], delta: string): LivePart[] {
  const next = endReasoning(parts);
  const last = next[next.length - 1];
  if (last?.kind === "text") {
    next[next.length - 1] = { kind: "text", text: last.text + delta };
  } else {
    next.push({ kind: "text", text: delta });
  }
  return next;
}

function startReasoning(parts: LivePart[]): LivePart[] {
  const last = parts[parts.length - 1];
  if (last?.kind === "reasoning" && last.streaming) return parts;
  return [...parts, { kind: "reasoning", text: "", streaming: true }];
}

function appendReasoningDelta(parts: LivePart[], delta: string): LivePart[] {
  const next = [...parts];
  const last = next[next.length - 1];
  if (last?.kind === "reasoning") {
    next[next.length - 1] = {
      kind: "reasoning",
      text: last.text + delta,
      streaming: true,
    };
    return next;
  }
  return [...next, { kind: "reasoning", text: delta, streaming: true }];
}

function endReasoning(parts: LivePart[]): LivePart[] {
  const next = [...parts];
  const last = next[next.length - 1];
  if (last?.kind === "reasoning" && last.streaming) {
    next[next.length - 1] = { ...last, streaming: false };
  }
  return next;
}

function parseToolArgs(argsText: string): Record<string, unknown> | undefined {
  if (!argsText) return undefined;
  try {
    const parsed: unknown = JSON.parse(argsText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed as unknown };
  } catch {
    return { _partial: argsText };
  }
}

function parseToolOutput(content: string): Record<string, unknown> {
  if (!content) return { result: "" };
  // Server usually strips BinaryContent, but keep a client guard so chat never
  // stores multi-MB base64 dumps from screenshot/read_file image results.
  if (
    content.length > 12_000 &&
    (content.includes('"media_type"') ||
      content.includes("iVBOR") ||
      content.includes('"image/'))
  ) {
    return {
      result:
        "[Image/binary tool result omitted from chat — model still sees vision images.]",
    };
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { result: parsed as unknown };
  } catch {
    return { result: content };
  }
}

function updateTool(
  parts: LivePart[],
  toolCallId: string | undefined,
  patch:
    | Partial<ToolPart & { argsText?: string; progress?: string[] }>
    | ((
        tool: ToolPart & { argsText?: string; progress?: string[] }
      ) => ToolPart & { argsText?: string; progress?: string[] })
): LivePart[] {
  const next = [...parts];
  let idx = -1;
  if (toolCallId) {
    idx = next.findIndex(
      (p) => p.kind === "tool" && p.tool.toolCallId === toolCallId
    );
  }
  if (idx < 0) {
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i]?.kind === "tool") {
        idx = i;
        break;
      }
    }
  }
  if (idx < 0) return next;
  const part = next[idx];
  if (part?.kind !== "tool") return next;
  const tool =
    typeof patch === "function" ? patch(part.tool) : { ...part.tool, ...patch };
  next[idx] = { kind: "tool", tool };
  return next;
}

const STOPPED_BY_USER_MESSAGE = "You stopped this response.";

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

function partsToPersist(parts: LivePart[]): {
  content: string;
  tools: ChatToolPart[];
  ordered: ChatContentPart[];
  reasoning: string;
} {
  const tools: ChatToolPart[] = [];
  const ordered: ChatContentPart[] = [];
  const reasoningChunks: string[] = [];
  let content = "";
  for (const part of parts) {
    if (part.kind === "text") {
      content += part.text;
      if (part.text) ordered.push({ kind: "text", text: part.text });
    } else if (part.kind === "reasoning") {
      if (part.text.trim()) {
        ordered.push({ kind: "reasoning", text: part.text });
        reasoningChunks.push(part.text);
      }
    } else if (part.kind === "clarifying_question") {
      ordered.push({
        kind: "clarifying_question",
        questions: part.questions,
        toolCallId: part.toolCallId,
        submitted: part.submitted,
      });
    } else {
      const tool: ChatToolPart = {
        type: part.tool.type,
        state:
          part.tool.state === "input-streaming"
            ? "output-available"
            : part.tool.state,
        toolCallId: part.tool.toolCallId,
        input: part.tool.input,
        output: part.tool.output,
        errorText: part.tool.errorText,
      };
      tools.push(tool);
      ordered.push({ kind: "tool", tool });
    }
  }
  return {
    content,
    tools,
    ordered,
    reasoning: reasoningChunks.join("\n\n"),
  };
}

type ClarifyingHandlers = {
  /** When true, hide clarifying cards (docked above composer instead). */
  hideInChat?: boolean;
};

function AssistantTurnMedia({
  tools,
  className,
}: {
  tools: ChatToolPart[];
  className?: string;
}) {
  const { workspace } = useApp();
  const media = useMemo(
    () =>
      mergeToolMedia(
        ...tools
          .filter((t) => isToolMediaGallerySource(t.type))
          .map((t) => parseToolMedia(t.output))
      ),
    [tools]
  );
  if (!workspace?.id) return null;
  if (!media.images.length && !media.files.length) return null;
  return (
    <ToolMediaGallery
      workspaceId={workspace.id}
      images={media.images}
      files={media.files}
      className={cn("not-typeset max-w-xl", className)}
    />
  );
}

function renderContentParts(
  parts: ChatContentPart[],
  keyPrefix: string,
  isStreaming = false,
  clarifying?: ClarifyingHandlers,
  planSegments?: TodoPlanSegment[],
  planMeta?: { planIndex: number; planCount: number }[]
) {
  const nodes: React.ReactNode[] = [];
  let toolBuffer: ChatToolPart[] = [];
  let group = 0;
  let todoListRendered = false;

  const flushTools = () => {
    const visible = toolBuffer.filter((t) => !isAskUserTool(t));
    toolBuffer = [];
    if (!visible.length) return;
    const g = group++;
    nodes.push(
      <ToolSteps
        key={`${keyPrefix}-tools-${g}`}
        tools={visible}
        isStreaming={isStreaming}
      />
    );
    // Immediately after the tool group (before later reasoning/text) so history
    // scrolling shows a big preview without opening the tool card.
    const galleryTools = visible.filter((t) => isToolMediaGallerySource(t.type));
    const media = mergeToolMedia(
      ...galleryTools.map((t) => parseToolMedia(t.output))
    );
    if (media.images.length || media.files.length) {
      nodes.push(
        <AssistantTurnMedia
          key={`${keyPrefix}-turn-media-${g}`}
          tools={galleryTools}
          className="my-2"
        />
      );
    }
  };

  parts.forEach((part, i) => {
    if (part.kind === "tool") {
      // Show plan card(s) anchored to this message once, then list tool steps.
      if (
        isTodoTool(part.tool) &&
        !todoListRendered &&
        planSegments &&
        planSegments.length > 0
      ) {
        flushTools();
        planSegments.forEach((seg, segIdx) => {
          const meta = planMeta?.[segIdx];
          nodes.push(
            <AgentTodoList
              key={`${keyPrefix}-${seg.id}`}
              tools={seg.tools}
              planIndex={meta?.planIndex}
              planCount={meta?.planCount}
            />
          );
        });
        todoListRendered = true;
      }
      toolBuffer.push(part.tool);
      return;
    }
    flushTools();
    if (part.kind === "clarifying_question") {
      // Questions are shown in the composer dock, not inline in the chat body.
      if (!clarifying?.hideInChat) {
        // Fallback stub if dock unavailable
        const n = part.questions?.length || (part.question ? 1 : 0);
        if (n > 0) {
          nodes.push(
            <p
              key={`${keyPrefix}-clarify-${i}`}
              className="text-[13px] text-muted-foreground"
            >
              Asked {n} clarifying question{n === 1 ? "" : "s"}.
            </p>
          );
        }
      }
      return;
    }
    if (part.kind === "reasoning") {
      if (!part.text && !part.streaming) return;
      nodes.push(
        <ReasoningBlock
          key={`${keyPrefix}-reasoning-${i}`}
          text={part.text}
          isStreaming={!!part.streaming}
        />
      );
      return;
    }
    if (!part.text) return;
    nodes.push(
      <div key={`${keyPrefix}-text-${i}`} className="typeset typeset-chat">
        <Markdown>{part.text}</Markdown>
      </div>
    );
  });
  flushTools();
  return nodes;
}

function ReasoningBlock({
  text,
  isStreaming,
}: {
  text: string;
  isStreaming?: boolean;
}) {
  if (!text && !isStreaming) return null;
  return (
    <Reasoning isStreaming={isStreaming} className="mb-2 max-w-xl">
      <ReasoningTrigger>
        {isStreaming ? (
          <TextShimmer
            as="span"
            duration={1.2}
            className="font-sans! text-[15px]! leading-[1.6]! font-normal"
          >
            Thinking…
          </TextShimmer>
        ) : (
          "Show AI reasoning"
        )}
      </ReasoningTrigger>
      <ReasoningContent
        markdown
        contentClassName="ml-2 border-l-2 border-l-slate-200 px-2 pb-1 dark:border-l-slate-700"
      >
        {text || " "}
      </ReasoningContent>
    </Reasoning>
  );
}

function formatContextWindow(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function formatPricePerM(input?: number | null, output?: number | null): string | null {
  if (input == null || output == null) return null;
  const fmt = (v: number) =>
    Number.isInteger(v) ? `$${v}` : `$${v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `${fmt(input)} / ${fmt(output)}`;
}

type ModelChoice = {
  id: string;
  label: string;
  context_window?: number;
  price_input_per_m?: number | null;
  price_output_per_m?: number | null;
  reasoning?: string | null;
  reasoning_efforts?: string[] | null;
  reasoning_mode?: string | null;
};

/** Prefer an enabled catalog id; fall back to Base (first) when the saved id was removed. */
function pickEnabledModelId(
  models: { id: string }[],
  ...candidates: (string | null | undefined)[]
): string {
  for (const id of candidates) {
    if (id && models.some((m) => m.id === id)) return id;
  }
  return models[0]?.id || "";
}

function resolveSelectedModel(
  models: ModelChoice[],
  value: string
): ModelChoice | undefined {
  const id = pickEnabledModelId(models, value);
  return models.find((m) => m.id === id) || models[0];
}

function ModelPicker({
  models,
  value,
  onChange,
}: {
  models: ModelChoice[];
  value: string;
  onChange: (id: string) => void;
}) {
  const selected = resolveSelectedModel(models, value);
  if (!selected) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="inline-flex h-8 max-w-[9.5rem] items-center gap-1 rounded-xl px-2.5 font-sans! text-[14px]! font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground"
      >
        <span className="truncate">{selected.label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="min-w-64 rounded-2xl p-1.5"
      >
        {models.map((m) => {
          const active = m.id === selected.id;
          const price = formatPricePerM(m.price_input_per_m, m.price_output_per_m);
          const ctx =
            m.context_window != null
              ? `${formatContextWindow(m.context_window)} context`
              : null;
          const meta = [price ? `${price} per 1M` : null, ctx]
            .filter(Boolean)
            .join(" · ");
          return (
            <DropdownMenuItem
              key={m.id}
              onClick={() => onChange(m.id)}
              className="items-start gap-2 rounded-xl py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold">{m.label}</div>
                {meta ? (
                  <div className="truncate text-[11px] text-muted-foreground">
                    {meta}
                  </div>
                ) : null}
                {m.reasoning ? (
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    Reasoning: {m.reasoning}
                  </div>
                ) : null}
              </div>
              {active ? (
                <Check className="mt-1 size-4 shrink-0 text-foreground" />
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AgentPicker({
  agents,
  value,
  onChange,
  disabled = false,
}: {
  agents: { name: string; slug: string; description?: string; icon?: string }[];
  value: string;
  onChange: (slug: string) => void;
  disabled?: boolean;
}) {
  const selected =
    agents.find((p) => p.slug === value) ||
    agents.find((p) => p.slug === "agent") ||
    agents[0];
  if (!selected) return null;
  const SelectedIcon = agentIconComponent(selected.icon);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={`Agent: ${selected.name}`}
        title="Switch Agent"
        className="inline-flex h-8 max-w-[12rem] items-center gap-1.5 rounded-xl px-2 font-sans! text-[14px]! font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground disabled:pointer-events-none disabled:opacity-50"
      >
        <SelectedIcon className="size-3.5 shrink-0 opacity-70" />
        <span className="truncate">{selected.name}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="min-w-64 rounded-2xl p-1.5"
      >
        {agents.map((p) => {
          const active = p.slug === selected.slug;
          const Icon = agentIconComponent(p.icon);
          return (
            <DropdownMenuItem
              key={`${p.slug}`}
              onClick={() => {
                if (p.slug !== selected.slug) onChange(p.slug);
              }}
              className="items-start gap-2 rounded-xl py-2.5"
            >
              <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold">{p.name}</div>
                {p.description ? (
                  <div className="line-clamp-2 text-[11px] text-muted-foreground">
                    {p.description}
                  </div>
                ) : null}
              </div>
              {active ? (
                <Check className="mt-1 size-4 shrink-0 text-foreground" />
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ReasoningEffortPicker({
  value,
  options,
  onChange,
}: {
  value: ReasoningEffort;
  options: ReasoningEffort[];
  onChange: (effort: ReasoningEffort) => void;
}) {
  const allowed = options.length > 0 ? options : (["medium"] as ReasoningEffort[]);
  const selectedId = clampEffort(value, allowed);
  const selected = {
    id: selectedId,
    ...REASONING_EFFORT_META[selectedId],
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="inline-flex h-8 items-center gap-1.5 rounded-xl px-2 font-sans! text-[14px]! font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground"
        aria-label={`Reasoning effort: ${selected.label}`}
      >
        <EffortBars level={selected.id} />
        <span className="whitespace-nowrap">{selected.label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="min-w-56 rounded-2xl p-1.5"
      >
        {allowed.map((id) => {
          const meta = REASONING_EFFORT_META[id];
          const active = id === selected.id;
          return (
            <DropdownMenuItem
              key={id}
              onClick={() => onChange(id)}
              className="items-start gap-2 rounded-xl py-2.5"
            >
              <EffortBars level={id} className="mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold">{meta.label}</div>
                <div className="text-[11px] text-muted-foreground">
                  {meta.description}
                </div>
              </div>
              {active ? (
                <Check className="mt-1 size-4 shrink-0 text-foreground" />
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** On/off control for models that support reasoning without effort levels. */
function ReasoningToggle({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={enabled ? "Reasoning on" : "Reasoning off"}
      title={
        enabled
          ? "Reasoning enabled — click to disable"
          : "Reasoning disabled — click to enable"
      }
      onClick={() => onChange(!enabled)}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-xl px-2 font-sans! text-[14px]! font-medium transition-colors hover:bg-muted hover:text-foreground",
        enabled ? "text-foreground" : "text-muted-foreground"
      )}
    >
      <span
        className={cn(
          "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors",
          enabled ? "bg-primary" : "bg-border"
        )}
      >
        <span
          className={cn(
            "inline-block size-3 translate-x-0.5 rounded-full bg-background transition-transform",
            enabled && "translate-x-3.5"
          )}
        />
      </span>
      <span className="whitespace-nowrap">Reasoning</span>
    </button>
  );
}

type ChatPaneProps = {
  documentCollapsed?: boolean;
  onOpenDocument?: () => void;
};

function ChatThreadSkeleton() {
  return (
    <div
      className="mx-auto w-full max-w-[44em] flex-1 space-y-6 px-4 py-6"
      aria-busy
      aria-label="Loading conversation"
    >
      <div className="flex justify-end">
        <div className="w-[55%] space-y-2">
          <Skeleton className="ml-auto h-4 w-full" />
          <Skeleton className="ml-auto h-4 w-3/4" />
        </div>
      </div>
      <div className="space-y-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-[92%]" />
        <Skeleton className="h-4 w-[78%]" />
        <Skeleton className="h-4 w-[88%]" />
      </div>
      <div className="flex justify-end">
        <div className="w-[40%] space-y-2">
          <Skeleton className="ml-auto h-4 w-full" />
          <Skeleton className="ml-auto h-4 w-2/3" />
        </div>
      </div>
      <div className="space-y-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-[85%]" />
        <Skeleton className="h-4 w-[70%]" />
      </div>
    </div>
  );
}

export function ChatPane({
  documentCollapsed = false,
  onOpenDocument,
}: ChatPaneProps) {
  const {
    messages,
    appendMessage,
    setMessages,
    persistMessage,
    activeThreadId,
    threads,
    models,
    setThreadModel,
    draftModel,
    preferredModel,
    createThread,
    apiUrl,
    agentRunPath,
    refreshWorkspaceFiles,
    refreshWorkspaceUploads,
    ingestLiveSuggestion,
    ingestDocumentCreated,
    applyLiveDocumentContent,
    ingestCanvasCreated,
    applyLiveCanvasScene,
    refreshThreadArtifacts,
    quotedSelection,
    clearQuotedSelection,
    updateThreadUsage,
    setAccountSpend,
    accountSpend,
    documents,
    workspaceFiles,
    workspaceAssets,
    workspaceUploads,
    workspace,
    agents,
    skills,
    refreshAgents,
    setThreadAgent,
    activeAgentSlug,
    threadLoading,
    setEditorTarget,
  } = useApp();
  const [agentSwitchBusy, setAgentSwitchBusy] = useState(false);
  const activeAgent = useMemo(
    () => agents.find((p) => p.slug === activeAgentSlug),
    [agents, activeAgentSlug]
  );
  const skillMentions = useMemo(() => {
    // Full inventory: library + every agent's playbooks (same as sidebar Skills).
    const allAgentSkills = agents.flatMap((a) => a.skills || []);
    return mergeSkillMentionOptions(skills, allAgentSkills);
  }, [skills, agents]);
  const [value, setValue] = useState("");
  const [budgetLimitOpen, setBudgetLimitOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [liveParts, setLiveParts] = useState<LivePart[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const documentCollapsedRef = useRef(documentCollapsed);
  const onOpenDocumentRef = useRef(onOpenDocument);

  useEffect(() => {
    documentCollapsedRef.current = documentCollapsed;
    onOpenDocumentRef.current = onOpenDocument;
  }, [documentCollapsed, onOpenDocument]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const dragDepthRef = useRef(0);
  const [clarifyingDock, setClarifyingDock] = useState<ClarifyingSession | null>(
    null
  );
  const [reasoningEffort, setReasoningEffort] =
    useState<ReasoningEffort>("high");
  const [reasoningEnabled, setReasoningEnabled] = useState(true);
  const [mentionChips, setMentionChips] = useState<MentionChip[]>([]);
  const [activeMention, setActiveMention] = useState<ActiveMention | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [previewChip, setPreviewChip] = useState<MentionChip | null>(null);
  /** Per-thread context + token spend (session-local until refresh). */
  const [usageByThread, setUsageByThread] = useState<Record<string, ThreadUsage>>(
    {}
  );

  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeThreadId),
    [threads, activeThreadId]
  );

  const selectedModelId = pickEnabledModelId(
    models,
    activeThread?.model,
    draftModel,
    preferredModel
  );
  const reasoningMode = useMemo(
    () => reasoningModeForModel(selectedModelId, models),
    [selectedModelId, models]
  );
  const reasoningOptions = useMemo(
    () => effortsForModel(selectedModelId, models),
    [selectedModelId, models]
  );

  // Stale preferred/thread model (e.g. old GLM Base) → migrate to an enabled tier.
  useEffect(() => {
    if (!models.length || !selectedModelId) return;
    const raw = activeThread?.model || draftModel || preferredModel;
    if (raw && raw !== selectedModelId) {
      setThreadModel(selectedModelId);
    }
  }, [
    models,
    selectedModelId,
    activeThread?.model,
    draftModel,
    preferredModel,
    setThreadModel,
  ]);

  useEffect(() => {
    if (reasoningMode === "efforts") {
      setReasoningEffort((prev) => clampEffort(prev, reasoningOptions));
    }
  }, [reasoningMode, reasoningOptions]);

  const mentionOptions = useMemo(() => {
    if (!activeMention) return [] as MentionOption[];
    if (activeMention.trigger === "/") {
      return filterMentionOptions(skillMentions, activeMention.query);
    }
    // Mirror Files pane inventory: persona, documents, workspace files, assets, uploads.
    const persona: MentionOption[] = [
      {
        id: "persona-agent",
        kind: "file",
        label: "agent.md",
        path: "agent.md",
        description: "Persona",
        searchText: "agent.md persona",
      },
      {
        id: "persona-soul",
        kind: "file",
        label: "soul.md",
        path: "soul.md",
        description: "Persona",
        searchText: "soul.md persona",
      },
    ];
    const docs: MentionOption[] = documents.map((d) => ({
      id: d.id,
      kind: "document" as const,
      label: d.title,
      path: d.path,
      description: "Document",
      searchText: `${d.title} ${d.path} document`,
    }));
    const files: MentionOption[] = workspaceFiles.map((f) => ({
      id: f.id,
      kind: "file" as const,
      label: f.path.replace(/^(memory|research)\//, ""),
      path: f.path,
      description: f.kind,
      searchText: `${f.path} ${f.kind}`,
    }));
    const assets: MentionOption[] = workspaceAssets.map((a) => ({
      id: `asset:${a.path}`,
      kind: "file" as const,
      label: a.filename || a.path,
      path: a.path,
      description: "Asset",
      size: a.size,
      searchText: `${a.path} ${a.filename} asset`,
    }));
    const uploads: MentionOption[] = workspaceUploads.map((u) => ({
      id: u.path,
      kind: "upload" as const,
      label: u.filename || u.path.replace(/^uploads\//, ""),
      path: u.path,
      description: "Upload",
      size: u.size,
      searchText: `${u.path} ${u.filename} upload`,
    }));
    return filterMentionOptions(
      [...persona, ...docs, ...files, ...assets, ...uploads],
      activeMention.query
    );
  }, [
    activeMention,
    skillMentions,
    documents,
    workspaceFiles,
    workspaceAssets,
    workspaceUploads,
  ]);

  useEffect(() => {
    setMentionIndex(0);
  }, [activeMention?.trigger, activeMention?.query, mentionOptions.length]);

  const threadUsage = useMemo(() => {
    const base = activeThreadId
      ? usageByThread[activeThreadId] || EMPTY_USAGE
      : EMPTY_USAGE;
    const modelMeta = models.find((m) => m.id === selectedModelId);
    const contextMax = modelMeta?.context_window || base.contextMax;
    if (contextMax === base.contextMax) return base;
    return {
      ...base,
      contextMax,
      contextPct: contextMax ? Math.min(1, base.contextUsed / contextMax) : 0,
    };
  }, [activeThreadId, selectedModelId, models, usageByThread]);

  // Hydrate meter from persisted thread.usage (survives refresh).
  useEffect(() => {
    if (!activeThreadId) return;
    const stored = usageFromStored(activeThread?.usage);
    setUsageByThread((prev) => {
      const current = prev[activeThreadId];
      // Keep live totals if they're ahead of the stored snapshot.
      if (
        current &&
        current.sessionTokens >= stored.sessionTokens &&
        current.contextUsed >= stored.contextUsed
      ) {
        return prev;
      }
      return { ...prev, [activeThreadId]: stored };
    });
  }, [activeThreadId, activeThread?.usage]);

  function stopStreaming() {
    abortRef.current?.abort();
  }

  async function sendText(
    displayText: string,
    opts?: {
      agentText?: string;
      attachments?: MentionChip[];
    }
  ) {
    const attachments = opts?.attachments ?? [];
    const agentText = (opts?.agentText ?? displayText).trim();
    const bubbleText = displayText.trim();
    if ((!bubbleText && !attachments.length && !agentText) || isLoading) return;

    const spent = accountSpend.total_cost_usd ?? 0;
    const budget = accountSpend.spend_budget_usd ?? 5;
    if (spent >= budget) {
      setBudgetLimitOpen(true);
      return;
    }

    const tempUserId = `temp-${crypto.randomUUID()}`;
    appendMessage({
      id: tempUserId,
      role: "user",
      content: bubbleText || (attachments.length ? "" : agentText),
      attachments: attachments.length ? attachments : undefined,
    });
    setIsLoading(true);
    setLiveParts([]);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    let threadId = activeThreadId;
    let collectedParts: LivePart[] = [];

    try {
      if (!threadId) {
        const thread = await createThread();
        if (!thread) throw new Error("Could not start a new chat");
        threadId = thread.id;
      }

      await persistMessage(threadId, {
        role: "user",
        content: bubbleText || (attachments.length ? "" : agentText),
        attachments: attachments.length ? attachments : undefined,
      });

      if (controller.signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      const historyMessages = buildAgUiHistoryMessages(
        messages.map((m) => ({
          ...m,
          content:
            m.role === "user" && m.attachments?.length
              ? buildAgentTextFromAttachments(m.content, m.attachments)
              : m.content,
        })),
        { id: tempUserId, content: agentText }
      );

      const res = await fetch(`${apiUrl}${agentRunPath}/${threadId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...getAuthHeaders(),
        },
        signal: controller.signal,
        body: JSON.stringify({
          threadId,
          runId: crypto.randomUUID(),
          messages: historyMessages,
          tools: [],
          context: [],
          state: {},
          forwardedProps: {
            ...(reasoningMode === "toggle"
              ? { reasoningEnabled }
              : reasoningMode === "efforts"
                ? { reasoningEffort }
                : {}),
            agentId: activeAgentSlug,
          },
        }),
      });

      if (!res.ok || !res.body) {
        const raw = await res.text();
        let message = raw || `Request failed (${res.status})`;
        try {
          const parsed = JSON.parse(raw) as {
            detail?:
              | string
              | { code?: string; message?: string; budget_usd?: number; spent_usd?: number };
          };
          const detail = parsed.detail;
          if (
            detail &&
            typeof detail === "object" &&
            detail.code === "spend_budget_exceeded"
          ) {
            const err = new Error(
              detail.message ||
                "You've reached your usage budget. Contact an admin to increase it."
            );
            err.name = "BudgetExceededError";
            throw err;
          }
          if (typeof detail === "string") message = detail;
        } catch (parseErr) {
          if (
            parseErr instanceof Error &&
            parseErr.name === "BudgetExceededError"
          ) {
            throw parseErr;
          }
          // keep raw text
        }
        throw new Error(message);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        buffer += decoder.decode(chunk, { stream: true });
        const sseParts = buffer.split("\n\n");
        buffer = sseParts.pop() || "";
        for (const part of sseParts) {
          const line = part.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          const raw = line.replace(/^data:\s?/, "");
          if (!raw || raw === "[DONE]") continue;
          try {
            const evt = JSON.parse(raw) as {
              type?: string;
              delta?: string;
              content?: string;
              toolCallName?: string;
              toolCallId?: string;
              name?: string;
              value?: Record<string, unknown>;
            };
            if (evt.type === "CUSTOM" && evt.name === "usage" && evt.value) {
              const usageValue = evt.value as Parameters<typeof applyUsageEvent>[1];
              let nextUsage: ThreadUsage = EMPTY_USAGE;
              setUsageByThread((prev) => {
                nextUsage = applyUsageEvent(
                  prev[threadId!] || EMPTY_USAGE,
                  usageValue
                );
                return { ...prev, [threadId!]: nextUsage };
              });
              const assetPaths = (
                usageValue as { asset_paths?: string[] }
              ).asset_paths;
              updateThreadUsage(threadId, {
                context_max: nextUsage.contextMax,
                context_used: nextUsage.contextUsed,
                context_pct: nextUsage.contextPct,
                breakdown: nextUsage.breakdown,
                session_tokens: nextUsage.sessionTokens,
                session_input_tokens: nextUsage.sessionInputTokens,
                session_output_tokens: nextUsage.sessionOutputTokens,
                last_run_tokens: nextUsage.lastRunTokens,
                ...(Array.isArray(assetPaths) ? { asset_paths: assetPaths } : {}),
              });
              const account = (
                usageValue as {
                  account?: {
                    total_tokens?: number;
                    input_tokens?: number;
                    output_tokens?: number;
                    run_count?: number;
                    total_cost_usd?: number | null;
                    token_cost_usd?: number | null;
                    multimodal_cost_usd?: number | null;
                    last_run_tokens?: number;
                  };
                }
              ).account;
              if (account) {
                setAccountSpend((prev) => ({
                  total_tokens: account.total_tokens ?? 0,
                  input_tokens: account.input_tokens ?? 0,
                  output_tokens: account.output_tokens ?? 0,
                  run_count: account.run_count ?? 0,
                  total_cost_usd: account.total_cost_usd ?? null,
                  token_cost_usd: account.token_cost_usd ?? null,
                  multimodal_cost_usd: account.multimodal_cost_usd ?? null,
                  last_run_tokens: account.last_run_tokens ?? 0,
                  spend_budget_usd: prev.spend_budget_usd ?? 5,
                }));
              }
            } else if (
              evt.type === "CUSTOM" &&
              evt.name === "document_created" &&
              evt.value
            ) {
              ingestDocumentCreated(
                evt.value as {
                  id?: string;
                  path?: string;
                  title?: string;
                  content_md?: string;
                }
              );
              if (documentCollapsedRef.current) {
                setEditorTarget({ type: "document" });
                onOpenDocumentRef.current?.();
              }
            } else if (evt.type === "CUSTOM" && evt.name === "md_applied" && evt.value) {
              const applied = evt.value as { content_md?: string };
              if (typeof applied.content_md === "string") {
                applyLiveDocumentContent(applied.content_md);
              }
              // If the document editor is closed, open it so the user sees the addition.
              if (documentCollapsedRef.current) {
                setEditorTarget({ type: "document" });
                onOpenDocumentRef.current?.();
              }
            } else if (evt.type === "CUSTOM" && evt.name === "md_suggestion" && evt.value) {
              ingestLiveSuggestion(
                evt.value as {
                  kind?: string;
                  old_text?: string;
                  new_text?: string;
                  section_heading?: string;
                  rationale?: string;
                }
              );
              // If the document editor is closed, open it so the user sees the diff.
              if (documentCollapsedRef.current) {
                setEditorTarget({ type: "document" });
                onOpenDocumentRef.current?.();
              }
            } else if (
              evt.type === "CUSTOM" &&
              evt.name === "canvas_created" &&
              evt.value
            ) {
              ingestCanvasCreated(
                evt.value as {
                  id?: string;
                  title?: string;
                  scene_json?: Record<string, unknown>;
                }
              );
              setEditorTarget({ type: "canvas" });
              if (documentCollapsedRef.current) {
                onOpenDocumentRef.current?.();
              }
            } else if (
              evt.type === "CUSTOM" &&
              evt.name === "canvas_updated" &&
              evt.value
            ) {
              const updated = evt.value as {
                id?: string;
                scene_json?: Record<string, unknown>;
              };
              if (updated.scene_json && typeof updated.scene_json === "object") {
                applyLiveCanvasScene(updated.scene_json, updated.id);
              }
              setEditorTarget({ type: "canvas" });
              if (documentCollapsedRef.current) {
                onOpenDocumentRef.current?.();
              }
            } else if (
              evt.type === "CUSTOM" &&
              evt.name === "clarifying_question" &&
              evt.value
            ) {
              const parsed = parseClarifyingEvent(evt.value);
              if (parsed) {
                collectedParts = [
                  ...collectedParts,
                  {
                    kind: "clarifying_question",
                    questions: parsed.questions,
                    toolCallId: parsed.toolCallId,
                  },
                ];
                setLiveParts(collectedParts);
                setClarifyingDock(parsed);
              }
            } else if (evt.type === "CUSTOM" && evt.name === "agents_changed") {
              void refreshAgents();
            } else if (evt.type === "CUSTOM" && evt.name === "tool_progress" && evt.value) {
              const progress = evt.value as {
                tool_call_id?: string;
                status?: string;
                detail?: string;
              };
              const line = [progress.status, progress.detail]
                .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
                .join(": ");
              if (line) {
                collectedParts = updateTool(
                  collectedParts,
                  progress.tool_call_id,
                  (tool) => {
                    const prev =
                      (tool as ToolPart & { progress?: string[] }).progress || [];
                    if (prev[prev.length - 1] === line) return tool;
                    return {
                      ...tool,
                      progress: [...prev, line],
                    };
                  }
                );
                setLiveParts(collectedParts);
              }
            } else if (
              evt.type === "REASONING_START" ||
              evt.type === "THINKING_START" ||
              evt.type === "REASONING_MESSAGE_START" ||
              evt.type === "THINKING_TEXT_MESSAGE_START"
            ) {
              collectedParts = startReasoning(collectedParts);
              setLiveParts(collectedParts);
            } else if (
              (evt.type === "REASONING_MESSAGE_CONTENT" ||
                evt.type === "REASONING_MESSAGE_CHUNK" ||
                evt.type === "THINKING_TEXT_MESSAGE_CONTENT") &&
              evt.delta
            ) {
              collectedParts = appendReasoningDelta(collectedParts, evt.delta);
              setLiveParts(collectedParts);
            } else if (
              evt.type === "REASONING_END" ||
              evt.type === "THINKING_END" ||
              evt.type === "REASONING_MESSAGE_END" ||
              evt.type === "THINKING_TEXT_MESSAGE_END"
            ) {
              collectedParts = endReasoning(collectedParts);
              setLiveParts(collectedParts);
            } else if (evt.type === "TEXT_MESSAGE_CONTENT" && evt.delta) {
              collectedParts = appendTextDelta(collectedParts, evt.delta);
              setLiveParts(collectedParts);
            } else if (evt.type === "TOOL_CALL_START") {
              collectedParts = endReasoning(collectedParts);
              const tool: ToolPart & { argsText?: string } = {
                type: evt.toolCallName || "tool",
                state: "input-streaming",
                toolCallId: evt.toolCallId,
                argsText: "",
              };
              collectedParts = [...collectedParts, { kind: "tool", tool }];
              setLiveParts(collectedParts);
            } else if (evt.type === "TOOL_CALL_ARGS" && evt.delta) {
              collectedParts = updateTool(collectedParts, evt.toolCallId, (tool) => {
                const argsText = (tool.argsText || "") + evt.delta!;
                return {
                  ...tool,
                  argsText,
                  input: parseToolArgs(argsText),
                  state: "input-streaming",
                };
              });
              setLiveParts(collectedParts);
            } else if (evt.type === "TOOL_CALL_END") {
              collectedParts = updateTool(collectedParts, evt.toolCallId, (tool) => {
                // Always re-parse completed argsText — don't keep a stale `_partial` input.
                const parsed = tool.argsText
                  ? parseToolArgs(tool.argsText)
                  : undefined;
                const input =
                  parsed && !("_partial" in parsed)
                    ? parsed
                    : tool.input && !("_partial" in tool.input)
                      ? tool.input
                      : parsed || tool.input;
                return {
                  ...tool,
                  input,
                  state: "input-available",
                };
              });
              setLiveParts(collectedParts);
            } else if (evt.type === "TOOL_CALL_RESULT") {
              const finished = collectedParts.find(
                (p) => p.kind === "tool" && p.tool.toolCallId === evt.toolCallId
              );
              const toolName =
                finished && finished.kind === "tool" ? finished.tool.type : "";
              const rawContent = evt.content || "";
              const failed = isToolResultError(rawContent);
              collectedParts = updateTool(collectedParts, evt.toolCallId, {
                output: failed
                  ? { result: toolResultErrorText(rawContent) }
                  : parseToolOutput(rawContent),
                state: failed ? "output-error" : "output-available",
                errorText: failed ? toolResultErrorText(rawContent) : undefined,
              });
              setLiveParts(collectedParts);
              // Research / workspace writes land in DB after the tool —
              // refresh so Artifacts tabs appear without re-selecting the thread.
              if (
                /delegate_research|write_workspace_file|run_code/i.test(
                  toolName
                )
              ) {
                void refreshWorkspaceFiles();
              }
            }
          } catch {
            // ignore malformed SSE chunks
          }
        }
      }

      collectedParts = endReasoning(collectedParts);
      const { content, tools, ordered, reasoning } = partsToPersist(collectedParts);

      // Drop the live stream bubble before committing the final message so the
      // UI never shows both at once (duplicate flash at end of stream).
      setLiveParts([]);
      setIsLoading(false);
      if (abortRef.current === controller) {
        abortRef.current = null;
      }

      if (content || tools.length || reasoning || ordered.length) {
        const tempAssistantId = `temp-${crypto.randomUUID()}`;
        appendMessage({
          id: tempAssistantId,
          role: "assistant",
          content,
          tools,
          parts: ordered,
          reasoning: reasoning || undefined,
        });
        await persistMessage(threadId, {
          role: "assistant",
          content,
          tools,
          parts: ordered,
          reasoning: reasoning || undefined,
        });
      }
      await refreshThreadArtifacts();
    } catch (err) {
      if (isAbortError(err)) {
        collectedParts = endReasoning(collectedParts);
        const { content, tools, ordered, reasoning } =
          partsToPersist(collectedParts);
        const stopNote = `_${STOPPED_BY_USER_MESSAGE}_`;
        const finalContent = content.trim()
          ? `${content.trim()}\n\n${stopNote}`
          : STOPPED_BY_USER_MESSAGE;
        const finalOrdered: ChatContentPart[] = [
          ...ordered,
          { kind: "text", text: stopNote },
        ];
        setLiveParts([]);
        setIsLoading(false);
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        appendMessage({
          id: `temp-${crypto.randomUUID()}`,
          role: "assistant",
          content: finalContent,
          tools,
          parts: finalOrdered,
          reasoning: reasoning || undefined,
        });
        if (threadId) {
          try {
            await persistMessage(threadId, {
              role: "assistant",
              content: finalContent,
              tools,
              parts: finalOrdered,
              reasoning: reasoning || undefined,
            });
          } catch {
            // ignore persist failure on stop path
          }
        }
      } else if (
        err instanceof Error &&
        (err.name === "BudgetExceededError" ||
          /usage budget/i.test(err.message))
      ) {
        setLiveParts([]);
        setIsLoading(false);
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        setBudgetLimitOpen(true);
      } else {
        const errText = `Error: ${err instanceof Error ? err.message : String(err)}`;
        setLiveParts([]);
        setIsLoading(false);
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        appendMessage({
          id: `temp-${crypto.randomUUID()}`,
          role: "assistant",
          content: errText,
        });
        if (threadId) {
          try {
            await persistMessage(threadId, {
              role: "assistant",
              content: errText,
            });
          } catch {
            // ignore persist failure on error path
          }
        }
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      setIsLoading(false);
      setLiveParts([]);
    }
  }

  async function send() {
    if ((!value.trim() && mentionChips.length === 0) || isLoading) return;
    const { displayText, agentText, attachments } = formatMentionsForSend(
      value,
      mentionChips
    );
    const quote = quotedSelection?.text?.trim();
    const bubble = quote ? formatQuotedUserMessage(quote, displayText) : displayText;
    const agent = quote ? formatQuotedUserMessage(quote, agentText) : agentText;
    setValue("");
    setMentionChips([]);
    setActiveMention(null);
    clearQuotedSelection();
    await sendText(bubble, { agentText: agent, attachments });
  }

  function markClarifyingSubmitted() {
    setMessages((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        const m = next[i];
        if (!m || m.role !== "assistant" || !m.parts?.length) continue;
        let partIdx = -1;
        for (let j = m.parts.length - 1; j >= 0; j--) {
          const p = m.parts[j];
          if (p?.kind === "clarifying_question" && !p.submitted && !p.answeredLabel) {
            partIdx = j;
            break;
          }
        }
        if (partIdx < 0) continue;
        const nextParts = m.parts.map((p, j) =>
          j === partIdx && p.kind === "clarifying_question"
            ? { ...p, submitted: true }
            : p
        );
        next[i] = { ...m, parts: nextParts };
        break;
      }
      return next;
    });
  }

  function submitClarifyingAnswers(
    answers: Record<string, ClarifyingAnswerValue>
  ) {
    if (isLoading || !clarifyingDock) return;
    const text = formatClarifyingAnswersBatch(clarifyingDock.questions, answers);
    markClarifyingSubmitted();
    setClarifyingDock(null);
    void sendText(text);
  }

  function dismissClarifyingDock() {
    markClarifyingSubmitted();
    setClarifyingDock(null);
  }

  // Restore unanswered clarifying session after reload / thread switch.
  useEffect(() => {
    if (isLoading) return;
    let lastAssistantIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "assistant") {
        lastAssistantIdx = i;
        break;
      }
    }
    if (lastAssistantIdx < 0) {
      setClarifyingDock(null);
      return;
    }
    // If the user already replied after that assistant turn, don't reopen.
    for (let i = lastAssistantIdx + 1; i < messages.length; i++) {
      if (messages[i]?.role === "user") {
        setClarifyingDock(null);
        return;
      }
    }
    const parts = getMessageParts(messages[lastAssistantIdx]!);
    for (let j = parts.length - 1; j >= 0; j--) {
      const p = parts[j];
      if (p?.kind !== "clarifying_question") continue;
      if (p.submitted || p.answeredLabel) {
        setClarifyingDock(null);
        return;
      }
      const session = sessionFromPart(p);
      if (session) setClarifyingDock(session);
      else setClarifyingDock(null);
      return;
    }
    setClarifyingDock(null);
  }, [activeThreadId, messages, isLoading]);

  const liveMessageIndex = messages.length;

  /** One segment per write_todos so finished plans stay visible in history. */
  const todoPlanSegments = useMemo(() => {
    const batches: { messageIndex: number; tools: ChatToolPart[] }[] = [];
    messages.forEach((m, messageIndex) => {
      const tools = getMessageParts(m)
        .filter((p): p is Extract<ChatContentPart, { kind: "tool" }> => p.kind === "tool")
        .map((p) => p.tool)
        .filter(isTodoTool);
      if (tools.length) batches.push({ messageIndex, tools });
    });
    if (isLoading) {
      const liveTools = liveParts
        .filter((p): p is Extract<LivePart, { kind: "tool" }> => p.kind === "tool")
        .map((p) => p.tool as ChatToolPart)
        .filter(isTodoTool);
      if (liveTools.length) {
        batches.push({ messageIndex: liveMessageIndex, tools: liveTools });
      }
    }
    return buildTodoPlanSegments(batches);
  }, [messages, liveParts, isLoading, liveMessageIndex]);

  const todoPlanCount = todoPlanSegments.length;

  const isEmpty = messages.length === 0 && !isLoading && !threadLoading;
  const canSend = Boolean(value.trim()) || mentionChips.length > 0;
  const sendDisabled = !canSend && !isLoading;

  const uploadFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList?.length || !workspace) return;
      const files = Array.from(fileList);
      const batch: PendingUpload[] = files.map((file) => ({
        id:
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `${file.name}-${Date.now()}-${Math.random()}`,
        label: file.name,
      }));
      setPendingUploads((prev) => [...prev, ...batch]);
      setUploading(true);
      try {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const pendingId = batch[i].id;
          const clientError = validateUploadFile(file);
          if (clientError) {
            window.alert(clientError);
            setPendingUploads((prev) => prev.filter((p) => p.id !== pendingId));
            continue;
          }
          try {
            const body = new FormData();
            body.append("file", file);
            const res = await fetch(
              `${apiUrl}/api/workspaces/${workspace.id}/uploads`,
              {
                method: "POST",
                headers: getAuthHeaders(),
                body,
              }
            );
            if (!res.ok) {
              const detail = await res.text();
              throw new Error(detail || `Upload failed (${res.status})`);
            }
            const uploaded = (await res.json()) as {
              path: string;
              filename: string;
              size: number;
            };
            setMentionChips((prev) => {
              if (prev.some((c) => c.path === uploaded.path)) return prev;
              return [
                ...prev,
                {
                  id: uploaded.path,
                  kind: "upload" as const,
                  label: uploaded.filename,
                  path: uploaded.path,
                  size: uploaded.size,
                  description: "Attached for LiteParse",
                },
              ];
            });
            void refreshWorkspaceUploads();
          } catch (err) {
            console.error("Upload failed:", err);
            window.alert(
              err instanceof Error ? err.message : "Failed to upload file"
            );
          } finally {
            setPendingUploads((prev) => prev.filter((p) => p.id !== pendingId));
          }
        }
      } finally {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [workspace, apiUrl, refreshWorkspaceUploads]
  );

  const canDropUploads = !!workspace && !uploading;

  const onChatDragEnter = useCallback(
    (e: DragEvent) => {
      if (!canDropUploads) return;
      if (![...e.dataTransfer.types].includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
      dragDepthRef.current += 1;
      setDragActive(true);
    },
    [canDropUploads]
  );

  const onChatDragLeave = useCallback(
    (e: DragEvent) => {
      if (!canDropUploads) return;
      e.preventDefault();
      e.stopPropagation();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setDragActive(false);
    },
    [canDropUploads]
  );

  const onChatDragOver = useCallback(
    (e: DragEvent) => {
      if (!canDropUploads) return;
      if (![...e.dataTransfer.types].includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
    },
    [canDropUploads]
  );

  const onChatDrop = useCallback(
    (e: DragEvent) => {
      if (!canDropUploads) return;
      e.preventDefault();
      e.stopPropagation();
      dragDepthRef.current = 0;
      setDragActive(false);
      void uploadFiles(e.dataTransfer.files);
    },
    [canDropUploads, uploadFiles]
  );

  useEffect(() => {
    if (!dragActive) return;
    const clear = () => {
      dragDepthRef.current = 0;
      setDragActive(false);
    };
    const preventNav = (e: Event) => {
      e.preventDefault();
    };
    window.addEventListener("dragend", clear);
    window.addEventListener("dragover", preventNav);
    window.addEventListener("drop", preventNav);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("dragover", preventNav);
      window.removeEventListener("drop", preventNav);
      window.removeEventListener("drop", clear);
    };
  }, [dragActive]);

  const selectMention = (option: MentionOption) => {
    if (!activeMention) return;
    if (mentionChips.some((c) => c.id === option.id)) {
      // Already selected — just clear the trigger text.
      const { nextValue, nextCursor } = applyMentionSelection(
        value,
        activeMention,
        option
      );
      setValue(nextValue);
      setActiveMention(null);
      requestAnimationFrame(() => {
        const el = document.activeElement;
        if (el instanceof HTMLTextAreaElement) {
          el.setSelectionRange(nextCursor, nextCursor);
        }
      });
      return;
    }
    const chip: MentionChip = {
      id: option.id,
      kind: option.kind,
      label: option.label,
      path: option.path,
      description: option.description,
      size: option.size,
    };
    const { nextValue, nextCursor } = applyMentionSelection(
      value,
      activeMention,
      chip
    );
    setMentionChips((prev) => [...prev, chip]);
    setValue(nextValue);
    setActiveMention(null);
    requestAnimationFrame(() => {
      const el = document.activeElement;
      if (el instanceof HTMLTextAreaElement) {
        el.setSelectionRange(nextCursor, nextCursor);
      }
    });
  };

  const syncMentionFromTextarea = (el: HTMLTextAreaElement) => {
    const next = detectActiveMention(el.value, el.selectionStart ?? el.value.length);
    setActiveMention(next);
  };

  const composer = (
    <div className="relative w-full">
      {clarifyingDock && !isLoading ? (
        <ClarifyingQuestionsDock
          className="mb-2"
          session={clarifyingDock}
          disabled={isLoading}
          onSubmit={submitClarifyingAnswers}
          onDismiss={dismissClarifyingDock}
        />
      ) : null}
      {quotedSelection?.text ? (
        <div className="mb-2 flex items-start gap-2 rounded-2xl border border-border bg-muted/40 px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Quote
            </div>
            <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-sm leading-snug text-foreground">
              “{quotedSelection.text}”
            </p>
          </div>
          <button
            type="button"
            aria-label="Remove quote"
            className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={clearQuotedSelection}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}
      <div className="relative">
        {!isEmpty ? (
          <div className="pointer-events-none absolute right-3 bottom-full z-20 flex justify-end">
            <ChatSpriteBuddy
              variant="perched"
              playful={isLoading}
              className="drop-shadow-sm"
            />
          </div>
        ) : null}
      <PromptInput
        value={value}
        onValueChange={(next) => {
          setValue(next);
        }}
        isLoading={isLoading}
        onSubmit={() => {
          if (activeMention && mentionOptions.length > 0) return;
          void send();
        }}
        maxHeight={384}
        className={cn(
          "relative flex flex-col items-stretch gap-4 rounded-2xl border border-border bg-background p-3 shadow-[0_0_15px_rgba(0,0,0,0.06)] transition-shadow hover:shadow-[0_0_20px_rgba(0,0,0,0.09)] focus-within:shadow-[0_0_25px_rgba(0,0,0,0.11)]"
        )}
      >
        {activeMention ? (
          <ComposerMentionMenu
            options={mentionOptions}
            activeIndex={mentionIndex}
            onHover={setMentionIndex}
            onSelect={selectMention}
          />
        ) : null}
        <ComposerMentionChips
          chips={mentionChips}
          pending={pendingUploads}
          onSelect={setPreviewChip}
          onRemove={(id) => {
            const chip = mentionChips.find((c) => c.id === id);
            setMentionChips((prev) => prev.filter((c) => c.id !== id));
            if (chip) setValue((v) => removeMentionFromText(v, chip));
          }}
        />
        <PromptInputTextarea
          placeholder={
            quotedSelection?.text
              ? "Ask OpenAgents what to do with the selected text…"
              : isEmpty
                ? "How can I help you today? Use @ for files, / for skills"
                : "Ask OpenAgents…  @ files  / skills"
          }
          className="w-full px-1 text-[16px]!"
          onChange={(e) => syncMentionFromTextarea(e.target)}
          onClick={(e) => syncMentionFromTextarea(e.currentTarget)}
          onKeyUp={(e) => {
            if (
              e.key === "ArrowLeft" ||
              e.key === "ArrowRight" ||
              e.key === "Home" ||
              e.key === "End"
            ) {
              syncMentionFromTextarea(e.currentTarget);
            }
          }}
          onKeyDown={(e) => {
            if (!activeMention) return;
            if (e.key === "Escape") {
              e.preventDefault();
              setActiveMention(null);
              return;
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setMentionIndex((i) =>
                mentionOptions.length
                  ? (i + 1) % mentionOptions.length
                  : 0
              );
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setMentionIndex((i) =>
                mentionOptions.length
                  ? (i - 1 + mentionOptions.length) % mentionOptions.length
                  : 0
              );
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              const opt = mentionOptions[mentionIndex];
              if (opt) {
                e.preventDefault();
                selectMention(opt);
              } else {
                setActiveMention(null);
              }
            }
          }}
        />
        <PromptInputActions className="w-full shrink-0 items-center justify-between gap-1 p-0">
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              multiple
              accept={`${UPLOAD_ACCEPT},application/pdf,text/markdown,text/plain,text/csv,image/*`}
              onChange={(e) => void uploadFiles(e.target.files)}
            />
            <Tooltip>
              <TooltipTrigger
                type="button"
                aria-label="Attach PDF, DOCX, or images"
                disabled={uploading || !workspace}
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                onClick={(e) => {
                  e.stopPropagation();
                  fileInputRef.current?.click();
                }}
              >
                <Plus className={cn("size-5", uploading && "animate-pulse")} />
              </TooltipTrigger>
              <TooltipContent side="top">
                {uploading
                  ? "Uploading…"
                  : "Attach PDF, DOCX, Markdown, or images"}
              </TooltipContent>
            </Tooltip>
            <AgentPicker
              agents={agents}
              value={activeAgent?.slug || activeAgentSlug}
              disabled={isLoading || agentSwitchBusy || threadLoading}
              onChange={(slug) => {
                void (async () => {
                  setAgentSwitchBusy(true);
                  try {
                    await setThreadAgent(slug);
                  } catch (err) {
                    console.error("Failed to switch agent:", err);
                  } finally {
                    setAgentSwitchBusy(false);
                  }
                })();
              }}
            />
            <ModelPicker
              models={models}
              value={selectedModelId}
              onChange={setThreadModel}
            />
            {reasoningMode === "toggle" ? (
              <ReasoningToggle
                enabled={reasoningEnabled}
                onChange={setReasoningEnabled}
              />
            ) : reasoningMode === "efforts" ? (
              <ReasoningEffortPicker
                value={reasoningEffort}
                options={reasoningOptions}
                onChange={setReasoningEffort}
              />
            ) : null}
            {!isEmpty ? <ContextUsageMeter usage={threadUsage} /> : null}
          </div>
          <div className="flex shrink-0 items-center">
            <Tooltip>
              <TooltipTrigger
                type="button"
                disabled={sendDisabled}
                aria-label={isLoading ? "Stop generating" : "Send message"}
                className={cn(
                  "inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors",
                  isLoading || canSend
                    ? "bg-primary text-primary-foreground hover:bg-primary/80"
                    : "pointer-events-none bg-muted text-muted-foreground opacity-50"
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  if (isLoading) stopStreaming();
                  else void send();
                }}
              >
                {isLoading ? (
                  <Square className="size-3.5 fill-current" />
                ) : (
                  <ArrowUp className="size-4" />
                )}
              </TooltipTrigger>
              <TooltipContent side="top">
                {isLoading
                  ? "Stop"
                  : sendDisabled
                    ? "Add a message or attachment"
                    : "Send"}
              </TooltipContent>
            </Tooltip>
          </div>
        </PromptInputActions>
      </PromptInput>
      </div>
      {isEmpty ? (
        <p className="mt-3 text-center text-xs text-muted-foreground">
          AI can make mistakes. Please check important information.
        </p>
      ) : null}
    </div>
  );

  return (
    <div
      className="relative flex h-full flex-col"
      onDragEnter={onChatDragEnter}
      onDragLeave={onChatDragLeave}
      onDragOver={onChatDragOver}
      onDrop={onChatDrop}
    >
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col transition-[filter,opacity] duration-200",
          dragActive && "pointer-events-none opacity-40 blur-[3px]"
        )}
      >
      {documentCollapsed && activeThreadId ? (
        <div className="flex h-12 shrink-0 items-center justify-end gap-2 px-3">
          <Tooltip>
            <TooltipTrigger
              className="inline-flex"
              onClick={onOpenDocument}
              aria-label="Open artifacts"
            >
              <span className="inline-flex h-7 items-center gap-1.5 rounded-md border bg-background px-2 text-xs font-medium hover:bg-muted">
                <FileText className="size-3.5 opacity-70" />
                Artifacts
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">Open artifacts</TooltipContent>
          </Tooltip>
        </div>
      ) : (
        <div className="h-12 shrink-0" />
      )}

      {threadLoading ? (
        <ChatThreadSkeleton />
      ) : isEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center px-4 pb-10">
          <div className="mb-8 w-full max-w-2xl animate-in fade-in-0 duration-300 text-center sm:mb-10">
            <ChatSpriteBuddy variant="hero" className="mx-auto mb-5" />
            <h1 className="text-3xl font-light tracking-tight text-foreground sm:text-4xl">
              {timeGreeting()}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {activeAgent?.description ||
                "Chat with OpenAgents — specialized by the selected Agent."}
            </p>
          </div>

          <div className="w-full max-w-2xl">{composer}</div>

          <div className="mt-4 flex max-w-2xl flex-wrap justify-center gap-2 px-2">
            {STARTER_PROMPTS.map(({ label, prompt, icon: Icon }) => (
              <button
                key={label}
                type="button"
                onClick={() => setValue(prompt)}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-transparent px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Icon className="size-3.5 opacity-70" />
                {label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          <ChatContainerRoot className="relative flex-1">
            <ChatContainerContent className="mx-auto w-full max-w-[44em] space-y-5 px-4 py-6">
              {messages.map((m, messageIndex) => (
                <div key={m.id} className="space-y-3">
                  {m.role === "assistant" ? (
                    (() => {
                      const parts = getMessageParts(m);
                      if (!parts.length) {
                        return (
                          <div className="typeset typeset-chat">
                            <Markdown> </Markdown>
                          </div>
                        );
                      }
                      const segmentsHere = todoPlanSegments
                        .map((seg, idx) => ({ seg, idx }))
                        .filter(({ seg }) => seg.anchorMessageIndex === messageIndex);
                      return renderContentParts(
                        parts,
                        m.id,
                        false,
                        { hideInChat: true },
                        segmentsHere.map(({ seg }) => seg),
                        segmentsHere.map(({ idx }) => ({
                          planIndex: idx + 1,
                          planCount: todoPlanCount,
                        }))
                      );
                    })()
                  ) : (
                    (() => {
                      const legacy = !m.attachments?.length
                        ? splitLegacyAttachmentBlock(m.content)
                        : null;
                      const bubbleContent = legacy?.displayText ?? m.content;
                      const attachments = (m.attachments?.length
                        ? m.attachments
                        : legacy?.attachments) as MentionChip[] | undefined;
                      const clarifying = parseClarifyingUserMessage(bubbleContent);
                      const parsed = clarifying
                        ? null
                        : parseQuotedUserMessage(bubbleContent);
                      const hasBubble =
                        clarifying ||
                        (parsed?.quote ? true : !!bubbleContent.trim());

                      return (
                        <div className="flex flex-col items-end gap-1.5">
                          {!!attachments?.length && (
                            <MessageAttachmentChips
                              attachments={attachments}
                              onSelect={setPreviewChip}
                            />
                          )}
                          {hasBubble && (
                            <Message className="w-full justify-end">
                              <MessageContent className="typeset typeset-chat max-w-[85%] bg-muted text-foreground">
                                {clarifying ? (
                                  <ClarifyingAnswersBubble pairs={clarifying} />
                                ) : parsed?.quote ? (
                                  <div className="not-typeset space-y-2">
                                    <blockquote className="border-l-2 border-muted-foreground/40 pl-2 text-[13px] leading-snug opacity-90">
                                      <span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide opacity-70">
                                        Selected
                                      </span>
                                      <span className="line-clamp-6 whitespace-pre-wrap">
                                        {parsed.quote}
                                      </span>
                                    </blockquote>
                                    {parsed.prompt ? (
                                      <div className="whitespace-pre-wrap">
                                        {parsed.prompt}
                                      </div>
                                    ) : null}
                                  </div>
                                ) : (
                                  bubbleContent
                                )}
                              </MessageContent>
                            </Message>
                          )}
                        </div>
                      );
                    })()
                  )}
                </div>
              ))}

              {isLoading && (
                <div className="space-y-3">
                  {liveParts.length > 0 ? (
                    <>
                      {renderContentParts(
                        liveParts.map((p) =>
                          p.kind === "text"
                            ? { kind: "text" as const, text: p.text }
                            : p.kind === "reasoning"
                              ? {
                                  kind: "reasoning" as const,
                                  text: p.text,
                                  streaming: p.streaming,
                                }
                              : p.kind === "clarifying_question"
                                ? {
                                    kind: "clarifying_question" as const,
                                    questions: p.questions,
                                    toolCallId: p.toolCallId,
                                    submitted: p.submitted,
                                  }
                                : { kind: "tool" as const, tool: p.tool as ChatToolPart }
                        ),
                        "live",
                        true,
                        { hideInChat: true },
                        todoPlanSegments
                          .filter((seg) => seg.anchorMessageIndex === liveMessageIndex)
                          .map((seg) => seg),
                        todoPlanSegments
                          .map((seg, idx) => ({ seg, idx }))
                          .filter(({ seg }) => seg.anchorMessageIndex === liveMessageIndex)
                          .map(({ idx }) => ({
                            planIndex: idx + 1,
                            planCount: todoPlanCount,
                          }))
                      )}
                      {!liveParts.some((p) => p.kind === "text" && p.text.trim()) &&
                      !liveParts.some(
                        (p) =>
                          p.kind === "tool" &&
                          (p.tool.state === "input-streaming" ||
                            p.tool.state === "input-available")
                      ) &&
                      !liveParts.some((p) => p.kind === "reasoning" && p.streaming) ? (
                        <WorkingShimmer />
                      ) : null}
                    </>
                  ) : (
                    <WorkingShimmer />
                  )}
                </div>
              )}
            </ChatContainerContent>
            <div className="absolute right-7 bottom-4 z-10">
              <ScrollButton className="shadow-sm" />
            </div>
          </ChatContainerRoot>

          <div className="overflow-visible p-3 pt-10">
            <div className="relative mx-auto w-full max-w-[44em] overflow-visible">
              {composer}
            </div>
          </div>
        </>
      )}
      </div>

      {dragActive ? (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-background/55 px-6 backdrop-blur-md"
          aria-hidden
        >
          <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-2xl border border-dashed border-foreground/25 bg-background/90 px-8 py-10 text-center shadow-[0_12px_40px_rgba(0,0,0,0.08)]">
            <div className="flex size-14 items-center justify-center rounded-full border border-border bg-muted/60">
              <Upload className="size-6 text-foreground" />
            </div>
            <p className="text-base font-medium tracking-tight text-foreground">
              Drop files to attach
            </p>
            <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">
              PDF, DOCX, Markdown, spreadsheets, slides, or images
            </p>
          </div>
        </div>
      ) : null}

      <Dialog open={budgetLimitOpen} onOpenChange={setBudgetLimitOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="mb-1 flex size-10 items-center justify-center rounded-full border bg-muted">
              <CircleDollarSign className="size-5 text-foreground" />
            </div>
            <DialogTitle>Usage budget reached</DialogTitle>
            <DialogDescription>
              You&apos;ve used{" "}
              <span className="font-medium text-foreground">
                {formatUsd(accountSpend.total_cost_usd)}
              </span>{" "}
              of your{" "}
              <span className="font-medium text-foreground">
                {formatUsd(accountSpend.spend_budget_usd ?? 5)}
              </span>{" "}
              allowance. Contact an admin to increase your limit so you can keep
              chatting.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" onClick={() => setBudgetLimitOpen(false)}>
              Got it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AttachmentPreviewDialog
        chip={previewChip}
        workspaceId={workspace?.id ?? null}
        open={!!previewChip}
        onOpenChange={(open) => {
          if (!open) setPreviewChip(null);
        }}
        resolveTextPreview={(chip) => {
          if (chip.kind === "skill") return null;
          if (chip.kind === "document") {
            const doc =
              documents.find((d) => d.id === chip.id) ||
              documents.find((d) => d.path === chip.path || d.title === chip.label);
            return doc?.content_md ?? null;
          }
          if (chip.kind === "file") {
            if (chip.id === "persona-agent") return workspace?.agent_md ?? "";
            if (chip.id === "persona-soul") return workspace?.soul_md ?? "";
            const file =
              workspaceFiles.find((f) => f.id === chip.id) ||
              workspaceFiles.find((f) => f.path === chip.path || f.path === chip.label);
            return file?.content_md ?? null;
          }
          return null;
        }}
      />
    </div>
  );
}
