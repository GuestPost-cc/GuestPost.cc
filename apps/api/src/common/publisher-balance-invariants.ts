import { Logger } from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/client"

export class PublisherBalanceInvariantError extends Error {
  constructor(context: string, violations: string[]) {
    super(
      `Publisher balance invariant failed in ${context}: ${violations.join(", ")}`,
    )
    this.name = "PublisherBalanceInvariantError"
  }
}

export function checkPublisherBalanceInvariant(
  balance: {
    withdrawableBalance?: any
    debtBalance?: any
    publisherId?: string
  } | null,
  logger: Logger,
  context: string,
) {
  if (!balance) return
  const withdrawable = new Decimal(balance.withdrawableBalance ?? 0)
  const debt = new Decimal(balance.debtBalance ?? 0)
  const violations: string[] = []

  if (!withdrawable.isFinite() || withdrawable.isNegative()) {
    violations.push("withdrawableBalance must be finite and non-negative")
  }
  if (!debt.isFinite() || debt.isNegative()) {
    violations.push("debtBalance must be finite and non-negative")
  }
  if (violations.length === 0) return

  logger.error(
    {
      publisherId: balance.publisherId,
      withdrawableBalance: withdrawable.toString(),
      debtBalance: debt.toString(),
      context,
      violations,
    },
    "publisher balance invariant violation",
  )
  throw new PublisherBalanceInvariantError(context, violations)
}
