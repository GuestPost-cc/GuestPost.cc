import {
  type Order,
  type OrderStatus,
  type PaymentStatus,
  Prisma,
} from "@guestpost/database"
import { ConflictException } from "@nestjs/common"

export const ORDER_TRANSITION_CONFLICT_MESSAGE =
  "Order was modified by another request. Retry."

type OrderTransitionDatabase = Pick<Prisma.TransactionClient, "order">
type OrderTransitionPatch = Pick<
  Prisma.OrderUncheckedUpdateManyInput,
  | "assigneeId"
  | "acceptedAt"
  | "fulfillmentDueAt"
  | "revisionCount"
  | "submittedAt"
>

interface OrderTransitionCasBaseInput {
  db: OrderTransitionDatabase
  orderId: string
  expectedVersion: number
  fromStatus: OrderStatus
  toStatus: OrderStatus
  patch?: OrderTransitionPatch
}

type PaymentStatusTransition =
  | { fromPaymentStatus?: never; toPaymentStatus?: never }
  | {
      fromPaymentStatus: PaymentStatus
      toPaymentStatus: PaymentStatus
    }

export type TransitionOrderCasInput = OrderTransitionCasBaseInput &
  PaymentStatusTransition

/**
 * Compare-and-swap an Order lifecycle mutation and return the committed row.
 *
 * The helper owns the status mutation and aggregate version increment. Its
 * patch whitelist intentionally excludes identity, contract, settlement-fence
 * and delivery-evidence fields; those require their own domain predicates.
 */
export async function transitionOrderCas({
  db,
  orderId,
  expectedVersion,
  fromStatus,
  toStatus,
  fromPaymentStatus,
  toPaymentStatus,
  patch = {},
}: TransitionOrderCasInput): Promise<Order> {
  const updated = await db.order.updateMany({
    where: {
      id: orderId,
      version: expectedVersion,
      status: fromStatus,
      ...(fromPaymentStatus === undefined
        ? {}
        : { paymentStatus: fromPaymentStatus }),
    },
    data: {
      ...patch,
      status: toStatus,
      ...(toPaymentStatus === undefined
        ? {}
        : { paymentStatus: toPaymentStatus }),
      version: { increment: 1 },
    },
  })

  if (updated.count !== 1) {
    throw new ConflictException(ORDER_TRANSITION_CONFLICT_MESSAGE)
  }

  return db.order.findUniqueOrThrow({ where: { id: orderId } })
}
