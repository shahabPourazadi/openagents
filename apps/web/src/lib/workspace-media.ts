import { getAuthHeaders } from "@/lib/app-state";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

/** Relative markdown image paths the editor can resolve via the assets API. */
export function isWorkspaceAssetPath(url: string): boolean {
  const path = url.trim().replace(/^\.\//, "");
  return /^(diagrams|other)\//.test(path);
}

/**
 * Find durable asset paths in free text / tool JSON.
 * Matches markdown embeds, backtick paths, and absolute sandbox paths that
 * contain ``…/diagrams/foo.svg``.
 */
export function collectWorkspaceAssetPaths(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const match of text.matchAll(
    /((?:diagrams|other)\/(?:[\w.\- ]+\/)*[\w.\- ]+\.[A-Za-z0-9]+)/g
  )) {
    const path = match[1]?.replace(/\\/g, "/");
    if (path && isWorkspaceAssetPath(path)) found.add(path);
  }
  // Markdown image embeds (covers odd whitespace / ./ prefix).
  for (const match of text.matchAll(
    /!\[[^\]]*\]\(\s*\.?\/?((?:diagrams|other)\/[^)\s]+)\s*\)/g
  )) {
    const path = match[1]?.trim().replace(/\\/g, "/");
    if (path && isWorkspaceAssetPath(path)) found.add(path);
  }
  return [...found];
}

/** True when resolve fell back to the inline “Missing figure” SVG. */
export function isMissingAssetPlaceholder(url: string): boolean {
  return (
    url.startsWith("data:image/svg+xml") &&
    decodeURIComponent(url).includes("Missing figure")
  );
}

/** Placeholder so BlockNote does not crash when an asset is missing (404). */
function missingAssetPlaceholder(path: string): string {
  const label = path.length > 48 ? `${path.slice(0, 45)}…` : path;
  const safe = label.replace(/[<>&'"]/g, "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="160" viewBox="0 0 520 160">
  <rect width="520" height="160" rx="12" fill="#f4f4f5"/>
  <text x="260" y="58" text-anchor="middle" fill="#71717a" font-family="ui-sans-serif,system-ui,sans-serif" font-size="14">Missing figure</text>
  <text x="260" y="84" text-anchor="middle" fill="#a1a1aa" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">${safe}</text>
  <text x="260" y="118" text-anchor="middle" fill="#52525b" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">Click to reload</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Resolve a markdown image src for BlockNote.
 * Relative ``diagrams/…`` / ``other/…`` paths are fetched with auth and turned
 * into blob: URLs (Garage SSE-C cannot use bare <img> GETs).
 * Missing assets return a placeholder instead of throwing (keeps the editor usable).
 */
export async function resolveWorkspaceMediaUrl(
  url: string,
  workspaceId: string | null | undefined
): Promise<string> {
  const trimmed = (url || "").trim();
  if (!trimmed || !workspaceId) return trimmed;
  if (/^(https?:|blob:|data:)/i.test(trimmed)) return trimmed;
  if (!isWorkspaceAssetPath(trimmed)) return trimmed;

  const path = trimmed.replace(/^\.\//, "");
  const q = new URLSearchParams({ path });
  try {
    const res = await fetch(
      `${API_URL}/api/workspaces/${workspaceId}/assets/content?${q}`,
      { headers: getAuthHeaders() }
    );
    if (!res.ok) {
      console.warn(`Workspace asset not found: ${path} (${res.status})`);
      return missingAssetPlaceholder(path);
    }
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  } catch (err) {
    console.warn(`Workspace asset load failed: ${path}`, err);
    return missingAssetPlaceholder(path);
  }
}
