"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import { appHomePath } from "@/lib/agent-routes";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/client";

type AuthState = {
  ready: boolean;
  session: Session | null;
  user: User | null;
  accessToken: string | null;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signUp: (
    email: string,
    password: string,
    name?: string
  ) => Promise<{ error: string | null; needsEmailConfirmation: boolean }>;
  signOut: () => Promise<void>;
};

const AuthCtx = createContext<AuthState | null>(null);

const NOT_CONFIGURED = "Authentication is not configured";

/**
 * Matches API AUTH_MODE=none default (X-User-Id / seed_demo.DEMO_OWNER_ID).
 * Without this, AppProvider never bootstraps a workspace and pack selection no-ops.
 */
const OPEN_AUTH_USER = {
  id: "dev-user",
  email: "dev@localhost",
  app_metadata: {},
  user_metadata: {},
  aud: "authenticated",
  created_at: "1970-01-01T00:00:00.000Z",
} as User;

export function AuthProvider({ children }: { children: ReactNode }) {
  const configured = isSupabaseConfigured();
  const supabase = useMemo(
    () => (configured ? createClient() : null),
    [configured]
  );
  const [ready, setReady] = useState(!configured);
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    if (!supabase) {
      setReady(true);
      return;
    }
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setReady(true);
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, [supabase]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      if (!supabase) return { error: NOT_CONFIGURED };
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      return { error: error?.message ?? null };
    },
    [supabase]
  );

  const signUp = useCallback(
    async (email: string, password: string, name?: string) => {
      if (!supabase) {
        return { error: NOT_CONFIGURED, needsEmailConfirmation: false };
      }
      const redirectTo =
        typeof window !== "undefined"
          ? `${window.location.origin}${appHomePath()}`
          : undefined;
      const trimmedName = name?.trim();
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          ...(redirectTo ? { emailRedirectTo: redirectTo } : {}),
          ...(trimmedName ? { data: { full_name: trimmedName } } : {}),
        },
      });
      if (error) {
        return { error: error.message, needsEmailConfirmation: false };
      }
      // No session means confirm-email is required before sign-in.
      return { error: null, needsEmailConfirmation: !data.session };
    },
    [supabase]
  );

  const signOut = useCallback(async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
  }, [supabase]);

  const value = useMemo<AuthState>(() => {
    // Open auth (no Supabase keys): act as the local demo user so workspace
    // bootstrap + X-User-Id API calls work without a real login session.
    if (!configured) {
      return {
        ready: true,
        session: null,
        user: OPEN_AUTH_USER,
        accessToken: null,
        signIn,
        signUp,
        signOut,
      };
    }
    return {
      ready,
      session,
      user: session?.user ?? null,
      accessToken: session?.access_token ?? null,
      signIn,
      signUp,
      signOut,
    };
  }, [configured, ready, session, signIn, signUp, signOut]);

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
