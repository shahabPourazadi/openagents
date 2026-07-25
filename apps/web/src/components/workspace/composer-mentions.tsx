"use client";

import { cn } from "@/lib/utils";
import { formatStyleForChip } from "@/components/workspace/file-format-style";
import {
  AttachmentCardRow,
  type PendingUpload,
} from "@/components/workspace/attachment-cards";
import { skillIconComponent } from "@/lib/agent-icons";

export type MentionKind = "document" | "file" | "skill" | "upload";

export type MentionChip = {
  id: string;
  kind: MentionKind;
  label: string;
  path?: string;
  description?: string;
  /** Lucide icon id for library skills (same catalog as agents). */
  icon?: string;
  /** Byte size when known (uploads). Used for preview gating. */
  size?: number;
};

export type MentionTrigger = "@" | "/";

export type ActiveMention = {
  trigger: MentionTrigger;
  query: string;
  /** Index of the trigger character in the textarea value. */
  start: number;
};

export type MentionOption = MentionChip & {
  searchText: string;
};

/** Fallback when the selected agent has no skills listed yet. */
export const OPENAGENTS_SKILLS: MentionOption[] = [];

/** Build /skill mention options from the active agent's skills. */
export function skillsFromAgent(
  skills:
    | { slug: string; name?: string; content?: string; description?: string; icon?: string }[]
    | undefined
): MentionOption[] {
  if (!skills?.length) return [];
  return skills.map((s) => ({
    id: s.slug,
    kind: "skill" as const,
    label: s.name || s.slug,
    icon: s.icon,
    description:
      s.description ||
      s.content
        ?.split("\n")
        .find((l) => l.trim() && !l.startsWith("#") && !l.startsWith("---"))
        ?.slice(0, 80),
    searchText: `${s.slug} ${s.name || ""} ${s.description || ""}`,
  }));
}

/**
 * Merge library skills with agent-scoped playbooks for the `/` picker.
 * Pass skills from every agent (not only the active one) so the list matches
 * the sidebar Skills inventory.
 */
export function mergeSkillMentionOptions(
  library:
    | { slug: string; name?: string; description?: string; icon?: string }[]
    | undefined,
  agentSkills:
    | { slug: string; name?: string; content?: string; description?: string; icon?: string }[]
    | undefined
): MentionOption[] {
  const byId = new Map<string, MentionOption>();
  for (const opt of skillsFromAgent(agentSkills)) {
    byId.set(opt.id, opt);
  }
  for (const s of library || []) {
    if (!s.slug) continue;
    const prev = byId.get(s.slug);
    byId.set(s.slug, {
      id: s.slug,
      kind: "skill",
      label: s.name || s.slug,
      icon: s.icon || prev?.icon,
      description: s.description || prev?.description,
      searchText: `${s.slug} ${s.name || ""} ${s.description || ""}`,
    });
  }
  return Array.from(byId.values()).sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" })
  );
}

/** Find an active @ or / mention just before the caret. */
export function detectActiveMention(
  value: string,
  cursor: number
): ActiveMention | null {
  const before = value.slice(0, cursor);
  // Trigger must start a token (start of string or whitespace/newline before it).
  const match = before.match(/(^|[\s\n])([@/])([^\s@/]*)$/);
  if (!match) return null;
  const trigger = match[2] as MentionTrigger;
  const query = match[3] ?? "";
  const start = before.length - trigger.length - query.length;
  return { trigger, query, start };
}

export function filterMentionOptions(
  options: MentionOption[],
  query: string
): MentionOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter((o) => {
    const hay = `${o.label} ${o.path ?? ""} ${o.description ?? ""} ${o.searchText}`.toLowerCase();
    return hay.includes(q);
  });
}

export function mentionToken(chip: MentionChip): string {
  if (chip.kind === "skill") return `/${chip.id}`;
  // Prefer path for files/docs so chat shows a stable handle.
  const handle = (chip.path || chip.label).replace(/\s+/g, "_");
  return `@${handle}`;
}

export function applyMentionSelection(
  value: string,
  active: ActiveMention,
  chip: MentionChip
): { nextValue: string; nextCursor: number } {
  const before = value.slice(0, active.start);
  const after = value.slice(active.start + 1 + active.query.length);
  const token = mentionToken(chip);
  // Keep a trailing space so the user can keep typing after the mention.
  const insertion = after.length === 0 || /^\s/.test(after) ? `${token} ` : `${token} `;
  const nextValue = `${before}${insertion}${after.replace(/^\s+/, "")}`;
  const nextCursor = before.length + insertion.length;
  return { nextValue, nextCursor };
}

/** Send payload: clean UI text vs full agent prompt + attachment chips. */
export type FormattedMentions = {
  /** Shown in the user bubble (prompt only). */
  displayText: string;
  /** Sent to the agent (includes skill/file tokens + upload paths). */
  agentText: string;
  attachments: MentionChip[];
};

const UPLOAD_AGENT_HINT =
  "Attached files (use parse_document for PDF/Office/images; read_file for .md/.txt/.csv only — never read_file on image/PNG paths):";

export function truncateLabel(label: string, max = 22): string {
  const name = label.trim();
  if (name.length <= max) return name;
  const extMatch = name.match(/(\.[a-zA-Z0-9]{1,8})$/);
  const ext = extMatch?.[1] ?? "";
  const stem = ext ? name.slice(0, -ext.length) : name;
  const keep = Math.max(6, max - ext.length - 1);
  return `${stem.slice(0, keep)}…${ext}`;
}

function buildUploadBlock(uploads: MentionChip[]): string {
  const lines = uploads.map((u) => `- \`${u.path}\``).join("\n");
  return `${UPLOAD_AGENT_HINT}\n${lines}`;
}

/** Build agent-facing text from a display prompt + attachment chips. */
export function buildAgentTextFromAttachments(
  displayText: string,
  attachments: MentionChip[]
): string {
  const uploads = attachments.filter((c) => c.kind === "upload" && c.path);
  const otherTokens = attachments
    .filter((c) => c.kind !== "upload")
    .map(mentionToken)
    .join(" ");

  let text = displayText.trim();
  if (!text && otherTokens) text = otherTokens;
  else if (text && otherTokens) {
    const hasToken = attachments
      .filter((c) => c.kind !== "upload")
      .some((c) => text.includes(mentionToken(c)));
    if (!hasToken) text = `${text}\n\n${otherTokens}`;
  }
  if (uploads.length) {
    const block = buildUploadBlock(uploads);
    text = text ? `${text}\n\n${block}` : block;
  }
  return text;
}

/** Split composer state into display bubble text vs agent payload. */
export function formatMentionsForSend(
  prompt: string,
  chips: MentionChip[]
): FormattedMentions {
  let displayText = prompt.trim();
  for (const chip of chips) {
    displayText = removeMentionFromText(displayText, chip);
  }
  displayText = displayText.trim();
  const attachments = chips.map((c) => ({ ...c }));
  const agentText = buildAgentTextFromAttachments(prompt.trim() || displayText, attachments);
  // Prefer clean display without duplicated tokens when chips cover them.
  if (!displayText && attachments.length) {
    // Keep empty — UI shows chips only.
  }
  return { displayText, agentText, attachments };
}

/** Recover chips from older messages that inlined the upload block into content. */
export function splitLegacyAttachmentBlock(content: string): {
  displayText: string;
  attachments: MentionChip[];
} {
  const re =
    /\n*\nAttached files \(use parse_document[^)]*\):\n((?:- `[^\n`]+`\n?)+)\s*$/;
  const match = content.match(re);
  if (!match) return { displayText: content, attachments: [] };
  const displayText = content.slice(0, match.index).trimEnd();
  const attachments: MentionChip[] = [];
  for (const line of match[1].split("\n")) {
    const m = line.match(/^- `([^`]+)`/);
    if (!m) continue;
    const path = m[1];
    const filename = path.split("/").pop() || path;
    attachments.push({
      id: path,
      kind: "upload",
      label: filename.includes("-") ? filename.split("-").slice(1).join("-") : filename,
      path,
    });
  }
  return { displayText, attachments };
}

export function removeMentionFromText(
  value: string,
  chip: MentionChip
): string {
  const token = mentionToken(chip);
  return value
    .split(token)
    .join("")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .trimStart();
}

export function ComposerMentionChips({
  chips,
  pending,
  onRemove,
  onSelect,
}: {
  chips: MentionChip[];
  pending?: PendingUpload[];
  onRemove: (id: string) => void;
  onSelect?: (chip: MentionChip) => void;
}) {
  if (!chips.length && !pending?.length) return null;
  return (
    <AttachmentCardRow
      className="px-0.5 pb-0.5"
      chips={chips}
      pending={pending}
      onRemove={onRemove}
      onSelect={onSelect}
    />
  );
}

export function ComposerMentionMenu({
  options,
  activeIndex,
  onSelect,
  onHover,
}: {
  options: MentionOption[];
  activeIndex: number;
  onSelect: (option: MentionOption) => void;
  onHover: (index: number) => void;
}) {
  if (!options.length) {
    return (
      <div className="absolute bottom-full left-0 z-50 mb-2 w-72 rounded-xl border border-border bg-popover p-3 text-xs text-muted-foreground shadow-md">
        No matches
      </div>
    );
  }

  return (
    <div
      className="absolute bottom-full left-0 z-50 mb-2 max-h-56 w-80 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-md"
      role="listbox"
    >
      {options.map((opt, i) => {
        const active = i === activeIndex;
        const style = formatStyleForChip(opt);
        const Icon =
          opt.kind === "skill" ? skillIconComponent(opt.icon) : style.Icon;
        return (
          <button
            key={`${opt.kind}:${opt.id}`}
            type="button"
            role="option"
            aria-selected={active}
            className={cn(
              "flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors",
              active ? "bg-muted" : "hover:bg-muted/70"
            )}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => {
              // Prevent textarea blur before click lands.
              e.preventDefault();
              onSelect(opt);
            }}
          >
            <span
              className={cn(
                "mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md",
                style.iconTile
              )}
            >
              <Icon className="size-3.5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-foreground">
                {opt.label}
              </span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {opt.description ||
                  opt.path ||
                  (opt.kind === "skill" ? `/${opt.id}` : style.label)}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
