"use client";

import { BlockNoteSchema, defaultBlockSpecs } from "@blocknote/core";
import { createMermaidBlock } from "@/components/workspace/mermaid-editor-block";
import { createWorkspaceImageBlock } from "@/components/workspace/workspace-image-block";

type DefaultImageSpec = (typeof defaultBlockSpecs)["image"];
const { image: _defaultImage, ...blockSpecsWithoutImage } = defaultBlockSpecs;
void _defaultImage;

/** BlockNote schema with Mermaid + workspace-aware image blocks. */
export const editorSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...blockSpecsWithoutImage,
    // Runtime-compatible with default image; custom render re-resolves assets.
    image: createWorkspaceImageBlock() as DefaultImageSpec,
    mermaid: createMermaidBlock(),
  },
});

export type EditorSchema = typeof editorSchema;

/** Turn ```mermaid code blocks into Mermaid blocks after markdown parse. */
export function promoteMermaidCodeBlocks<
  T extends {
    type: string;
    props?: Record<string, unknown>;
    content?: unknown;
    children?: T[];
  },
>(blocks: T[]): T[] {
  return blocks.map((block) => {
    const children = block.children
      ? promoteMermaidCodeBlocks(block.children)
      : block.children;

    if (
      block.type === "codeBlock" &&
      (block.props?.language === "mermaid" || block.props?.language === "mmd")
    ) {
      const code = inlineContentToText(block.content);
      return {
        ...block,
        type: "mermaid" as T["type"],
        props: { code },
        content: undefined,
        children: children ?? [],
      };
    }

    return children ? { ...block, children } : block;
  });
}

function inlineContentToText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((node) => {
      if (!node || typeof node !== "object") return "";
      const n = node as { type?: string; text?: string };
      return n.type === "text" && typeof n.text === "string" ? n.text : "";
    })
    .join("");
}
