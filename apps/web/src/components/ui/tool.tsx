"use client"

import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import {
  CheckCircle,
  ChevronDown,
  Loader2,
  Settings,
  XCircle,
} from "lucide-react"
import { useState } from "react"

export type ToolPart = {
  type: string
  state:
    | "input-streaming"
    | "input-available"
    | "output-available"
    | "output-error"
  input?: Record<string, unknown>
  output?: Record<string, unknown>
  toolCallId?: string
  errorText?: string
}

export type ToolProps = {
  toolPart: ToolPart
  defaultOpen?: boolean
  className?: string
}

/** End-user labels for agent / builtin tool names. */
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
}

function normalizeToolKey(type: string): string {
  // Builtin ids may look like: pyd_ai_builtin|openrouter|web_search
  const bare = type.includes("|") ? (type.split("|").pop() ?? type) : type
  return bare
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase()
}

function friendlyToolName(type: string): string {
  const key = normalizeToolKey(type)
  if (TOOL_LABELS[key]) return TOOL_LABELS[key]
  // Fallback: "some_tool_name" → "Some tool name"
  const words = key.replace(/_/g, " ").trim()
  if (!words || words === "tool") return "Working"
  return words.replace(/\b\w/g, (c) => c.toUpperCase())
}

const Tool = ({ toolPart, defaultOpen = false, className }: ToolProps) => {
  const [isOpen, setIsOpen] = useState(defaultOpen)

  const { state, input, output, toolCallId } = toolPart
  const label = friendlyToolName(toolPart.type)

  const getStateIcon = () => {
    switch (state) {
      case "input-streaming":
        return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
      case "input-available":
        return <Settings className="h-4 w-4 text-orange-500" />
      case "output-available":
        return <CheckCircle className="h-4 w-4 text-green-500" />
      case "output-error":
        return <XCircle className="h-4 w-4 text-red-500" />
      default:
        return <Settings className="text-muted-foreground h-4 w-4" />
    }
  }

  const getStateBadge = () => {
    const baseClasses = "px-2 py-1 rounded-full text-xs font-medium"
    switch (state) {
      case "input-streaming":
        return (
          <span
            className={cn(
              baseClasses,
              "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
            )}
          >
            Processing
          </span>
        )
      case "input-available":
        return (
          <span
            className={cn(
              baseClasses,
              "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400"
            )}
          >
            Ready
          </span>
        )
      case "output-available":
        return (
          <span
            className={cn(
              baseClasses,
              "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
            )}
          >
            Completed
          </span>
        )
      case "output-error":
        return (
          <span
            className={cn(
              baseClasses,
              "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
            )}
          >
            Error
          </span>
        )
      default:
        return (
          <span
            className={cn(
              baseClasses,
              "bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400"
            )}
          >
            Pending
          </span>
        )
    }
  }

  const formatValue = (value: unknown): string => {
    if (value === null) return "null"
    if (value === undefined) return "undefined"
    if (typeof value === "string") {
      if (
        value.length > 8_000 &&
        (value.includes('"media_type"') || value.includes("iVBOR"))
      ) {
        return "[Image/binary tool result omitted from display.]"
      }
      return value
    }
    if (typeof value === "object") {
      const serialized = JSON.stringify(value, null, 2)
      if (
        serialized.length > 8_000 &&
        (serialized.includes('"media_type"') || serialized.includes('"data"'))
      ) {
        return "[Image/binary tool result omitted from display.]"
      }
      return serialized
    }
    return String(value)
  }

  return (
    <div
      className={cn(
        "border-border mt-3 overflow-hidden rounded-lg border",
        className
      )}
    >
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger render={<Button variant="ghost" className="bg-background h-auto w-full justify-between rounded-b-none px-3 py-2 font-normal" />}><div className="flex min-w-0 items-center gap-2">
                            {getStateIcon()}
                            <span className="truncate text-sm font-medium">
                              {label}
                            </span>
                            {getStateBadge()}
                          </div><ChevronDown className={cn("h-4 w-4 shrink-0", isOpen && "rotate-180")} /></CollapsibleTrigger>
        <CollapsibleContent
          className={cn(
            "border-border border-t",
            "data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden"
          )}
        >
          <div className="bg-background space-y-3 p-3">
            {input && Object.keys(input).length > 0 && (
              <div>
                <h4 className="text-muted-foreground mb-2 text-sm font-medium">
                  Input
                </h4>
                <div className="bg-muted/40 max-h-60 overflow-auto rounded border p-2 font-mono text-xs">
                  <pre className="whitespace-pre-wrap wrap-break-word">
                    {JSON.stringify(input, null, 2)}
                  </pre>
                </div>
              </div>
            )}

            {output != null && (
              <div>
                <h4 className="text-muted-foreground mb-2 text-sm font-medium">
                  Output
                </h4>
                <div className="bg-muted/40 max-h-60 overflow-auto rounded border p-2 font-mono text-xs">
                  <pre className="whitespace-pre-wrap wrap-break-word">
                    {formatValue(
                      typeof output === "object" &&
                        output !== null &&
                        "result" in output &&
                        Object.keys(output).length === 1
                        ? (output as { result: unknown }).result
                        : output
                    )}
                  </pre>
                </div>
              </div>
            )}

            {state === "output-error" && toolPart.errorText && (
              <div>
                <h4 className="mb-2 text-sm font-medium text-red-500">Error</h4>
                <div className="bg-background rounded border border-red-200 p-2 text-sm dark:border-red-950 dark:bg-red-900/20">
                  {toolPart.errorText}
                </div>
              </div>
            )}

            {state === "input-streaming" &&
              !(input && Object.keys(input).length > 0) && (
                <div className="text-muted-foreground text-sm">
                  Processing tool call...
                </div>
              )}

            {!input && !output && state !== "input-streaming" && !toolPart.errorText && (
              <div className="text-muted-foreground text-sm">
                No input/output details captured for this call.
              </div>
            )}

            {(toolCallId || toolPart.type) && (
              <div className="text-muted-foreground space-y-0.5 border-t pt-2 text-xs">
                {toolPart.type && (
                  <div>
                    Tool: <span className="font-mono">{toolPart.type}</span>
                  </div>
                )}
                {toolCallId && (
                  <div>
                    Call ID: <span className="font-mono">{toolCallId}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

export { Tool }
