"use client"

import * as React from "react"
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-horizontal:flex-col",
        className
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center shrink-0 text-muted-foreground",
  {
    variants: {
      variant: {
        default: "bg-muted rounded-lg p-[3px] group-data-horizontal/tabs:h-8",
        button: "",
        line: "w-full justify-start gap-4 rounded-none border-b border-border bg-transparent p-0",
      },
      size: {
        lg: "gap-2.5",
        md: "gap-2",
        sm: "gap-1.5",
        xs: "gap-1",
      },
    },
    compoundVariants: [
      { variant: "line", size: "lg", className: "gap-9" },
      { variant: "line", size: "md", className: "gap-8" },
      { variant: "line", size: "sm", className: "gap-4" },
      { variant: "line", size: "xs", className: "gap-4" },
    ],
    defaultVariants: {
      variant: "default",
      size: "md",
    },
  }
)

const tabsTriggerVariants = cva(
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "rounded-md border border-transparent px-1.5 py-0.5 text-sm text-foreground/60 hover:text-foreground data-active:bg-background data-active:text-foreground data-active:shadow-sm dark:text-muted-foreground dark:hover:text-foreground dark:data-active:border-input dark:data-active:bg-input/30",
        button:
          "rounded-lg text-accent-foreground hover:text-foreground data-active:bg-accent data-active:text-foreground",
        line: "rounded-none border-b-2 border-transparent px-0 text-sm text-muted-foreground hover:text-primary data-active:border-primary data-active:text-primary",
      },
      size: {
        lg: "gap-2.5 text-sm [&_svg]:size-5",
        md: "gap-2 text-sm [&_svg]:size-4",
        sm: "gap-1.5 text-xs [&_svg]:size-3.5",
        xs: "gap-1 text-xs [&_svg]:size-3.5",
      },
    },
    compoundVariants: [
      { variant: "default", size: "lg", className: "px-4 py-2.5" },
      { variant: "default", size: "md", className: "px-3 py-1.5" },
      { variant: "default", size: "sm", className: "px-2.5 py-1.5" },
      { variant: "default", size: "xs", className: "px-2 py-1" },
      { variant: "button", size: "lg", className: "px-4 py-3" },
      { variant: "button", size: "md", className: "px-3 py-2.5" },
      { variant: "button", size: "sm", className: "px-2.5 py-2" },
      { variant: "button", size: "xs", className: "px-2 py-1.5" },
      { variant: "line", size: "lg", className: "py-3" },
      { variant: "line", size: "md", className: "py-2.5" },
      { variant: "line", size: "sm", className: "py-2" },
      { variant: "line", size: "xs", className: "py-1.5" },
    ],
    defaultVariants: {
      variant: "default",
      size: "md",
    },
  }
)

type TabsContextType = {
  variant?: "default" | "button" | "line"
  size?: "lg" | "md" | "sm" | "xs"
}

const TabsContext = React.createContext<TabsContextType>({
  variant: "default",
  size: "md",
})

function TabsList({
  className,
  variant = "default",
  size = "md",
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsContext.Provider
      value={{ variant: variant || "default", size: size || "md" }}
    >
      <TabsPrimitive.List
        data-slot="tabs-list"
        data-variant={variant}
        className={cn(tabsListVariants({ variant, size }), className)}
        {...props}
      />
    </TabsContext.Provider>
  )
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  const { variant, size } = React.useContext(TabsContext)

  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(tabsTriggerVariants({ variant, size }), className)}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("flex-1 text-sm outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
