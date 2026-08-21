import {
  type DeliveryUrlReuseFreshnessResult,
  refreshDeliveryUrlReuseEvidenceUnderLock,
} from "./delivery-url-claim-core"
import { lockOrderAggregate } from "./order-aggregate-lock"

// Settlement gating — the platform never settles on a human "done" claim. A
// settlement may be created/released only when delivery is independently
// verified (or explicitly manual-approved), with no open dispute, no active
// revision, and no fraud flags.
//
// Architecture:
//   SettlementEligibilitySnapshot — the data needed to decide (pure data)
//   buildSettlementEligibilitySnapshot(db, orderId) — data access (generic)
//   buildLockedSettlementEligibilitySnapshot(tx, orderId) — lock + data access
//   evaluateSettlementEligibility(snapshot) — pure business logic (no DB)
//
// This separation means callers can use any database handle (PrismaClient or
// TransactionClient) with the same snapshot builder, and the eligibility rules
// are defined once in the pure function.

export interface SettlementEligibility {
  eligible: boolean
  reasons: string[]
  blockers: SettlementEligibilityBlocker[]
}

export type SettlementEligibilityBlockerCode =
  | "ORDER_STATUS"
  | "ORDER_CURRENCY"
  | "ORDER_PAYMENT_STATUS"
  | "ACTIVE_DELIVERY_MISSING"
  | "ACTIVE_DELIVERY_ORDER_MISMATCH"
  | "ACTIVE_DELIVERY_SUPERSEDED"
  | "ACTIVE_DELIVERY_REJECTED"
  | "ACTIVE_DELIVERY_UNVERIFIED"
  | "ACTIVE_DISPUTE"
  | "ACTIVE_REVISION"
  | "ACTIVE_CANCELLATION"
  | "UNRESOLVED_FRAUD"

export interface SettlementEligibilityBlocker {
  code: SettlementEligibilityBlockerCode
  message: string
}

export interface SettlementEligibilitySnapshot {
  orderStatus: string
  orderVersion: number
  orderCurrency: string
  orderPaymentStatus: string
  activeDeliveryVersionId: string | null
  activeDeliveryMatchesOrder: boolean
  activeDeliveryIsCurrent: boolean
  activeDeliveryVerificationStatus: string | null
  activeDeliveryInterventionStatus: string | null
  hasActiveDispute: boolean
  hasActiveRevision: boolean
  hasActiveCancellationRequest: boolean
  fraudFlagCount: number
}

// A revision blocks unless it is explicitly terminal. This is intentionally a
// terminal allowlist: newly-added workflow states fail closed instead of
// silently becoming payout-eligible.
const TERMINAL_REVISION_STATUSES = ["APPROVED", "REJECTED"]
const SETTLEMENT_SAFE_DISPUTE_STATUSES = [
  "RESOLVED_REJECTED",
  "RESOLVED_RESTORED",
]
/** Pure evaluator — no DB access. Decides eligibility from a data snapshot. */
export function evaluateSettlementEligibility(
  snapshot: SettlementEligibilitySnapshot,
): SettlementEligibility {
  const blockers: SettlementEligibilityBlocker[] = []
  const block = (code: SettlementEligibilityBlockerCode, message: string) => {
    blockers.push({ code, message })
  }

  if (snapshot.orderStatus !== "DELIVERED") {
    block(
      "ORDER_STATUS",
      `Order status is ${snapshot.orderStatus}, expected DELIVERED`,
    )
  }

  if (snapshot.orderCurrency !== "USD") {
    block(
      "ORDER_CURRENCY",
      `Order currency is ${snapshot.orderCurrency}, expected USD`,
    )
  }

  if (snapshot.orderPaymentStatus !== "PAID") {
    block(
      "ORDER_PAYMENT_STATUS",
      `Order payment status is ${snapshot.orderPaymentStatus}, expected PAID`,
    )
  }

  if (!snapshot.activeDeliveryVersionId) {
    block("ACTIVE_DELIVERY_MISSING", "No active delivery version")
  } else {
    if (!snapshot.activeDeliveryMatchesOrder) {
      block(
        "ACTIVE_DELIVERY_ORDER_MISMATCH",
        "Active delivery version does not belong to the order",
      )
    }
    if (!snapshot.activeDeliveryIsCurrent) {
      block(
        "ACTIVE_DELIVERY_SUPERSEDED",
        "Active delivery version is superseded",
      )
    }
    const explicitlyRejected =
      snapshot.activeDeliveryInterventionStatus === "REJECTED"
    const verified = snapshot.activeDeliveryVerificationStatus === "VERIFIED"
    // APPROVED and OVERRIDDEN are durable manual decisions. Any workflow that
    // starts a fresh automated verification must atomically reset the
    // intervention to NONE with that transition.
    const manuallyApproved =
      snapshot.activeDeliveryInterventionStatus === "APPROVED" ||
      snapshot.activeDeliveryInterventionStatus === "OVERRIDDEN"
    if (explicitlyRejected) {
      block(
        "ACTIVE_DELIVERY_REJECTED",
        "Active delivery was explicitly rejected",
      )
    } else if (!verified && !manuallyApproved) {
      block(
        "ACTIVE_DELIVERY_UNVERIFIED",
        `Active delivery is ${snapshot.activeDeliveryVerificationStatus} and not manually approved`,
      )
    }
  }

  if (snapshot.hasActiveDispute) {
    block("ACTIVE_DISPUTE", "Order has an active dispute")
  }

  if (snapshot.hasActiveRevision) {
    block("ACTIVE_REVISION", "Order has an active revision in progress")
  }

  if (snapshot.hasActiveCancellationRequest) {
    block("ACTIVE_CANCELLATION", "Order has an active cancellation request")
  }

  if (snapshot.fraudFlagCount > 0) {
    block(
      "UNRESOLVED_FRAUD",
      `Order has ${snapshot.fraudFlagCount} active fraud hold(s)`,
    )
  }

  return {
    eligible: blockers.length === 0,
    reasons: blockers.map((blocker) => blocker.message),
    blockers,
  }
}

/**
 * Builds a SettlementEligibilitySnapshot from any database handle that
 * supports the Prisma model methods used here. Works with both top-level
 * PrismaClient and Prisma.TransactionClient.
 */
export async function buildSettlementEligibilitySnapshot(
  db: any,
  orderId: string,
): Promise<SettlementEligibilitySnapshot> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      version: true,
      currency: true,
      paymentStatus: true,
      activeDeliveryVersionId: true,
    },
  })
  return buildSnapshotForOrder(db, orderId, order)
}

/**
 * Locks the complete settlement-eligibility decision set before reading it.
 *
 * This helper MUST receive a Prisma interactive transaction client. The Order
 * row is the aggregate serialization point. Database blocker triggers acquire
 * this same parent lock before inserting, updating, or deleting a delivery,
 * dispute, revision, fraud flag, or cancellation request. Do not also lock the
 * child rows here: an UPDATE owns its child row before its BEFORE trigger runs,
 * so taking parent then child in this reader would create an avoidable
 * parent/child deadlock.
 */
export async function buildLockedSettlementEligibilitySnapshot(
  tx: any,
  orderId: string,
): Promise<SettlementEligibilitySnapshot> {
  const state = await buildLockedSettlementEligibilityState(tx, orderId)
  return state.snapshot
}

async function buildLockedSettlementEligibilityState(
  tx: any,
  orderId: string,
): Promise<{
  snapshot: SettlementEligibilitySnapshot
  urlReuseFreshness: DeliveryUrlReuseFreshnessResult | null
}> {
  // Fixed SQL plus bound interpolation only. Keep this lock order stable across
  // every create/approve/release caller.
  await lockOrderAggregate(tx, orderId)
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      version: true,
      currency: true,
      paymentStatus: true,
      activeDeliveryVersionId: true,
      organizationId: true,
    },
  })

  let urlReuseFreshness: DeliveryUrlReuseFreshnessResult | null = null
  if (order?.activeDeliveryVersionId) {
    const activeDelivery = await tx.orderDeliveryVersion.findUnique({
      where: { id: order.activeDeliveryVersionId },
      select: {
        id: true,
        orderId: true,
        normalizedUrl: true,
        supersededByVersion: true,
      },
    })
    if (
      activeDelivery?.orderId === orderId &&
      activeDelivery.supersededByVersion === null
    ) {
      urlReuseFreshness = await refreshDeliveryUrlReuseEvidenceUnderLock(tx, {
        orderId,
        deliveryVersionId: activeDelivery.id,
        normalizedUrl: activeDelivery.normalizedUrl,
        organizationId: order.organizationId,
        actorUserId: null,
        source: "SETTLEMENT_ELIGIBILITY",
      })
    }
  }

  return {
    snapshot: await buildSnapshotForOrder(tx, orderId, order),
    urlReuseFreshness,
  }
}

export async function evaluateLockedSettlementEligibility(
  tx: any,
  orderId: string,
): Promise<
  SettlementEligibility & {
    snapshot: SettlementEligibilitySnapshot
    urlReuseEvidenceCreated: boolean
    urlReuseCommunicationEventId: string | null
    urlReuseCommunicationDedupKey: string | null
  }
> {
  const state = await buildLockedSettlementEligibilityState(tx, orderId)
  return {
    ...evaluateSettlementEligibility(state.snapshot),
    snapshot: state.snapshot,
    urlReuseEvidenceCreated:
      state.urlReuseFreshness?.createdFlagId !== null &&
      state.urlReuseFreshness?.createdFlagId !== undefined,
    urlReuseCommunicationEventId:
      state.urlReuseFreshness?.communicationEventId ?? null,
    urlReuseCommunicationDedupKey:
      state.urlReuseFreshness?.communicationDedupKey ?? null,
  }
}

async function buildSnapshotForOrder(
  db: any,
  orderId: string,
  order: {
    status: string
    version: number
    currency: string
    paymentStatus: string
    activeDeliveryVersionId: string | null
  } | null,
): Promise<SettlementEligibilitySnapshot> {
  if (!order) {
    return {
      orderStatus: "NOT_FOUND",
      orderVersion: -1,
      orderCurrency: "NOT_FOUND",
      orderPaymentStatus: "NOT_FOUND",
      activeDeliveryVersionId: null,
      activeDeliveryMatchesOrder: false,
      activeDeliveryIsCurrent: false,
      activeDeliveryVerificationStatus: null,
      activeDeliveryInterventionStatus: null,
      hasActiveDispute: false,
      hasActiveRevision: false,
      hasActiveCancellationRequest: false,
      fraudFlagCount: 0,
    }
  }

  let activeDeliveryVerificationStatus: string | null = null
  let activeDeliveryInterventionStatus: string | null = null
  let activeDeliveryMatchesOrder = false
  let activeDeliveryIsCurrent = false

  if (order.activeDeliveryVersionId) {
    const active = await db.orderDeliveryVersion.findUnique({
      where: { id: order.activeDeliveryVersionId },
    })
    if (active) {
      activeDeliveryMatchesOrder = active.orderId === orderId
      activeDeliveryIsCurrent = active.supersededByVersion == null
      activeDeliveryVerificationStatus = active.verificationStatus
      activeDeliveryInterventionStatus = active.interventionStatus
    }
  }

  const dispute = await db.orderDispute.findFirst({
    // Terminal allowlist: a refunded dispute and any future state fail closed.
    where: { orderId, status: { notIn: SETTLEMENT_SAFE_DISPUTE_STATUSES } },
  })

  const activeRevision = await db.revision.findFirst({
    where: { orderId, status: { notIn: TERMINAL_REVISION_STATUSES } },
  })

  // Cancellation is deliberately expressed as a safe terminal allowlist.
  // Unknown/new statuses, disputed requests, and approved refund requests all
  // block settlement. APPROVED is only safe when the adjudicated resolution
  // explicitly says to continue the order.
  const activeCancellationRequest = await db.orderCancellationRequest.findFirst(
    {
      where: {
        orderId,
        OR: [
          { status: { notIn: ["REJECTED", "WITHDRAWN", "APPROVED"] } },
          { status: "APPROVED", resolution: null },
          { status: "APPROVED", resolution: { not: "CONTINUE_ORDER" } },
        ],
      },
    },
  )

  // DeliveryFraudHold is the database-maintained settlement authority. A
  // confirmed finding intentionally retains its hold even though the signal
  // has been adjudicated, so `resolution: null` is not a safe proxy here.
  const fraud = await db.deliveryFraudHold.count({ where: { orderId } })

  return {
    orderStatus: order.status,
    orderVersion: order.version,
    orderCurrency: order.currency,
    orderPaymentStatus: order.paymentStatus,
    activeDeliveryVersionId: order.activeDeliveryVersionId,
    activeDeliveryMatchesOrder,
    activeDeliveryIsCurrent,
    activeDeliveryVerificationStatus,
    activeDeliveryInterventionStatus,
    hasActiveDispute: !!dispute,
    hasActiveRevision: !!activeRevision,
    hasActiveCancellationRequest: !!activeCancellationRequest,
    fraudFlagCount: fraud,
  }
}

// Separation of duties: for platform-owned inventory the user who fulfilled an
// order (submitted the active delivery) may NOT be the user who releases its
// settlement. Returns the violation reason, or null if OK.
export function checkSeparationOfDuties(params: {
  ownershipType: string
  fulfilledByUserId: string | null | undefined
  releasedByUserId: string
}): string | null {
  if (params.ownershipType !== "PLATFORM") return null
  if (
    params.fulfilledByUserId &&
    params.fulfilledByUserId === params.releasedByUserId
  ) {
    return "Separation of duties: the user who fulfilled this platform order cannot release its settlement"
  }
  return null
}
