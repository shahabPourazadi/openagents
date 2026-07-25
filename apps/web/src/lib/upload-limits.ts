/** Client-side gates matching apps/api `openagents_api.uploads` (server is source of truth). */

export const MAX_UPLOAD_BYTES = 40 * 1024 * 1024; // 40 MB

/** Skip inline preview above this size (still downloadable). */
export const MAX_PREVIEW_BYTES = 200 * 1024; // 200 KB

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(2)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

export const ALLOWED_UPLOAD_EXTENSIONS = new Set([
  ".pdf",
  ".docx",
  ".doc",
  ".xlsx",
  ".xls",
  ".pptx",
  ".ppt",
  ".odt",
  ".ods",
  ".odp",
  ".png",
  ".jpg",
  ".jpeg",
  ".tif",
  ".tiff",
  ".webp",
  ".gif",
  ".bmp",
  ".md",
  ".markdown",
  ".txt",
  ".csv",
]);

/** Value for `<input type="file" accept=…>`. */
export const UPLOAD_ACCEPT =
  ".pdf,.docx,.doc,.xlsx,.xls,.pptx,.ppt,.odt,.ods,.odp,.png,.jpg,.jpeg,.tif,.tiff,.webp,.gif,.bmp,.md,.markdown,.txt,.csv";

export function uploadExtension(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "";
  return base.slice(dot).toLowerCase();
}

export function validateUploadFile(file: File): string | null {
  const ext = uploadExtension(file.name);
  if (!ext || !ALLOWED_UPLOAD_EXTENSIONS.has(ext)) {
    return (
      `"${file.name}" is not a supported type. Allowed: PDF, DOCX, XLSX, PPTX, ODF, images, Markdown, TXT, and CSV.`
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return `"${file.name}" is too large (max ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB).`;
  }
  if (file.size === 0) {
    return `"${file.name}" is empty.`;
  }
  return null;
}
