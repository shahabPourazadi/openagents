/**
 * Detect MCP / tool failures that arrive as plain TOOL_CALL_RESULT text
 * (AG-UI has no error flag on the live event).
 */

const TOOL_FAILURE_PATTERNS: RegExp[] = [
  /Upstream error\s+HTTP\s+\d+/i,
  /Fix the errors and try again\.?/i,
  /\bTOOL FAILED\b/,
  /No model found for\s+"/i,
  /"code"\s*:\s*404\b/,
  /HTTP\s+404\b/,
];

export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (typeof content === "object") {
    const obj = content as Record<string, unknown>;
    if (typeof obj.result === "string") return obj.result;
    if (typeof obj.error === "string") return obj.error;
    if (typeof obj.message === "string") return obj.message;
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return String(content);
}

/** True when tool result content is a failed MCP/upstream call, not success. */
export function isToolResultError(content: unknown): boolean {
  const text = toolResultText(content).trim();
  if (!text) return false;
  return TOOL_FAILURE_PATTERNS.some((re) => re.test(text));
}

/** Human-readable error for UI; strips the soft-retry boilerplate when present. */
export function toolResultErrorText(content: unknown): string {
  let text = toolResultText(content).trim();
  if (!text) return "Tool failed.";
  text = text.replace(/\n*Fix the errors and try again\.?\s*$/i, "").trim();
  text = text.replace(/\n*TOOL FAILED[\s\S]*$/i, "").trim() || text;
  return text || "Tool failed.";
}
