"use client";

import { useEffect, useState } from "react";
import {
  Code2,
  FileSearch,
  FileText,
  Globe,
  Hammer,
  List,
  Pencil,
  Search,
  Sparkles,
  XCircle,
} from "lucide-react";
import { TextShimmer } from "@/components/ui/text-shimmer";
import {
  Source,
  SourceContent,
  SourceTrigger,
} from "@/components/ui/source";
import {
  Steps,
  StepsBar,
  StepsContent,
  StepsItem,
  StepsTrigger,
} from "@/components/ui/steps";
import type { ToolPart } from "@/components/ui/tool";
import {
  isToolMediaGallerySource,
  looksLikeImageGenerationTool,
  ToolMediaGallery,
} from "@/components/workspace/tool-media-gallery";
import { useApp, type ChatToolPart } from "@/lib/app-state";
import { parseToolMedia } from "@/lib/tool-media";
import { cn } from "@/lib/utils";
export type WebSource = {
  href: string;
  title: string;
  description: string;
  label?: string;
};

const WORKING_PHASES = [
  "Thinking…",
  "Planning next steps…",
  "Gathering context…",
  "Reviewing the document…",
  "Working…",
] as const;

const TOOL_LABELS: Record<string, string> = {
  suggest_patch: "Editing the document",
  suggest_section_rewrite: "Updating a section",
  suggest_full_document: "Drafting the document",
  read_workspace_file: "Reading a file",
  list_workspace_files: "Browsing files",
  write_workspace_file: "Writing a workspace file",
  run_code_interpreter: "Running code",
  delegate_research: "Researching",
  delegate_technical_writer: "Drafting with technical writer",
  ask_user: "Asking a clarifying question",
  list_skills: "Checking skills",
  load_skill: "Loading a skill",
  add_todo: "Adding a task",
  write_todos: "Updating the task list",
  read_todos: "Reading tasks",
  update_todo_status: "Updating a task",
  remove_todo: "Removing a task",
  add_subtask: "Adding a subtask",
  set_dependency: "Linking tasks",
  get_available_tasks: "Checking ready tasks",
  web_search: "Searching the web",
  web_search_tool: "Searching the web",
  duckduckgo_search: "Searching the web",
  web_search_duckduckgo: "Searching the web",
  firecrawl_search: "Searching the web",
  firecrawl_scrape: "Reading a page",
  firecrawl_crawl: "Crawling pages",
  firecrawl_map: "Mapping a site",
  firecrawl_extract: "Extracting page data",
  firecrawl_batch_scrape: "Reading pages",
  generate_image: "Generating an image",
  generate_images: "Generating images",
};

function normalizeToolKey(type: string): string {
  const bare = type.includes("|") ? (type.split("|").pop() ?? type) : type;
  return bare
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

function strField(input: Record<string, unknown> | undefined, ...keys: string[]) {
  if (!input) return undefined;
  for (const key of keys) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/** Pull a (possibly incomplete) JSON string value for `key` from streaming args text. */
function extractPartialString(source: string, key: string): string | undefined {
  const marker = `"${key}"`;
  const keyIdx = source.indexOf(marker);
  if (keyIdx < 0) return undefined;
  const afterKey = source.slice(keyIdx + marker.length);
  const colon = afterKey.match(/^\s*:\s*"/);
  if (!colon) return undefined;
  const raw = afterKey.slice(colon[0].length);
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\\") {
      const next = raw[i + 1];
      if (next == null) break;
      if (next === "n") out += "\n";
      else if (next === "t") out += "\t";
      else if (next === "r") out += "\r";
      else if (next === '"') out += '"';
      else if (next === "\\") out += "\\";
      else if (next === "/") out += "/";
      else if (next === "u" && /^[0-9a-fA-F]{4}/.test(raw.slice(i + 2, i + 6))) {
        out += String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16));
        i += 5;
        continue;
      } else out += next;
      i++;
      continue;
    }
    if (ch === '"') break;
    out += ch;
  }
  return out;
}

function toolArgsSource(tool: ToolPart | ChatToolPart): string | undefined {
  const withArgs = tool as ToolPart & { argsText?: string };
  if (typeof withArgs.argsText === "string" && withArgs.argsText) return withArgs.argsText;
  const partial = tool.input?._partial;
  if (typeof partial === "string" && partial) return partial;
  return undefined;
}

function toolField(tool: ToolPart | ChatToolPart, ...keys: string[]): string | undefined {
  const fromInput = strField(tool.input, ...keys);
  if (fromInput) return fromInput;
  const source = toolArgsSource(tool);
  if (!source) return undefined;
  for (const key of keys) {
    const partial = extractPartialString(source, key);
    if (partial) return partial;
  }
  return undefined;
}

function isWebSearchTool(key: string): boolean {
  return (
    key === "web_search" ||
    key === "web_search_tool" ||
    key === "duckduckgo_search" ||
    key === "web_search_duckduckgo" ||
    key === "firecrawl_search" ||
    key === "firecrawl_scrape" ||
    key === "firecrawl_crawl" ||
    key === "firecrawl_map" ||
    key === "firecrawl_batch_scrape" ||
    key === "firecrawl_extract" ||
    key === "delegate_research"
  );
}

function unwrapToolResult(output: Record<string, unknown> | undefined): unknown {
  if (output == null) return undefined;
  if ("result" in output) return (output as { result: unknown }).result;
  return output;
}

function tryParseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function hostnameLabel(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return href;
  }
}

function sourceFromRecord(item: Record<string, unknown>): WebSource | null {
  const href =
    (typeof item.url === "string" && item.url) ||
    (typeof item.href === "string" && item.href) ||
    (typeof item.link === "string" && item.link) ||
    (typeof item.sourceURL === "string" && item.sourceURL) ||
    "";
  if (!href.startsWith("http")) return null;

  const meta =
    item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
      ? (item.metadata as Record<string, unknown>)
      : undefined;

  const title =
    (typeof item.title === "string" && item.title.trim()) ||
    (typeof meta?.title === "string" && meta.title.trim()) ||
    (typeof item.name === "string" && item.name.trim()) ||
    hostnameLabel(href);

  const description =
    (typeof item.description === "string" && item.description.trim()) ||
    (typeof item.snippet === "string" && item.snippet.trim()) ||
    (typeof item.summary === "string" && item.summary.trim()) ||
    (typeof meta?.description === "string" && meta.description.trim()) ||
    (typeof item.markdown === "string" && item.markdown.trim().slice(0, 180)) ||
    (typeof item.content === "string" && item.content.trim().slice(0, 180)) ||
    href;

  return {
    href,
    title,
    description,
    label: hostnameLabel(href),
  };
}

function collectSourcesFromValue(value: unknown, into: WebSource[], seen: Set<string>) {
  const parsed = tryParseJson(value);
  if (parsed == null) return;

  if (Array.isArray(parsed)) {
    for (const item of parsed) collectSourcesFromValue(item, into, seen);
    return;
  }

  if (typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    // MCP tool payloads often wrap JSON in { type: "text", text: "..." }
    if (typeof obj.text === "string" && (obj.type === "text" || obj.type == null)) {
      collectSourcesFromValue(obj.text, into, seen);
    }
    const direct = sourceFromRecord(obj);
    if (direct && !seen.has(direct.href)) {
      seen.add(direct.href);
      into.push(direct);
    }
    for (const key of [
      "data",
      "web",
      "results",
      "organic",
      "sources",
      "links",
      "pages",
      "content",
    ]) {
      if (key in obj) collectSourcesFromValue(obj[key], into, seen);
    }
    return;
  }

  if (typeof parsed === "string") {
    // Markdown links: [title](url)
    const mdLink = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = mdLink.exec(parsed)) !== null) {
      const href = m[2];
      if (seen.has(href)) continue;
      seen.add(href);
      into.push({
        href,
        title: m[1].trim() || hostnameLabel(href),
        description: href,
        label: hostnameLabel(href),
      });
    }
    // Bare URLs (skip ones already captured via markdown)
    const bare = /https?:\/\/[^\s<>)"'\]]+/g;
    while ((m = bare.exec(parsed)) !== null) {
      const href = m[0].replace(/[.,;:]+$/, "");
      if (seen.has(href)) continue;
      seen.add(href);
      into.push({
        href,
        title: hostnameLabel(href),
        description: href,
        label: hostnameLabel(href),
      });
    }
  }
}

/** Pull citation chips from Firecrawl / search / research tool I/O. */
export function extractWebSources(tool: ToolPart | ChatToolPart): WebSource[] {
  const key = normalizeToolKey(tool.type);
  if (!isWebSearchTool(key)) return [];

  const into: WebSource[] = [];
  const seen = new Set<string>();

  // Input URL while scraping/crawling (show early).
  const inputUrl = toolField(tool, "url", "urls");
  if (inputUrl?.startsWith("http") && !seen.has(inputUrl)) {
    seen.add(inputUrl);
    into.push({
      href: inputUrl,
      title: hostnameLabel(inputUrl),
      description: inputUrl,
      label: hostnameLabel(inputUrl),
    });
  }

  collectSourcesFromValue(unwrapToolResult(tool.output), into, seen);
  collectSourcesFromValue(tool.output, into, seen);

  return into.slice(0, 12);
}

function toolTitle(tool: ToolPart | ChatToolPart): string {
  const key = normalizeToolKey(tool.type);

  if (key === "read_workspace_file") {
    const path = toolField(tool, "relative_path", "path", "file");
    return path ? `Reading ${basename(path)}` : "Reading a file";
  }
  // Prefer "Web search: {query}" when we know the query.
  if (
    key === "web_search" ||
    key === "web_search_tool" ||
    key === "duckduckgo_search" ||
    key === "web_search_duckduckgo" ||
    key === "firecrawl_search"
  ) {
    const q = toolField(tool, "query", "q", "search");
    if (q) {
      const short = q.length > 64 ? `${q.slice(0, 61)}…` : q;
      return `Web search: ${short}`;
    }
    return "Searching the web";
  }
  if (key === "firecrawl_scrape" || key === "firecrawl_batch_scrape") {
    return "Reading a page";
  }
  if (key === "firecrawl_crawl") {
    return "Crawling pages";
  }
  if (key === "firecrawl_map") {
    return "Mapping a site";
  }
  if (key === "suggest_section_rewrite") {
    const heading = toolField(tool, "section_heading", "heading");
    return heading ? `Updating ${heading}` : "Updating a section";
  }
  if (key === "delegate_research") {
    return "Researching";
  }
  if (key === "delegate_technical_writer") {
    const step = toolField(tool, "step_id");
    return step ? `Drafting ${step}` : "Drafting with technical writer";
  }
  if (key === "load_skill") {
    const name = toolField(tool, "name");
    return name ? `Loading skill ${name}` : "Loading a skill";
  }
  if (key === "suggest_patch") return "Editing the document";
  if (key === "suggest_full_document") return "Drafting the document";
  if (key === "list_workspace_files") return "Browsing files";
  if (key === "run_code_interpreter") return "Running code";
  if (key === "list_skills") return "Checking skills";

  if (TOOL_LABELS[key]) return TOOL_LABELS[key];
  const words = key.replace(/_/g, " ").trim();
  if (!words || words === "tool") return "Working";
  return words.replace(/\b\w/g, (c) => c.toUpperCase());
}

function toolIcon(tool: ToolPart | ChatToolPart) {
  const className = "size-3.5";
  if (tool.state === "output-error") {
    return <XCircle className={cn(className, "text-red-500")} />;
  }
  const key = normalizeToolKey(tool.type);
  if (key === "read_workspace_file") return <FileText className={className} />;
  if (key === "list_workspace_files") return <List className={className} />;
  if (key.includes("search") || key.includes("grep")) return <Search className={className} />;
  if (key === "run_code_interpreter") return <Code2 className={className} />;
  if (key === "delegate_research") return <Globe className={className} />;
  if (key.startsWith("suggest_")) return <Pencil className={className} />;
  if (key.includes("skill")) return <Sparkles className={className} />;
  if (key.includes("list") || key.includes("file")) return <FileSearch className={className} />;
  return <Hammer className={className} />;
}

function isToolRunning(tool: ToolPart | ChatToolPart): boolean {
  return tool.state === "input-streaming" || tool.state === "input-available";
}

function formatToolOutput(output: Record<string, unknown> | undefined): string {
  if (output == null) return "";
  const result =
    typeof output === "object" && "result" in output
      ? (output as { result: unknown }).result
      : output;
  if (typeof result === "string") {
    // Guard against accidental base64/BinaryContent dumps in the activity UI.
    if (
      result.length > 8_000 &&
      (result.includes('"media_type"') || result.includes("iVBOR"))
    ) {
      return "[Image/binary tool result omitted from display.]";
    }
    return result;
  }
  if (result == null) return "";
  const serialized = JSON.stringify(result, null, 2);
  if (
    serialized.length > 8_000 &&
    (serialized.includes('"media_type"') || serialized.includes('"data"'))
  ) {
    return "[Image/binary tool result omitted from display.]";
  }
  return serialized;
}

/** Suggest tools already show their payload in the input fields — skip the short queue ack. */
const SKIP_OUTPUT_KEYS = new Set([
  "suggest_patch",
  "suggest_section_rewrite",
  "suggest_full_document",
]);

function toolDetailLines(tool: ToolPart | ChatToolPart): string[] {
  const lines: string[] = [];
  const key = normalizeToolKey(tool.type);
  const output = tool.output;
  const running = isToolRunning(tool);
  const progress = (tool as ToolPart & { progress?: string[] }).progress;
  const sources = extractWebSources(tool);
  const hasSources = sources.length > 0;
  const media = parseToolMedia(output);

  if (key === "suggest_patch") {
    const oldText = toolField(tool, "old_text");
    const newText = toolField(tool, "new_text");
    if (oldText) lines.push(`Replace “${oldText}”`);
    if (newText) lines.push(`With “${newText}”`);
  } else if (key === "suggest_section_rewrite") {
    const heading = toolField(tool, "section_heading", "heading");
    const body = toolField(tool, "new_body", "new_text");
    if (heading) lines.push(`Section: ${heading}`);
    if (body) lines.push(body);
  } else if (key === "suggest_full_document") {
    const md = toolField(tool, "new_markdown", "new_text");
    if (md) lines.push(md);
  } else if (key === "run_code_interpreter") {
    const code = toolField(tool, "code");
    if (code) lines.push(code);
  } else if (key === "read_workspace_file") {
    const path = toolField(tool, "relative_path", "path", "file");
    if (path) lines.push(path);
  } else if (
    key === "web_search" ||
    key === "web_search_tool" ||
    key === "duckduckgo_search" ||
    key === "web_search_duckduckgo" ||
    key === "firecrawl_search"
  ) {
    // Query is shown in the Steps trigger; keep details for progress/results only.
  } else if (
    key === "firecrawl_scrape" ||
    key === "firecrawl_crawl" ||
    key === "firecrawl_map" ||
    key === "firecrawl_batch_scrape"
  ) {
    // URL shown as Source chips when available.
    if (!hasSources) {
      const url = toolField(tool, "url", "urls");
      if (url) lines.push(url);
    }
  } else if (key === "delegate_research") {
    const topic = toolField(tool, "topic");
    if (topic) lines.push(topic);
  }

  // Live progress from nested research / mid-tool CustomEvents.
  if (running && progress?.length) {
    for (const line of progress) {
      if (line && !lines.includes(line)) lines.push(line);
    }
  } else if (running && key === "delegate_research" && lines.length > 0) {
    // Topic known but no progress event yet — show that search is underway.
    lines.push("Searching the web…");
  }

  // While args are still streaming and we haven't decoded a known field yet,
  // show the raw growing payload instead of a generic "In progress…".
  if (running && lines.length === 0 && !hasSources) {
    const source = toolArgsSource(tool);
    if (source?.trim()) lines.push(source.trim());
  }

  if (tool.state === "output-error" && tool.errorText) {
    lines.push(tool.errorText);
  } else if (media.images.length > 0 || media.files.length > 0) {
    if (media.text && !lines.includes(media.text)) lines.push(media.text);
  } else if (
    output != null &&
    !running &&
    !SKIP_OUTPUT_KEYS.has(key) &&
    // Prefer Source chips over dumping raw Firecrawl / search JSON.
    !(
      hasSources &&
      (key.startsWith("firecrawl_") ||
        key === "web_search" ||
        key === "web_search_tool" ||
        key === "duckduckgo_search" ||
        key === "web_search_duckduckgo")
    )
  ) {
    const text = formatToolOutput(output).trim();
    if (text && !lines.includes(text)) lines.push(text);
  }

  return lines;
}

/** Rotating shimmer label while waiting for the first model tokens/tools. */
export function WorkingShimmer({ className }: { className?: string }) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => {
      setIndex((i) => (i + 1) % WORKING_PHASES.length);
    }, 2400);
    return () => window.clearInterval(id);
  }, []);

  return (
    <TextShimmer
      as="span"
      duration={1.2}
      className={cn("font-sans! text-[15px]! leading-[1.6]! font-normal", className)}
    >
      {WORKING_PHASES[index]}
    </TextShimmer>
  );
}

function ShimmerLabel({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <TextShimmer
      as="span"
      duration={1.2}
      className={cn("font-sans! text-[15px]! leading-[1.6]! font-normal", className)}
    >
      {text}
    </TextShimmer>
  );
}

type ToolStepsProps = {
  tools: (ToolPart | ChatToolPart)[];
  /** Keep open and shimmer the active tool while streaming. */
  isStreaming?: boolean;
  className?: string;
};

/** prompt-kit Steps: one block for a single tool, or a grouped list of expandable sub-tools. */
export function ToolSteps({ tools, isStreaming = false, className }: ToolStepsProps) {
  if (!tools.length) return null;

  if (tools.length === 1) {
    return (
      <div className={cn("not-typeset w-full max-w-xl", className)}>
        <ToolStepItem tool={tools[0]} />
      </div>
    );
  }

  return (
    <ToolStepsGroup tools={tools} isStreaming={isStreaming} className={className} />
  );
}

function ToolStepItem({
  tool,
  nested = false,
}: {
  tool: ToolPart | ChatToolPart;
  nested?: boolean;
}) {
  const { workspace, refreshWorkspaceAssets } = useApp();
  const running = isToolRunning(tool);
  const failed = tool.state === "output-error";
  const [open, setOpen] = useState(running || failed);
  const title = toolTitle(tool);
  const details = toolDetailLines(tool);
  const sources = extractWebSources(tool);
  const media = parseToolMedia(tool.output);
  const key = normalizeToolKey(tool.type);
  const isSearch =
    key === "web_search" ||
    key === "web_search_tool" ||
    key === "duckduckgo_search" ||
    key === "web_search_duckduckgo" ||
    key === "firecrawl_search";
  const showWebUi = isWebSearchTool(key) && (sources.length > 0 || isSearch || running);
  const gallerySource = isToolMediaGallerySource(tool.type);
  const showMediaLoading =
    running && looksLikeImageGenerationTool(tool.type) && media.images.length === 0;
  const showMedia =
    Boolean(workspace?.id) &&
    gallerySource &&
    (media.images.length > 0 || media.files.length > 0 || showMediaLoading);

  // Auto open while active; keep failed tools open so the error is visible.
  useEffect(() => {
    setOpen(running || failed);
  }, [running, failed]);

  const mediaImagesKey = media.images.join("\0");
  const mediaFilesKey = media.files.join("\0");
  const hasToolMedia = media.images.length > 0 || media.files.length > 0;

  useEffect(() => {
    if (hasToolMedia) {
      void refreshWorkspaceAssets();
    }
  }, [hasToolMedia, mediaImagesKey, mediaFilesKey, refreshWorkspaceAssets]);

  const hasBody =
    details.length > 0 || sources.length > 0 || (running && isSearch) || showMedia;

  return (
    <Steps open={open} onOpenChange={setOpen} defaultOpen={false}>
      <StepsTrigger
        leftIcon={toolIcon(tool)}
        swapIconOnHover={!running}
        className={nested ? "text-sm!" : undefined}
      >
        {running ? (
          <ShimmerLabel text={title} className={nested ? "text-sm!" : undefined} />
        ) : failed ? (
          <span className={cn("text-red-600 dark:text-red-400", nested && "text-sm!")}>
            {title} failed
          </span>
        ) : (
          title
        )}
      </StepsTrigger>
      {hasBody ? (
        <StepsContent bar={<StepsBar className="mr-2 ml-1.5" />}>
          <div className="space-y-2">
            {showWebUi && running && sources.length === 0 ? (
              <StepsItem>Searching across curated sources…</StepsItem>
            ) : null}

            {showMedia && workspace?.id ? (
              <ToolMediaGallery
                workspaceId={workspace.id}
                images={media.images}
                files={media.files}
                loading={showMediaLoading}
              />
            ) : null}

            {details.map((line, i) => (
              <StepsItem key={`d-${i}`} className="whitespace-pre-wrap break-words">
                {line}
              </StepsItem>
            ))}

            {sources.length > 0 ? (
              <>
                {isSearch || key === "delegate_research" ? (
                  <StepsItem>Top matches</StepsItem>
                ) : null}
                <div className="flex flex-wrap gap-1.5">
                  {sources.map((s) => (
                    <Source key={s.href} href={s.href}>
                      <SourceTrigger label={s.label} showFavicon />
                      <SourceContent title={s.title} description={s.description} />
                    </Source>
                  ))}
                </div>
                {running && isSearch ? (
                  <StepsItem>Extracting key sections and summarizing…</StepsItem>
                ) : null}
              </>
            ) : null}
          </div>
        </StepsContent>
      ) : null}
    </Steps>
  );
}

function ToolStepsGroup({
  tools,
  isStreaming = false,
  className,
}: {
  tools: (ToolPart | ChatToolPart)[];
  isStreaming?: boolean;
  className?: string;
}) {
  const anyRunning = tools.some(isToolRunning);
  const stageOpen = anyRunning || isStreaming;
  const [open, setOpen] = useState(stageOpen);

  useEffect(() => {
    setOpen(stageOpen);
  }, [stageOpen]);

  const active = [...tools].reverse().find(isToolRunning) ?? tools[tools.length - 1];
  const triggerLabel = anyRunning ? toolTitle(active) : `${tools.length} steps`;

  return (
    <div className={cn("not-typeset w-full max-w-xl", className)}>
      <Steps open={open} onOpenChange={setOpen} defaultOpen={false}>
        <StepsTrigger leftIcon={<Hammer className="size-3.5" />} swapIconOnHover={!anyRunning}>
          {anyRunning ? <ShimmerLabel text={triggerLabel} /> : triggerLabel}
        </StepsTrigger>
        <StepsContent bar={<StepsBar className="mr-2 ml-1.5" />}>
          <div className="space-y-2">
            {tools.map((tool, i) => (
              <ToolStepItem
                key={tool.toolCallId || `${tool.type}-${i}`}
                tool={tool}
                nested
              />
            ))}
          </div>
        </StepsContent>
      </Steps>
    </div>
  );
}
