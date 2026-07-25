"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";

export default function RejectedPage() {
  const { signOut } = useAuth();
  const router = useRouter();

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Request not approved</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Your signup was not approved. Contact YVR Studio if you believe this is a
        mistake.
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
