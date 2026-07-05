// Settlement gating — the platform never settles on a human "done" claim. A
// settlement may be created/released only when delivery is independently
// verified (or explicitly manual-approved), with no open dispute, no active
// revision, and no fraud flags.
//
// Architecture:
//   SettlementEligibilitySnapshot — the data needed to decide (pure data)
//   buildSettlementEligibilitySnapshot(db, orderId) — data access (generic)
//   evaluateSettlementEligibility(snapshot) — pure business logic (no DB)
//
// This separation means callers can use any database handle (PrismaClient or
// TransactionClient) with the same snapshot builder, and the eligibility rules
// are defined once in the pure function.

export interface SettlementEligibility {
  eligible: boolean
  reasons: string[]
}

export interface SettlementEligibilitySnapshot {
  orderStatus: string
  activeDeliveryVersionId: string | null
  activeDeliveryVerificationStatus: string | null
  activeDeliveryInterventionStatus: string | null
  hasActiveDispute: boolean
  hasActiveRevision: boolean
  fraudFlagCount: number
}

// Active-revision = a revision the publisher still owes. Terminal revision
// states do not block.
const ACTIVE_REVISION_STATUSES = ["REQUESTED", "PENDING"]

/** Pure evaluator — no DB access. Decides eligibility from a data snapshot. */
export function evaluateSettlementEligibility(
  snapshot: SettlementEligibilitySnapshot,
): SettlementEligibility {
  const reasons: string[] = []

  if (snapshot.orderStatus !== "DELIVERED") {
    reasons.push(`Order status is ${snapshot.orderStatus}, expected DELIVERED`)
  }

  if (!snapshot.activeDeliveryVersionId) {
    reasons.push("No active delivery version")
  } else {
    const verified = snapshot.activeDeliveryVerificationStatus === "VERIFIED"
    const manuallyApproved =
      snapshot.activeDeliveryInterventionStatus === "APPROVED" ||
      snapshot.activeDeliveryInterventionStatus === "OVERRIDDEN"
    if (!verified && !manuallyApproved) {
      reasons.push(
        `Active delivery is ${snapshot.activeDeliveryVerificationStatus} and not manually approved`,
      )
    }
  }

  if (snapshot.hasActiveDispute) {
    reasons.push("Order has an active dispute")
  }

  if (snapshot.hasActiveRevision) {
    reasons.push("Order has an active revision in progress")
  }

  if (snapshot.fraudFlagCount > 0) {
    reasons.push(
      `Order has ${snapshot.fraudFlagCount} unresolved fraud flag(s)`,
    )
  }

  return { eligible: reasons.length === 0, reasons }
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
  const order = await db.order.findUnique({ where: { id: orderId } })
  if (!order) {
    return {
      orderStatus: "NOT_FOUND",
      activeDeliveryVersionId: null,
      activeDeliveryVerificationStatus: null,
      activeDeliveryInterventionStatus: null,
      hasActiveDispute: false,
      hasActiveRevision: false,
      fraudFlagCount: 0,
    }
  }

  let activeDeliveryVerificationStatus: string | null = null
  let activeDeliveryInterventionStatus: string | null = null

  if (order.activeDeliveryVersionId) {
    const active = await db.orderDeliveryVersion.findUnique({
      where: { id: order.activeDeliveryVersionId },
    })
    if (active) {
      activeDeliveryVerificationStatus = active.verificationStatus
      activeDeliveryInterventionStatus = active.interventionStatus
    }
  }

  const dispute = await db.orderDispute.findFirst({
    where: { orderId, status: { in: ["OPEN", "UNDER_REVIEW"] } },
  })

  const activeRevision = await db.revision.findFirst({
    where: { orderId, status: { in: ACTIVE_REVISION_STATUSES } },
  })

  const fraud = await db.deliveryFraudFlag.count({ where: { orderId } })

  return {
    orderStatus: order.status,
    activeDeliveryVersionId: order.activeDeliveryVersionId,
    activeDeliveryVerificationStatus,
    activeDeliveryInterventionStatus,
    hasActiveDispute: !!dispute,
    hasActiveRevision: !!activeRevision,
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
