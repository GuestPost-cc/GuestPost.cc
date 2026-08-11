export const EMAIL_DELIVERY_LEASE_MS = 15 * 60 * 1000

export interface EmailDeliveryLease {
  attempts: number
  lockedAt: Date
}

interface LeaseRecord {
  status: string
  attempts: number
  lockedAt: Date | null
}

export function ownsEmailDeliveryLease(
  delivery: LeaseRecord,
  lease: EmailDeliveryLease,
): boolean {
  return (
    delivery.status === "PROCESSING" &&
    delivery.attempts === lease.attempts &&
    delivery.lockedAt !== null &&
    delivery.lockedAt.getTime() === lease.lockedAt.getTime()
  )
}

export function emailDeliveryLeaseWhere(id: string, lease: EmailDeliveryLease) {
  return {
    id,
    channel: "EMAIL" as const,
    status: "PROCESSING" as const,
    attempts: lease.attempts,
    lockedAt: lease.lockedAt,
  }
}

function nextLeaseTimestamp(current: Date, requested: Date): Date {
  return new Date(Math.max(requested.getTime(), current.getTime() + 1))
}

/**
 * Crosses the external-side-effect boundary under the exact database lease.
 * Once this succeeds, automatic recovery must quarantine an unknown outcome
 * rather than let a replacement claimant submit the same SMTP message.
 */
export async function beginEmailDispatch(
  db: any,
  deliveryId: string,
  lease: EmailDeliveryLease,
  requestedAt = new Date(),
): Promise<EmailDeliveryLease | null> {
  const dispatchStartedAt = nextLeaseTimestamp(lease.lockedAt, requestedAt)
  const claimed = await db.communicationDelivery.updateMany({
    where: {
      ...emailDeliveryLeaseWhere(deliveryId, lease),
      dispatchStartedAt: null,
    },
    data: {
      lockedAt: dispatchStartedAt,
      dispatchStartedAt,
    },
  })
  return claimed.count === 1
    ? { attempts: lease.attempts, lockedAt: dispatchStartedAt }
    : null
}

/**
 * Recovers only work that provably never crossed the SMTP boundary. An
 * expired dispatch is terminally uncertain and requires provider/operator
 * reconciliation; it is never selected by the automatic retry sweep.
 */
export async function recoverExpiredEmailDeliveryLeases(
  db: any,
  input: { now?: Date; deliveryId?: string } = {},
): Promise<{ retryable: number; uncertain: number }> {
  const now = input.now ?? new Date()
  const expiredBefore = new Date(now.getTime() - EMAIL_DELIVERY_LEASE_MS)
  const idWhere = input.deliveryId ? { id: input.deliveryId } : {}
  const uncertain = await db.communicationDelivery.updateMany({
    where: {
      ...idWhere,
      channel: "EMAIL",
      status: "PROCESSING",
      lockedAt: { lt: expiredBefore },
      dispatchStartedAt: { not: null },
    },
    data: {
      status: "DELIVERY_UNCERTAIN",
      lockedAt: null,
      failedAt: now,
      lastError:
        "SMTP outcome unknown after delivery lease expiry; reconcile manually",
    },
  })
  const retryable = await db.communicationDelivery.updateMany({
    where: {
      ...idWhere,
      channel: "EMAIL",
      status: "PROCESSING",
      lockedAt: { lt: expiredBefore },
      dispatchStartedAt: null,
    },
    data: {
      status: "FAILED",
      lockedAt: null,
      availableAt: now,
      failedAt: now,
      lastError: "Recovered an expired pre-dispatch delivery lease",
    },
  })
  return { retryable: retryable.count, uncertain: uncertain.count }
}
