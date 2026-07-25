"use client";

import {
  blockHasType,
  type BlockSchema,
  type InlineContentSchema,
  type StyleSchema,
} from "@blocknote/core";
import {
  useBlockNoteEditor,
  useComponentsContext,
  useEditorState,
} from "@blocknote/react";
import { Maximize2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { isMissingAssetPlaceholder } from "@/lib/workspace-media";

/** Expand the selected image block to a full-viewport lightbox. */
export function FileExpandButton() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor<
    BlockSchema,
    InlineContentSchema,
    StyleSchema
  >();

  const block = useEditorState({
    editor,
    selector: ({ editor: ed }) => {
      if (!ed.isEditable) return undefined;
      const selectedBlocks = ed.getSelection()?.blocks || [
        ed.getTextCursorPosition().block,
      ];
      if (selectedBlocks.length !== 1) return undefined;
      const b = selectedBlocks[0];
      if (
        !blockHasType(b, ed, b.type, {
          url: "string",
          showPreview: "boolean",
        })
      ) {
        return undefined;
      }
      if (b.type !== "image" || !b.props.url || !b.props.showPreview) {
        return undefined;
      }
      return b;
    },
  });

  const [open, setOpen] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const close = useCallback(() => {
    setOpen(false);
    setSrc(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  const onClick = useCallback(() => {
    if (!block) return;
    editor.focus();
    setLoading(true);
    setOpen(true);
    const resolve = editor.resolveFileUrl
      ? editor.resolveFileUrl(block.props.url)
      : Promise.resolve(block.props.url);
    void resolve
      .then((url) => {
        if (isMissingAssetPlaceholder(url)) {
          setSrc(null);
          return;
        }
        setSrc(url);
      })
      .catch(() => setSrc(null))
      .finally(() => setLoading(false));
  }, [block, editor]);

  if (block === undefined) {
    return null;
  }

  return (
    <>
      <Components.FormattingToolbar.Button
        className="bn-button"
        label="Expand image"
        mainTooltip="Expand image"
        icon={<Maximize2 size={16} />}
        onClick={onClick}
      />
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed inset-0 z-200 flex items-center justify-center bg-black/80 p-4"
            role="dialog"
            aria-modal="true"
            aria-label="Expanded image"
            onClick={close}
          >
            <button
              type="button"
              className="absolute right-4 top-4 inline-flex size-9 items-center justify-center rounded-md bg-white/10 text-white hover:bg-white/20"
              aria-label="Close"
              onClick={close}
            >
              <X className="size-5" />
            </button>
            <div
              className="flex max-h-full max-w-full items-center justify-center"
              onClick={(e) => e.stopPropagation()}
            >
              {loading ? (
                <div className="text-sm text-white/80">Loading…</div>
              ) : src ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={src}
                  alt={
                    ("name" in block.props &&
                      typeof block.props.name === "string" &&
                      block.props.name) ||
                    "Expanded figure"
                  }
                  className="max-h-[min(92vh,100%)] max-w-[min(96vw,100%)] object-contain shadow-lg"
                />
              ) : (
                <div className="rounded-md bg-white/10 px-4 py-3 text-sm text-white/90">
                  Image unavailable
                </div>
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
