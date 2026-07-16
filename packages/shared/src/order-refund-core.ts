export type FinalRefundResponsibility =
  | "CUSTOMER"
  | "PUBLISHER"
  | "PLATFORM"
  | "SHARED"
  | "SYSTEM"

export class OrderRefundConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OrderRefundConflictError"
  }
}

export interface UnacceptedPaidOrder {
  id: string
  organizationId: string
  status: string
  paymentStatus: string
  amount: unknown
  version: number
}

export interface UnacceptedRefundAuditData {
  action: string
  entityType: "Order"
  entityId: string
  metadata: Record<string, unknown>
  userId: string | null
  organizationId: string
}

export async function refundUnacceptedPaidOrderInTransaction(
  tx: any,
  order: UnacceptedPaidOrder,
  input: {
    reference: string
    reason: string
    responsibility: FinalRefundResponsibility
    actorUserId: string | null
    auditAction: string
    auditMetadata?: Record<string, unknown>
  },
  writeAudit: (data: UnacceptedRefundAuditData, tx: any) => Promise<unknown>,
) {
  if (!["PAID", "SUBMITTED"].includes(order.status)) {
    throw new OrderRefundConflictError(
      `Unaccepted refund cannot run from ${order.status}`,
    )
  }
  if (order.paymentStatus !== "PAID") {
    throw new OrderRefundConflictError(
      "Unaccepted refund requires captured payment",
    )
  }

  const wallet = await tx.wallet.findUnique({
    where: { organizationId: order.organizationId },
  })
  if (!wallet) {
    throw new OrderRefundConflictError(
      `Wallet missing for paid order ${order.id}`,
    )
  }

  const walletUpdated = await tx.wallet.updateMany({
    where: { id: wallet.id, version: wallet.version },
    data: {
      availableBalance: { increment: order.amount ?? 0 },
      version: { increment: 1 },
    },
  })
  if (walletUpdated.count === 0) {
    throw new OrderRefundConflictError(
      `Wallet changed during refund ${order.id}`,
    )
  }

  const orderUpdated = await tx.order.updateMany({
    where: {
      id: order.id,
      version: order.version,
      status: order.status,
      paymentStatus: "PAID",
    },
    data: {
      status: "REFUNDED",
      paymentStatus: "REFUNDED",
      refundResponsibility: input.responsibility,
      version: { increment: 1 },
    },
  })
  if (orderUpdated.count === 0) {
    throw new OrderRefundConflictError(
      `Order changed during refund ${order.id}`,
    )
  }

  await tx.fulfillmentAssignment.updateMany({
    where: {
      orderId: order.id,
      status: { in: ["ASSIGNED", "IN_PROGRESS"] },
    },
    data: { status: "CANCELLED", version: { increment: 1 } },
  })

  const transaction = await tx.transaction.create({
    data: {
      amount: order.amount ?? 0,
      type: "REFUND",
      orderId: order.id,
      walletId: wallet.id,
      reference: input.reference,
      description: `Refund for order ${order.id}: ${input.reason}`,
    },
  })

  await tx.orderEvent.create({
    data: {
      orderId: order.id,
      eventType: "REFUND_ISSUED",
      actorId: input.actorUserId,
      message: `Order refunded: ${input.reason}`,
      metadata: {
        reason: input.reason,
        responsibility: input.responsibility,
        refundTransactionId: transaction.id,
      },
    },
  })

  await writeAudit(
    {
      action: input.auditAction,
      entityType: "Order",
      entityId: order.id,
      metadata: {
        fromStatus: order.status,
        responsibility: input.responsibility,
        refundTransactionId: transaction.id,
        ...input.auditMetadata,
      },
      userId: input.actorUserId,
      organizationId: order.organizationId,
    },
    tx,
  )

  return {
    order: await tx.order.findUniqueOrThrow({ where: { id: order.id } }),
    refundTransactionId: transaction.id,
  }
}
