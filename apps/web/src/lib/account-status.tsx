"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "@/lib/auth-context";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export type AccountStatus = {
  user_id: string;
  email: string | null;
  display_name: string | null;
  role: string;
  status: string;
  pending_count: number | null;
};

type AccountState = {
  ready: boolean;
  status: AccountStatus | null;
  refresh: () => Promise<void>;
  isAdmin: boolean;
};

const AccountCtx = createContext<AccountState | null>(null);

export function AccountStatusProvider({ children }: { children: ReactNode }) {
  const { ready: authReady, accessToken, user } = useAuth();
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const hasLoadedRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!user) {
      setStatus(null);
      hasLoadedRef.current = false;
      setReady(true);
      return;
    }
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (accessToken) {
        headers.Authorization = `Bearer ${accessToken}`;
      } else if (user.id) {
        headers["X-User-Id"] = user.id;
      }
      const res = await fetch(`${API_URL}/api/account/status`, {
        headers,
      });
      if (!res.ok) {
        setStatus(null);
        setReady(true);
        return;
      }
      const data = (await res.json()) as AccountStatus;
      setStatus(data);
      hasLoadedRef.current = true;
    } catch {
      setStatus(null);
    } finally {
      setReady(true);
    }
  }, [user, accessToken]);

  useEffect(() => {
    if (!authReady) return;
    // Only block the UI on the first status fetch. Token refreshes should
    // revalidate in the background without remounting the whole app.
    if (!hasLoadedRef.current) setReady(false);
    void refresh();
  }, [authReady, refresh]);

  const value = useMemo<AccountState>(
    () => ({
      ready: authReady && ready,
      status,
      refresh,
      isAdmin: status?.role === "admin",
    }),
    [authReady, ready, status, refresh]
  );

  return <AccountCtx.Provider value={value}>{children}</AccountCtx.Provider>;
}

export function useAccountStatus() {
  const ctx = useContext(AccountCtx);
  if (!ctx) throw new Error("useAccountStatus must be used within AccountStatusProvider");
  return ctx;
}
