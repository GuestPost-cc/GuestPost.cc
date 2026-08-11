import { runSerializableTransactionWithRetry } from "./settlement-transaction"

/**
 * Acquire the parent Order row before mutating any settlement-blocking child.
 *
 * PostgreSQL BEFORE triggers on OrderDeliveryVersion, OrderDispute, Revision,
 * DeliveryFraudFlag, and OrderCancellationRequest acquire the same lock. A
 * caller that mutates a child before taking this lock can deadlock with a
 * settlement transition that locks Order first. Keep this as the first SQL
 * statement in retryable aggregate-write transactions.
 */
export async function lockOrderAggregate(
  tx: any,
  orderId: string,
): Promise<void> {
  // Fixed SQL with Prisma-bound interpolation; orderId is never concatenated.
  await tx.$queryRaw`SELECT "id" FROM public."Order" WHERE "id" = ${orderId} FOR UPDATE`
}

/**
 * Run rollback-safe Order aggregate database work using the canonical parent
 * lock order and bounded retries for PostgreSQL serialization/deadlock errors.
 * External I/O (providers, queues, email) must happen after this returns.
 */
export async function runLockedOrderSerializableTransaction<T>(
  prisma: any,
  orderId: string,
  operation: (tx: any) => Promise<T>,
): Promise<T> {
  return runSerializableTransactionWithRetry(prisma, async (tx) => {
    await lockOrderAggregate(tx, orderId)
    return operation(tx)
  })
}
