// Lock ordering policy
// =====================
// Existing-withdrawal payout transactions MUST acquire aggregate locks in
// this order to prevent deadlocks. A verified provider-inbox row, when
// present, is locked first.
//
//   1. PayoutWebhookEvent (webhook path only)
//   2. Withdrawal
//   3. PayoutExecution
//   4. PublisherBalance
//   5. PayoutProvider (execution/send paths)
//   6. PublisherProviderAccount (managed routes)
//   7. PayoutMethod
//
// A new withdrawal reservation has no Withdrawal row to lock yet. It starts
// with any Settlement/Transaction allocation parents, updates
// PublisherBalance, and only then lets the deferred liability trigger take
// PublisherProviderAccount -> PayoutMethod at commit. Thus every managed path
// shares the same routing suffix without inverting settlement release's
// Settlement -> PublisherBalance order.
//
// Settlement/refund flows have separate aggregate roots; any new transaction
// that crosses those domains needs an explicit deadlock-order review.
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
