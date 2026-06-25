// Order-scoped support panel. Renders the list of tickets attached to one
// order with a channel badge, status pill, and "Open ticket" CTA. Shared
// between the portal (customer), publisher, and admin order-detail pages.
//
// Kept purely presentational on purpose:
//   - Callers fetch and filter tickets themselves (each app has its own
//     api client + query layer).
//   - Callers pass a `linkHref(ticketId)` factory because each app routes
//     its support detail page at a different path.
//   - `actorScope` only controls the empty-state copy — it does NOT scope
//     the data. Server-side authz already enforces visibility.

import type * as React from "react"
import { cn } from "../lib/utils"
import { Button } from "./button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./card"
import {
  FulfillmentChannelBadge,
  type FulfillmentChannelValue,
} from "./fulfillment-channel-badge"
import { Skeleton } from "./skeleton"

export interface SupportPanelTicket {
  id: string
  subject: string
  status: string
  updatedAt?: string | null
  createdAt?: string | null
  fulfillmentChannel?: FulfillmentChannelValue
  lastMessagePreview?: string | null
  lastResponderRole?:
    | "CUSTOMER"
    | "PUBLISHER"
    | "OPERATIONS"
    | "ADMIN"
    | "FINANCE"
    | string
    | null
}

export type SupportPanelActorScope =
  | "customer"
  | "publisher"
  | "operations"
  | "admin"
  | "finance"

export interface SupportPanelProps {
  tickets: SupportPanelTicket[] | undefined
  isLoading?: boolean
  onOpenNew?: () => void
  linkHref?: (ticketId: string) => string
  actorScope?: SupportPanelActorScope
  title?: string
  description?: string
  emptyState?: React.ReactNode
  className?: string
}

const EMPTY_COPY: Record<SupportPanelActorScope, string> = {
  customer:
    "No tickets yet for this order. Open one if something's blocking you.",
  publisher:
    "No tickets on this order. Customers will reach you here if they need help.",
  operations: "No support activity on this order yet.",
  admin: "No support activity on this order yet.",
  finance: "No support activity on this order yet.",
}

export function SupportPanel({
  tickets,
  isLoading,
  onOpenNew,
  linkHref,
  actorScope = "customer",
  title = "Support",
  description = "Tickets attached to this order.",
  emptyState,
  className,
}: SupportPanelProps) {
  return (
    <Card className={cn("mt-6", className)}>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">{title}</CardTitle>
            <CardDescription className="text-xs">{description}</CardDescription>
          </div>
          {onOpenNew && (
            <Button size="sm" variant="outline" onClick={onOpenNew}>
              Open ticket
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : !tickets || tickets.length === 0 ? (
          (emptyState ?? (
            <p className="text-sm text-muted-foreground">
              {EMPTY_COPY[actorScope]}
            </p>
          ))
        ) : (
          <ul className="space-y-2">
            {tickets.map((ticket) => (
              <li key={ticket.id}>
                <SupportTicketRow ticket={ticket} linkHref={linkHref} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function SupportTicketRow({
  ticket,
  linkHref,
}: {
  ticket: SupportPanelTicket
  linkHref?: (id: string) => string
}) {
  const updated = ticket.updatedAt ?? ticket.createdAt
  const updatedLabel = updated ? new Date(updated).toLocaleDateString() : null

  const content = (
    <div className="flex items-start justify-between gap-3 rounded-md border p-3 transition-colors hover:bg-muted/40">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <FulfillmentChannelBadge channel={ticket.fulfillmentChannel} />
          <span className="truncate text-sm font-medium">{ticket.subject}</span>
        </div>
        {ticket.lastMessagePreview && (
          <p className="line-clamp-2 text-xs text-muted-foreground">
            {ticket.lastResponderRole && (
              <span className="font-medium uppercase tracking-wide">
                {ticket.lastResponderRole.toLowerCase()}:
              </span>
            )}{" "}
            {ticket.lastMessagePreview}
          </p>
        )}
        {updatedLabel && (
          <p className="text-xs text-muted-foreground">
            Updated {updatedLabel}
          </p>
        )}
      </div>
      <StatusPill status={ticket.status} />
    </div>
  )

  if (!linkHref) return content

  return (
    <a
      href={linkHref(ticket.id)}
      className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md"
    >
      {content}
    </a>
  )
}

function StatusPill({ status }: { status: string }) {
  const tone = statusTone(status)
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium capitalize",
        tone,
      )}
    >
      {status.toLowerCase().replace(/_/g, " ")}
    </span>
  )
}

function statusTone(status: string): string {
  const s = status.toUpperCase()
  if (s === "OPEN" || s === "AWAITING_CUSTOMER" || s === "AWAITING_REPLY") {
    return "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300"
  }
  if (s === "IN_PROGRESS" || s === "ASSIGNED") {
    return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
  }
  if (s === "RESOLVED" || s === "CLOSED") {
    return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
  }
  return "bg-muted text-muted-foreground"
}
