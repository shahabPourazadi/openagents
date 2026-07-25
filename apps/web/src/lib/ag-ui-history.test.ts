import { describe, expect, it } from "vitest";
import { buildAgUiHistoryMessages } from "./ag-ui-history";
import type { ChatMessage } from "./app-state";

describe("buildAgUiHistoryMessages", () => {
  it("includes failed tool results so later turns see the error", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "create image using Grok" },
      {
        id: "a1",
        role: "assistant",
        content: "Done — generated with Grok.",
        tools: [
          {
            type: "generate-image",
            state: "output-error",
            toolCallId: "call_1",
            input: { model: "xai/grok-imagine-image-quality" },
            errorText:
              'Upstream error HTTP 404: {"error":{"message":"No model found","code":404}}',
          },
        ],
      },
    ];

    const history = buildAgUiHistoryMessages(messages, {
      id: "u2",
      content: "create another one",
    });

    expect(history.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "user",
    ]);

    const tool = history.find((m) => m.role === "tool");
    expect(tool && tool.role === "tool" && tool.error).toContain("Upstream error");
    expect(tool && tool.role === "tool" && tool.content).toContain("TOOL FAILED");
    expect(tool && tool.role === "tool" && tool.toolCallId).toBe("call_1");

    const assistant = history.find((m) => m.role === "assistant");
    expect(
      assistant &&
        assistant.role === "assistant" &&
        assistant.toolCalls?.[0]?.function.name
    ).toBe("generate-image");
  });

  it("keeps plain text turns when there are no tools", () => {
    const history = buildAgUiHistoryMessages([
      { id: "u1", role: "user", content: "hi" },
      { id: "a1", role: "assistant", content: "hello" },
    ]);
    expect(history).toEqual([
      { id: "u1", role: "user", content: "hi" },
      { id: "a1", role: "assistant", content: "hello" },
    ]);
  });
});
