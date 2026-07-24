import type { PrismaService } from "./prisma.service"

const PERMANENTLY_UNLOCKING_DEPOSIT_STATUSES = [
  "SUCCEEDED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
] as const

export async function canCustomerViewWebsite(
  prisma: PrismaService,
  organizationId?: string | null,
): Promise<boolean> {
  if (!organizationId) return false

  const successfulDeposit = prisma.depositAttempt?.findFirst
    ? await prisma.depositAttempt.findFirst({
        where: {
          organizationId,
          status: { in: [...PERMANENTLY_UNLOCKING_DEPOSIT_STATUSES] },
        },
        select: { id: true },
      })
    : null
  if (successfulDeposit) return true

  // Deposits recorded before provider-neutral DepositAttempt rollout remain
  // authoritative. A DEPOSIT ledger row is written only by the verified
  // credit path, so spending or refunding the balance never re-locks access.
  const legacyLedgerDeposit = prisma.transaction?.findFirst
    ? await prisma.transaction.findFirst({
        where: {
          type: "DEPOSIT",
          wallet: { organizationId },
        },
        select: { id: true },
      })
    : null
  return legacyLedgerDeposit !== null
}
