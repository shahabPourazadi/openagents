/** Parse tool-output media metadata for chat galleries (no base64). */

export type ToolMedia = {
  images: string[];
  files: string[];
  text?: string;
};

const ASSET_PATH_RE =
  /(?:diagrams|other)\/(?:[\w.\- ]+\/)*[\w.\- ]+\.[A-Za-z0-9]+/g;

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "tif",
  "tiff",
]);

function isAssetPath(value: string): boolean {
  return /^(diagrams|other)\//.test(value.trim().replace(/^\.\//, ""));
}

function classifyPath(path: string, images: string[], files: string[]) {
  const normalized = path.trim().replace(/^\.\//, "").replace(/\\/g, "/");
  if (!isAssetPath(normalized)) return;
  const ext = normalized.split(".").pop()?.toLowerCase() ?? "";
  const target = IMAGE_EXTS.has(ext) ? images : files;
  if (!target.includes(normalized)) target.push(normalized);
}

function walk(
  value: unknown,
  images: string[],
  files: string[],
  texts: string[]
) {
  if (value == null) return;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 4_000) return;
    if (trimmed.includes("iVBOR") || trimmed.startsWith("data:image")) return;

    if (isAssetPath(trimmed)) {
      classifyPath(trimmed, images, files);
      return;
    }

    const matches = [...trimmed.matchAll(ASSET_PATH_RE)].map((m) => m[0]);
    if (matches.length) {
      for (const path of matches) classifyPath(path, images, files);
      return;
    }

    if (trimmed.length < 500 && !texts.includes(trimmed)) texts.push(trimmed);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) walk(item, images, files, texts);
    return;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.images)) {
      for (const item of obj.images) {
        if (typeof item === "string") classifyPath(item, images, files);
      }
    }
    if (Array.isArray(obj.files)) {
      for (const item of obj.files) {
        if (typeof item === "string") classifyPath(item, images, files);
      }
    }
    if (typeof obj.text === "string" && obj.text.trim()) {
      const t = obj.text.trim();
      if (!texts.includes(t)) texts.push(t);
    }
    for (const [key, child] of Object.entries(obj)) {
      if (
        key === "images" ||
        key === "files" ||
        key === "text" ||
        key === "data" ||
        key === "blob" ||
        key === "media_type" ||
        key === "mimeType" ||
        key === "mime_type"
      ) {
        continue;
      }
      walk(child, images, files, texts);
    }
  }
}

export function parseToolMedia(output: unknown): ToolMedia {
  const images: string[] = [];
  const files: string[] = [];
  const texts: string[] = [];
  walk(output, images, files, texts);
  return {
    images,
    files,
    ...(texts.length ? { text: texts.join("\n") } : {}),
  };
}

function normalizeToolTypeKey(toolType: string): string {
  const bare = toolType.includes("|")
    ? (toolType.split("|").pop() ?? toolType)
    : toolType;
  return bare
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

export function looksLikeImageGenerationTool(toolType: string): boolean {
  const key = normalizeToolTypeKey(toolType);
  return (
    key.includes("generate_image") ||
    key.includes("image_gen") ||
    key.includes("flux") ||
    (key.includes("image") &&
      (key.includes("generate") || key.includes("create") || key.includes("draw")))
  );
}

/** read_file / vision re-reads — must not feed the generation gallery. */
export function looksLikeFileReadTool(toolType: string): boolean {
  const key = normalizeToolTypeKey(toolType);
  if (key === "read_file" || key === "read_workspace_file" || key === "read_resource") {
    return true;
  }
  return key.startsWith("read_") && key.includes("file");
}

/** Tools whose outputs should contribute paths to the chat image gallery. */
export function isToolMediaGallerySource(toolType: string): boolean {
  return !looksLikeFileReadTool(toolType);
}

/** Merge media from several tool outputs / free-text path mentions (deduped). */
export function mergeToolMedia(...parts: Array<ToolMedia | unknown>): ToolMedia {
  const images: string[] = [];
  const files: string[] = [];
  const texts: string[] = [];
  for (const part of parts) {
    const media =
      part &&
      typeof part === "object" &&
      ("images" in (part as object) || "files" in (part as object))
        ? (part as ToolMedia)
        : parseToolMedia(part);
    for (const path of media.images ?? []) classifyPath(path, images, files);
    for (const path of media.files ?? []) classifyPath(path, images, files);
    if (media.text?.trim() && !texts.includes(media.text.trim())) {
      texts.push(media.text.trim());
    }
  }
  return {
    images,
    files,
    ...(texts.length ? { text: texts.join("\n") } : {}),
  };
}
