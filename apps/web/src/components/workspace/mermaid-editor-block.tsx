"use client";

import type { EditorSchema } from "@/lib/editor-schema";
import { MermaidBlock } from "@/components/workspace/mermaid-block";
import { insertOrUpdateBlockForSlashMenu } from "@blocknote/core";
import { createReactBlockSpec } from "@blocknote/react";
import { useCallback, useState } from "react";

const DEFAULT_CHART = `flowchart LR
  A[Start] --> B[End]`;

function languageFromCodeEl(el: Element): string | undefined {
  const dataLang = el.getAttribute("data-language");
  if (dataLang) return dataLang;
  const cls = Array.from(el.classList).find((c) => c.startsWith("language-"));
  return cls?.replace("language-", "");
}

type MermaidEditor = {
  isEditable: boolean;
  updateBlock: (
    block: { props: { code: string } },
    update: { props: { code: string } }
  ) => void;
};

/** Named component so hooks satisfy react-hooks/rules-of-hooks. */
function MermaidBlockView({
  block,
  editor,
}: {
  block: { props: { code: string } };
  editor: MermaidEditor;
}) {
  const [editing, setEditing] = useState(false);
  const code = block.props.code;

  const onChange = useCallback(
    (next: string) => {
      editor.updateBlock(block, { props: { code: next } });
    },
    [block, editor]
  );

  return (
    <div className="bn-mermaid not-typeset my-2 w-full rounded-md border border-border bg-muted/20 p-2">
      {editor.isEditable && (
        <div className="mb-2 flex justify-end">
          <button
            type="button"
            className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? "Preview" : "Edit source"}
          </button>
        </div>
      )}
      {editing && editor.isEditable ? (
        <textarea
          className="min-h-[140px] w-full resize-y rounded border bg-background p-2 font-mono text-xs leading-relaxed"
          value={code}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
        />
      ) : (
        <MermaidBlock chart={code} />
      )}
    </div>
  );
}

/**
 * BlockNote block that renders ```mermaid fences as live diagrams,
 * while keeping the source editable and round-tripping to markdown.
 */
export const createMermaidBlock = createReactBlockSpec(
  {
    type: "mermaid",
    propSchema: {
      code: { default: DEFAULT_CHART },
    },
    content: "none",
  },
  {
    meta: { selectable: true },
    runsBefore: ["codeBlock"],
    parse: (el) => {
      if (el.tagName !== "PRE") return undefined;
      const codeEl = el.firstElementChild;
      if (!codeEl || codeEl.tagName !== "CODE") return undefined;
      if (languageFromCodeEl(codeEl) !== "mermaid") return undefined;
      return { code: codeEl.textContent ?? "" };
    },
    render: ({ block, editor }) => (
      <MermaidBlockView
        block={block}
        editor={editor as unknown as MermaidEditor}
      />
    ),
    toExternalHTML: ({ block }) => (
      <pre>
        <code className="language-mermaid" data-language="mermaid">
          {block.props.code}
        </code>
      </pre>
    ),
  }
);

export function insertMermaidSlashItem(editor: EditorSchema["BlockNoteEditor"]) {
  return {
    title: "Mermaid",
    subtext: "Insert a Mermaid diagram",
    // Distinct from BlockNote's default "Media" group so slash-menu
    // group headers stay unique (React keys by group name).
    group: "Diagrams",
    aliases: ["mermaid", "diagram", "flowchart", "chart"],
    onItemClick: () => {
      insertOrUpdateBlockForSlashMenu(editor, {
        type: "mermaid",
        props: { code: DEFAULT_CHART },
      });
    },
  };
}
