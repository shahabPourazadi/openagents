"use client";

import { useEffect, useState } from "react";
import { Braces, Check, FormInput, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { useApp, type McpServer } from "@/lib/app-state";
import { cn } from "@/lib/utils";

type TestStatus = "idle" | "ok" | "fail";

export type McpDialogMode = "create" | "edit";

type TabId = "fields" | "json" | "ai";

type McpServerDialogProps = {
  open: boolean;
  mode: McpDialogMode;
  server?: McpServer | null;
  onOpenChange: (open: boolean) => void;
  onSaved?: (server: McpServer) => void;
};

function apiErrorMessage(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : err && typeof err === "object" && "message" in err
        ? String((err as { message: string }).message)
        : "Request failed";
  try {
    const parsed = JSON.parse(raw) as { detail?: unknown };
    if (typeof parsed.detail === "string") return parsed.detail;
  } catch {
    /* not JSON */
  }
  return raw;
}

export function McpServerDialog({
  open,
  mode,
  server,
  onOpenChange,
  onSaved,
}: McpServerDialogProps) {
  const {
    createMcpServer,
    updateMcpServer,
    testMcpServer,
    parseMcpServerRaw,
    setupMcpChat,
  } = useApp();

  const [tab, setTab] = useState<TabId>("fields");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [authMode, setAuthMode] = useState("token");
  const [jsonText, setJsonText] = useState("");
  const [toolNames, setToolNames] = useState<string[]>([]);
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [statusHeadline, setStatusHeadline] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiSaved, setAiSaved] = useState(false);
  const testedOk = testStatus === "ok";

  function effectiveAuthMode(): string {
    if (authMode === "token" && !token.trim()) return "none";
    return authMode;
  }

  function clearResult() {
    setTestStatus("idle");
    setStatusHeadline("");
    setError(null);
  }

  const [aiInput, setAiInput] = useState("");
  const [aiHistory, setAiHistory] = useState<
    { role: string; content: string }[]
  >([]);
  const [aiReply, setAiReply] = useState("");

  useEffect(() => {
    if (!open) return;
    clearResult();
    setAiSaved(false);
    setToolNames([]);
    setAiHistory([]);
    setAiReply("");
    setAiInput("");
    setTab("fields");
    if (mode === "edit" && server) {
      setName(server.name);
      setUrl(server.url);
      setToken("");
      setAuthMode(server.auth_mode || "token");
      setJsonText(
        JSON.stringify(
          {
            name: server.name,
            url: server.url,
            auth_mode: server.auth_mode,
          },
          null,
          2
        )
      );
      setToolNames(server.tool_names || []);
      if (server.last_tested_at) {
        setTestStatus("ok");
        setStatusHeadline(
          `Previously tested · Tools (${(server.tool_names || []).length})`
        );
      }
    } else {
      setName("");
      setUrl("");
      setToken("");
      setAuthMode("token");
      setJsonText(
        '{\n  "name": "My MCP",\n  "url": "https://example.com/mcp",\n  "token": ""\n}'
      );
    }
  }, [open, mode, server]);

  async function applyJson() {
    setBusy(true);
    setError(null);
    try {
      let raw: unknown = jsonText;
      try {
        raw = JSON.parse(jsonText);
      } catch {
        /* keep as string for server parse */
      }
      const drafts = await parseMcpServerRaw(raw);
      if (!drafts.length) {
        setError("No HTTP MCP servers found in JSON.");
        return;
      }
      const d = drafts[0];
      setName(d.name);
      setUrl(d.url);
      if (d.token) setToken(d.token);
      setAuthMode(d.token ? "token" : "none");
      setTab("fields");
      clearResult();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function runTest() {
    setBusy(true);
    clearResult();
    try {
      const result = await testMcpServer({
        name: name.trim() || "MCP Server",
        url: url.trim(),
        token: token.trim() || null,
        auth_mode: effectiveAuthMode(),
      });
      if (!result.ok) {
        setToolNames([]);
        setTestStatus("fail");
        setStatusHeadline("Test failed");
        setError(result.error || "Connection test failed");
        return;
      }
      setToolNames(result.tool_names || []);
      setTestStatus("ok");
      setStatusHeadline(
        `Test passed · Tools (${(result.tool_names || []).length})`
      );
    } catch (err) {
      setToolNames([]);
      setTestStatus("fail");
      setStatusHeadline("Test failed");
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!testedOk) {
      setError("Test the connection successfully before saving.");
      return;
    }
    setBusy(true);
    setError(null);
    const modeToSave = effectiveAuthMode();
    try {
      let saved: McpServer | null = null;
      if (mode === "edit" && server) {
        saved = await updateMcpServer(server.id, {
          name: name.trim(),
          url: url.trim(),
          token: token.trim() || null,
          auth_mode: modeToSave,
          clear_token: modeToSave !== "token",
        });
      } else {
        saved = await createMcpServer({
          name: name.trim(),
          url: url.trim(),
          token: token.trim() || null,
          auth_mode: modeToSave,
        });
      }
      if (!saved) {
        setError("Failed to save MCP server.");
        return;
      }
      onSaved?.(saved);
      onOpenChange(false);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function sendAi() {
    const msg = aiInput.trim();
    if (!msg) return;
    setBusy(true);
    clearResult();
    try {
      const res = await setupMcpChat(msg, aiHistory);
      if (!res) {
        setTestStatus("fail");
        setStatusHeadline("Setup failed");
        setError("AI setup failed.");
        return;
      }
      const nextHistory = [
        ...aiHistory,
        { role: "user", content: msg },
        { role: "assistant", content: res.reply },
      ];
      setAiHistory(nextHistory);
      setAiReply(res.reply);
      setAiInput("");
      if (res.draft) {
        setName(res.draft.name);
        setUrl(res.draft.url);
        if (res.draft.token) {
          setToken(res.draft.token);
          setAuthMode("token");
        } else if (!res.error) {
          setAuthMode("none");
        }
      }
      if (res.saved) {
        const tools = res.tool_names || [];
        setToolNames(tools);
        setTestStatus("ok");
        setStatusHeadline(`Saved · Tools (${tools.length})`);
        setAiSaved(true);
        onSaved?.(res.saved);
        return;
      }
      if (res.error) {
        setTestStatus("fail");
        setStatusHeadline("Setup failed");
        setError(res.error);
        if (res.tool_names?.length) setToolNames(res.tool_names);
        return;
      }
      // Conversational reply (e.g. ask for URL) — no pass/fail yet.
    } catch (err) {
      setTestStatus("fail");
      setStatusHeadline("Setup failed");
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {mode === "edit" ? "Edit MCP server" : "Add MCP server"}
          </DialogTitle>
          <DialogDescription>
            HTTP/SSE MCP only. Test must pass before save. Secrets are stored
            encrypted.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as TabId)}
          className="gap-0"
        >
          <TabsList variant="line" size="sm" className="w-full">
            <TabsTrigger value="fields">
              <FormInput /> Fields
            </TabsTrigger>
            <TabsTrigger value="json">
              <Braces /> Paste JSON
            </TabsTrigger>
            <TabsTrigger value="ai">
              <Sparkles /> Set up with AI
            </TabsTrigger>
          </TabsList>

          <TabsContent value="fields" className="mt-2.5 flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Name</span>
              <Input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  clearResult();
                }}
                disabled={busy || (server?.is_prebuilt && mode === "edit")}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">URL</span>
              <Input
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  clearResult();
                }}
                placeholder="https://…/mcp"
                disabled={busy || (server?.is_prebuilt && mode === "edit")}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Auth</span>
              <select
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                value={authMode}
                onChange={(e) => {
                  setAuthMode(e.target.value);
                  clearResult();
                }}
                disabled={busy}
              >
                <option value="token">Bearer token</option>
                <option value="openrouter_settings">
                  OpenRouter key from Settings
                </option>
                <option value="none">None</option>
              </select>
            </label>
            {authMode === "token" ? (
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">
                  Token
                  {mode === "edit" && server?.has_token
                    ? " (leave blank to keep)"
                    : ""}
                </span>
                <Input
                  type="password"
                  value={token}
                  onChange={(e) => {
                    setToken(e.target.value);
                    clearResult();
                  }}
                  disabled={busy}
                  autoComplete="off"
                />
              </label>
            ) : null}
          </TabsContent>

          <TabsContent value="json" className="mt-2.5 flex flex-col gap-2">
            <Textarea
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              rows={10}
              className="font-mono text-xs"
              disabled={busy}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void applyJson()}
            >
              Apply to fields
            </Button>
          </TabsContent>

          <TabsContent value="ai" className="mt-2.5 flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              Describe the MCP server you want. The assistant will propose a
              config, test it, and can look up docs if something fails.
            </p>
            {aiHistory.length > 0 ? (
              <div className="max-h-40 space-y-2 overflow-y-auto rounded-md border p-2 text-xs">
                {aiHistory.map((m, i) => (
                  <p key={`${m.role}-${i}`}>
                    <span className="font-medium">
                      {m.role === "user" ? "You" : "Assistant"}:
                    </span>{" "}
                    {m.content}
                  </p>
                ))}
              </div>
            ) : null}
            {aiReply && aiHistory.length === 0 ? (
              <p className="text-xs text-muted-foreground">{aiReply}</p>
            ) : null}
            <Textarea
              value={aiInput}
              onChange={(e) => setAiInput(e.target.value)}
              rows={3}
              placeholder="e.g. Add DeepWiki MCP at https://mcp.deepwiki.com/mcp"
              disabled={busy}
            />
            <Button
              type="button"
              size="sm"
              disabled={busy || !aiInput.trim()}
              onClick={() => void sendAi()}
            >
              Send
            </Button>
          </TabsContent>
        </Tabs>

        {testStatus === "ok" || testStatus === "fail" ? (
          <div
            className={cn(
              "rounded-md border px-3 py-2 text-xs",
              testStatus === "ok"
                ? "border-emerald-500/30 bg-emerald-500/5"
                : "border-destructive/30 bg-destructive/5"
            )}
          >
            <p className="flex items-center gap-1.5 font-medium">
              {testStatus === "ok" ? (
                <Check
                  className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                  aria-hidden
                />
              ) : (
                <X
                  className="size-3.5 shrink-0 text-destructive"
                  aria-hidden
                />
              )}
              <span>
                {statusHeadline ||
                  (testStatus === "ok" ? "Success" : "Failed")}
              </span>
            </p>
            {testStatus === "ok" && toolNames.length > 0 ? (
              <p className="mt-1 text-muted-foreground">
                {toolNames.slice(0, 12).join(", ")}
                {toolNames.length > 12 ? "…" : ""}
              </p>
            ) : null}
            {testStatus === "fail" && error ? (
              <p className="mt-1 text-destructive">{error}</p>
            ) : null}
          </div>
        ) : null}

        {error && testStatus !== "fail" ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : null}

        <DialogFooter className="gap-2 sm:gap-0">
          {tab !== "ai" ? (
            <Button
              type="button"
              variant="secondary"
              disabled={busy || !url.trim()}
              onClick={() => void runTest()}
            >
              Test
            </Button>
          ) : null}
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {aiSaved ? "Close" : "Cancel"}
          </Button>
          {tab !== "ai" && !aiSaved ? (
            <Button
              type="button"
              disabled={busy || !testedOk}
              onClick={() => void save()}
            >
              Save
            </Button>
          ) : null}
          {tab === "ai" && aiSaved ? (
            <Button type="button" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
