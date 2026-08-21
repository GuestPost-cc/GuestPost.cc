import type { LucideIcon } from "lucide-react"
import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  Info,
  ShieldAlert,
} from "lucide-react"
import { Badge, type BadgeProps } from "./badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./card"

export type OrderStakeholderUpdateKind =
  | "SECURITY_REVIEW_OPENED"
  | "SECURITY_REVIEW_CLEARED"
  | "SECURITY_VIOLATION_CONFIRMED"
  | "CUSTOMER_REFUND_COMPLETED"
  | "PUBLISHER_COMPENSATION_DECIDED"

export type OrderStakeholderUpdateStatus =
  | "PENDING"
  | "ACTION_REQUIRED"
  | "COMPLETED"

export type OrderStakeholderUpdateSeverity =
  | "INFO"
  | "WARNING"
  | "CRITICAL"
  | "SUCCESS"

export interface OrderStakeholderFinancialImpact {
  currency: string
  customerRefund?: string
  publisherCompensation?: string
  debtApplied?: string
  netPublisherCredit?: string
}

export interface OrderStakeholderUpdate {
  id: string
  kind: OrderStakeholderUpdateKind
  occurredAt: string
  status: OrderStakeholderUpdateStatus
  severity: OrderStakeholderUpdateSeverity
  title: string
  summary: string
  financialImpact?: OrderStakeholderFinancialImpact
}

export interface OrderStakeholderUpdatesProps {
  updates: readonly OrderStakeholderUpdate[]
  title?: string
  description?: string
  className?: string
}

const severityPresentation: Record<
  OrderStakeholderUpdateSeverity,
  {
    icon: LucideIcon
    iconClassName: string
    itemClassName: string
  }
> = {
  INFO: {
    icon: Info,
    iconClassName: "text-blue-700 dark:text-blue-300",
    itemClassName:
      "border-blue-200 bg-blue-50/50 dark:border-blue-900 dark:bg-blue-950/20",
  },
  WARNING: {
    icon: AlertTriangle,
    iconClassName: "text-amber-700 dark:text-amber-300",
    itemClassName:
      "border-amber-200 bg-amber-50/50 dark:border-amber-900 dark:bg-amber-950/20",
  },
  CRITICAL: {
    icon: ShieldAlert,
    iconClassName: "text-red-700 dark:text-red-300",
    itemClassName:
      "border-red-200 bg-red-50/50 dark:border-red-900 dark:bg-red-950/20",
  },
  SUCCESS: {
    icon: CheckCircle2,
    iconClassName: "text-emerald-700 dark:text-emerald-300",
    itemClassName:
      "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/20",
  },
}

const statusPresentation: Record<
  OrderStakeholderUpdateStatus,
  { label: string; variant: BadgeProps["variant"] }
> = {
  PENDING: { label: "Pending", variant: "info" },
  ACTION_REQUIRED: { label: "Action required", variant: "warning" },
  COMPLETED: { label: "Completed", variant: "success" },
}

const financialLabels: Array<
  [keyof Omit<OrderStakeholderFinancialImpact, "currency">, string]
> = [
  ["customerRefund", "Customer refund"],
  ["publisherCompensation", "Publisher compensation"],
  ["debtApplied", "Debt applied"],
  ["netPublisherCredit", "Net publisher credit"],
]

function formatOccurredAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Time unavailable"
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)
}

function updateTimestamp(value: string): number {
  const timestamp = new Date(value).getTime()
  return Number.isNaN(timestamp) ? 0 : timestamp
}

function FinancialImpact({
  impact,
}: {
  impact: OrderStakeholderFinancialImpact
}) {
  const visible = financialLabels.filter(([key]) => impact[key] !== undefined)
  if (visible.length === 0) return null

  return (
    <dl className="mt-3 grid gap-2 rounded-lg border bg-background/80 p-3 text-sm sm:grid-cols-2">
      {visible.map(([key, label]) => (
        <div key={key}>
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="mt-0.5 font-semibold tabular-nums">
            <bdi>{impact[key]}</bdi> <bdi>{impact.currency}</bdi>
          </dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * Persistent, server-projected decision history for order stakeholders.
 * Financial fields are rendered only when the role-aware API includes them.
 */
export function OrderStakeholderUpdates({
  updates,
  title = "Decisions and financial outcomes",
  description = "Official review decisions and completed financial effects for this order.",
  className,
}: OrderStakeholderUpdatesProps) {
  const ordered = [...updates].sort((left, right) => {
    const byTime =
      updateTimestamp(right.occurredAt) - updateTimestamp(left.occurredAt)
    return byTime || right.id.localeCompare(left.id)
  })

  if (ordered.length === 0) return null

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="rounded-full bg-primary/10 p-2 text-primary">
            <CircleAlert className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <CardTitle className="text-base">{title}</CardTitle>
            <CardDescription className="mt-1">{description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ol className="space-y-3" aria-label="Official order decisions">
          {ordered.map((update) => {
            const severity =
              severityPresentation[update.severity] ?? severityPresentation.INFO
            const status =
              statusPresentation[update.status] ?? statusPresentation.PENDING
            const Icon = severity.icon
            return (
              <li key={update.id}>
                <article
                  className={`rounded-xl border p-4 ${severity.itemClassName}`}
                  aria-label={update.title}
                >
                  <div className="flex items-start gap-3">
                    <Icon
                      className={`mt-0.5 h-5 w-5 shrink-0 ${severity.iconClassName}`}
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <h4 className="font-semibold" dir="auto">
                          {update.title}
                        </h4>
                        <Badge variant={status.variant}>{status.label}</Badge>
                      </div>
                      <p
                        className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground"
                        dir="auto"
                      >
                        {update.summary}
                      </p>
                      {update.financialImpact ? (
                        <FinancialImpact impact={update.financialImpact} />
                      ) : null}
                      <time
                        className="mt-3 block text-xs text-muted-foreground"
                        dateTime={update.occurredAt}
                      >
                        {formatOccurredAt(update.occurredAt)}
                      </time>
                    </div>
                  </div>
                </article>
              </li>
            )
          })}
        </ol>
      </CardContent>
    </Card>
  )
}
