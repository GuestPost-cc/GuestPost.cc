import type * as React from "react"
import { cn } from "../lib/utils"

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
  eyebrow,
  title,
  description,
  features,
  stats,
}: AuthLayoutProps) {
  const hasPanel = Boolean(
    eyebrow || title || description || features?.length || stats?.length,
  )

  return (
    <div className="dark relative min-h-screen overflow-hidden bg-[#02030a] text-[#f7f8f8]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -left-24 top-0 h-72 w-72 rounded-full bg-[#5e6ad2]/25 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-20 top-1/4 h-80 w-80 rounded-full bg-[#10b981]/10 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0 left-1/3 h-72 w-72 rounded-full bg-[#8b5cf6]/15 blur-3xl"
      />
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0)_28%)]" />

      <div className="relative mx-auto flex min-h-screen w-full max-w-7xl flex-col px-4 py-6 sm:px-6 lg:px-8">
        <header
          className={cn(
            "flex items-center gap-4",
            hasPanel ? "justify-between" : "justify-center",
          )}
        >
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.06] text-white shadow-lg shadow-[#5e6ad2]/20 backdrop-blur">
              <span className="text-sm font-bold tracking-tight">GP</span>
            </div>
            <span className="text-lg font-semibold tracking-tight text-[#f7f8f8]">
              {brandLabel}
            </span>
          </div>

          {hasPanel && (
            <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-[#aeb7c8] shadow-sm backdrop-blur sm:flex">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              Secure workspace
            </div>
          )}
        </header>

        <main
          className={cn(
            "grid flex-1 items-center gap-10 py-8 sm:py-12",
            hasPanel ? "lg:grid-cols-2" : "place-items-center",
          )}
        >
          {hasPanel && (
            <section className="hidden max-w-2xl lg:block" aria-label="Welcome">
              {eyebrow && (
                <div className="mb-5 inline-flex rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.24em] text-[#aeb7c8] backdrop-blur">
                  {eyebrow}
                </div>
              )}
              {title && (
                <h1 className="text-4xl font-semibold leading-tight tracking-tight text-white xl:text-5xl">
                  {title}
                </h1>
              )}
              {description && (
                <p className="mt-5 max-w-xl text-base leading-7 text-[#aeb7c8]">
                  {description}
                </p>
              )}

              {features && features.length > 0 && (
                <div className="mt-10 grid gap-3 sm:grid-cols-2">
                  {features.map((feature) => (
                    <div
                      key={feature.title}
                      className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 shadow-lg shadow-black/10 backdrop-blur"
                    >
                      <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl bg-[#5e6ad2]/15 text-[#b7c0ff]">
                        <span aria-hidden="true" className="text-sm font-bold">
                          ✓
                        </span>
                      </div>
                      <h2 className="text-sm font-semibold text-white">
                        {feature.title}
                      </h2>
                      <p className="mt-1 text-sm leading-6 text-[#8f9aab]">
                        {feature.description}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              {stats && stats.length > 0 && (
                <div className="mt-6 grid gap-3 sm:grid-cols-3">
                  {stats.map((stat) => (
                    <div
                      key={`${stat.value}-${stat.label}`}
                      className="rounded-2xl border border-white/10 bg-[#070b14]/70 p-4 backdrop-blur"
                    >
                      <div className="text-lg font-semibold text-white">
                        {stat.value}
                      </div>
                      <div className="mt-1 text-xs leading-5 text-[#8f9aab]">
                        {stat.label}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          <section
            className={cn(
              "w-full",
              hasPanel ? "mx-auto max-w-[460px] lg:ml-auto" : "max-w-sm",
            )}
          >
            {children}
          </section>
        </main>
      </div>
    </div>
  )
}
