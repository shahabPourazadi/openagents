import { describe, expect, it } from "vitest";
import {
  isToolResultError,
  toolResultErrorText,
} from "./tool-result-errors";

describe("isToolResultError", () => {
  it("detects OpenRouter upstream 404 retry prompts", () => {
    const content =
      'Upstream error HTTP 404: {"error":{"message":"No model found for \\"xai/grok-imagine-image-quality\\"","code":404}}\n\nFix the errors and try again.';
    expect(isToolResultError(content)).toBe(true);
    expect(isToolResultError({ result: content })).toBe(true);
  });

  it("does not flag successful image path metadata", () => {
    expect(
      isToolResultError({
        images: ["diagrams/generated-abc-1.jpg"],
        text: "Saved",
      })
    ).toBe(false);
    expect(isToolResultError({ result: "ok" })).toBe(false);
  });
});

describe("toolResultErrorText", () => {
  it("strips soft-retry boilerplate", () => {
    const content =
      "Upstream error HTTP 404: no model\n\nFix the errors and try again.";
    expect(toolResultErrorText(content)).toBe("Upstream error HTTP 404: no model");
  });
});
