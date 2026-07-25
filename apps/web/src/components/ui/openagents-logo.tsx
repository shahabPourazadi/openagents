import { cn } from "@/lib/utils";

const LOGO_SRC = {
  stack: "/brand/icon-stack.webp",
  wide: "/brand/icon-wide.webp",
} as const;

export function OpenAgentsLogo({
  className,
  variant = "text",
}: {
  className?: string;
  /** Image mark for auth (`stack`) or sidebar (`wide`); default is text wordmark. */
  variant?: "text" | "stack" | "wide";
  /** Kept for call-site compatibility; no animation. */
  autoPlay?: boolean;
  onIntroComplete?: () => void;
}) {
  if (variant === "stack" || variant === "wide") {
    return (
      // Static brand asset under /public.
      // eslint-disable-next-line @next/next/no-img-element -- local logo; no optimization needed
      <img
        src={LOGO_SRC[variant]}
        alt="OpenAgents"
        className={cn("inline-block select-none object-contain", className)}
      />
    );
  }

  return (
    <span
      className={cn(
        "inline-block select-none font-sans text-[15px] font-semibold tracking-tight text-foreground",
        className
      )}
      aria-label="OpenAgents"
    >
      OpenAgents
    </span>
  );
}
