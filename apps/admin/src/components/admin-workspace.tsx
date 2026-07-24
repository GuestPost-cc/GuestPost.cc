"use client"

import {
  Badge,
  type BadgeProps,
  Button,
  Card,
  CardContent,
  cn,
} from "@guestpost/ui"
import type { LucideIcon } from "lucide-react"
import {
  CheckCircle2,
  CircleAlert,
  FilterX,
  SearchX,
  SlidersHorizontal,
} from "lucide-react"
import type { ReactNode } from "react"

export type AdminTone = "neutral" | "info" | "success" | "warning" | "danger"

const TONE_STYLES: Record<
  AdminTone,
  { icon: string; surface: string; value: string }
> = {
  neutral: {
    icon: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200",
    surface: "border-border bg-card",
    value: "text-foreground",
  },
  info: {
    icon: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
    surface:
      "border-blue-200/70 bg-blue-50/35 dark:border-blue-900 dark:bg-blue-950/15",
    value: "text-blue-800 dark:text-blue-200",
  },
  success: {
    icon: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
    surface:
      "border-emerald-200/70 bg-emerald-50/35 dark:border-emerald-900 dark:bg-emerald-950/15",
    value: "text-emerald-800 dark:text-emerald-200",
  },
  warning: {
    icon: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
    surface:
      "border-amber-200/80 bg-amber-50/40 dark:border-amber-900 dark:bg-amber-950/15",
    value: "text-amber-800 dark:text-amber-200",
  },
  danger: {
    icon: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
    surface:
      "border-red-200/80 bg-red-50/35 dark:border-red-900 dark:bg-red-950/15",
    value: "text-red-800 dark:text-red-200",
  },
}

export function AdminPage({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "min-w-0 max-w-full space-y-6 overflow-x-clip pb-4",
        className,
      )}
    >
      {children}
    </div>
  )
}

export function AdminPageHeader({
  title,
  description,
  eyebrow,
  icon: Icon,
  actions,
  badges,
  className,
}: {
  title: string
  description: string
  eyebrow?: string
  icon?: LucideIcon
  actions?: ReactNode
  badges?: ReactNode
  className?: string
}) {
  return (
    <header
      className={cn(
        "flex min-w-0 flex-col justify-between gap-4 sm:flex-row sm:items-end",
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow ? (
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            {eyebrow}
          </p>
        ) : null}
        <div className="flex min-w-0 items-start gap-3">
          {Icon ? (
            <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Icon className="h-5 w-5" />
            </div>
          ) : null}
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h1 className="break-words text-2xl font-bold tracking-tight sm:text-3xl">
                {title}
              </h1>
              {badges}
            </div>
            <p className="mt-1.5 max-w-3xl text-sm leading-6 text-muted-foreground">
              {description}
            </p>
          </div>
        </div>
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      ) : null}
    </header>
  )
}

export function AdminFilterBar({
  children,
  activeCount = 0,
  resultCount,
  resultLabel = "results",
  onClear,
  className,
}: {
  children: ReactNode
  activeCount?: number
  resultCount?: number
  resultLabel?: string
  onClear?: () => void
  className?: string
}) {
  return (
    <section
      aria-label="Filters"
      className={cn(
        "min-w-0 rounded-2xl border border-blue-200/70 bg-blue-50/40 p-4 dark:border-blue-900/70 dark:bg-blue-950/15",
        className,
      )}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-blue-900 dark:text-blue-100">
          <SlidersHorizontal className="h-4 w-4" />
          Filter workspace
          {activeCount > 0 ? (
            <Badge variant="info">
              {activeCount} active filter{activeCount === 1 ? "" : "s"}
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          {resultCount !== undefined ? (
            <span className="text-xs font-medium tabular-nums text-muted-foreground">
              {resultCount.toLocaleString()} {resultLabel}
            </span>
          ) : null}
          {onClear && activeCount > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-blue-800 hover:bg-blue-100 hover:text-blue-950 dark:text-blue-200 dark:hover:bg-blue-950"
              onClick={onClear}
            >
              <FilterX className="mr-1.5 h-3.5 w-3.5" />
              Clear
            </Button>
          ) : null}
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end">
        {children}
      </div>
    </section>
  )
}

export function AdminMetricCard({
  label,
  value,
  description,
  icon: Icon,
  tone = "neutral",
  className,
}: {
  label: string
  value: ReactNode
  description?: string
  icon?: LucideIcon
  tone?: AdminTone
  className?: string
}) {
  const styles = TONE_STYLES[tone]
  return (
    <Card
      className={cn("min-w-0 rounded-2xl shadow-sm", styles.surface, className)}
    >
      <CardContent className="flex items-start justify-between gap-4 p-5">
        <div className="min-w-0">
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
          <div
            className={cn(
              "mt-1 break-words text-2xl font-bold tracking-tight tabular-nums",
              styles.value,
            )}
          >
            {value}
          </div>
          {description ? (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {Icon ? (
          <div
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
              styles.icon,
            )}
          >
            <Icon className="h-5 w-5" />
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

export function AdminNotice({
  title,
  children,
  tone = "info",
  className,
}: {
  title: string
  children: ReactNode
  tone?: AdminTone
  className?: string
}) {
  const styles = TONE_STYLES[tone]
  const Icon =
    tone === "success"
      ? CheckCircle2
      : tone === "danger" || tone === "warning"
        ? CircleAlert
        : SlidersHorizontal
  return (
    <div
      className={cn(
        "flex min-w-0 gap-3 rounded-xl border p-4 text-sm",
        styles.surface,
        className,
      )}
    >
      <div
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
          styles.icon,
        )}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="font-semibold">{title}</p>
        <div className="mt-1 break-words text-muted-foreground">{children}</div>
      </div>
    </div>
  )
}

export function AdminEmptyState({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <SearchX className="h-5 w-5" />
      </div>
      <p className="mt-4 font-semibold">{title}</p>
      <p className="mt-1 max-w-sm text-sm leading-6 text-muted-foreground">
        {description}
      </p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}

export function AdminStatusBadge({
  children,
  tone,
}: {
  children: ReactNode
  tone: AdminTone
}) {
  const variant: BadgeProps["variant"] =
    tone === "danger"
      ? "destructive"
      : tone === "warning"
        ? "warning"
        : tone === "success"
          ? "success"
          : tone === "info"
            ? "info"
            : "secondary"
  return <Badge variant={variant}>{children}</Badge>
}
