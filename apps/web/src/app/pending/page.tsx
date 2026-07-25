"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";

export default function PendingPage() {
  const { user, signOut } = useAuth();
  const router = useRouter();

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Awaiting approval</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Your email is confirmed{user?.email ? ` (${user.email})` : ""}. An admin
        still needs to approve your account before you can use OpenAgents.
      </p>
      <Button
        variant="outline"
        onClick={async () => {
          await signOut();
          router.replace("/login");
        }}
      >
        Sign out
      </Button>
    </main>
  );
}
