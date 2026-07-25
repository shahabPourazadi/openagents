"use client";

import { useState } from "react";
import { LogOut, Settings, Shield } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getAuthHeaders, useApp } from "@/lib/app-state";
import { useAccountStatus } from "@/lib/account-status";
import { useAuth } from "@/lib/auth-context";

type SettingsDialogProps = {
  /** Legacy: icon-only trigger in collapsed sidebar. */
  iconOnly?: boolean;
  /** Controlled open state (when set, no built-in trigger is rendered). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export function SettingsDialog({
  iconOnly = false,
  open: controlledOpen,
  onOpenChange,
}: SettingsDialogProps) {
  const { apiUrl } = useApp();
  const { user, signOut } = useAuth();
  const { isAdmin, status } = useAccountStatus();
  const router = useRouter();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [key, setKey] = useState("");
  const [saved, setSaved] = useState(false);

  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  async function save() {
    await fetch(`${apiUrl}/api/settings`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...getAuthHeaders(),
      },
      body: JSON.stringify({ openrouter_api_key: key || null }),
    });
    setSaved(true);
  }

  async function handleSignOut() {
    await signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <>
      {!isControlled &&
        (iconOnly ? (
          <Tooltip>
            <TooltipTrigger
              className="inline-flex"
              onClick={() => setOpen(true)}
              aria-label="Settings"
            >
              <span className="inline-flex size-9 items-center justify-center rounded-md hover:bg-sidebar-accent">
                <Settings className="size-4" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="right">Settings</TooltipContent>
          </Tooltip>
        ) : (
          <Button
            variant="ghost"
            size="xs"
            className="h-7 w-full justify-start gap-2 px-2 text-xs!"
            onClick={() => setOpen(true)}
          >
            <Settings className="size-3.5 opacity-70" />
            Settings
          </Button>
        ))}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
          </DialogHeader>
          {user?.email ? (
            <p className="text-sm text-muted-foreground">Signed in as {user.email}</p>
          ) : null}
          <div className="space-y-2">
            <p className="text-sm font-medium">OpenRouter</p>
            <p className="text-sm text-muted-foreground">
              Optional BYOK. Leave empty to use the server OPENROUTER_API_KEY.
            </p>
            <Input
              type="password"
              placeholder="sk-or-…"
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                setSaved(false);
              }}
            />
            <Button onClick={() => void save()}>{saved ? "Saved" : "Save key"}</Button>
          </div>
          {isAdmin ? (
            <Link
              href="/admin"
              onClick={() => setOpen(false)}
              className="inline-flex h-8 w-full items-center justify-center gap-2 rounded-lg border border-border bg-background px-2.5 text-sm font-medium hover:bg-muted"
            >
              <Shield className="size-4" />
              Admin
              {(status?.pending_count ?? 0) > 0
                ? ` (${status?.pending_count} pending)`
                : ""}
            </Link>
          ) : null}
          <Button variant="outline" className="gap-2" onClick={() => void handleSignOut()}>
            <LogOut className="size-4" />
            Sign out
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
