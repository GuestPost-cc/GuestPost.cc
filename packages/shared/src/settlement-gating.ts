// Settlement gating — the platform never settles on a human "done" claim. A
// settlement may be created/released only when delivery is independently
// verified (or explicitly manual-approved), with no open dispute, no active
// revision, and no fraud flags. Pure logic, DI prisma — unit testable.

export interface SettlementEligibility {
  eligible: boolean
  reasons: string[]
}

// Active-revision = a revision the publisher still owes. Terminal revision
// states do not block.
const ACTIVE_REVISION_STATUSES = ["REQUESTED", "IN_PROGRESS"]

export async function evaluateSettlementEligibility(
  prisma: any,
  orderId: string,
): Promise<SettlementEligibility> {
  const reasons: string[] = []

  const order = await prisma.order.findUnique({ where: { id: orderId } })
  if (!order) return { eligible: false, reasons: ["Order not found"] }

  // Order must be DELIVERED
  if (order.status !== "DELIVERED") {
    reasons.push(`Order status is ${order.status}, expected DELIVERED`)
  }

  // Active delivery must exist
  if (!order.activeDeliveryVersionId) {
    reasons.push("No active delivery version")
  } else {
    const active = await prisma.orderDeliveryVersion.findUnique({
      where: { id: order.activeDeliveryVersionId },
    })
    if (!active) {
      reasons.push("Active delivery version missing")
    } else {
      const verified = active.verificationStatus === "VERIFIED"
      const manuallyApproved =
        active.interventionStatus === "APPROVED" ||
        active.interventionStatus === "OVERRIDDEN"
      if (!verified && !manuallyApproved) {
        reasons.push(
          `Active delivery is ${active.verificationStatus} and not manually approved`,
        )
      }
    }
  }

  // No open or under-review dispute (same active-status set as auto-approve)
  const dispute = await prisma.orderDispute.findFirst({
    where: { orderId, status: { in: ["OPEN", "UNDER_REVIEW"] } },
  })
  if (dispute) {
    reasons.push("Order has an active dispute")
  }

  // No active revision
  const activeRevision = await prisma.revision.findFirst({
    where: { orderId, status: { in: ACTIVE_REVISION_STATUSES } },
  })
  if (activeRevision) {
    reasons.push("Order has an active revision in progress")
  }

  // No fraud flags
  const fraud = await prisma.deliveryFraudFlag.count({ where: { orderId } })
  if (fraud > 0) {
    reasons.push(`Order has ${fraud} unresolved fraud flag(s)`)
  }

  return { eligible: reasons.length === 0, reasons }
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
