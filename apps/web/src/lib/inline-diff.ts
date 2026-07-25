import type { Suggestion } from "@/lib/app-state";
import { markedPatchReplacement } from "@/lib/text-diff";

const SECTION_RE = /^(#{1,6})\s+(.+)$/gm;

/** Deleted span tagged with suggestion id for inline actions. */
export function delMark(text: string, suggestionId: string): string {
  return `⟦DEL:${suggestionId}⟧${text}⟦/DEL⟧`;
}

/** Inserted span tagged with suggestion id. */
export function insMark(text: string, suggestionId: string): string {
  return `⟦INS:${suggestionId}⟧${text}⟦/INS⟧`;
}

/** Action chip anchor placed after a change group. */
export function actMark(suggestionId: string): string {
  return `⟦ACT:${suggestionId}⟧`;
}

function rewriteSectionPreview(
  content: string,
  heading: string,
  newBody: string,
  suggestionId: string
): string | null {
  const matches = [...content.matchAll(SECTION_RE)];
  let targetIndex = -1;
  let targetMatch: RegExpMatchArray | null = null;
  for (let i = 0; i < matches.length; i++) {
    if (matches[i][2].trim().toLowerCase() === heading.trim().toLowerCase()) {
      targetIndex = i;
      targetMatch = matches[i];
      break;
    }
  }
  if (!targetMatch || targetMatch.index === undefined) return null;

  const level = targetMatch[1].length;
  const headingEnd = targetMatch.index + targetMatch[0].length;
  let end = content.length;
  for (let j = targetIndex + 1; j < matches.length; j++) {
    if (matches[j][1].length <= level && matches[j].index !== undefined) {
      end = matches[j].index!;
      break;
    }
  }

  const oldBody = content.slice(headingEnd, end).replace(/^\n+/, "").replace(/\n+$/, "");
  const replacement =
    targetMatch[0] +
    "\n\n" +
    (oldBody ? delMark(oldBody, suggestionId) + "\n\n" : "") +
    insMark(newBody.trim(), suggestionId) +
    actMark(suggestionId) +
    "\n\n";

  return content.slice(0, targetMatch.index) + replacement + content.slice(end).replace(/^\n+/, "");
}

/**
 * Build a preview string with inline del/ins markers + action anchors for pending suggestions.
 */
export function buildInlineDiffPreview(content: string, suggestions: Suggestion[]): string {
  let result = content;
  for (const s of suggestions) {
    if (s.status !== "pending") continue;

    if (s.kind === "patch" && s.old_text) {
      if (!result.includes(s.old_text)) continue;
      result = result.replace(
        s.old_text,
        markedPatchReplacement(
          s.old_text,
          s.new_text,
          s.id,
          delMark,
          insMark,
          actMark
        )
      );
    } else if (s.kind === "section" && s.section_heading) {
      const next = rewriteSectionPreview(result, s.section_heading, s.new_text, s.id);
      if (next) result = next;
    } else if (s.kind === "full") {
      result =
        (result.trim() ? delMark(result.trim(), s.id) + "\n\n" : "") +
        insMark(s.new_text.trim(), s.id) +
        actMark(s.id);
    } else if (s.kind === "patch" && !s.old_text && s.new_text) {
      // Pure insert
      result = result + (result.endsWith("\n") ? "" : "\n") + insMark(s.new_text, s.id) + actMark(s.id);
    }
  }
  return result;
}

export type DiffPart =
  | { type: "text"; text: string }
  | { type: "del"; text: string; suggestionId: string }
  | { type: "ins"; text: string; suggestionId: string }
  | { type: "act"; suggestionId: string };

export function splitMarkers(input: string): DiffPart[] {
  const re = /⟦(DEL|INS):([^⟧]+)⟧([\s\S]*?)⟦\/\1⟧|⟦ACT:([^⟧]+)⟧/g;
  const parts: DiffPart[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    if (m.index > last) {
      parts.push({ type: "text", text: input.slice(last, m.index) });
    }
    if (m[4]) {
      parts.push({ type: "act", suggestionId: m[4] });
    } else if (m[1] === "DEL") {
      parts.push({ type: "del", text: m[3], suggestionId: m[2] });
    } else if (m[1] === "INS") {
      parts.push({ type: "ins", text: m[3], suggestionId: m[2] });
    }
    last = m.index + m[0].length;
  }
  if (last < input.length) {
    parts.push({ type: "text", text: input.slice(last) });
  }
  return parts.length ? parts : [{ type: "text", text: input }];
}
