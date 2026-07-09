"use client"

import * as React from "react"
import { cn } from "../lib/utils"

export interface ProviderButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: React.ComponentType<{ className?: string }>
}

const ProviderButton = React.forwardRef<HTMLButtonElement, ProviderButtonProps>(
  ({ icon: Icon, children, className, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      className={cn(
        "inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 text-sm font-semibold text-zinc-100 transition-colors hover:bg-zinc-800/50 hover:border-zinc-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400 disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {Icon && <Icon className="h-4 w-4" />}
      {children}
    </button>
  ),
)
ProviderButton.displayName = "ProviderButton"

export { ProviderButton }
