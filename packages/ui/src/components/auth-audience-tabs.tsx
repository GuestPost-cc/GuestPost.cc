"use client"

import { cn } from "../lib/utils"

export type PublicAuthAudience = "customer" | "publisher"

export interface AuthAudienceTabsProps {
  value: PublicAuthAudience
  onChange: (value: PublicAuthAudience) => void
  className?: string
}

export function AuthAudienceTabs({
  value,
  onChange,
  className,
}: AuthAudienceTabsProps) {
  return (
    <div
      role="tablist"
      aria-label="Account type"
      className={cn(
        "grid grid-cols-2 rounded-lg border border-zinc-800 bg-zinc-950/70 p-1",
        className,
      )}
    >
      {(["customer", "publisher"] as const).map((audience) => (
        <button
          key={audience}
          type="button"
          role="tab"
          aria-selected={value === audience}
          onClick={() => onChange(audience)}
          className={cn(
            "rounded-md px-4 py-2.5 text-sm font-semibold capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400",
            value === audience
              ? "bg-zinc-800 text-zinc-50 shadow-sm"
              : "text-zinc-400 hover:text-zinc-100",
          )}
        >
          {audience}
        </button>
      ))}
    </div>
  )
}
