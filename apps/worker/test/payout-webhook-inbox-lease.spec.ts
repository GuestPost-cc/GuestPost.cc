import assert from "node:assert/strict"
import test from "node:test"

process.env.DATABASE_URL ??=
  "postgresql://guestpost:guestpost@127.0.0.1:5432/guestpost_test"

test("a stalled payout inbox claimant cannot borrow a recovered lease", async () => {
  const previousMode = process.env.FINANCE_RUNTIME_MODE
  process.env.FINANCE_RUNTIME_MODE = "normal"
  const { processPayoutWebhookInbox } = await import(
    "../src/processors/payout.processor"
  )
  const now = new Date("2026-07-29T12:00:00.000Z")
  const candidate = {
    id: "payout-event-lease-a",
    status: "PENDING",
    attempts: 0,
    lockedAt: null,
    availableAt: new Date("2026-07-29T11:59:00.000Z"),
    providerExecutionId: null,
    receivedAt: new Date("2026-07-29T11:58:00.000Z"),
  }
  let state: any = { ...candidate }
  const writes: any[] = []
  let terminalWriteAttempted = false
  const eventStore = {
    findMany: async () => [{ ...candidate }],
    findUnique: async () => ({ ...state }),
    updateMany: async (input: any) => {
      writes.push(input)
      if (input.data.lastError === "StaleProcessingLeaseRecovered") {
        return { count: 0 }
      }
      if (input.data.status === "PROCESSING") {
        state = {
          ...state,
          status: "PROCESSING",
          attempts: state.attempts + 1,
          lockedAt: input.data.lockedAt,
        }
        return { count: 1 }
      }

      terminalWriteAttempted = true
      // Claimant A stalled after reading its lease. The reaper recovered it
      // and claimant B now owns a distinct attempt/timestamp.
      state = {
        ...state,
        attempts: 2,
        lockedAt: new Date("2026-07-29T12:20:00.000Z"),
      }
      const where = input.where
      const owns =
        where.status === state.status &&
        where.attempts === state.attempts &&
        where.lockedAt instanceof Date &&
        where.lockedAt.getTime() === state.lockedAt.getTime()
      return { count: owns ? 1 : 0 }
    },
  }
  const client: any = {
    payoutWebhookEvent: eventStore,
  }

  try {
    const summary = await processPayoutWebhookInbox(10, client, now)

    assert.equal(summary.claimed, 1)
    assert.equal(summary.processed, 0)
    assert.equal(summary.ignored, 0)
    assert.equal(summary.retried, 0)
    assert.equal(summary.quarantined, 0)
    assert.equal(summary.ownershipLost, 1)
    assert.equal(terminalWriteAttempted, true)

    const terminalAttempt = writes.at(-1)
    assert.equal(terminalAttempt.where.status, "PROCESSING")
    assert.equal(terminalAttempt.where.attempts, 1)
    assert.ok(terminalAttempt.where.lockedAt instanceof Date)
    assert.equal(state.status, "PROCESSING")
    assert.equal(state.attempts, 2)
  } finally {
    const { connection } = await import("../src/redis")
    connection.disconnect()
    if (previousMode === undefined) {
      delete process.env.FINANCE_RUNTIME_MODE
    } else {
      process.env.FINANCE_RUNTIME_MODE = previousMode
    }
  }
})

test("Stripe failure evidence is exact-lease quarantined across delayed mode changes", async () => {
  const previousRuntimeMode = process.env.FINANCE_RUNTIME_MODE
  const previousStripeKey = process.env.STRIPE_SECRET_KEY
  const previousLiveGate = process.env.STRIPE_LIVE_MODE_ENABLED
  process.env.FINANCE_RUNTIME_MODE = "normal"
  const { processPayoutWebhookInbox } = await import(
    "../src/processors/payout.processor"
  )
  const now = new Date("2026-07-29T12:00:00.000Z")

  async function runScenario(input: {
    executionLivemode: boolean
    eventLivemode: boolean
    secretKey: string
    liveGate: string
    expectedReason: string
  }) {
    process.env.STRIPE_SECRET_KEY = input.secretKey
    process.env.STRIPE_LIVE_MODE_ENABLED = input.liveGate
    const candidate = {
      id: `payout-failure-${input.executionLivemode}-${input.eventLivemode}-${input.secretKey}`,
      status: "PENDING",
      attempts: 0,
      lockedAt: null,
      availableAt: new Date("2026-07-29T11:59:00.000Z"),
      provider: "stripe_connect",
      providerExecutionId: "po_failure_1",
      providerAccountExternalId: "acct_1",
      eventType: "payout.failed",
      providerStatus: "FAILED",
      rawStatus: "failed",
      livemode: input.eventLivemode,
      payoutAmountMinor: 10_000n,
      payoutCurrency: "USD",
      receivedAt: new Date("2026-07-29T11:58:00.000Z"),
    }
    const execution = {
      id: "execution-1",
      withdrawalId: "withdrawal-1",
      status: "PROCESSING",
      stage: "BANK_PAYOUT_CREATED",
      version: 3,
      providerExecutionId: "tr_1",
      providerTransferId: "tr_1",
      providerPayoutId: "po_failure_1",
      amount: "100.00",
      destinationAmount: "100.00",
      destinationCurrency: "USD",
      livemode: input.executionLivemode,
      providerMetadata: {
        destinationSnapshot: {
          providerAccountExternalId: "acct_1",
        },
      },
      provider: { name: "stripe_connect" },
      withdrawal: {
        status: "PROCESSING",
        publisher: { organizationId: "organization-1" },
      },
    }
    let state: any = { ...candidate }
    let executionMutations = 0
    let exactLeaseQuarantines = 0
    const auditActions: string[] = []
    const eventStore = {
      findMany: async () => [{ ...candidate }],
      findUnique: async () => ({ ...state }),
      updateMany: async (request: any) => {
        if (request.data.lastError === "StaleProcessingLeaseRecovered") {
          return { count: 0 }
        }
        if (request.data.status === "PROCESSING") {
          state = {
            ...state,
            status: "PROCESSING",
            attempts: state.attempts + 1,
            lockedAt: request.data.lockedAt,
          }
          return { count: 1 }
        }
        const ownsLease =
          request.where.id === state.id &&
          request.where.status === "PROCESSING" &&
          request.where.attempts === state.attempts &&
          request.where.lockedAt instanceof Date &&
          state.lockedAt instanceof Date &&
          request.where.lockedAt.getTime() === state.lockedAt.getTime()
        if (!ownsLease) return { count: 0 }
        if (request.data.status === "QUARANTINED") {
          exactLeaseQuarantines += 1
        }
        state = { ...state, ...request.data }
        return { count: 1 }
      },
    }
    const client: any = {
      payoutWebhookEvent: eventStore,
      payoutExecution: {
        findFirst: async () => execution,
        findUnique: async () => execution,
        updateMany: async () => {
          executionMutations += 1
          return { count: 1 }
        },
      },
      staffMembership: { findMany: async () => [] },
      notification: { createMany: async () => ({ count: 0 }) },
      auditLog: {
        create: async (request: any) => {
          auditActions.push(request.data.action)
          return {}
        },
      },
      $queryRawUnsafe: async () => [{ id: "locked" }],
      $transaction: async (work: (tx: any) => Promise<unknown>) => work(client),
    }

    const summary = await processPayoutWebhookInbox(10, client, now)

    assert.deepEqual(summary, {
      claimed: 1,
      processed: 0,
      retried: 0,
      ignored: 0,
      quarantined: 1,
      ownershipLost: 0,
    })
    assert.equal(state.status, "QUARANTINED")
    assert.equal(state.lastError, input.expectedReason)
    assert.equal(exactLeaseQuarantines, 1)
    assert.equal(executionMutations, 0)
    assert.ok(
      auditActions.includes(
        input.expectedReason === "TerminalWebhookEnvelopeMismatch"
          ? "PAYOUT_WEBHOOK_ENVELOPE_QUARANTINED"
          : "PAYOUT_WEBHOOK_MODE_FENCE_QUARANTINED",
      ),
    )
  }

  try {
    await runScenario({
      executionLivemode: false,
      eventLivemode: false,
      secretKey: "rk_live_delayed_test",
      liveGate: "true",
      expectedReason: "FailureModeFence:STRIPE_PROVIDER_MODE_MISMATCH",
    })
    await runScenario({
      executionLivemode: true,
      eventLivemode: true,
      secretKey: "rk_test_delayed_live",
      liveGate: "false",
      expectedReason: "FailureModeFence:STRIPE_PROVIDER_MODE_MISMATCH",
    })
    await runScenario({
      executionLivemode: true,
      eventLivemode: true,
      secretKey: "rk_live_gate_disabled",
      liveGate: "false",
      expectedReason: "FailureModeFence:STRIPE_LIVE_MODE_DISABLED",
    })
    await runScenario({
      executionLivemode: false,
      eventLivemode: true,
      secretKey: "rk_test_envelope_mismatch",
      liveGate: "false",
      expectedReason: "TerminalWebhookEnvelopeMismatch",
    })
  } finally {
    const { connection } = await import("../src/redis")
    connection.disconnect()
    if (previousRuntimeMode === undefined) {
      delete process.env.FINANCE_RUNTIME_MODE
    } else {
      process.env.FINANCE_RUNTIME_MODE = previousRuntimeMode
    }
    if (previousStripeKey === undefined) {
      delete process.env.STRIPE_SECRET_KEY
    } else {
      process.env.STRIPE_SECRET_KEY = previousStripeKey
    }
    if (previousLiveGate === undefined) {
      delete process.env.STRIPE_LIVE_MODE_ENABLED
    } else {
      process.env.STRIPE_LIVE_MODE_ENABLED = previousLiveGate
    }
  }
})

test("status polling rejects current Stripe key drift before provider I/O or state mutation", async () => {
  const previousRuntimeMode = process.env.FINANCE_RUNTIME_MODE
  const previousStripeKey = process.env.STRIPE_SECRET_KEY
  const previousLiveGate = process.env.STRIPE_LIVE_MODE_ENABLED
  process.env.FINANCE_RUNTIME_MODE = "normal"
  process.env.STRIPE_SECRET_KEY = "rk_live_status_drift"
  process.env.STRIPE_LIVE_MODE_ENABLED = "true"
  const { handleCheckStatus } = await import(
    "../src/processors/payout.processor"
  )
  let providerCalls = 0
  let stateMutations = 0
  const execution = {
    id: "execution-status-drift",
    withdrawalId: "withdrawal-status-drift",
    status: "PROCESSING",
    stage: "BANK_PAYOUT_CREATED",
    providerExecutionId: "tr_1",
    providerTransferId: "tr_1",
    providerPayoutId: "po_1",
    requestedReference: "GP-WD-0001",
    amount: "100.00",
    destinationAmount: "100.00",
    destinationCurrency: "USD",
    livemode: false,
    providerMetadata: {
      destinationSnapshot: { providerAccountExternalId: "acct_1" },
    },
    provider: { name: "stripe_connect" },
    withdrawal: {
      status: "PROCESSING",
      publisher: { organizationId: "organization-1" },
    },
  }
  const client: any = {
    payoutExecution: {
      findMany: async (request: any) =>
        typeof request.where.stage === "string" ? [] : [execution],
      updateMany: async () => {
        stateMutations += 1
        return { count: 1 }
      },
    },
    $transaction: async (work: (tx: any) => Promise<unknown>) => work(client),
  }

  try {
    await assert.rejects(
      handleCheckStatus({ data: { limit: 10 } }, client, async () => {
        providerCalls += 1
        return null
      }),
      (error: any) => error?.code === "STRIPE_PROVIDER_MODE_MISMATCH",
    )
    assert.equal(providerCalls, 0)
    assert.equal(stateMutations, 0)
  } finally {
    const { connection } = await import("../src/redis")
    connection.disconnect()
    if (previousRuntimeMode === undefined) {
      delete process.env.FINANCE_RUNTIME_MODE
    } else {
      process.env.FINANCE_RUNTIME_MODE = previousRuntimeMode
    }
    if (previousStripeKey === undefined) {
      delete process.env.STRIPE_SECRET_KEY
    } else {
      process.env.STRIPE_SECRET_KEY = previousStripeKey
    }
    if (previousLiveGate === undefined) {
      delete process.env.STRIPE_LIVE_MODE_ENABLED
    } else {
      process.env.STRIPE_LIVE_MODE_ENABLED = previousLiveGate
    }
  }
})
