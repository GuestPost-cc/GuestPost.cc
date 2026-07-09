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
        "inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 text-sm font-semibold text-[#f7f8f8] shadow-sm shadow-black/10 transition-all hover:-translate-y-0.5 hover:border-white/20 hover:bg-white/[0.07] hover:shadow-lg hover:shadow-black/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5e69d1]/60 disabled:pointer-events-none disabled:opacity-50",
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
