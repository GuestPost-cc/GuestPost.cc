/**
 * Phase 7.9 #28 — single source of truth for status presentation across
 * portal / publisher / admin.
 *
 * Replaces ~29 inline `statusColors` consts scattered across 9 pages.
 * Pages used to render the SAME status with 3 different greens
 * (`green-700`, `emerald-700`, `#22c55e`); after this module the
 * appearance is unified.
 *
 * Design choices:
 *
 * 1. **Per-family typed accessors** (`getOrderStatusPresentation` etc.),
 *    not a generic `(family, status: string)` function. Cross-domain
 *    confusion like `getTicketStatusPresentation("PUBLISHED")` is
 *    rejected at COMPILE time. The whole class of "wrong status family"
 *    bug becomes a type error.
 *
 * 2. **Status types are imported from Prisma's generated enums**, not
 *    handwritten. When a future schema change adds or renames a status
 *    value, the `Record<XStatus, StatusPresentation>` shape below fails
 *    `tsc` with "Property 'X' is missing" or "Type 'Y' does not exist".
 *    A handwritten union would silently survive such a change and
 *    re-introduce drift — defeats the purpose.
 *
 * 3. **No `icon` field on `StatusPresentation`.** Pages that pair an
 *    icon with a status (e.g. dashboard timeline) keep their icon
 *    mapping LOCAL. Centralizing it would invite every page-specific
 *    visual concern (badge size, animation, hover state, click
 *    handler) to creep in. The table stays focused on color + label —
 *    the only things that need cross-page consistency.
 *
 * 4. **Cross-family deliberate divergence preserved.** Ticket `OPEN`
 *    renders `info` (blue) because tickets are conversational and
 *    blue reads "active". Dispute `OPEN` renders `destructive` (red)
 *    because disputes are adversarial and red reads "this needs
 *    attention". Both are intentional — a future contributor who
 *    "fixes" them to match each other should read this comment first.
 */

import type {
  CampaignStatus,
  DisputeStatus,
  ListingStatus,
  OrderStatus,
  TicketStatus,
} from "@guestpost/database"

export type StatusVariant =
  | "default"
  | "success"
  | "warning"
  | "destructive"
  | "info"
  | "pending"

export interface StatusPresentation {
  /** Maps to the variant prop on `<StatusBadge>`. */
  variant: StatusVariant
  /** Human form ("In Progress" not "IN_PROGRESS"). */
  label: string
  /** Hex for Recharts `<Cell fill={...}>` and other inline-style needs. */
  chartColor: string
}

// ─── Order (18 states) ──────────────────────────────────────────────────────

export const ORDER_STATUS_PRESENTATION: Record<
  OrderStatus,
  StatusPresentation
> = {
  DRAFT: { variant: "pending", label: "Draft", chartColor: "#9ca3af" },
  PENDING_PAYMENT: {
    variant: "warning",
    label: "Pending Payment",
    chartColor: "#f59e0b",
  },
  PAID: { variant: "info", label: "Paid", chartColor: "#3b82f6" },
  SUBMITTED: { variant: "info", label: "Submitted", chartColor: "#3b82f6" },
  ACCEPTED: { variant: "info", label: "Accepted", chartColor: "#3b82f6" },
  CONTENT_REQUESTED: {
    variant: "info",
    label: "Content Requested",
    chartColor: "#3b82f6",
  },
  CONTENT_CREATION: {
    variant: "info",
    label: "Content Creation",
    chartColor: "#3b82f6",
  },
  CONTENT_READY: {
    variant: "info",
    label: "Content Ready",
    chartColor: "#3b82f6",
  },
  CUSTOMER_REVIEW: {
    variant: "warning",
    label: "Customer Review",
    chartColor: "#f59e0b",
  },
  APPROVED: { variant: "success", label: "Approved", chartColor: "#10b981" },
  PUBLISHED: { variant: "success", label: "Published", chartColor: "#22c55e" },
  VERIFIED: { variant: "success", label: "Verified", chartColor: "#10b981" },
  DELIVERED: { variant: "success", label: "Delivered", chartColor: "#10b981" },
  SETTLED: { variant: "success", label: "Settled", chartColor: "#10b981" },
  COMPLETED: { variant: "success", label: "Completed", chartColor: "#10b981" },
  CANCELLED: {
    variant: "destructive",
    label: "Cancelled",
    chartColor: "#ef4444",
  },
  REFUNDED: {
    variant: "destructive",
    label: "Refunded",
    chartColor: "#ef4444",
  },
  DISPUTED: {
    variant: "destructive",
    label: "Disputed",
    chartColor: "#ef4444",
  },
}

// ─── Ticket (5 states) — `OPEN` is INFO (blue) by deliberate choice ────────

export const TICKET_STATUS_PRESENTATION: Record<
  TicketStatus,
  StatusPresentation
> = {
  OPEN: { variant: "info", label: "Open", chartColor: "#3b82f6" },
  IN_PROGRESS: {
    variant: "warning",
    label: "In Progress",
    chartColor: "#f59e0b",
  },
  WAITING_ON_CUSTOMER: {
    variant: "pending",
    label: "Waiting on Customer",
    chartColor: "#a78bfa",
  },
  RESOLVED: { variant: "success", label: "Resolved", chartColor: "#10b981" },
  CLOSED: { variant: "pending", label: "Closed", chartColor: "#9ca3af" },
}

// ─── Dispute (5 states) — `OPEN` is DESTRUCTIVE (red) by deliberate choice ─

export const DISPUTE_STATUS_PRESENTATION: Record<
  DisputeStatus,
  StatusPresentation
> = {
  OPEN: { variant: "destructive", label: "Open", chartColor: "#ef4444" },
  UNDER_REVIEW: {
    variant: "warning",
    label: "Under Review",
    chartColor: "#f59e0b",
  },
  RESOLVED_REFUNDED: {
    variant: "info",
    label: "Resolved (Refund)",
    chartColor: "#3b82f6",
  },
  RESOLVED_REJECTED: {
    variant: "pending",
    label: "Resolved (Rejected)",
    chartColor: "#9ca3af",
  },
  RESOLVED_RESTORED: {
    variant: "success",
    label: "Resolved (Restored)",
    chartColor: "#10b981",
  },
}

// ─── Listing (6 states) ─────────────────────────────────────────────────────

export const LISTING_STATUS_PRESENTATION: Record<
  ListingStatus,
  StatusPresentation
> = {
  DRAFT: { variant: "pending", label: "Draft", chartColor: "#9ca3af" },
  PENDING_REVIEW: {
    variant: "warning",
    label: "Pending Review",
    chartColor: "#f59e0b",
  },
  APPROVED: { variant: "success", label: "Approved", chartColor: "#10b981" },
  REJECTED: {
    variant: "destructive",
    label: "Rejected",
    chartColor: "#ef4444",
  },
  PAUSED: { variant: "warning", label: "Paused", chartColor: "#f59e0b" },
  ARCHIVED: { variant: "pending", label: "Archived", chartColor: "#9ca3af" },
}

// ─── Campaign (4 states — Prisma has 4, not 2 as roadmap noted) ────────────

export const CAMPAIGN_STATUS_PRESENTATION: Record<
  CampaignStatus,
  StatusPresentation
> = {
  ACTIVE: { variant: "success", label: "Active", chartColor: "#10b981" },
  PAUSED: { variant: "warning", label: "Paused", chartColor: "#f59e0b" },
  COMPLETED: { variant: "success", label: "Completed", chartColor: "#10b981" },
  ARCHIVED: { variant: "pending", label: "Archived", chartColor: "#9ca3af" },
}

// ─── Per-family accessors ───────────────────────────────────────────────────
//
// These exist purely for type safety: `getOrderStatusPresentation("PAID")`
// compiles; `getTicketStatusPresentation("PAID")` does NOT (PAID isn't a
// TicketStatus). Cross-family confusion is the whole class of bug we're
// preventing — it's a compile-time error, not a runtime fallback.

export function getOrderStatusPresentation(s: OrderStatus): StatusPresentation {
  return ORDER_STATUS_PRESENTATION[s] ?? ORDER_STATUS_PRESENTATION.DRAFT
}
export function getTicketStatusPresentation(
  s: TicketStatus,
): StatusPresentation {
  return TICKET_STATUS_PRESENTATION[s] ?? TICKET_STATUS_PRESENTATION.OPEN
}
export function getDisputeStatusPresentation(
  s: DisputeStatus,
): StatusPresentation {
  return DISPUTE_STATUS_PRESENTATION[s] ?? DISPUTE_STATUS_PRESENTATION.OPEN
}
export function getListingStatusPresentation(
  s: ListingStatus,
): StatusPresentation {
  return LISTING_STATUS_PRESENTATION[s] ?? LISTING_STATUS_PRESENTATION.DRAFT
}
export function getCampaignStatusPresentation(
  s: CampaignStatus,
): StatusPresentation {
  return (
    CAMPAIGN_STATUS_PRESENTATION[s] ?? CAMPAIGN_STATUS_PRESENTATION.ARCHIVED
  )
}
