import { describe, expect, it } from "vitest";
import {
  isToolMediaGallerySource,
  looksLikeFileReadTool,
  looksLikeImageGenerationTool,
  mergeToolMedia,
  parseToolMedia,
} from "./tool-media";

describe("parseToolMedia", () => {
  it("extracts image and file asset paths from tool output metadata", () => {
    const media = parseToolMedia({
      images: ["diagrams/generated-abc-1.png", "diagrams/screenshots/page-1.png"],
      files: ["other/notes.txt"],
      text: "Saved sample",
    });

    expect(media.images).toEqual([
      "diagrams/generated-abc-1.png",
      "diagrams/screenshots/page-1.png",
    ]);
    expect(media.files).toEqual(["other/notes.txt"]);
    expect(media.text).toBe("Saved sample");
  });

  it("ignores base64 payloads and keeps only path metadata", () => {
    const media = parseToolMedia({
      result: {
        media_type: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        images: ["diagrams/generated-xyz-1.png"],
      },
    });

    expect(media.images).toEqual(["diagrams/generated-xyz-1.png"]);
    expect(media.files).toEqual([]);
    expect(JSON.stringify(media)).not.toContain("iVBOR");
  });

  it("returns empty media for ordinary tool text", () => {
    expect(parseToolMedia({ result: "ok" })).toEqual({
      images: [],
      files: [],
      text: "ok",
    });
  });

  it("mergeToolMedia dedupes images across tool outputs", () => {
    const merged = mergeToolMedia(
      { images: ["diagrams/a.png"], files: [] },
      { images: ["diagrams/a.png", "diagrams/b.png"], files: ["other/notes.txt"] }
    );
    expect(merged.images).toEqual(["diagrams/a.png", "diagrams/b.png"]);
    expect(merged.files).toEqual(["other/notes.txt"]);
  });
});

describe("gallery source helpers", () => {
  it("treats read_file as non-gallery and generate-image as gallery", () => {
    expect(looksLikeFileReadTool("read_file")).toBe(true);
    expect(looksLikeFileReadTool("ReadFile")).toBe(true);
    expect(isToolMediaGallerySource("read_file")).toBe(false);
    expect(looksLikeImageGenerationTool("generate-image")).toBe(true);
    expect(isToolMediaGallerySource("generate-image")).toBe(true);
  });
});
