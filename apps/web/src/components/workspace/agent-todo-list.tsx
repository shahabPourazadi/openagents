"use client";

import { useRef } from "react";
import { Check, Circle, ListTodo, Loader2 } from "lucide-react";
import { TextShimmer } from "@/components/ui/text-shimmer";
import type { ToolPart } from "@/components/ui/tool";
import type { ChatToolPart } from "@/lib/app-state";
import { cn } from "@/lib/utils";

export type AgentTodoStatus = "pending" | "in_progress" | "completed" | "blocked";

export type AgentTodoItem = {
  id: string;
  content: string;
  status: AgentTodoStatus;
  activeForm?: string;
};

const TODO_TOOL_KEYS = new Set([
  "write_todos",
  "add_todo",
  "update_todo_status",
  "update_todo_statuses",
  "remove_todo",
  "read_todos",
  "add_subtask",
  "set_dependency",
  "get_available_tasks",
  // pydantic-deep native plan tools (planner subagent / save_plan)
  "save_plan",
]);

function normalizeToolKey(type: string): string {
  const bare = type.includes("|") ? (type.split("|").pop() ?? type) : type;
  return bare
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

export function isTodoTool(tool: ToolPart | ChatToolPart): boolean {
  return TODO_TOOL_KEYS.has(normalizeToolKey(tool.type));
}

export type TodoPlanSegment = {
  id: string;
  /** Message index where this plan started (`write_todos`); use for chat placement. */
  anchorMessageIndex: number;
  tools: ChatToolPart[];
};

/**
 * Split chronological todo tools into plans.
 * Each `write_todos` starts a new segment; later updates belong to that plan
 * until the next `write_todos`.
 */
export function buildTodoPlanSegments(
  batches: { messageIndex: number; tools: ChatToolPart[] }[]
): TodoPlanSegment[] {
  const segments: TodoPlanSegment[] = [];
  let current: TodoPlanSegment | null = null;
  let planNum = 0;

  for (const { messageIndex, tools } of batches) {
    for (const tool of tools) {
      if (!isTodoTool(tool)) continue;
      const key = normalizeToolKey(tool.type);
      if (key === "write_todos") {
        planNum += 1;
        current = {
          id: `plan-${planNum}-${tool.toolCallId || `m${messageIndex}`}`,
          anchorMessageIndex: messageIndex,
          tools: [tool],
        };
        segments.push(current);
        continue;
      }
      if (!current) {
        planNum += 1;
        current = {
          id: `plan-${planNum}-orphan-m${messageIndex}`,
          anchorMessageIndex: messageIndex,
          tools: [tool],
        };
        segments.push(current);
        continue;
      }
      current.tools = [...current.tools, tool];
    }
  }
  return segments;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function parseStatus(value: unknown): AgentTodoStatus | null {
  if (value === "pending" || value === "in_progress" || value === "completed" || value === "blocked") {
    return value;
  }
  return null;
}

function statusFromIcon(icon: string): AgentTodoStatus {
  const t = icon.trim();
  if (t === "[x]" || t === "[X]") return "completed";
  if (t === "[*]") return "in_progress";
  if (t === "[!]") return "blocked";
  return "pending";
}

function parseTodoItem(raw: unknown, index: number): AgentTodoItem | null {
  const obj = asRecord(raw);
  if (!obj) return null;
  const content = typeof obj.content === "string" ? obj.content.trim() : "";
  if (!content) return null;
  const id =
    typeof obj.id === "string" && obj.id.trim()
      ? obj.id.trim()
      : `todo-${index}-${content.slice(0, 24)}`;
  return {
    id,
    content,
    status: parseStatus(obj.status) ?? "pending",
    activeForm: typeof obj.active_form === "string" ? obj.active_form : undefined,
  };
}

function toolArgsText(tool: ToolPart | ChatToolPart): string | undefined {
  const withArgs = tool as ToolPart & { argsText?: string };
  if (typeof withArgs.argsText === "string" && withArgs.argsText.trim()) {
    return withArgs.argsText;
  }
  const partial = tool.input?._partial;
  if (typeof partial === "string" && partial.trim()) return partial;
  return undefined;
}

function toolInput(tool: ToolPart | ChatToolPart): Record<string, unknown> | undefined {
  if (tool.input && typeof tool.input === "object" && !("_partial" in tool.input && Object.keys(tool.input).length === 1)) {
    const rest = { ...(tool.input as Record<string, unknown>) };
    delete rest._partial;
    if (Object.keys(rest).length) return rest;
  }
  const argsText = toolArgsText(tool);
  if (!argsText) return undefined;
  try {
    const parsed = JSON.parse(argsText) as unknown;
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

function toolOutputText(tool: ToolPart | ChatToolPart): string | undefined {
  const output = tool.output;
  if (!output) return undefined;
  if (typeof output.result === "string") return output.result;
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return undefined;
  }
}

/** Parse `read_todos` tool output into items with real server IDs. */
function parseReadTodosOutput(text: string): AgentTodoItem[] | null {
  const lines = text.split("\n");
  const items: AgentTodoItem[] = [];
  // e.g. `1. [x] [a1b2c3d4] Do the thing`
  const re = /^\s*\d+\.\s*(\[[^\]]+\])\s*\[([^\]]+)\]\s+(.+?)\s*$/;
  for (const line of lines) {
    const m = line.match(re);
    if (!m) continue;
    items.push({
      id: m[2].trim(),
      content: m[3].trim(),
      status: statusFromIcon(m[1]),
    });
  }
  return items.length ? items : null;
}

function applyStatusByIdOrContent(
  todos: AgentTodoItem[],
  todoId: string | undefined,
  status: AgentTodoStatus,
  contentHint?: string
): AgentTodoItem[] {
  if (todoId && todos.some((t) => t.id === todoId)) {
    return todos.map((t) => (t.id === todoId ? { ...t, status } : t));
  }
  if (contentHint) {
    const hint = contentHint.trim().toLowerCase();
    const idx = todos.findIndex(
      (t) =>
        t.content.trim().toLowerCase() === hint ||
        t.content.trim().toLowerCase().includes(hint) ||
        hint.includes(t.content.trim().toLowerCase())
    );
    if (idx >= 0) {
      return todos.map((t, i) => (i === idx ? { ...t, status } : t));
    }
  }
  // Last resort: if only one non-completed item, update that when completing/progressing
  if (status === "in_progress" || status === "completed") {
    const candidates = todos.filter((t) => t.status !== "completed");
    if (candidates.length === 1) {
      const onlyId = candidates[0].id;
      return todos.map((t) => (t.id === onlyId ? { ...t, status } : t));
    }
  }
  return todos;
}

/** Replay todo tool calls into a single list snapshot (latest wins). */
export function reduceTodoTools(tools: (ToolPart | ChatToolPart)[]): AgentTodoItem[] {
  let todos: AgentTodoItem[] = [];

  for (const tool of tools) {
    const key = normalizeToolKey(tool.type);
    const input = toolInput(tool);
    const outputText = toolOutputText(tool);

    if (key === "write_todos") {
      const rawList = input?.todos;
      if (Array.isArray(rawList)) {
        todos = rawList
          .map((item, i) => parseTodoItem(item, i))
          .filter((item): item is AgentTodoItem => item != null);
      }
      continue;
    }

    if (key === "read_todos" && outputText) {
      const parsed = parseReadTodosOutput(outputText);
      if (parsed) {
        // Merge activeForm from previous snapshot when content matches
        todos = parsed.map((item) => {
          const prev = todos.find(
            (t) => t.id === item.id || t.content.trim().toLowerCase() === item.content.trim().toLowerCase()
          );
          return prev?.activeForm ? { ...item, activeForm: prev.activeForm } : item;
        });
      }
      continue;
    }

    if (key === "add_todo") {
      const content = typeof input?.content === "string" ? input.content.trim() : "";
      if (!content) continue;
      const activeForm =
        typeof input?.active_form === "string" ? input.active_form : undefined;
      const idMatch = outputText?.match(/ID:\s*([a-f0-9]{6,})\b/i);
      const id = idMatch?.[1] || `pending-${content.slice(0, 32)}`;
      if (!todos.some((t) => t.id === id || t.content === content)) {
        todos = [...todos, { id, content, status: "pending", activeForm }];
      } else {
        // Upgrade temp id → real id once output arrives
        todos = todos.map((t) =>
          t.content === content && idMatch?.[1] ? { ...t, id: idMatch[1] } : t
        );
      }
      continue;
    }

    if (key === "update_todo_status") {
      const todoId =
        (typeof input?.todo_id === "string" && input.todo_id) ||
        (typeof input?.id === "string" && input.id) ||
        undefined;
      let status = parseStatus(input?.status);
      let contentHint: string | undefined;

      // Fallback: "Updated todo 'Do the thing' status to 'completed'"
      if (outputText) {
        const m = outputText.match(
          /Updated todo ['"](.+?)['"] status to ['"](\w+)['"]/i
        );
        if (m) {
          contentHint = m[1];
          status = parseStatus(m[2]) ?? status;
        }
      }

      if (!status) continue;
      todos = applyStatusByIdOrContent(todos, todoId, status, contentHint);
      continue;
    }

    if (key === "update_todo_statuses") {
      const updates = input?.updates;
      if (Array.isArray(updates)) {
        for (const entry of updates) {
          const obj = asRecord(entry);
          if (!obj) continue;
          const todoId = typeof obj.todo_id === "string" ? obj.todo_id : undefined;
          const status = parseStatus(obj.status);
          if (!status) continue;
          todos = applyStatusByIdOrContent(todos, todoId, status);
        }
      }
      // Also parse batch output lines: `- [id] content → completed`
      if (outputText) {
        for (const line of outputText.split("\n")) {
          const m = line.match(/^\s*-\s*\[([^\]]+)\]\s+(.+?)\s*→\s*(\w+)\s*$/);
          if (!m) continue;
          const status = parseStatus(m[3]);
          if (!status) continue;
          todos = applyStatusByIdOrContent(todos, m[1], status, m[2]);
        }
      }
      continue;
    }

    if (key === "remove_todo") {
      const todoId = typeof input?.todo_id === "string" ? input.todo_id : undefined;
      if (todoId) {
        todos = todos.filter((t) => t.id !== todoId);
      } else if (outputText) {
        const m = outputText.match(/Removed todo ['"](.+?)['"]/i);
        if (m) {
          const hint = m[1].trim().toLowerCase();
          todos = todos.filter((t) => t.content.trim().toLowerCase() !== hint);
        }
      }
      continue;
    }

    if (key === "add_subtask") {
      const content = typeof input?.content === "string" ? input.content.trim() : "";
      if (!content) continue;
      const idMatch = outputText?.match(/ID:\s*([a-f0-9]{6,})\b/i);
      const id = idMatch?.[1] || `sub-${content.slice(0, 32)}`;
      if (!todos.some((t) => t.id === id || t.content === content)) {
        todos = [
          ...todos,
          {
            id,
            content,
            status: "pending",
            activeForm:
              typeof input?.active_form === "string" ? input.active_form : undefined,
          },
        ];
      }
    }
  }

  return todos;
}

function StatusIcon({ status }: { status: AgentTodoStatus }) {
  if (status === "completed") {
    return (
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-emerald-500/40 bg-emerald-500/10 text-emerald-600">
        <Check className="size-2.5 stroke-3" />
      </span>
    );
  }
  if (status === "in_progress") {
    return (
      <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-foreground/70" />
    );
  }
  if (status === "blocked") {
    return (
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-amber-500/50 text-[10px] font-semibold text-amber-600">
        !
      </span>
    );
  }
  return <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground/50" />;
}

type AgentTodoListProps = {
  tools: (ToolPart | ChatToolPart)[];
  className?: string;
  /** Optional plan number for multi-plan history (1-based). */
  planIndex?: number;
  planCount?: number;
};

/** Single live to-do card — updates in place as write/update todo tools stream. */
export function AgentTodoList({
  tools,
  className,
  planIndex,
  planCount,
}: AgentTodoListProps) {
  const todos = reduceTodoTools(tools);
  // Assign entrance order during render so the first paint already animates.
  const enterOrderRef = useRef(new Map<string, number>());
  for (const todo of todos) {
    if (!enterOrderRef.current.has(todo.id)) {
      enterOrderRef.current.set(todo.id, enterOrderRef.current.size);
    }
  }

  if (!todos.length) return null;

  const allDone = todos.every((t) => t.status === "completed");
  const title =
    planCount && planCount > 1 && planIndex
      ? `To-dos · Plan ${planIndex}`
      : "To-dos";

  return (
    <div className={cn("not-typeset w-full max-w-xl", className)}>
      <div
        className={cn(
          "overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm",
          allDone && "opacity-90"
        )}
      >
        <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
          <ListTodo className="size-3.5 text-muted-foreground" />
          <span className="text-sm font-medium">{title}</span>
          <span className="text-sm text-muted-foreground">{todos.length}</span>
          {allDone ? (
            <span className="ml-auto text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Done
            </span>
          ) : null}
        </div>
        <ul className="divide-y divide-border/60">
          {todos.map((todo) => {
            const done = todo.status === "completed";
            const active = todo.status === "in_progress";
            const label =
              active && todo.activeForm?.trim() ? todo.activeForm : todo.content;
            const enterOrder = enterOrderRef.current.get(todo.id) ?? 0;
            return (
              <li
                key={todo.id}
                className="flex animate-in fade-in-0 slide-in-from-bottom-3 fill-mode-both items-start gap-2.5 px-3 py-2.5"
                style={{
                  animationDelay: `${enterOrder * 80}ms`,
                  animationDuration: "450ms",
                }}
              >
                <StatusIcon status={todo.status} />
                {active ? (
                  <TextShimmer
                    as="span"
                    duration={1.2}
                    className="min-w-0 flex-1 text-sm leading-snug font-normal"
                  >
                    {label}
                  </TextShimmer>
                ) : (
                  <span
                    className={cn(
                      "min-w-0 flex-1 text-sm leading-snug",
                      done && "text-muted-foreground line-through",
                      todo.status === "blocked" && "text-amber-700/90"
                    )}
                  >
                    {label}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
