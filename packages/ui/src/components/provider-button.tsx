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
        "inline-flex w-full items-center justify-center gap-2 rounded-md border border-[#23252a] bg-[#0f1011] px-4 py-2.5 text-sm font-medium text-[#f7f8f8] hover:bg-[#141516] hover:border-[#34343a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5e69d1]/50 disabled:pointer-events-none disabled:opacity-50 transition-colors",
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
