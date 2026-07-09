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
        "relative overflow-hidden rounded-[1.75rem] border border-white/10 bg-[#070b14]/85 p-6 shadow-2xl shadow-black/40 backdrop-blur-xl sm:p-8",
        className,
      )}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/40 to-transparent"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-[#5e6ad2]/20 blur-3xl"
      />

      <div className="relative">
        <div className="mb-7 text-center">
          {eyebrow && (
            <div className="mb-3 inline-flex rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#aeb7c8]">
              {eyebrow}
            </div>
          )}
          <h1 className="text-2xl font-semibold tracking-tight text-[#f7f8f8] sm:text-3xl">
            {title}
          </h1>
          {description && (
            <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-[#8f9aab]">
              {description}
            </p>
          )}
        </div>

        {children}

        {footer && (
          <div className="mt-8 border-t border-white/10 pt-6 text-center text-sm text-[#8f9aab]">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
