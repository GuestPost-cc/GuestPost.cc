import assert from "node:assert/strict"
import test from "node:test"

process.env.DATABASE_URL ??=
  "postgresql://guestpost:guestpost@127.0.0.1:5432/guestpost_test"

function fakeClient(
  event: any,
  options: {
    failCoreTransaction?: boolean
    coreError?: Error
    recoverDuringCoreFailure?: {
      attempts: number
      lockedAt: Date
    }
    staleCount?: number
    candidateAttempts?: number
    noCandidates?: boolean
  } = {},
) {
  const writes: any[] = []
  const reads: any[] = []
  const audits: any[] = []
  const notifications: any[] = []
  let transactionCalls = 0
  const client: any = {
    paymentProviderEvent: {
      updateMany: async (input: any) => {
        writes.push(input)
        if (input.data.lastError === "STALE_PROCESSING_LEASE") {
          return { count: options.staleCount ?? 0 }
        }
        if (
          ["FAILED", "QUARANTINED"].includes(input.data.status) &&
          input.where.attempts != null &&
          (!ownsExactTestLease(event, input.where) ||
            event.status !== "PROCESSING")
        ) {
          return { count: 0 }
        }
        return { count: 1 }
      },
      findMany: async (input: any) => {
        reads.push(input)
        if (options.noCandidates) return []
        return [
          {
            id: event.id,
            attempts:
              options.candidateAttempts ??
              Math.max(Number(event.attempts) - 1, 0),
          },
        ]
      },
      findUnique: async () => event,
    },
    auditLog: {
      create: async (input: any) => {
        audits.push(input)
        return {}
      },
    },
    staffMembership: {
      findMany: async () => [{ userId: "finance-1" }],
    },
    notification: {
      createMany: async (input: any) => {
        notifications.push(input)
        return { count: input.data.length }
      },
    },
    $queryRawUnsafe: async () => [],
    $transaction: async (callback: any) => {
      if (
        transactionCalls++ === 0 &&
        (options.failCoreTransaction || options.coreError)
      ) {
        if (options.recoverDuringCoreFailure) {
          event.status = "PROCESSING"
          event.attempts = options.recoverDuringCoreFailure.attempts
          event.lockedAt = options.recoverDuringCoreFailure.lockedAt
        }
        throw options.coreError ?? new Error("temporary database outage")
      }
      return callback(client)
    },
  }
  return { client, writes, reads, audits, notifications }
}

function ownsExactTestLease(event: any, where: any): boolean {
  return (
    event.attempts === where.attempts &&
    new Date(event.lockedAt).getTime() === new Date(where.lockedAt).getTime()
  )
}

test("does not claim dispute inbox rows while finance mode is locked", async () => {
  const previousMode = process.env.FINANCE_RUNTIME_MODE
  process.env.FINANCE_RUNTIME_MODE = "locked"
  const { processPaymentDisputeInbox } = await import(
    "../src/processors/payment-dispute.processor"
  )
  const { client, writes } = fakeClient({ id: "inbox-locked" })

  try {
    await assert.rejects(
      processPaymentDisputeInbox(10, client, new Date("2026-07-29T00:00:00Z")),
      (error: any) =>
        error?.code === "FINANCE_OPERATION_BLOCKED" &&
        error?.mode === "locked" &&
        error?.operation === "recovery",
    )
    assert.equal(writes.length, 0)
  } finally {
    if (previousMode === undefined) {
      delete process.env.FINANCE_RUNTIME_MODE
    } else {
      process.env.FINANCE_RUNTIME_MODE = previousMode
    }
  }
})

test("never selects canonical PROCESSED dispute-role evidence for worker mutation", async () => {
  const { processPaymentDisputeInbox } = await import(
    "../src/processors/payment-dispute.processor"
  )
  const event = {
    id: "inbox-canonical-role",
    provider: "stripe",
    providerEventId: "evt_canonical_role",
    eventType: "charge.dispute.created",
    objectId: "dp_canonical_role",
    status: "PROCESSED",
    attempts: 1,
    lockedAt: null,
    processedAt: new Date("2026-07-29T00:00:00Z"),
    paymentDisputeId: "case-canonical-role",
    openedPaymentDispute: { id: "case-canonical-role" },
    receivedAt: new Date("2026-07-29T00:00:00Z"),
  }
  const { client, writes, reads, audits, notifications } = fakeClient(event, {
    noCandidates: true,
  })

  const summary = await processPaymentDisputeInbox(
    10,
    client,
    new Date("2026-07-29T00:01:00Z"),
  )

  assert.equal(summary.eligible, 0)
  assert.equal(summary.claimed, 0)
  assert.equal(summary.quarantined, 0)
  assert.deepEqual(reads[0].where.status, {
    in: ["PENDING", "FAILED"],
  })
  assert.equal(
    writes.some((write) => write.data.status === "QUARANTINED"),
    false,
  )
  assert.equal(audits.length, 0)
  assert.equal(notifications.length, 0)
})

test("quarantines malformed retry evidence and alerts Finance", async () => {
  const { processPaymentDisputeInbox } = await import(
    "../src/processors/payment-dispute.processor"
  )
  const event = {
    id: "inbox-malformed",
    provider: "stripe",
    providerEventId: "evt_malformed",
    eventType: "charge.dispute.created",
    objectId: "dp_malformed",
    status: "PROCESSING",
    attempts: 1,
    lockedAt: new Date("2026-07-29T00:00:00Z"),
    receivedAt: new Date(),
  }
  const { client, writes, audits, notifications } = fakeClient(event, {
    staleCount: 1,
  })

  const summary = await processPaymentDisputeInbox(
    10,
    client,
    new Date("2026-07-29T00:00:00Z"),
  )

  assert.equal(summary.staleRecovered, 1)
  assert.equal(summary.claimed, 1)
  assert.equal(summary.quarantined, 1)
  assert.equal(summary.retried, 0)
  assert.equal(
    writes.some((write) => write.data.status === "QUARANTINED"),
    true,
  )
  assert.equal(audits.length, 1)
  assert.equal(notifications[0].data[0].userId, "finance-1")
})

test("schedules bounded backoff for a transient processing failure", async () => {
  const { paymentDisputeEventFingerprint } = await import(
    "@guestpost/shared/dist/payment-dispute-core"
  )
  const { processPaymentDisputeInbox } = await import(
    "../src/processors/payment-dispute.processor"
  )
  const facts = {
    provider: "stripe" as const,
    providerEventId: "evt_retry",
    eventType: "charge.dispute.created" as const,
    providerDisputeId: "dp_retry",
    providerPaymentId: "pi_retry",
    providerChargeId: "ch_retry",
    amountMinor: 1000n,
    amount: "10.00",
    currency: "USD",
    providerStatus: "needs_response",
    livemode: false,
  }
  const event = {
    id: "inbox-retry",
    ...facts,
    objectId: facts.providerDisputeId,
    disputeAmountMinor: facts.amountMinor,
    disputeCurrency: facts.currency,
    eventFingerprint: paymentDisputeEventFingerprint(facts),
    status: "PROCESSING",
    attempts: 2,
    lockedAt: new Date("2026-07-29T00:01:00Z"),
    receivedAt: new Date("2026-07-29T00:00:00Z"),
  }
  const { client, writes } = fakeClient(event, {
    failCoreTransaction: true,
  })
  const now = new Date("2026-07-29T00:01:00Z")

  const summary = await processPaymentDisputeInbox(10, client, now)

  assert.equal(summary.claimed, 1)
  assert.equal(summary.retried, 1)
  assert.equal(summary.quarantined, 0)
  const retry = writes.find(
    (write) =>
      write.data.status === "FAILED" &&
      write.data.lastError === "TRANSIENT_PROCESSING_FAILURE",
  )
  assert.ok(retry)
  assert.equal(retry.data.availableAt.toISOString(), "2026-07-29T00:02:00.000Z")
})

test("exact-lease quarantines deterministic Stripe mode drift", async () => {
  const { PaymentDisputeTransitionError, paymentDisputeEventFingerprint } =
    await import("@guestpost/shared/dist/payment-dispute-core")
  const { processPaymentDisputeInbox } = await import(
    "../src/processors/payment-dispute.processor"
  )
  const now = new Date("2026-07-29T00:01:00Z")
  const facts = {
    provider: "stripe" as const,
    providerEventId: "evt_test_after_live_promotion",
    eventType: "charge.dispute.created" as const,
    providerDisputeId: "dp_test_after_live_promotion",
    providerPaymentId: "pi_test_after_live_promotion",
    providerChargeId: "ch_test_after_live_promotion",
    amountMinor: 1000n,
    amount: "10.00",
    currency: "USD",
    providerStatus: "needs_response",
    livemode: false,
  }
  const event = {
    id: "inbox-test-after-live-promotion",
    ...facts,
    objectId: facts.providerDisputeId,
    disputeAmountMinor: facts.amountMinor,
    disputeCurrency: facts.currency,
    eventFingerprint: paymentDisputeEventFingerprint(facts),
    status: "PROCESSING",
    attempts: 3,
    lockedAt: now,
    receivedAt: new Date("2026-07-29T00:00:00Z"),
  }
  const { client, writes, audits, notifications } = fakeClient(event, {
    candidateAttempts: 2,
    coreError: new PaymentDisputeTransitionError(
      "STRIPE_PROVIDER_MODE_MISMATCH",
      "stored test evidence does not match the promoted live key",
      false,
    ),
  })

  const summary = await processPaymentDisputeInbox(10, client, now)

  assert.equal(summary.claimed, 1)
  assert.equal(summary.retried, 0)
  assert.equal(summary.quarantined, 1)
  const quarantine = writes.find(
    (write) =>
      write.data.status === "QUARANTINED" &&
      write.data.lastError === "STRIPE_PROVIDER_MODE_MISMATCH",
  )
  assert.ok(quarantine)
  assert.equal(quarantine.where.attempts, 3)
  assert.equal(quarantine.where.lockedAt.getTime(), now.getTime())
  assert.equal(audits.length, 1)
  assert.equal(notifications.length, 1)
})

test("a failed old attempt cannot overwrite a recovered worker lease", async () => {
  const { paymentDisputeEventFingerprint } = await import(
    "@guestpost/shared/dist/payment-dispute-core"
  )
  const { processPaymentDisputeInbox } = await import(
    "../src/processors/payment-dispute.processor"
  )
  const now = new Date("2026-07-29T00:01:00Z")
  const facts = {
    provider: "stripe" as const,
    providerEventId: "evt_recovered_during_failure",
    eventType: "charge.dispute.created" as const,
    providerDisputeId: "dp_recovered_during_failure",
    providerPaymentId: "pi_recovered_during_failure",
    providerChargeId: "ch_recovered_during_failure",
    amountMinor: 1000n,
    amount: "10.00",
    currency: "USD",
    providerStatus: "needs_response",
    livemode: false,
  }
  const event = {
    id: "inbox-recovered-during-failure",
    ...facts,
    objectId: facts.providerDisputeId,
    disputeAmountMinor: facts.amountMinor,
    disputeCurrency: facts.currency,
    eventFingerprint: paymentDisputeEventFingerprint(facts),
    status: "PROCESSING",
    attempts: 1,
    lockedAt: now,
    receivedAt: new Date("2026-07-29T00:00:00Z"),
  }
  const recoveredLockedAt = new Date("2026-07-29T00:20:00Z")
  const { client, writes } = fakeClient(event, {
    candidateAttempts: 0,
    failCoreTransaction: true,
    recoverDuringCoreFailure: {
      attempts: 2,
      lockedAt: recoveredLockedAt,
    },
  })

  const summary = await processPaymentDisputeInbox(10, client, now)

  assert.equal(summary.claimed, 1)
  assert.equal(summary.retried, 0)
  const staleFailure = writes.find(
    (write) =>
      write.data.status === "FAILED" &&
      write.data.lastError === "TRANSIENT_PROCESSING_FAILURE",
  )
  assert.ok(staleFailure)
  assert.equal(staleFailure.where.attempts, 1)
  assert.equal(staleFailure.where.lockedAt.getTime(), now.getTime())
  assert.equal(event.status, "PROCESSING")
  assert.equal(event.attempts, 2)
  assert.equal(event.lockedAt.getTime(), recoveredLockedAt.getTime())
})

test("a deterministic old attempt cannot quarantine a recovered worker lease", async () => {
  const { PaymentDisputeTransitionError, paymentDisputeEventFingerprint } =
    await import("@guestpost/shared/dist/payment-dispute-core")
  const { processPaymentDisputeInbox } = await import(
    "../src/processors/payment-dispute.processor"
  )
  const now = new Date("2026-07-29T00:01:00Z")
  const facts = {
    provider: "stripe" as const,
    providerEventId: "evt_recovered_before_quarantine",
    eventType: "charge.dispute.created" as const,
    providerDisputeId: "dp_recovered_before_quarantine",
    providerPaymentId: "pi_recovered_before_quarantine",
    providerChargeId: "ch_recovered_before_quarantine",
    amountMinor: 1000n,
    amount: "10.00",
    currency: "USD",
    providerStatus: "needs_response",
    livemode: false,
  }
  const event = {
    id: "inbox-recovered-before-quarantine",
    ...facts,
    objectId: facts.providerDisputeId,
    disputeAmountMinor: facts.amountMinor,
    disputeCurrency: facts.currency,
    eventFingerprint: paymentDisputeEventFingerprint(facts),
    status: "PROCESSING",
    attempts: 1,
    lockedAt: now,
    receivedAt: new Date("2026-07-29T00:00:00Z"),
  }
  const { client, writes, audits, notifications } = fakeClient(event, {
    candidateAttempts: 0,
    coreError: new PaymentDisputeTransitionError(
      "EVENT_ENVELOPE_MISMATCH",
      "deterministic test failure",
      false,
    ),
    recoverDuringCoreFailure: {
      attempts: 2,
      lockedAt: new Date("2026-07-29T00:20:00Z"),
    },
  })

  const summary = await processPaymentDisputeInbox(10, client, now)

  assert.equal(summary.claimed, 1)
  assert.equal(summary.quarantined, 0)
  assert.equal(
    writes.some((write) => write.data.status === "QUARANTINED"),
    false,
  )
  assert.equal(audits.length, 0)
  assert.equal(notifications.length, 0)
})

test("a stale claimant cannot fail or quarantine a recovered lease", async () => {
  const { processPaymentDisputeInbox } = await import(
    "../src/processors/payment-dispute.processor"
  )
  const event = {
    id: "inbox-recovered",
    provider: "stripe",
    providerEventId: "evt_recovered",
    eventType: "charge.dispute.created",
    objectId: "dp_recovered",
    status: "PROCESSING",
    attempts: 2,
    lockedAt: new Date("2026-07-29T00:20:00Z"),
    receivedAt: new Date("2026-07-29T00:00:00Z"),
  }
  const { client, writes, audits, notifications } = fakeClient(event, {
    candidateAttempts: 0,
  })

  const summary = await processPaymentDisputeInbox(
    10,
    client,
    new Date("2026-07-29T00:00:00Z"),
  )

  assert.equal(summary.claimed, 1)
  assert.equal(summary.processed, 0)
  assert.equal(summary.retried, 0)
  assert.equal(summary.quarantined, 0)
  assert.equal(
    writes.some(
      (write) =>
        ["FAILED", "QUARANTINED"].includes(write.data.status) &&
        write.data.lastError !== "STALE_PROCESSING_LEASE",
    ),
    false,
  )
  assert.equal(audits.length, 0)
  assert.equal(notifications.length, 0)
})
