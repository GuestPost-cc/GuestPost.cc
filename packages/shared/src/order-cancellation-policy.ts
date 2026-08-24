/**
 * Pure cancellation policy shared by the API and browser clients.
 *
 * This module intentionally uses string unions instead of Prisma types so it
 * stays browser-safe and cannot drift behind a generated database client.
 */

export const IMMEDIATE_CANCELLATION_STATUSES = [
  "DRAFT",
  "PENDING_PAYMENT",
  "PAID",
  "SUBMITTED",
] as const

export const CANCELLATION_REQUEST_STATUSES = [
  "ACCEPTED",
  "CONTENT_REQUESTED",
  "CONTENT_CREATION",
  "CONTENT_READY",
  "CUSTOMER_REVIEW",
  "APPROVED",
] as const

export const DISPUTE_CANCELLATION_STATUSES = [
  "PUBLISHED",
  "VERIFIED",
  "DELIVERED",
  "COMPLETED",
] as const

export const CANCELLATION_TERMINAL_STATUSES = [
  "CANCELLED",
  "REFUNDED",
  "DISPUTED",
] as const

export const ACTIVE_CANCELLATION_REQUEST_STATUSES = [
  "REQUESTED",
  "UNDER_REVIEW",
  "PENDING_FINANCE",
  "ESCALATED",
] as const

export const REFUNDABLE_ORDER_STATUSES = [
  "PAID",
  "SUBMITTED",
  ...CANCELLATION_REQUEST_STATUSES,
  ...DISPUTE_CANCELLATION_STATUSES,
  "DISPUTED",
] as const

export const FULFILLMENT_WORK_STATUSES = [
  "SUBMITTED",
  ...CANCELLATION_REQUEST_STATUSES,
] as const

export type CancellationActor = "CUSTOMER" | "PUBLISHER" | "STAFF" | "SYSTEM"
export type CancellationAction =
  | "CANCEL_NOW"
  | "DECLINE_NOW"
  | "REQUEST_CANCELLATION"
  | "OPEN_DISPUTE"
  | "NOT_ALLOWED"

export interface OrderCancellationPolicyInput {
  status: string
  paymentStatus: string
  fulfillmentChannel: "PUBLISHER" | "PLATFORM"
  actor: CancellationActor
  hasActiveRequest?: boolean
  hasActiveDispute?: boolean
  fulfillmentDueAt?: Date | string | null
  warrantyEndsAt?: Date | string | null
  now?: Date
}

export interface OrderCancellationDecision {
  action: CancellationAction
  refundRequired: boolean
  requiresCounterpartyResponse: boolean
  requiresStaffReview: boolean
  message: string
}

function includes(values: readonly string[], value: string): boolean {
  return values.includes(value)
}

export function decideOrderCancellation(
  input: OrderCancellationPolicyInput,
): OrderCancellationDecision {
  if (input.hasActiveRequest) {
    return denied("A cancellation request is already active for this order.")
  }

  if (input.hasActiveDispute || input.status === "DISPUTED") {
    return denied("This order is already in dispute review.")
  }

  if (includes(CANCELLATION_TERMINAL_STATUSES, input.status)) {
    return denied("This order is already in a terminal state.")
  }

  if (input.actor === "CUSTOMER") {
    if (includes(IMMEDIATE_CANCELLATION_STATUSES, input.status)) {
      return {
        action: "CANCEL_NOW",
        refundRequired: input.paymentStatus === "PAID",
        requiresCounterpartyResponse: false,
        requiresStaffReview: false,
        message:
          input.paymentStatus === "PAID"
            ? "Cancel now and return the full amount to the customer wallet."
            : "Cancel this unpaid draft now.",
      }
    }

    if (includes(CANCELLATION_REQUEST_STATUSES, input.status)) {
      return requestDecision(
        input.fulfillmentChannel,
        deadlineExpired(input.fulfillmentDueAt, input.now),
      )
    }

    if (includes(DISPUTE_CANCELLATION_STATUSES, input.status)) {
      if (input.status === "COMPLETED") {
        if (!input.warrantyEndsAt) {
          return denied(
            "This completed order has no post-completion warranty. Contact support if further review is required.",
          )
        }
        if (deadlineExpired(input.warrantyEndsAt, input.now)) {
          return denied(
            "The post-completion warranty has expired. Contact support if further review is required.",
          )
        }
      }
      return {
        action: "OPEN_DISPUTE",
        refundRequired: false,
        requiresCounterpartyResponse: false,
        requiresStaffReview: true,
        message:
          "Open a dispute so delivery evidence and settlement can be reviewed.",
      }
    }
  }

  if (input.actor === "PUBLISHER") {
    if (input.fulfillmentChannel !== "PUBLISHER") {
      return denied(
        "Publisher actions are not available for platform-fulfilled orders.",
      )
    }

    if (input.status === "SUBMITTED") {
      return {
        action: "DECLINE_NOW",
        refundRequired: true,
        requiresCounterpartyResponse: false,
        requiresStaffReview: false,
        message: "Decline the unaccepted order and issue a full wallet refund.",
      }
    }

    if (includes(CANCELLATION_REQUEST_STATUSES, input.status)) {
      return requestDecision(
        input.fulfillmentChannel,
        deadlineExpired(input.fulfillmentDueAt, input.now),
      )
    }
  }

  if (input.actor === "STAFF") {
    if (
      input.fulfillmentChannel === "PLATFORM" &&
      input.status === "SUBMITTED"
    ) {
      return {
        action: "DECLINE_NOW",
        refundRequired: true,
        requiresCounterpartyResponse: false,
        requiresStaffReview: false,
        message:
          "Decline the unaccepted platform order and issue a full wallet refund.",
      }
    }

    if (includes(CANCELLATION_REQUEST_STATUSES, input.status)) {
      return requestDecision(
        input.fulfillmentChannel,
        deadlineExpired(input.fulfillmentDueAt, input.now),
      )
    }
  }

  return denied(
    "Cancellation is not available to this actor at the current stage.",
  )
}

function requestDecision(
  channel: "PUBLISHER" | "PLATFORM",
  fulfillmentDeadlineMissed = false,
): OrderCancellationDecision {
  return {
    action: "REQUEST_CANCELLATION",
    refundRequired: false,
    requiresCounterpartyResponse: true,
    requiresStaffReview: false,
    message: fulfillmentDeadlineMissed
      ? channel === "PLATFORM"
        ? "The platform fulfillment deadline was missed. Request cancellation for Operations review."
        : "The publisher fulfillment deadline was missed. Request cancellation from the publisher."
      : channel === "PLATFORM"
        ? "Request cancellation from the platform operations team."
        : "Request cancellation from the publisher.",
  }
}

function deadlineExpired(
  value: Date | string | null | undefined,
  now = new Date(),
): boolean {
  if (!value) return false
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isFinite(timestamp) && timestamp <= now.getTime()
}

function denied(message: string): OrderCancellationDecision {
  return {
    action: "NOT_ALLOWED",
    refundRequired: false,
    requiresCounterpartyResponse: false,
    requiresStaffReview: false,
    message,
  }
}

/**
 * Staff-review SLA clock for fraud-confirmed handoff cases. Unlike
 * counterparty REQUEST_CANCELLATION flows (which deadline the responder),
 * this bounds how long a confirmed-fraud case may sit before its first
 * staff review without surfacing as overdue on every workbench.
 */
export function computeFraudHandoffDeadline(
  now: Date,
  fraudReviewWindowHours: number,
): Date {
  return new Date(now.getTime() + fraudReviewWindowHours * 3_600_000)
}

/**
 * Whole days a case has sat in its current active state. Callers pass the
 * case row's updatedAt, which every review transition bumps — so any human
 * progress resets the stall clock.
 */
export function caseStalledDays(updatedAt: Date, now: Date): number {
  const elapsed = now.getTime() - updatedAt.getTime()
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 0
  return Math.floor(elapsed / 86_400_000)
}

/**
 * Reminder cadence for stalled cases: first nudge at firstReminderDays,
 * then every intervalDays thereafter. Pure so the API and worker share one
 * definition of "due".
 */
export function isCaseStallReminderDue(
  stalledDays: number,
  firstReminderDays: number,
  intervalDays: number,
): boolean {
  if (!Number.isFinite(stalledDays) || stalledDays < firstReminderDays) {
    return false
  }
  return (stalledDays - firstReminderDays) % intervalDays === 0
}
