"use client";

import * as React from "react";
import { useId, useState } from "react";
import dynamic from "next/dynamic";
import { Eye, EyeOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { OpenAgentsLogo } from "@/components/ui/openagents-logo";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const PixelBlast = dynamic(
  () => import("@/components/ui/pixel-blast").then((m) => m.PixelBlast),
  { ssr: false }
);

function Label({
  className,
  ...props
}: React.ComponentProps<"label">) {
  return (
    <label
      className={cn(
        "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
        className
      )}
      {...props}
    />
  );
}

export interface PasswordInputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className, label, id: idProp, ...props }, ref) => {
    const generatedId = useId();
    const id = idProp ?? generatedId;
    const [showPassword, setShowPassword] = useState(false);

    return (
      <div className="grid w-full items-center gap-2">
        {label ? <Label htmlFor={id}>{label}</Label> : null}
        <div className="relative">
          <Input
            id={id}
            type={showPassword ? "text" : "password"}
            className={cn(
              "h-10 pe-10 py-3 shadow-sm shadow-black/5 placeholder:text-muted-foreground/70",
              className
            )}
            ref={ref}
            {...props}
          />
          <button
            type="button"
            onClick={() => setShowPassword((prev) => !prev)}
            className="absolute inset-y-0 inset-e-0 flex h-full w-10 items-center justify-center text-muted-foreground/80 transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
            aria-label={showPassword ? "Hide password" : "Show password"}
          >
            {showPassword ? (
              <EyeOff className="size-4" aria-hidden="true" />
            ) : (
              <Eye className="size-4" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
    );
  }
);
PasswordInput.displayName = "PasswordInput";

type SignInPayload = { email: string; password: string };
type SignUpPayload = { name: string; email: string; password: string };

function SignInForm({
  onSubmit,
  error,
  busy,
}: {
  onSubmit: (data: SignInPayload) => void | Promise<void>;
  error?: string | null;
  busy?: boolean;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        void onSubmit({
          email: String(form.get("email") ?? ""),
          password: String(form.get("password") ?? ""),
        });
      }}
      autoComplete="on"
      className="flex flex-col gap-8"
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <OpenAgentsLogo variant="stack" className="mb-2 h-12 w-auto" />
        <h1 className="text-2xl font-bold">Sign in to your account</h1>
      </div>
      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="signin-email">Email</Label>
          <Input
            id="signin-email"
            name="email"
            type="email"
            placeholder="m@example.com"
            required
            autoComplete="email"
            className="h-10 py-3 shadow-sm shadow-black/5 placeholder:text-muted-foreground/70"
          />
        </div>
        <PasswordInput
          name="password"
          label="Password"
          required
          minLength={6}
          autoComplete="current-password"
          placeholder="Password"
        />
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button type="submit" variant="outline" className="mt-2 h-10" disabled={busy}>
          {busy ? "Please wait…" : "Sign In"}
        </Button>
      </div>
    </form>
  );
}

function SignUpForm({
  onSubmit,
  error,
  busy,
}: {
  onSubmit: (data: SignUpPayload) => void | Promise<void>;
  error?: string | null;
  busy?: boolean;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        void onSubmit({
          name: String(form.get("name") ?? ""),
          email: String(form.get("email") ?? ""),
          password: String(form.get("password") ?? ""),
        });
      }}
      autoComplete="on"
      className="flex flex-col gap-8"
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <OpenAgentsLogo variant="stack" className="mb-2 h-12 w-auto" />
        <h1 className="text-2xl font-bold">Create an account</h1>
      </div>
      <div className="grid gap-4">
        <div className="grid gap-1">
          <Label htmlFor="signup-name">Full Name</Label>
          <Input
            id="signup-name"
            name="name"
            type="text"
            placeholder="John Doe"
            required
            autoComplete="name"
            className="h-10 py-3 shadow-sm shadow-black/5 placeholder:text-muted-foreground/70"
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="signup-email">Email</Label>
          <Input
            id="signup-email"
            name="email"
            type="email"
            placeholder="m@example.com"
            required
            autoComplete="email"
            className="h-10 py-3 shadow-sm shadow-black/5 placeholder:text-muted-foreground/70"
          />
        </div>
        <PasswordInput
          name="password"
          label="Password"
          required
          minLength={6}
          autoComplete="new-password"
          placeholder="Password"
        />
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button type="submit" variant="outline" className="mt-2 h-10" disabled={busy}>
          {busy ? "Please wait…" : "Sign Up"}
        </Button>
      </div>
    </form>
  );
}

function AuthFormContainer({
  isSignIn,
  onToggle,
  onSignIn,
  onSignUp,
  error,
  busy,
}: {
  isSignIn: boolean;
  onToggle: () => void;
  onSignIn: (data: SignInPayload) => void | Promise<void>;
  onSignUp: (data: SignUpPayload) => void | Promise<void>;
  error?: string | null;
  busy?: boolean;
}) {
  return (
    <div className="mx-auto grid w-[350px] gap-2">
      {isSignIn ? (
        <SignInForm onSubmit={onSignIn} error={error} busy={busy} />
      ) : (
        <SignUpForm onSubmit={onSignUp} error={error} busy={busy} />
      )}
      <div className="text-center text-sm">
        {isSignIn ? "Don't have an account?" : "Already have an account?"}{" "}
        <Button
          variant="link"
          type="button"
          className="h-auto p-0 pl-1 text-foreground"
          onClick={onToggle}
        >
          {isSignIn ? "Sign up" : "Sign in"}
        </Button>
      </div>
    </div>
  );
}

interface AuthUIProps {
  onSignIn: (data: SignInPayload) => void | Promise<void>;
  onSignUp: (data: SignUpPayload) => void | Promise<void>;
  onModeChange?: () => void;
  error?: string | null;
  busy?: boolean;
  /** When false, open on the sign-up form. Defaults to sign-in. */
  defaultIsSignIn?: boolean;
}

export function AuthUI({
  onSignIn,
  onSignUp,
  onModeChange,
  error,
  busy,
  defaultIsSignIn = true,
}: AuthUIProps) {
  const [isSignIn, setIsSignIn] = useState(defaultIsSignIn);

  return (
    <div className="w-full min-h-screen md:grid md:grid-cols-2">
      <style>{`
        input[type="password"]::-ms-reveal,
        input[type="password"]::-ms-clear {
          display: none;
        }
      `}</style>
      <div className="flex h-screen items-center justify-center p-6 md:h-auto md:p-0 md:py-12">
        <AuthFormContainer
          isSignIn={isSignIn}
          onToggle={() => {
            setIsSignIn((prev) => !prev);
            onModeChange?.();
          }}
          onSignIn={onSignIn}
          onSignUp={onSignUp}
          error={error}
          busy={busy}
        />
      </div>

      <div className="relative hidden min-h-screen overflow-hidden bg-[#f8f0e8] md:block">
        <div className="absolute inset-0">
          <PixelBlast
            variant="square"
            pixelSize={6}
            color="#D07050"
            patternScale={3}
            patternDensity={1.2}
            pixelSizeJitter={0.5}
            enableRipples
            rippleSpeed={0.4}
            rippleThickness={0.12}
            rippleIntensityScale={1.5}
            liquid
            liquidStrength={0.12}
            liquidRadius={1.2}
            liquidWobbleSpeed={5}
            speed={0.6}
            edgeFade={0.25}
            transparent
            logoSrc="/brand/oa-icon.webp"
            logoScale={0.45}
          />
        </div>
        <span className="sr-only">OpenAgents</span>
      </div>
    </div>
  );
}
