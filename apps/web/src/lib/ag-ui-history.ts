import type { ChatContentPart, ChatMessage, ChatToolPart } from "./app-state";
import {
  isToolResultError,
  toolResultErrorText,
  toolResultText,
} from "./tool-result-errors";

/** AG-UI RunAgentInput message shapes we send from the web client. */
export type AgUiHistoryMessage =
  | { id: string; role: "user" | "system"; content: string }
  | {
      id: string;
      role: "assistant";
      content: string;
      toolCalls?: AgUiToolCall[];
    }
  | {
      id: string;
      role: "tool";
      content: string;
      toolCallId: string;
      error?: string | null;
    };

type AgUiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

const MAX_TOOL_CONTENT = 4_000;

function compactToolContent(value: unknown): string {
  const text = toolResultText(value);
  if (text.length <= MAX_TOOL_CONTENT) return text;
  return `${text.slice(0, MAX_TOOL_CONTENT)}\n…[truncated]`;
}

function toolsFromMessage(message: ChatMessage): ChatToolPart[] {
  if (message.parts?.length) {
    return message.parts
      .filter((p): p is Extract<ChatContentPart, { kind: "tool" }> => p.kind === "tool")
      .map((p) => p.tool);
  }
  return message.tools ?? [];
}

function toolName(tool: ChatToolPart): string {
  // MCP tools may be namespaced as "server|tool_name" — keep as streamed.
  const name = (tool.type || "tool").trim();
  return name || "tool";
}

function toolArguments(tool: ChatToolPart): string {
  try {
    return JSON.stringify(tool.input ?? {});
  } catch {
    return "{}";
  }
}

function toolResultPayload(tool: ChatToolPart): {
  content: string;
  error: string | null;
} {
  const failed =
    tool.state === "output-error" ||
    Boolean(tool.errorText) ||
    isToolResultError(tool.output) ||
    isToolResultError(tool.errorText);

  if (failed) {
    const err =
      (tool.errorText && tool.errorText.trim()) ||
      toolResultErrorText(tool.output) ||
      "Tool failed.";
    return {
      content: compactToolContent(
        `${err}\n\nTOOL FAILED — do not claim this tool succeeded. ` +
          `Do not invent asset paths, costs, or image details. ` +
          `Tell the user about the error.`
      ),
      error: err,
    };
  }

  if (tool.output != null) {
    return { content: compactToolContent(tool.output), error: null };
  }
  return { content: "Tool completed with no output.", error: null };
}

/**
 * Expand chat messages into AG-UI history including tool calls/results so
 * later turns still see failures (and cannot invent success from text alone).
 */
export function buildAgUiHistoryMessages(
  messages: ChatMessage[],
  extraUser?: { id: string; content: string }
): AgUiHistoryMessage[] {
  const out: AgUiHistoryMessage[] = [];

  for (const message of messages) {
    if (message.role === "user" || message.role === "system") {
      out.push({
        id: message.id,
        role: message.role,
        content: message.content ?? "",
      });
      continue;
    }

    if (message.role !== "assistant") continue;

    const tools = toolsFromMessage(message).filter((t) => Boolean(t.toolCallId || t.type));
    const content = message.content ?? "";

    if (!tools.length) {
      if (content) {
        out.push({ id: message.id, role: "assistant", content });
      }
      continue;
    }

    const toolCalls: AgUiToolCall[] = tools.map((tool, index) => {
      const id = tool.toolCallId || `${message.id}-tool-${index}`;
      return {
        id,
        type: "function" as const,
        function: {
          name: toolName(tool),
          arguments: toolArguments(tool),
        },
      };
    });

    out.push({
      id: message.id,
      role: "assistant",
      content,
      toolCalls,
    });

    tools.forEach((tool, index) => {
      const toolCallId = tool.toolCallId || `${message.id}-tool-${index}`;
      const { content: toolContent, error } = toolResultPayload(tool);
      out.push({
        id: `${message.id}-result-${index}`,
        role: "tool",
        content: toolContent,
        toolCallId,
        error,
      });
    });
  }

  if (extraUser) {
    out.push({
      id: extraUser.id,
      role: "user",
      content: extraUser.content,
    });
  }

  return out;
}
