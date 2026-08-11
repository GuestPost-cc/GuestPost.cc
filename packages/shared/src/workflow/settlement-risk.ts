export interface SettlementCustomerHistory {
  chargebackCount: number
  disputeCount: number
}

export interface SettlementCustomerScope {
  organizationId: string | null | undefined
  customerId: string | null | undefined
}

interface SettlementRiskReader {
  paymentDispute: {
    count(args: unknown): Promise<number>
  }
  orderDispute: {
    count(args: unknown): Promise<number>
  }
}

function requireCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} history count is invalid`)
  }
  return value
}

/**
 * Loads the durable customer risk evidence used when a settlement policy is
 * snapshotted. This must be called with the transaction that owns settlement
 * creation; every current caller uses the canonical SERIALIZABLE Order
 * transaction, so the read is coherent and a serialization retry reloads it.
 * Auto-release loads the same evidence again after locking the Order, covering
 * risk that committed after the immutable creation-time policy snapshot.
 *
 * Organization scope is authoritative for current shared wallets. User scope
 * keeps legacy personal-wallet and user-created deposit evidence visible. An
 * absent scope is an evidence failure, never an implicit clean history.
 */
export async function loadSettlementCustomerHistory(
  tx: SettlementRiskReader,
  scope: SettlementCustomerScope,
): Promise<SettlementCustomerHistory> {
  const organizationId = scope.organizationId?.trim() || null
  const customerId = scope.customerId?.trim() || null
  if (!organizationId && !customerId) {
    throw new Error("Settlement customer risk scope is unavailable")
  }

  const paymentScopes: Record<string, unknown>[] = []
  const orderScopes: Record<string, unknown>[] = []
  if (organizationId) {
    paymentScopes.push(
      { depositAttempt: { organizationId } },
      { wallet: { organizationId } },
    )
    orderScopes.push({ organizationId })
  }
  if (customerId) {
    paymentScopes.push(
      { depositAttempt: { createdByUserId: customerId } },
      { wallet: { userId: customerId } },
    )
    orderScopes.push({ customerId })
  }

  const [chargebackCount, disputeCount] = await Promise.all([
    tx.paymentDispute.count({ where: { OR: paymentScopes } }),
    tx.orderDispute.count({ where: { order: { OR: orderScopes } } }),
  ])

  return {
    chargebackCount: requireCount(chargebackCount, "Chargeback"),
    disputeCount: requireCount(disputeCount, "Order dispute"),
  }
}
