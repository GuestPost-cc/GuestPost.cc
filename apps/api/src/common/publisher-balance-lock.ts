// Lock ordering policy
// =====================
// All financial transactions MUST acquire locks in this order to prevent
// deadlocks. Violation introduces a cycle risk.
//
//   1. PublisherBalance
//   2. Withdrawal
//   3. Settlement
//   4. Wallet
//   5. Order
//
// Current acquisition points:
//   - executeWithdrawal Tx1:             1 → 2
//   - refundOrder clawback section:      1 → 3
//   - adminApprove/forceApprove tx:      3 → (releaseFundsInternal: 1)
//   - adminApprove/forceApprove tx:      3 → (releaseFundsInternal: 4 → 5)
//
// Analysis: adminApprove acquires Settlement (3) then PublisherBalance (1).
// executeWithdrawal acquires PublisherBalance (1) then Withdrawal (2).
//      Path A: 3 → 1
//      Path B: 1 → 2
//      No cycle: A and B share only resource 1, and both lock it. The
//      second resource differs (2 vs 3), so no circular wait exists.
//
// All paths are consistent with the canonical order above. If a new
// path touches multiple resources, verify it follows this order.
//
// SAFETY: This helper MUST be called inside an existing Prisma interactive
// transaction (i.e., within a $transaction(async (tx) => { ... }) callback).
// Calling it outside a transaction (passing the top-level prisma client) will
// cause the FOR UPDATE lock to be released as soon as the query returns,
// silently breaking the concurrency guarantee. There is no way to assert this
// at runtime because Prisma's type system doesn't distinguish tx from prisma.

export async function lockPublisherBalanceForUpdate(
  tx: any,
  publisherId: string,
) {
  const [row] = await tx.$queryRaw<
    any[]
  >`SELECT * FROM "PublisherBalance" WHERE "publisherId" = ${publisherId} FOR UPDATE`
  return row ?? null
}
