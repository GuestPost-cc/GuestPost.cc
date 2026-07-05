import { Logger } from "@nestjs/common"

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
  const w = Number(balance.withdrawableBalance ?? 0)
  const d = Number(balance.debtBalance ?? 0)
  if (w < 0) {
    logger.warn(
      {
        publisherId: balance.publisherId,
        withdrawableBalance: w,
        debtBalance: d,
        context,
      },
      "invariant: withdrawableBalance below zero",
    )
  }
  if (d < 0) {
    logger.warn(
      {
        publisherId: balance.publisherId,
        withdrawableBalance: w,
        debtBalance: d,
        context,
      },
      "invariant: debtBalance below zero",
    )
  }
}
