"use client"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { ChevronDown } from "lucide-react"

export type StepsItemProps = React.ComponentProps<"div">

export const StepsItem = ({
  children,
  className,
  ...props
}: StepsItemProps) => (
  <div className={cn("text-muted-foreground text-sm", className)} {...props}>
    {children}
  </div>
)

export type StepsTriggerProps = React.ComponentProps<
  typeof CollapsibleTrigger
> & {
  leftIcon?: React.ReactNode
  swapIconOnHover?: boolean
}

export const StepsTrigger = ({
  children,
  className,
  leftIcon,
  swapIconOnHover = true,
  ...props
}: StepsTriggerProps) => (
  <CollapsibleTrigger
    className={cn(
      "group text-muted-foreground hover:text-foreground flex cursor-pointer items-start gap-1.5 font-sans! text-[15px]! leading-[1.6]! transition-colors",
      className
    )}
    {...props}
  >
    <span className="relative mt-[4px] inline-flex size-3.5 shrink-0 items-center justify-center">
      {leftIcon ? (
        <span
          className={cn(
            "inline-flex size-3.5 items-center justify-center transition-opacity [&_svg]:size-3.5",
            // Only swap away the tool icon when hover/open chevron swap is enabled.
            swapIconOnHover &&
              "group-hover:opacity-0 group-data-[state=open]:opacity-0"
          )}
        >
          {leftIcon}
        </span>
      ) : null}
      <ChevronDown
        className={cn(
          "absolute size-3.5 transition-opacity",
          leftIcon && swapIconOnHover
            ? // Idle: tool icon. Hover/open: chevron.
              "opacity-0 group-hover:opacity-100 group-data-[state=open]:opacity-100 group-data-[state=open]:rotate-180"
            : leftIcon
              ? // Streaming / no-swap: keep tool icon only — never show the arrow.
                "pointer-events-none opacity-0"
              : "opacity-100 group-data-[state=open]:rotate-180"
        )}
      />
    </span>
    <span className="min-w-0 text-left">{children}</span>
  </CollapsibleTrigger>
)

export type StepsContentProps = React.ComponentProps<
  typeof CollapsibleContent
> & {
  bar?: React.ReactNode
}

export const StepsContent = ({
  children,
  className,
  bar,
  ...props
}: StepsContentProps) => {
  return (
    <CollapsibleContent
      className={cn(
        "text-popover-foreground data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden",
        className
      )}
      {...props}
    >
      <div className="mt-3 grid max-w-full min-w-0 grid-cols-[min-content_minmax(0,1fr)] items-start gap-x-3">
        <div className="min-w-0 self-stretch">{bar ?? <StepsBar />}</div>
        <div className="min-w-0 space-y-2">{children}</div>
      </div>
    </CollapsibleContent>
  )
}

export type StepsBarProps = React.HTMLAttributes<HTMLDivElement>

export const StepsBar = ({ className, ...props }: StepsBarProps) => (
  <div
    className={cn("bg-muted h-full w-[2px]", className)}
    aria-hidden
    {...props}
  />
)

export type StepsProps = React.ComponentProps<typeof Collapsible>

export function Steps({ defaultOpen = false, className, ...props }: StepsProps) {
  return (
    <Collapsible
      className={cn(className)}
      defaultOpen={defaultOpen}
      {...props}
    />
  )
}
