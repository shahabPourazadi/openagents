"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { AuthUI } from "@/components/ui/auth-ui";
import { Button } from "@/components/ui/button";
import { appHomePath } from "@/lib/agent-routes";

function LoginForm() {
  const { signIn, signUp, ready } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || appHomePath();

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkEmailFor, setCheckEmailFor] = useState<string | null>(null);

  async function handleSignIn({
    email,
    password,
  }: {
    email: string;
    password: string;
  }) {
    setBusy(true);
    setError(null);
    const result = await signIn(email.trim(), password);
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    // Let AuthProvider commit the session before navigating into the app.
    await new Promise((r) => setTimeout(r, 0));
    router.replace(next);
    router.refresh();
  }

  async function handleSignUp({
    name,
    email,
    password,
  }: {
    name: string;
    email: string;
    password: string;
  }) {
    setBusy(true);
    setError(null);
    const trimmed = email.trim();
    const result = await signUp(trimmed, password, name);
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    if (result.needsEmailConfirmation) {
      setCheckEmailFor(trimmed);
      return;
    }
    router.replace(next);
    router.refresh();
  }

  if (!ready) {
    return (
      <div className="flex min-h-svh items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (checkEmailFor) {
    return (
      <div className="flex min-h-svh items-center justify-center px-4">
        <div className="w-full max-w-sm space-y-6 text-center">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">OpenAgents</h1>
            <p className="text-sm text-muted-foreground">Confirm your email</p>
          </div>
          <div className="space-y-4 rounded-xl border bg-background/80 p-6 shadow-sm backdrop-blur">
            <p className="text-sm leading-relaxed text-foreground">
              Thanks for signing up. We sent a confirmation link to{" "}
              <span className="font-medium">{checkEmailFor}</span>.
            </p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Please open your inbox and confirm your email to activate your
              account. If you don&apos;t see it within a few minutes, check your
              spam or junk folder.
            </p>
            <Button
              type="button"
              className="w-full"
              onClick={() => {
                setCheckEmailFor(null);
                setError(null);
              }}
            >
              Back to sign in
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <AuthUI
      onSignIn={handleSignIn}
      onSignUp={handleSignUp}
      onModeChange={() => setError(null)}
      error={error}
      busy={busy}
    />
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-svh items-center justify-center text-sm text-muted-foreground">
          Loading…
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
