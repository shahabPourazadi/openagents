"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { useAccountStatus } from "@/lib/account-status";
import { appHomePath } from "@/lib/agent-routes";
import { DotmSquare1 } from "@/components/ui/dotm-square-1";

const GATE_PATHS = new Set(["/pending", "/rejected", "/disabled"]);

function gatePathForStatus(status: string): string {
  if (status === "rejected") return "/rejected";
  if (status === "disabled") return "/disabled";
  return "/pending";
}

function AuthSpinner({ label = "Authenticating…" }: { label?: string }) {
  return (
    <div
      className="flex min-h-svh items-center justify-center gap-2 bg-background text-sm text-muted-foreground"
      style={{ ["--color-dot-on" as string]: "currentColor" }}
    >
      <DotmSquare1
        size={20}
        dotSize={3}
        speed={1.1}
        pattern="full"
        colorPreset="solid-theme"
        animated
        opacityBase={0.12}
        opacityMid={0.42}
        opacityPeak={1}
        ariaLabel={label}
      />
      {label}
    </div>
  );
}

/**
 * Redirects non-active users to status screens; keeps admins on /admin.
 * Active users are bounced off gate paths back to the app home.
 *
 * Important: do not mount the workspace (AppProvider) for non-active users —
 * those APIs require an active account and would spam console errors.
 */
export function AccountGate({ children }: { children: React.ReactNode }) {
  const { ready: authReady, user } = useAuth();
  const { ready, status, isAdmin } = useAccountStatus();
  const pathname = usePathname();
  const router = useRouter();

  const onGate = GATE_PATHS.has(pathname);
  const onAdmin = pathname.startsWith("/admin");
  const onLogin = pathname.startsWith("/login");
  const accountStatus = status?.status ?? null;
  const allowedForInactive =
    !user ||
    !accountStatus ||
    isAdmin ||
    accountStatus === "active" ||
    onLogin ||
    pathname === gatePathForStatus(accountStatus);

  useEffect(() => {
    if (!authReady || !ready || !user || !status) return;

    if (isAdmin) {
      if (onGate) {
        router.replace("/admin");
      }
      return;
    }

    if (status.status === "pending" && pathname !== "/pending" && !onLogin) {
      router.replace("/pending");
      return;
    }
    if (status.status === "rejected" && pathname !== "/rejected" && !onLogin) {
      router.replace("/rejected");
      return;
    }
    if (status.status === "disabled" && pathname !== "/disabled" && !onLogin) {
      router.replace("/disabled");
      return;
    }

    if (status.status === "active" && onGate) {
      router.replace(appHomePath());
      return;
    }

    if (status.status !== "active" && onAdmin) {
      router.replace(gatePathForStatus(status.status));
    }
  }, [authReady, ready, user, status, isAdmin, pathname, onGate, onAdmin, onLogin, router]);

  if (!authReady || (user && !ready)) {
    return <AuthSpinner />;
  }

  // Hold the workspace until redirect finishes — avoids /api/models etc. 403s.
  if (!allowedForInactive) {
    return <AuthSpinner label="Redirecting…" />;
  }

  return <>{children}</>;
}
