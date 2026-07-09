import type * as React from "react"
import { cn } from "../lib/utils"

export interface AuthCardProps {
  title: string
  description?: string
  eyebrow?: string
  footer?: React.ReactNode
  children: React.ReactNode
  className?: string
}

export function AuthCard({
  title,
  description,
  eyebrow,
  footer,
  children,
  className,
}: AuthCardProps) {
  return (
    <div
      className={cn(
        "w-full max-w-[400px] mx-auto bg-zinc-900/40 border border-zinc-800 rounded-xl p-6 sm:p-8",
        className,
      )}
    >
      <div className="space-y-6">
        <div className="text-center">
          {eyebrow && (
            <div className="mb-4 inline-flex rounded-full border border-zinc-800 bg-zinc-900/50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-zinc-400">
              {eyebrow}
            </div>
          )}
          <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            {title}
          </h1>
          {description && (
            <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
              {description}
            </p>
          )}
        </div>

        {children}

        {footer && (
          <div className="border-t border-zinc-800 pt-6 text-center text-sm text-muted-foreground">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
