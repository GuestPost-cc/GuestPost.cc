import { ConflictException } from "@nestjs/common"
import type { AuditService } from "../../audit/audit.service"

export const DELIVERY_FRAUD_REVIEW_REQUIRED =
  "DELIVERY_FRAUD_REVIEW_REQUIRED" as const

const BLOCKED_ATTEMPT_AUDIT_WINDOW_MS = 60 * 60 * 1000

interface DeliveryFraudHoldSummary {
  fraudFlagId: string
  deliveryVersionId: string
  type: string
}

export interface DeliveryFraudBlock {
  blocked: true
  count: number
}

async function unresolvedHolds(
  tx: any,
  orderId: string,
): Promise<DeliveryFraudHoldSummary[]> {
  return tx.deliveryFraudHold.findMany({
    where: { orderId },
    orderBy: { createdAt: "asc" },
    select: {
      fraudFlagId: true,
      deliveryVersionId: true,
      type: true,
    },
  })
}

/**
 * Staff delivery decisions must never adjudicate fraud as a side effect.
 * Every hold is resolved independently through the classified fraud endpoint.
 */
export async function assertNoUnresolvedDeliveryFraudHolds(
  tx: any,
  orderId: string,
): Promise<void> {
  const holds = await unresolvedHolds(tx, orderId)
  if (holds.length === 0) return
  throw new ConflictException({
    code: DELIVERY_FRAUD_REVIEW_REQUIRED,
    message:
      "Resolve every delivery fraud hold explicitly before approving this delivery.",
    unresolvedHolds: holds,
  })
}

/**
 * Customer denials are committed as throttled audit evidence without exposing
 * fraud types, related order IDs, or investigator-only details in the API.
 * The caller throws the public conflict only after this audit-only transaction
 * commits, so the denial cannot accidentally commit a delivery transition.
 */
export async function recordCustomerDeliveryFraudBlock(
  tx: any,
  audit: AuditService,
  input: {
    action: "CONFIRM" | "MANUAL_ACCEPT"
    orderId: string
    deliveryVersionId: string
    organizationId: string
    userId: string
    now: Date
  },
): Promise<DeliveryFraudBlock | null> {
  const holds = await unresolvedHolds(tx, input.orderId)
  if (holds.length === 0) return null

  const action = `ORDER_DELIVERY_CUSTOMER_${input.action}_BLOCKED_FRAUD`
  const recent = await tx.auditLog.findFirst({
    where: {
      action,
      entityType: "OrderDeliveryVersion",
      entityId: input.deliveryVersionId,
      userId: input.userId,
      createdAt: {
        gte: new Date(input.now.getTime() - BLOCKED_ATTEMPT_AUDIT_WINDOW_MS),
      },
    },
    select: { id: true },
  })
  if (!recent) {
    await audit.log(
      {
        action,
        entityType: "OrderDeliveryVersion",
        entityId: input.deliveryVersionId,
        metadata: {
          orderId: input.orderId,
          deliveryVersionId: input.deliveryVersionId,
          fraudHoldCount: holds.length,
          fraudFlagIds: holds.map((hold) => hold.fraudFlagId),
          fraudTypes: [...new Set(holds.map((hold) => hold.type))],
          decision: "BLOCKED_PENDING_STAFF_REVIEW",
        },
        userId: input.userId,
        organizationId: input.organizationId,
      },
      tx,
    )
  }
  return { blocked: true, count: holds.length }
}

export function deliveryFraudReviewRequiredForCustomer(): ConflictException {
  return new ConflictException({
    code: DELIVERY_FRAUD_REVIEW_REQUIRED,
    message:
      "This delivery is under security review and cannot be accepted yet. Support will notify you when review is complete.",
  })
}
