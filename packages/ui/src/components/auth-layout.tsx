import type * as React from "react"

export interface AuthLayoutFeature {
  title: string
  description: string
}

export interface AuthLayoutStat {
  value: string
  label: string
}

export interface AuthLayoutProps {
  children: React.ReactNode
  brandLabel?: string
  eyebrow?: string
  title?: string
  description?: string
  features?: AuthLayoutFeature[]
  stats?: AuthLayoutStat[]
}

export function AuthLayout({
  children,
  brandLabel = "GuestPost",
}: AuthLayoutProps) {
  return (
    <div className="dark relative flex min-h-screen w-full flex-col items-center justify-center bg-zinc-950 px-4">
      <div className="fixed left-6 top-6 z-20 flex items-center justify-start gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900 text-sm font-bold tracking-tight text-zinc-100">
          GP
        </div>
        <span className="text-lg font-semibold tracking-tight text-zinc-100">
          {brandLabel}
        </span>
      </div>
      {children}
    </div>
  )
}
