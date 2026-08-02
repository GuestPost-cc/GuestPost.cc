import {
  isRetryablePrismaTransactionError,
  prismaTransactionRetryDelayMs,
} from "./prisma-transaction-retry"

const MAX_SERIALIZABLE_TRANSACTION_ATTEMPTS = 3

/**
 * Runs rollback-safe database work at SERIALIZABLE with a small, bounded
 * retry budget for trusted PostgreSQL serialization/deadlock codes only.
 * Validation, authorization, invariant, and constraint errors are never
 * retried. The callback must contain only rollback-safe database work; queue,
 * email, provider, and other external I/O belongs after this function returns.
 */
export async function runSerializableTransactionWithRetry<T>(
  prisma: any,
  operation: (tx: any) => Promise<T>,
): Promise<T> {
  for (
    let attempt = 1;
    attempt <= MAX_SERIALIZABLE_TRANSACTION_ATTEMPTS;
    attempt++
  ) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: "Serializable",
      })
    } catch (error) {
      if (
        attempt === MAX_SERIALIZABLE_TRANSACTION_ATTEMPTS ||
        !isRetryablePrismaTransactionError(error)
      ) {
        throw error
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, prismaTransactionRetryDelayMs(attempt)),
      )
    }
  }

  // The loop either returns or throws. Keep an explicit terminal for type
  // systems and future refactors that alter its bounds.
  throw new Error("Serializable transaction retry budget exhausted")
}

/**
 * Backwards-compatible, domain-specific name retained for settlement callers.
 */
export const runSettlementSerializableTransaction =
  runSerializableTransactionWithRetry
