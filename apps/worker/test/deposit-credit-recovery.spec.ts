import assert from "node:assert/strict"
import test from "node:test"

process.env.DATABASE_URL ??=
  "postgresql://guestpost:guestpost@127.0.0.1:5432/guestpost_test"

function fakeClient(options: { locked?: boolean } = {}) {
  const writes: any[] = []
  const reads: any[] = []
  const recovery = {
    id: "recovery-1",
    depositAttemptId: "attempt-1",
    provider: "stripe",
    status: options.locked ? "PROCESSING" : "PENDING",
    attempts: options.locked ? 1 : 0,
    lockedAt: options.locked ? new Date("2026-08-12T00:00:00.000Z") : null,
    depositAttempt: {
      id: "attempt-1",
      providerSessionId: "cs_test_recovery",
      ledgerTransactionId: null,
      status: "PENDING_CUSTOMER_ACTION",
    },
  }
  const client: any = {
    depositAttempt: {
      findMany: async (input: any) => {
        reads.push(input)
        return []
      },
    },
    depositCreditRecovery: {
      create: async () => recovery,
      findMany: async (input: any) => {
        reads.push(input)
        return options.locked ? [] : [{ id: recovery.id, attempts: 0 }]
      },
      findUnique: async () => recovery,
      updateMany: async (input: any) => {
        writes.push(input)
        if (input.data.lastError === "STALE_PROCESSING_LEASE") {
          return { count: 0 }
        }
        if (input.data.status === "PROCESSING") {
          recovery.status = "PROCESSING"
          recovery.attempts = 1
          recovery.lockedAt = input.data.lockedAt
        }
        return { count: 1 }
      },
    },
    $transaction: async (callback: any) => callback(client),
    $queryRawUnsafe: async () => [],
  }
  return { client, reads, writes, recovery }
}

test("does not claim deposit recovery while finance mode is locked", async () => {
  const previousMode = process.env.FINANCE_RUNTIME_MODE
  process.env.FINANCE_RUNTIME_MODE = "locked"
  const { processDepositCreditRecovery } = await import(
    "../src/processors/deposit-credit-recovery.processor"
  )
  const { client, writes } = fakeClient()
  try {
    await assert.rejects(
      processDepositCreditRecovery(
        10,
        client,
        new Date("2026-08-12T00:30:00.000Z"),
      ),
      (error: any) =>
        error?.code === "FINANCE_OPERATION_BLOCKED" &&
        error?.operation === "recovery",
    )
    assert.equal(writes.length, 0)
  } finally {
    if (previousMode === undefined) delete process.env.FINANCE_RUNTIME_MODE
    else process.env.FINANCE_RUNTIME_MODE = previousMode
  }
})

test("selects only aged attached uncredited Stripe attempts", async () => {
  const previousMode = process.env.FINANCE_RUNTIME_MODE
  process.env.FINANCE_RUNTIME_MODE = "normal"
  const { processDepositCreditRecovery } = await import(
    "../src/processors/deposit-credit-recovery.processor"
  )
  const { client, reads } = fakeClient({ locked: true })
  const now = new Date("2026-08-12T00:30:00.000Z")
  try {
    const summary = await processDepositCreditRecovery(10, client, now)
    assert.equal(summary.claimed, 0)
    const seedRead = reads[0]
    assert.equal(seedRead.where.provider, "stripe")
    assert.deepEqual(seedRead.where.providerSessionId, { not: null })
    assert.equal(seedRead.where.ledgerTransactionId, null)
    assert.deepEqual(seedRead.where.creditRecovery, { is: null })
    assert.deepEqual(seedRead.where.status.in, [
      "CREATED",
      "PENDING_CUSTOMER_ACTION",
      "PROCESSING",
      "FAILED",
      "EXPIRED",
    ])
    assert.equal(
      seedRead.where.createdAt.lte.toISOString(),
      "2026-08-12T00:15:00.000Z",
    )
  } finally {
    if (previousMode === undefined) delete process.env.FINANCE_RUNTIME_MODE
    else process.env.FINANCE_RUNTIME_MODE = previousMode
  }
})

test("fences a transient retrieval retry by exact attempts and lockedAt", async () => {
  const previousMode = process.env.FINANCE_RUNTIME_MODE
  process.env.FINANCE_RUNTIME_MODE = "normal"
  const { processDepositCreditRecovery } = await import(
    "../src/processors/deposit-credit-recovery.processor"
  )
  const { StripeDepositRecoveryError } = await import(
    "@guestpost/shared/dist/stripe-deposit-recovery"
  )
  const { client, writes } = fakeClient()
  const now = new Date("2026-08-12T00:30:00.000Z")
  try {
    const summary = await processDepositCreditRecovery(
      10,
      client,
      now,
      async () => {
        throw new StripeDepositRecoveryError(
          "STRIPE_RECOVERY_RATE_LIMITED",
          true,
        )
      },
    )
    assert.equal(summary.claimed, 1)
    assert.equal(summary.retried, 1)
    const retry = writes.find(
      (write) => write.data.status === "FAILED" && write.where.attempts === 1,
    )
    assert.ok(retry)
    assert.equal(retry.where.lockedAt.getTime(), now.getTime())
    assert.equal(retry.data.lastError, "STRIPE_RECOVERY_RATE_LIMITED")
  } finally {
    if (previousMode === undefined) delete process.env.FINANCE_RUNTIME_MODE
    else process.env.FINANCE_RUNTIME_MODE = previousMode
  }
})

test("supersedes stale unpaid evidence when a webhook credited before the attempt lock", async () => {
  const { closeUnpaidRecovery } = await import(
    "../src/processors/deposit-credit-recovery.processor"
  )
  const lockedAt = new Date("2026-08-12T00:30:00.000Z")
  const recovery = {
    id: "recovery-1",
    depositAttemptId: "attempt-1",
    status: "PROCESSING",
    attempts: 1,
    lockedAt,
  }
  const attempt = {
    id: "attempt-1",
    status: "SUCCEEDED",
    provider: "stripe",
    providerSessionId: "cs_test_recovery",
    providerPaymentId: "pi_test_recovery",
    walletId: "wallet-1",
    walletCredit: "10.00",
    currency: "USD",
    ledgerTransactionId: "ledger-1",
  }
  const ledger = {
    id: "ledger-1",
    type: "DEPOSIT",
    provider: "stripe",
    providerRef: "pi_test_recovery",
    reference: "cs_test_recovery",
    walletId: "wallet-1",
    amount: "10.00",
    currency: "USD",
  }
  const writes: any[] = []
  const client: any = {
    $transaction: async (callback: any) => callback(client),
    $queryRawUnsafe: async () => [],
    depositCreditRecovery: {
      findUnique: async () => recovery,
      updateMany: async (input: any) => {
        writes.push(input)
        return { count: 1 }
      },
    },
    depositAttempt: {
      findUnique: async () => attempt,
      updateMany: async () => {
        throw new Error("credited attempt must not be expired")
      },
    },
    transaction: { findUnique: async () => ledger },
  }

  const result = await closeUnpaidRecovery(
    client,
    recovery.id,
    { attempts: 1, lockedAt },
    "evidence-1",
    {} as any,
  )

  assert.equal(result, "SUPERSEDED")
  assert.equal(writes.length, 1)
  assert.equal(writes[0].data.status, "SUPERSEDED")
  assert.equal(writes[0].data.evidenceId, undefined)
})
