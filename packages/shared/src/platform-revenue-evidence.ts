import { normalizePositiveUsdMoney } from "./money"

export interface PlatformRevenueOrderEvidence {
  id: string
  amount: unknown
  currency: unknown
  paymentStatus: unknown
  fulfillmentChannel: unknown
  organizationId: unknown
}

export type PlatformRevenueEvidenceErrorCode =
  | "INVALID_PLATFORM_ORDER"
  | "INVALID_PURCHASE_EVIDENCE"

export class PlatformRevenueEvidenceError extends Error {
  readonly name = "PlatformRevenueEvidenceError"

  constructor(
    readonly code: PlatformRevenueEvidenceErrorCode,
    message: string,
  ) {
    super(message)
  }
}

interface PurchaseEvidenceRow {
  amount: unknown
  currency: unknown
  walletId: unknown
  publisherId: unknown
  settlementId: unknown
  provider: unknown
  providerRef: unknown
  wallet: {
    currency: unknown
    organizationId: unknown
  } | null
}

/**
 * Fail-closed application check for the canonical funding evidence required by
 * a new PlatformRevenue row. Callers must already hold the parent Order lock;
 * PostgreSQL independently repeats these relational checks in its insert
 * trigger so direct SQL and stale application pods cannot bypass them.
 */
export async function assertCanonicalPlatformRevenueFundingCore(
  tx: {
    transaction: {
      findMany(args: {
        where: { orderId: string; type: "PURCHASE" }
        select: Record<string, unknown>
        orderBy: { id: "asc" }
        take: number
      }): Promise<PurchaseEvidenceRow[]>
    }
  },
  order: PlatformRevenueOrderEvidence,
): Promise<void> {
  const gross = normalizePositiveUsdMoney(order.amount)
  if (
    !gross ||
    order.currency !== "USD" ||
    order.paymentStatus !== "PAID" ||
    order.fulfillmentChannel !== "PLATFORM" ||
    typeof order.organizationId !== "string" ||
    order.organizationId.length === 0
  ) {
    throw new PlatformRevenueEvidenceError(
      "INVALID_PLATFORM_ORDER",
      "Platform revenue requires a paid exact-USD PLATFORM order",
    )
  }

  // Read up to two even though the migration adds a partial unique index. This
  // stays safe during rolling deployment and makes duplicate legacy evidence a
  // hard failure rather than selecting an arbitrary row.
  const purchases = await tx.transaction.findMany({
    where: { orderId: order.id, type: "PURCHASE" },
    select: {
      amount: true,
      currency: true,
      walletId: true,
      publisherId: true,
      settlementId: true,
      provider: true,
      providerRef: true,
      wallet: { select: { currency: true, organizationId: true } },
    },
    orderBy: { id: "asc" },
    take: 2,
  })
  const purchase = purchases.length === 1 ? purchases[0] : null
  const purchaseText = purchase ? String(purchase.amount) : ""
  const purchasedGross = purchaseText.startsWith("-")
    ? normalizePositiveUsdMoney(purchaseText.slice(1))
    : null

  if (
    !purchase ||
    purchasedGross !== gross ||
    purchase.currency !== "USD" ||
    typeof purchase.walletId !== "string" ||
    purchase.walletId.length === 0 ||
    purchase.publisherId !== null ||
    purchase.settlementId !== null ||
    purchase.provider !== null ||
    purchase.providerRef !== null ||
    !purchase.wallet ||
    purchase.wallet.currency !== "USD" ||
    purchase.wallet.organizationId !== order.organizationId
  ) {
    throw new PlatformRevenueEvidenceError(
      "INVALID_PURCHASE_EVIDENCE",
      "Platform revenue requires one exact canonical PURCHASE ledger row",
    )
  }
}
