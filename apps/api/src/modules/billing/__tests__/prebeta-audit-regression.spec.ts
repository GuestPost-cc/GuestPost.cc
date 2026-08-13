/**
 * Regression tests for the 2026-06-11 pre-beta audit findings.
 *
 * F-1: Stripe deposit webhook double-credit race — a P2002 on the ledger
 *      insert must ABORT the transaction (wallet increment rolls back).
 * F-2: payout webhook normalization — real Wise/Stripe payload shapes map
 *      through the same status maps as the poller.
 * F-3: order idempotency replay is tenant-scoped.
 * F-4: a local FAILED label cannot restore reserved withdrawal funds without
 *      durable provider failure/cancellation evidence.
 * F-5: customerApprove cannot overwrite a RELEASED settlement.
 * F-6: chargebacks place a spend-blocking hold; closed disputes release or
 *      debit it idempotently.
 */

import { createHash } from "node:crypto"
import { normalizeProviderWebhook } from "@guestpost/shared"
import {
  type FingerprintablePaymentDisputeEvent,
  paymentDisputeEventFingerprint,
} from "@guestpost/shared/dist/payment-dispute-core"
import { BadRequestException, ConflictException } from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/client"
import { OrdersService } from "../../orders/orders.service"
import { PublisherPayoutsService } from "../../publisher-payouts/publisher-payouts.service"
import { SettlementsService } from "../../settlements/settlements.service"
import { BillingService } from "../billing.service"

const previousStripeSecretKey = process.env.STRIPE_SECRET_KEY
const previousStripeLiveMode = process.env.STRIPE_LIVE_MODE_ENABLED

beforeAll(() => {
  process.env.STRIPE_SECRET_KEY = "rk_test_prebeta_financial_regression"
  process.env.STRIPE_LIVE_MODE_ENABLED = "false"
})

afterAll(() => {
  if (previousStripeSecretKey === undefined) {
    delete process.env.STRIPE_SECRET_KEY
  } else {
    process.env.STRIPE_SECRET_KEY = previousStripeSecretKey
  }
  if (previousStripeLiveMode === undefined) {
    delete process.env.STRIPE_LIVE_MODE_ENABLED
  } else {
    process.env.STRIPE_LIVE_MODE_ENABLED = previousStripeLiveMode
  }
})

function makePrismaMock() {
  const tables = [
    "wallet",
    "transaction",
    "order",
    "orderItem",
    "orderEvent",
    "settlement",
    "settlementApproval",
    "publisherBalance",
    "withdrawal",
    "payoutExecution",
    "withdrawalAllocation",
    "publisher",
    "publisherMembership",
    "staffMembership",
    "notification",
    "depositAttempt",
    "paymentProviderEvent",
    "paymentDispute",
    "orderDispute",
    "orderDeliveryVersion",
    "revision",
    "deliveryFraudFlag",
    "orderCancellationRequest",
    "auditLog",
    "marketplaceListing",
    "service",
    "website",
    // Phase 6 — production orders.service.ts calls tx.listingService.findUnique
    // on the snapshot path; F-3 needs this model to be on the mock.
    "listingService",
  ]
  const mock: any = {}
  for (const t of tables) {
    mock[t] = {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      upsert: jest.fn().mockResolvedValue({}),
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    }
  }
  // Tracks whether the interactive transaction COMMITTED (callback resolved)
  // or ROLLED BACK (callback rejected) — the heart of the F-1/F-6 assertions.
  mock.__committed = null
  mock.__transactionOutcomes = []
  mock.$transaction = jest.fn().mockImplementation(async (cb: any) => {
    try {
      const result = await cb(mock)
      mock.__committed = true
      mock.__transactionOutcomes.push(true)
      return result
    } catch (err) {
      mock.__committed = false
      mock.__transactionOutcomes.push(false)
      throw err
    }
  })
  mock.$queryRawUnsafe = jest.fn().mockResolvedValue([])
  mock.$queryRaw = jest.fn().mockResolvedValue([])
  mock.depositAttempt.findUniqueOrThrow.mockResolvedValue({
    status: "SUCCEEDED",
  })
  return mock
}

const auditMock = () => ({ log: jest.fn().mockResolvedValue(undefined) })
const queueMock = () => ({
  addJob: jest.fn().mockResolvedValue({ id: "job-1" }),
})

function storedDisputeEvent(
  id: string,
  type: "charge.dispute.created" | "charge.dispute.closed",
  dispute: {
    id: string
    payment_intent: string
    charge: string | null
    amount: number
    currency: string
    status: string
  },
) {
  const fingerprintable: FingerprintablePaymentDisputeEvent = {
    provider: "stripe",
    providerEventId: `evt_${id}`,
    eventType: type,
    providerDisputeId: dispute.id,
    providerPaymentId: dispute.payment_intent,
    providerChargeId: dispute.charge,
    amountMinor: BigInt(dispute.amount),
    amount: new Decimal(dispute.amount).div(100).toFixed(2),
    currency: dispute.currency.toUpperCase(),
    providerStatus: dispute.status,
    livemode: false,
  }
  return {
    id,
    ...fingerprintable,
    objectId: fingerprintable.providerDisputeId,
    disputeAmountMinor: fingerprintable.amountMinor,
    disputeCurrency: fingerprintable.currency,
    eventFingerprint: paymentDisputeEventFingerprint(fingerprintable),
    status: "PROCESSING",
    attempts: 1,
    lockedAt: new Date("2026-07-29T00:00:00.000Z"),
    depositAttemptId: null,
    paymentDisputeId: null,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
describe("F-1: deposit webhook double-credit race", () => {
  let service: BillingService
  let prisma: any
  let audit: any

  beforeEach(() => {
    prisma = makePrismaMock()
    audit = auditMock()
    service = new BillingService(prisma, audit as any)
    prisma.depositAttempt.findMany.mockResolvedValue([attempt])
    prisma.depositAttempt.findUniqueOrThrow.mockResolvedValue(attempt)
    prisma.paymentProviderEvent.findUnique.mockResolvedValue(providerEvent)
  })

  const lockedAt = new Date("2026-07-29T00:00:00.000Z")
  const lease = { kind: "lease", attempt: 1, lockedAt }
  const session = {
    id: "cs_test_123",
    client_reference_id: "attempt-1",
    status: "complete",
    amount_total: 25050, // $250.50
    currency: "usd",
    payment_status: "paid",
    mode: "payment",
    livemode: false,
    payment_intent: "pi_test_456",
    metadata: {
      depositAttemptId: "attempt-1",
      publicReference: "DP-TEST-1",
      walletId: "wallet-1",
      organizationId: "org-1",
      userId: "user-1",
    },
  }
  const attempt = {
    id: "attempt-1",
    publicReference: "DP-TEST-1",
    walletId: "wallet-1",
    organizationId: "org-1",
    createdByUserId: "user-1",
    provider: "stripe",
    providerSessionId: "cs_test_123",
    providerPaymentId: null,
    providerChargeId: null,
    amount: new Decimal("250.50"),
    walletCredit: new Decimal("250.50"),
    customerFee: new Decimal(0),
    currency: "USD",
    status: "PROCESSING",
    ledgerTransactionId: null,
  }
  const providerEvent = {
    id: "provider-event-credit",
    provider: "stripe",
    providerEventId: "evt_credit",
    eventType: "checkout.session.completed",
    objectId: "cs_test_123",
    livemode: false,
    status: "PROCESSING",
    attempts: 1,
    lockedAt,
    processedAt: null,
    depositAttemptId: null,
  }
  const exactReplay = {
    id: "t-1",
    walletId: "wallet-1",
    amount: new Decimal("250.50"),
    currency: "USD",
    type: "DEPOSIT",
    reference: "cs_test_123",
    provider: "stripe",
    providerRef: "pi_test_456",
    depositAttempt: {
      ...attempt,
      providerPaymentId: "pi_test_456",
      ledgerTransactionId: "t-1",
      status: "SUCCEEDED",
    },
  }

  it("commits exactly one wallet increment with the ledger row (happy path)", async () => {
    prisma.wallet.findUniqueOrThrow.mockResolvedValue({
      id: "wallet-1",
      version: 3,
      currency: "USD",
    })
    prisma.transaction.findMany.mockResolvedValue([])

    await (service as any).processSuccessfulPayment(
      session,
      providerEvent.id,
      lease,
      false,
    )

    expect(prisma.__committed).toBe(true)
    expect(prisma.wallet.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "wallet-1", version: 3 },
      }),
    )
    // Ledger row carries the payment_intent linkage for chargeback lookup (F-6).
    // FIN-02 regression guard: `provider: "stripe"` MUST be set so the row
    // participates in the provider-aware partial unique index
    // `(provider, providerRef) WHERE providerRef IS NOT NULL` (migration
    // 20260716030403). Without it, a replayed webhook with a new session.id
    // but the same payment_intent bypasses the constraint (NULL=NULL is
    // treated as distinct by PostgreSQL unique indexes).
    expect(prisma.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        reference: "cs_test_123",
        provider: "stripe",
        providerRef: "pi_test_456",
        type: "DEPOSIT",
      }),
    })
  })

  it("aborts on a ledger P2002 and acknowledges only the exact race winner", async () => {
    prisma.wallet.findUniqueOrThrow.mockResolvedValue({
      id: "wallet-1",
      version: 3,
      currency: "USD",
    })
    prisma.transaction.create.mockRejectedValue(
      Object.assign(new Error("unique"), { code: "P2002" }),
    )
    prisma.transaction.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValue([exactReplay])
    prisma.depositAttempt.findMany
      .mockResolvedValueOnce([attempt])
      .mockResolvedValue([exactReplay.depositAttempt])
    prisma.depositAttempt.findUniqueOrThrow
      .mockResolvedValueOnce(attempt)
      .mockResolvedValue(exactReplay.depositAttempt)

    // The first serializable transaction must abort. A retry may acknowledge
    // only after re-reading the winner's exact ledger-and-attempt evidence.
    await expect(
      (service as any).processSuccessfulPayment(
        session,
        providerEvent.id,
        lease,
        false,
      ),
    ).resolves.toBeUndefined()

    expect(prisma.__transactionOutcomes).toEqual([false, true])
    // Ledger creation precedes the wallet increment, so the losing writer
    // never reaches a balance mutation before its transaction aborts.
    expect(prisma.wallet.updateMany).not.toHaveBeenCalled()
    expect(prisma.paymentProviderEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: providerEvent.id,
        status: "PROCESSING",
        attempts: 1,
        lockedAt,
      },
      data: expect.objectContaining({
        status: "PROCESSED",
        depositAttemptId: attempt.id,
      }),
    })
  })

  it("commits only the inbox acknowledgement for an exact replay", async () => {
    prisma.transaction.findMany.mockResolvedValue([exactReplay])
    prisma.depositAttempt.findMany.mockResolvedValue([
      exactReplay.depositAttempt,
    ])
    prisma.depositAttempt.findUniqueOrThrow.mockResolvedValue(
      exactReplay.depositAttempt,
    )
    prisma.wallet.findUniqueOrThrow.mockResolvedValue({
      id: "wallet-1",
      version: 4,
      currency: "USD",
    })

    await expect(
      (service as any).processSuccessfulPayment(
        session,
        providerEvent.id,
        lease,
        false,
      ),
    ).resolves.toBeUndefined()
    expect(prisma.__transactionOutcomes).toEqual([true])
    expect(prisma.wallet.updateMany).not.toHaveBeenCalled()
    expect(prisma.transaction.create).not.toHaveBeenCalled()
  })

  it("marks an exact ledger-and-attempt replay processed", async () => {
    prisma.depositAttempt.findMany.mockResolvedValue([
      exactReplay.depositAttempt,
    ])
    prisma.depositAttempt.findUniqueOrThrow.mockResolvedValue(
      exactReplay.depositAttempt,
    )
    prisma.wallet.findUniqueOrThrow.mockResolvedValue({
      id: "wallet-1",
      version: 3,
      currency: "USD",
    })
    prisma.transaction.findMany.mockResolvedValue([exactReplay])
    prisma.paymentProviderEvent.findUnique.mockResolvedValue({
      id: "provider-event-exact",
      provider: "stripe",
      providerEventId: "evt_exact",
      eventType: "checkout.session.completed",
      objectId: session.id,
      livemode: false,
      status: "PROCESSING",
      attempts: 1,
      lockedAt,
      depositAttemptId: null,
    })

    await expect(
      (service as any).processSuccessfulPayment(
        session,
        "provider-event-exact",
        lease,
        false,
      ),
    ).resolves.toBeUndefined()

    expect(prisma.paymentProviderEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: "provider-event-exact",
        status: "PROCESSING",
        attempts: 1,
        lockedAt,
      },
      data: expect.objectContaining({
        status: "PROCESSED",
        lockedAt: null,
        lastError: null,
      }),
    })
    expect(audit.log).not.toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PAYMENT_PROVIDER_EVENT_QUARANTINED",
      }),
      prisma,
    )
  })

  it.each([
    ["amount", { amount: new Decimal("250.51") }],
    ["wallet", { walletId: "wallet-other" }],
    ["currency", { currency: "EUR" }],
    ["reference", { reference: "cs_other" }],
  ])("quarantines a duplicate-key %s mismatch after rollback", async (_name, candidateOverride) => {
    const lockedAt = new Date("2026-07-29T00:00:00.000Z")
    const lease = { kind: "lease", attempt: 1, lockedAt }
    prisma.wallet.findUniqueOrThrow.mockResolvedValue({
      id: "wallet-1",
      version: 3,
      currency: "USD",
    })
    prisma.transaction.create.mockRejectedValue(
      Object.assign(new Error("unique"), { code: "P2002" }),
    )
    prisma.transaction.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ ...exactReplay, ...candidateOverride }])
    prisma.depositAttempt.findMany
      .mockResolvedValueOnce([attempt])
      .mockResolvedValue([exactReplay.depositAttempt])
    prisma.depositAttempt.findUniqueOrThrow
      .mockResolvedValueOnce(attempt)
      .mockResolvedValue(exactReplay.depositAttempt)
    prisma.paymentProviderEvent.findUnique.mockResolvedValue({
      id: "provider-event-collision",
      provider: "stripe",
      providerEventId: "evt_collision",
      eventType: "checkout.session.completed",
      objectId: session.id,
      livemode: false,
      status: "PROCESSING",
      attempts: 1,
      lockedAt,
      processedAt: null,
    })

    await expect(
      (service as any).processSuccessfulPayment(
        session,
        "provider-event-collision",
        lease,
        false,
      ),
    ).resolves.toBeUndefined()

    expect(prisma.paymentProviderEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: "provider-event-collision",
        status: "PROCESSING",
        attempts: 1,
        lockedAt,
      },
      data: expect.objectContaining({
        status: "QUARANTINED",
        lockedAt: null,
        lastError: "DEPOSIT_IDEMPOTENCY_COLLISION",
      }),
    })
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PAYMENT_PROVIDER_EVENT_QUARANTINED",
        entityId: "provider-event-collision",
      }),
      prisma,
    )
  })

  it("never credits a Checkout session unless Stripe explicitly marks it paid", async () => {
    await expect(
      (service as any).processSuccessfulPayment(
        {
          ...session,
          id: "cs_test_unpaid",
          payment_status: "unpaid",
        },
        providerEvent.id,
        lease,
        false,
      ),
    ).rejects.toThrow(/not paid/i)

    expect(prisma.wallet.updateMany).not.toHaveBeenCalled()
    expect(prisma.transaction.create).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("F-6: chargeback hold workflow", () => {
  let service: BillingService
  let prisma: any
  let audit: any

  const dispute = {
    id: "dp_1",
    charge: "ch_1",
    payment_intent: "pi_test_456",
    amount: 60000, // $600
    currency: "usd",
    reason: "fraudulent",
    status: "needs_response",
  }

  const depositRow = {
    id: "t-dep",
    walletId: "wallet-1",
    amount: new Decimal(1000),
    currency: "USD",
    depositAttempt: {
      id: "attempt-1",
      walletId: "wallet-1",
      walletCredit: new Decimal(1000),
      currency: "USD",
      provider: "stripe",
      providerPaymentId: "pi_test_456",
      ledgerTransactionId: "t-dep",
      status: "SUCCEEDED",
    },
  }

  const wallet = {
    id: "wallet-1",
    organizationId: "org-1",
    currency: "USD",
    version: 2,
    availableBalance: new Decimal(1000),
    reservedBalance: new Decimal(0),
  }

  const openCase = {
    id: "case-1",
    provider: "stripe",
    providerDisputeId: "dp_1",
    providerPaymentId: "pi_test_456",
    providerChargeId: "ch_1",
    depositAttemptId: "attempt-1",
    depositTransactionId: "t-dep",
    walletId: "wallet-1",
    amount: new Decimal(600),
    currency: "USD",
    heldAmount: new Decimal(600),
    shortfallAmount: new Decimal(0),
    currentExposureAmount: new Decimal(0),
    status: "OPEN",
    providerStatus: "needs_response",
    openedByEventId: "event-open",
    resolvedByEventId: null,
    holdTransactionId: "hold-tx",
    resolutionTransactionId: null,
    version: 0,
    openedAt: new Date("2026-06-11T10:00:00Z"),
    resolvedAt: null,
    createdAt: new Date("2026-06-11T10:00:00Z"),
    updatedAt: new Date("2026-06-11T10:00:00Z"),
  }

  const closedDispute = (status: string) => ({
    ...dispute,
    status,
  })

  beforeEach(() => {
    prisma = makePrismaMock()
    audit = auditMock()
    service = new BillingService(prisma, audit as any)
    let currentDepositAttemptStatus = depositRow.depositAttempt.status
    prisma.transaction.findFirst.mockResolvedValue(depositRow)
    prisma.depositAttempt.findUniqueOrThrow.mockImplementation(
      ({ where }: any) => {
        if (where.id !== depositRow.depositAttempt.id) {
          return Promise.reject(new Error("DepositAttempt not found"))
        }
        return Promise.resolve({ status: currentDepositAttemptStatus })
      },
    )
    prisma.depositAttempt.updateMany.mockImplementation(
      ({ where, data }: any) => {
        if (
          where.id !== depositRow.depositAttempt.id ||
          where.status !== currentDepositAttemptStatus
        ) {
          return Promise.resolve({ count: 0 })
        }
        currentDepositAttemptStatus = data.status
        return Promise.resolve({ count: 1 })
      },
    )
    prisma.paymentDispute.findUnique.mockResolvedValue(null)
    prisma.paymentDispute.aggregate.mockResolvedValue({
      _sum: { amount: null },
    })
    prisma.paymentDispute.findMany.mockResolvedValue([{ status: "OPEN" }])
    prisma.wallet.findUniqueOrThrow.mockResolvedValue(wallet)
    prisma.transaction.create.mockImplementation(({ data }: any) =>
      Promise.resolve({
        id: data.reference.endsWith(":hold") ? "hold-tx" : "resolution-tx",
      }),
    )
    prisma.paymentDispute.create.mockResolvedValue({ id: "case-1" })
    prisma.paymentProviderEvent.findUnique.mockImplementation(
      ({ where }: any) => {
        const id = where.id
        const isOpen = id.includes("open")
        const status = id.includes("lost")
          ? "lost"
          : id.includes("unknown")
            ? "under_review"
            : isOpen
              ? "needs_response"
              : "won"
        return Promise.resolve(
          storedDisputeEvent(
            id,
            isOpen ? "charge.dispute.created" : "charge.dispute.closed",
            { ...dispute, status },
          ),
        )
      },
    )
  })

  it("atomically moves available funds to reserved and creates a durable case", async () => {
    const outcome = await (service as any).handleChargeback(
      dispute,
      "event-open",
    )

    expect(prisma.__committed).toBe(true)
    expect(outcome).toEqual(
      expect.objectContaining({
        status: "OPEN",
        held: "600.00",
        shortfall: "0.00",
        created: true,
      }),
    )
    expect(prisma.wallet.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "wallet-1", version: 2 },
        data: expect.objectContaining({
          availableBalance: { decrement: expect.anything() },
          reservedBalance: { increment: expect.anything() },
        }),
      }),
    )
    const holdData = prisma.transaction.create.mock.calls[0][0].data
    expect(holdData).toEqual(
      expect.objectContaining({
        type: "RESERVATION",
        reference: "payment-dispute:stripe:dp_1:hold",
      }),
    )
    // The DEPOSIT exclusively owns (provider, providerRef). Reusing the
    // PaymentIntent on this hold is the production collision that lost holds.
    expect(holdData).not.toHaveProperty("provider")
    expect(holdData).not.toHaveProperty("providerRef")
    expect(prisma.paymentDispute.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        provider: "stripe",
        providerDisputeId: "dp_1",
        depositTransactionId: "t-dep",
        holdTransactionId: "hold-tx",
        status: "OPEN",
      }),
    })
    expect(prisma.depositAttempt.updateMany).toHaveBeenCalledWith({
      where: { id: "attempt-1", status: "SUCCEEDED" },
      data: { status: "DISPUTED" },
    })
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "STRIPE_CHARGEBACK_HOLD_PLACED",
        metadata: expect.objectContaining({
          heldAmount: "600.00",
          bookedShortfallAmount: "0.00",
          currentExposureAmount: "0.00",
        }),
      }),
      prisma,
    )
    expect(prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.transaction.findFirst.mock.invocationCallOrder[0],
    )
  })

  it("durably separates booked shortfall from current exposure", async () => {
    prisma.wallet.findUniqueOrThrow.mockResolvedValue({
      ...wallet,
      availableBalance: new Decimal(100),
    })

    const outcome = await (service as any).handleChargeback(
      dispute,
      "event-open",
    )

    expect(outcome).toEqual(
      expect.objectContaining({ held: "100.00", shortfall: "500.00" }),
    )
    expect(prisma.paymentDispute.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        heldAmount: "100",
        shortfallAmount: "500",
        currentExposureAmount: "500",
      }),
    })
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "STRIPE_CHARGEBACK_HOLD_PLACED",
        metadata: expect.objectContaining({
          heldAmount: "100.00",
          bookedShortfallAmount: "500.00",
          currentExposureAmount: "500.00",
        }),
      }),
      prisma,
    )
  })

  it("creates no zero-value hold ledger row when the wallet has no available funds", async () => {
    prisma.wallet.findUniqueOrThrow.mockResolvedValue({
      ...wallet,
      availableBalance: new Decimal(0),
    })

    const outcome = await (service as any).handleChargeback(
      dispute,
      "event-open",
    )

    expect(outcome).toEqual(
      expect.objectContaining({ held: "0.00", shortfall: "600.00" }),
    )
    expect(prisma.wallet.updateMany).not.toHaveBeenCalled()
    expect(prisma.transaction.create).not.toHaveBeenCalled()
    expect(prisma.paymentDispute.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        heldAmount: "0",
        shortfallAmount: "600",
        currentExposureAmount: "600",
        holdTransactionId: null,
        openedByEventId: "event-open",
      }),
    })
  })

  it("makes an exact duplicate open event a durable no-op", async () => {
    prisma.paymentDispute.findUnique.mockResolvedValue(openCase)

    const outcome = await (service as any).handleChargeback(
      dispute,
      "event-open",
    )

    expect(outcome).toEqual(
      expect.objectContaining({ status: "OPEN", created: false }),
    )
    expect(prisma.__committed).toBe(true)
    expect(prisma.wallet.updateMany).not.toHaveBeenCalled()
    expect(prisma.transaction.create).not.toHaveBeenCalled()
    expect(audit.log).not.toHaveBeenCalled()
  })

  it("fails an unlinked event so the durable provider inbox can retry it", async () => {
    prisma.transaction.findFirst.mockResolvedValue(null)

    await expect(
      (service as any).handleChargeback(dispute, "event-open"),
    ).rejects.toThrow(/not yet linked/i)

    expect(prisma.wallet.updateMany).not.toHaveBeenCalled()
    expect(audit.log).not.toHaveBeenCalled()
  })

  it("revalidates deposit status inside the transaction before moving money", async () => {
    prisma.transaction.findFirst.mockResolvedValue({
      ...depositRow,
      depositAttempt: {
        ...depositRow.depositAttempt,
        status: "FAILED",
      },
    })

    await expect(
      (service as any).handleChargeback(dispute, "event-open"),
    ).rejects.toThrow(/eligible originating deposit state/i)

    expect(prisma.wallet.updateMany).not.toHaveBeenCalled()
    expect(prisma.transaction.create).not.toHaveBeenCalled()
    expect(prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.transaction.findFirst.mock.invocationCallOrder[0],
    )
  })

  it("rejects an uncertified currency before interpreting its minor units", async () => {
    await expect(
      (service as any).handleChargeback(
        { ...dispute, currency: "jpy" },
        "event-open",
      ),
    ).rejects.toThrow(/not certified/i)

    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(prisma.transaction.findFirst).not.toHaveBeenCalled()
  })

  it("WON releases the hold and clears current uncovered exposure", async () => {
    prisma.paymentDispute.findUnique.mockResolvedValue({
      ...openCase,
      heldAmount: new Decimal(100),
      shortfallAmount: new Decimal(500),
      currentExposureAmount: new Decimal(500),
    })
    prisma.paymentDispute.findMany.mockResolvedValue([{ status: "WON" }])
    prisma.wallet.findUniqueOrThrow.mockResolvedValue({
      ...wallet,
      version: 5,
      availableBalance: new Decimal(100),
      reservedBalance: new Decimal(100),
    })

    const outcome = await (service as any).handleChargebackClosed(
      closedDispute("won"),
      "event-close-won",
    )

    expect(outcome.shortfall).toBe("0.00")
    expect(prisma.wallet.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reservedBalance: { decrement: expect.anything() },
          availableBalance: { increment: expect.anything() },
        }),
      }),
    )
    expect(prisma.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "RESERVATION",
        reference: "payment-dispute:stripe:dp_1:won",
      }),
    })
    expect(prisma.paymentDispute.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "WON",
          currentExposureAmount: "0",
        }),
      }),
    )
    const caseUpdate = prisma.paymentDispute.updateMany.mock.calls[0][0].data
    expect(caseUpdate).not.toHaveProperty("shortfallAmount")
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "STRIPE_CHARGEBACK_WON_RELEASED",
        metadata: expect.objectContaining({
          bookedShortfallAmount: "500.00",
          currentExposureAmount: "0.00",
        }),
      }),
      prisma,
    )
  })

  it("LOST consumes the hold and retains any unrecovered shortfall", async () => {
    prisma.paymentDispute.findUnique.mockResolvedValue({
      ...openCase,
      heldAmount: new Decimal(100),
      shortfallAmount: new Decimal(500),
      currentExposureAmount: new Decimal(500),
    })
    prisma.paymentDispute.findMany.mockResolvedValue([{ status: "LOST" }])
    prisma.wallet.findUniqueOrThrow.mockResolvedValue({
      ...wallet,
      version: 5,
      reservedBalance: new Decimal(100),
    })

    const outcome = await (service as any).handleChargebackClosed(
      closedDispute("lost"),
      "event-close-lost",
    )

    expect(outcome.shortfall).toBe("500.00")
    const updateData = prisma.wallet.updateMany.mock.calls[0][0].data
    expect(updateData.reservedBalance).toEqual({ decrement: expect.anything() })
    expect(updateData.availableBalance).toBeUndefined() // money does NOT come back
    expect(prisma.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "CHARGEBACK",
        reference: "payment-dispute:stripe:dp_1:lost",
      }),
    })
    const caseUpdate = prisma.paymentDispute.updateMany.mock.calls[0][0].data
    expect(caseUpdate).toEqual(
      expect.objectContaining({
        status: "LOST",
        currentExposureAmount: "500",
      }),
    )
    expect(caseUpdate).not.toHaveProperty("shortfallAmount")
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "STRIPE_CHARGEBACK_LOST_DEBITED" }),
      prisma,
    )
    expect(prisma.depositAttempt.updateMany).toHaveBeenCalledWith({
      where: { id: "attempt-1", status: "SUCCEEDED" },
      data: { status: "CHARGEBACK" },
    })
  })

  it("creates LOST directly when close arrives before open", async () => {
    prisma.wallet.findUniqueOrThrow.mockResolvedValue({
      ...wallet,
      availableBalance: new Decimal(100),
    })

    const outcome = await (service as any).handleChargebackClosed(
      closedDispute("lost"),
      "event-close-lost",
    )

    expect(outcome).toEqual(
      expect.objectContaining({
        status: "LOST",
        held: "100.00",
        shortfall: "500.00",
      }),
    )
    expect(prisma.wallet.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          availableBalance: { decrement: "100" },
          version: { increment: 1 },
        },
      }),
    )
    expect(prisma.paymentDispute.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "LOST",
        heldAmount: "100",
        shortfallAmount: "500",
        currentExposureAmount: "500",
        resolutionTransactionId: "resolution-tx",
      }),
    })
  })

  it("creates no zero-value debit ledger row for LOST-before-open with no funds", async () => {
    prisma.wallet.findUniqueOrThrow.mockResolvedValue({
      ...wallet,
      availableBalance: new Decimal(0),
    })
    prisma.paymentDispute.findMany.mockResolvedValue([{ status: "LOST" }])

    const outcome = await (service as any).handleChargebackClosed(
      closedDispute("lost"),
      "event-close-lost",
    )

    expect(outcome).toEqual(
      expect.objectContaining({
        status: "LOST",
        held: "0.00",
        shortfall: "600.00",
      }),
    )
    expect(prisma.wallet.updateMany).not.toHaveBeenCalled()
    expect(prisma.transaction.create).not.toHaveBeenCalled()
    expect(prisma.paymentDispute.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "LOST",
        heldAmount: "0",
        shortfallAmount: "600",
        currentExposureAmount: "600",
        resolutionTransactionId: null,
      }),
    })
  })

  it("WON-before-open records no current exposure and moves no wallet funds", async () => {
    prisma.paymentDispute.findMany.mockResolvedValue([{ status: "WON" }])

    const outcome = await (service as any).handleChargebackClosed(
      closedDispute("won"),
      "event-close-won",
    )

    expect(outcome).toEqual(
      expect.objectContaining({
        status: "WON",
        held: "0.00",
        shortfall: "0.00",
      }),
    )
    expect(prisma.wallet.updateMany).not.toHaveBeenCalled()
    expect(prisma.transaction.create).not.toHaveBeenCalled()
    expect(prisma.paymentDispute.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "WON",
        heldAmount: "0",
        shortfallAmount: "600",
        currentExposureAmount: "0",
        resolvedByEventId: "event-close-won",
        resolutionTransactionId: null,
      }),
    })
  })

  it("attaches a delayed open event to a terminal case without regressing it", async () => {
    prisma.paymentDispute.findUnique.mockResolvedValue({
      ...openCase,
      status: "WON",
      providerStatus: "won",
      heldAmount: new Decimal(0),
      shortfallAmount: new Decimal(600),
      currentExposureAmount: new Decimal(0),
      openedByEventId: null,
      openedAt: null,
      resolvedByEventId: "event-close",
      resolutionTransactionId: null,
      resolvedAt: new Date("2026-06-11T10:00:00Z"),
    })
    prisma.paymentDispute.findMany.mockResolvedValue([{ status: "WON" }])

    const outcome = await (service as any).handleChargeback(
      dispute,
      "event-delayed-open",
    )

    expect(outcome.status).toBe("WON")
    expect(prisma.wallet.updateMany).not.toHaveBeenCalled()
    const evidenceUpdate = prisma.paymentDispute.updateMany.mock.calls.find(
      ([input]: any[]) => input.data.openedByEventId,
    )?.[0]
    expect(evidenceUpdate).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "case-1",
          openedByEventId: null,
          openedAt: null,
        }),
        data: expect.objectContaining({
          openedByEventId: "event-delayed-open",
          openedAt: expect.any(Date),
          version: { increment: 1 },
        }),
      }),
    )
    expect(evidenceUpdate.data).not.toHaveProperty("status")
    expect(evidenceUpdate.data).not.toHaveProperty("providerStatus")
    expect(prisma.paymentProviderEvent.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "event-delayed-open" }),
      data: expect.objectContaining({
        status: "PROCESSED",
        depositAttemptId: "attempt-1",
        paymentDisputeId: "case-1",
      }),
    })
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "STRIPE_CHARGEBACK_OPEN_EVIDENCE_ATTACHED",
      }),
      prisma,
    )
  })

  it("refuses conflicting terminal outcomes and unknown close statuses", async () => {
    prisma.paymentDispute.findUnique.mockResolvedValue({
      ...openCase,
      status: "WON",
      providerStatus: "won",
      resolutionTransactionId: "resolution-tx",
      resolvedAt: new Date(),
    })

    await expect(
      (service as any).handleChargebackClosed(
        closedDispute("lost"),
        "event-close-lost",
      ),
    ).rejects.toThrow(/already terminal/i)
    await expect(
      (service as any).handleChargebackClosed(
        closedDispute("under_review"),
        "event-close-unknown",
      ),
    ).rejects.toThrow(/does not match its provider status/i)
    expect(prisma.wallet.updateMany).not.toHaveBeenCalled()
  })

  it("rejects cumulative distinct disputes above the originating deposit", async () => {
    prisma.paymentDispute.aggregate.mockResolvedValue({
      _sum: { amount: new Decimal(700) },
    })

    await expect(
      (service as any).handleChargeback(dispute, "event-open"),
    ).rejects.toThrow(/cumulative disputes exceed/i)

    expect(prisma.wallet.updateMany).not.toHaveBeenCalled()
    expect(prisma.transaction.create).not.toHaveBeenCalled()
  })

  it.each([
    {
      statuses: [{ status: "WON" }, { status: "OPEN" }],
      expected: "DISPUTED",
    },
    {
      statuses: [{ status: "WON" }, { status: "LOST" }],
      expected: "CHARGEBACK",
    },
  ])("derives the deposit attempt from every dispute case ($expected)", async ({
    statuses,
    expected,
  }) => {
    prisma.paymentDispute.findUnique.mockResolvedValue(openCase)
    prisma.paymentDispute.findMany.mockResolvedValue(statuses)
    prisma.wallet.findUniqueOrThrow.mockResolvedValue({
      ...wallet,
      reservedBalance: new Decimal(600),
    })

    await (service as any).handleChargebackClosed(
      closedDispute("won"),
      "event-close-won",
    )

    expect(prisma.depositAttempt.updateMany).toHaveBeenCalledWith({
      where: { id: "attempt-1", status: "SUCCEEDED" },
      data: { status: expected },
    })
  })

  it("creates deduplicated staff notifications inside the financial transaction", async () => {
    prisma.staffMembership.findMany.mockResolvedValue([
      { userId: "staff-1" },
      { userId: "staff-2" },
    ])

    await (service as any).handleChargeback(dispute, "event-open")

    expect(prisma.notification.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          userId: "staff-1",
          dedupKey: "chargeback:dp_1:opened:staff-1",
        }),
        expect.objectContaining({
          userId: "staff-2",
          dedupKey: "chargeback:dp_1:opened:staff-2",
        }),
      ],
      skipDuplicates: true,
    })
    expect(prisma.__committed).toBe(true)
  })

  it("never treats an unrelated P2002 as a harmless duplicate", async () => {
    const collision = Object.assign(new Error("unique"), { code: "P2002" })
    prisma.paymentDispute.create.mockRejectedValueOnce(collision)
    prisma.paymentDispute.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)

    await expect(
      (service as any).handleChargeback(dispute, "event-open"),
    ).rejects.toBe(collision)

    expect(prisma.__committed).toBe(false)
  })

  it("retries P2002 only after rereading an exact durable dispute case", async () => {
    const collision = Object.assign(new Error("unique"), { code: "P2002" })
    prisma.paymentDispute.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(openCase)
      .mockResolvedValueOnce(openCase)
    prisma.paymentDispute.create.mockRejectedValueOnce(collision)

    const outcome = await (service as any).handleChargeback(
      dispute,
      "event-open",
    )

    expect(outcome).toEqual(
      expect.objectContaining({ status: "OPEN", created: false }),
    )
    expect(prisma.paymentDispute.findUnique).toHaveBeenCalledTimes(3)
    expect(audit.log).not.toHaveBeenCalled()
    expect(prisma.__committed).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("F-2: payout webhook normalization (real provider shapes)", () => {
  it("maps a real Wise transfers#state-change envelope", () => {
    const wiseEnvelope = {
      data: {
        resource: {
          id: 12345678,
          profile_id: 111,
          account_id: 222,
          type: "transfer",
        },
        current_state: "outgoing_payment_sent",
        previous_state: "processing",
        occurred_at: "2026-06-11T12:00:00Z",
      },
      subscription_id: "sub-1",
      event_type: "transfers#state-change",
      schema_version: "2.0.0",
      sent_at: "2026-06-11T12:00:01Z",
    }
    const n = normalizeProviderWebhook("wise", wiseEnvelope)
    expect(n.providerExecutionId).toBe("12345678")
    expect(n.status).toBe("PROCESSING") // same WISE_STATUS_MAP as the poller
    expect(n.rawStatus).toBe("outgoing_payment_sent")
  })

  it("fails closed for the non-official Wise completed state", () => {
    const inner = {
      resource: { id: 99, type: "transfer" },
      current_state: "completed",
    }
    const n = normalizeProviderWebhook("wise", inner)
    expect(n.providerExecutionId).toBe("99")
    expect(n.status).toBeNull()
  })

  it("maps Wise cancelled to FAILED", () => {
    const n = normalizeProviderWebhook("wise", {
      resource: { id: 7 },
      current_state: "cancelled",
    })
    expect(n.status).toBe("FAILED")
  })

  it("keeps a real Stripe transfer.updated snapshot observational", () => {
    const stripeEnvelope = {
      id: "evt_1",
      type: "transfer.updated",
      data: {
        object: {
          id: "tr_123",
          object: "transfer",
          status: "paid",
          amount: 20000,
        },
      },
    }
    const n = normalizeProviderWebhook("stripe_connect", stripeEnvelope)
    expect(n.providerExecutionId).toBe("tr_123")
    expect(n.status).toBe("PROCESSING")
  })

  it("maps Stripe payout failure with the failure message", () => {
    const n = normalizeProviderWebhook("stripe_connect", {
      object: {
        id: "po_9",
        status: "failed",
        failure_message: "account closed",
      },
    })
    expect(n.providerExecutionId).toBe("po_9")
    expect(n.status).toBe("FAILED")
    expect(n.error).toBe("account closed")
  })

  it("passes pre-normalized internal payloads through untouched", () => {
    const n = normalizeProviderWebhook("wise", {
      providerExecutionId: "abc",
      status: "COMPLETED",
    })
    expect(n.providerExecutionId).toBe("abc")
    expect(n.status).toBe("COMPLETED")
  })

  it("yields no transition for unknown provider states", () => {
    const n = normalizeProviderWebhook("wise", {
      resource: { id: 1 },
      current_state: "bounced_back_weirdly",
    })
    expect(n.providerExecutionId).toBe("1")
    expect(n.status).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("F-3: tenant-scoped order idempotency", () => {
  let service: OrdersService
  let prisma: any

  beforeEach(() => {
    prisma = makePrismaMock()
    service = new OrdersService(prisma)
  })

  it("replays via the composite (organizationId, idempotencyKey) lookup — never key-only", async () => {
    const requestFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          actorUserId: "u1",
          customerId: "u1",
          items: [],
          organizationId: "org-A",
          type: "GUEST_POST",
        }),
      )
      .digest("hex")
    const existing = {
      id: "order-A",
      organizationId: "org-A",
      currency: "USD",
      requestFingerprint,
    }
    prisma.order.findUnique.mockResolvedValue(existing)

    const result = await service.createOrder(
      {
        type: "GUEST_POST",
        customerId: "u1",
        organizationId: "org-A",
        idempotencyKey: "key-1",
      } as any,
      "u1",
    )

    expect(result).toEqual(
      expect.objectContaining({
        id: "order-A",
        currency: "USD",
      }),
    )
    expect(result).not.toHaveProperty("organizationId")
    expect(result).not.toHaveProperty("requestFingerprint")
    expect(prisma.order.findUnique).toHaveBeenCalledWith({
      where: {
        organizationId_idempotencyKey: {
          organizationId: "org-A",
          idempotencyKey: "key-1",
        },
      },
      include: {
        items: true,
        articleVersions: true,
      },
    })
    expect(prisma.order.create).not.toHaveBeenCalled()
  })

  it("another tenant reusing the same key gets its OWN order, not the other tenant's", async () => {
    prisma.order.findUnique.mockResolvedValue(null) // scoped lookup: no hit for org-B

    // Phase 6 — orders.service.ts:99–132 requires the listingServiceId snapshot
    // to resolve before order creation. Mock shape mirrors the production
    // findUnique({ where, include: { listing: { include: { website } } } })
    // query so the snapshot block can read availability + listing.status +
    // listing.ownerType + listing.website.{id,ownershipType,verificationStatus,managedByUserId}.
    prisma.listingService.findUnique.mockResolvedValue({
      id: "ls-B",
      listingId: "listing-B",
      serviceType: "GUEST_POST",
      price: 500,
      currency: "USD",
      availability: "AVAILABLE",
      turnaroundDays: 7,
      listing: {
        status: "APPROVED",
        ownerType: "PUBLISHER",
        website: {
          id: "site-B",
          ownershipType: "PUBLISHER",
          verificationStatus: "VERIFIED",
          managedByUserId: null,
        },
      },
    })
    prisma.order.create.mockResolvedValue({
      id: "order-B",
      organizationId: "org-B",
    })
    prisma.website.findUnique.mockResolvedValue({
      ownershipType: "PUBLISHER",
      verificationStatus: "VERIFIED",
    })
    prisma.order.findUniqueOrThrow.mockResolvedValue({
      id: "order-B",
      organizationId: "org-B",
      amount: 500,
      items: [{ id: "item-B", price: 500 }],
      articleVersions: [],
    })

    const result = await service.createOrder(
      {
        type: "GUEST_POST",
        customerId: "u2",
        organizationId: "org-B",
        idempotencyKey: "key-1",
        listingServiceId: "ls-B", // Phase 6 snapshot requirement
        briefData: {
          title: "Tenant B guest post",
          topic: "A complete topic for tenant-scoped idempotency validation",
          targetUrl: "https://tenant-b.example/target",
          anchorText: "Tenant B anchor",
        },
      } as any,
      "u2",
    )

    expect(result.id).toBe("order-B")
    expect(prisma.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org-B",
          idempotencyKey: "key-1",
        }),
      }),
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("F-4: FAILED withdrawal reversal evidence gate", () => {
  let service: PublisherPayoutsService
  let prisma: any
  let audit: any

  const failedWithdrawal = {
    id: "wd-1",
    publisherId: "pub-1",
    amount: new Decimal(200),
    status: "FAILED",
    version: 4,
    publisher: { id: "pub-1", organizationId: "org-1" },
    executions: [
      {
        id: "exec-1",
        status: "FAILED",
        providerExecutionId: "provider-object-1",
        providerPayoutId: null,
        stage: "PROVIDER_FAILURE_REVIEW_REQUIRED",
      },
    ],
  }

  beforeEach(() => {
    prisma = makePrismaMock()
    audit = auditMock()
    service = new PublisherPayoutsService(
      prisma,
      audit as any,
      queueMock() as any,
      {} as any,
      {} as any,
    )
  })

  it("keeps funds reserved until typed provider evidence is revalidated atomically", async () => {
    prisma.withdrawal.findUnique.mockResolvedValue(failedWithdrawal)

    let thrown: unknown
    try {
      await service.reverseFailedWithdrawal(
        "wd-1",
        "admin-1",
        "Provider failure needs reviewed reversal evidence",
      )
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ConflictException)
    expect((thrown as ConflictException).getResponse()).toEqual({
      code: "PAYOUT_REVERSAL_EVIDENCE_REQUIRED",
      message:
        "Automatic failed-withdrawal reversal is disabled. Durable provider-confirmed failure or cancellation evidence must be revalidated atomically before reserved funds can be restored.",
      withdrawalStatus: "FAILED",
      executionIds: ["exec-1"],
    })
    expect(prisma.publisherBalance.updateMany).not.toHaveBeenCalled()
    expect(prisma.withdrawal.updateMany).not.toHaveBeenCalled()
    expect(prisma.transaction.create).not.toHaveBeenCalled()
    expect(audit.log).not.toHaveBeenCalled()
  })

  it("rejects a missing or placeholder reason before reading financial state", async () => {
    await expect(
      service.reverseFailedWithdrawal("wd-1", "admin-1", "short"),
    ).rejects.toThrow(BadRequestException)
    expect(prisma.withdrawal.findUnique).not.toHaveBeenCalled()
    expect(prisma.publisherBalance.updateMany).not.toHaveBeenCalled()
    expect(prisma.transaction.create).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("F-5: customerApprove cannot corrupt a RELEASED settlement", () => {
  let service: SettlementsService
  let prisma: any

  const settlement = {
    id: "set-1",
    orderId: "order-1",
    publisherId: "pub-1",
    status: "PENDING",
    currency: "USD",
    publisherAmount: new Decimal(160),
    version: 2,
    order: { organizationId: "org-1", customerId: "u1" },
  }

  beforeEach(() => {
    prisma = makePrismaMock()
    prisma.order.findUnique.mockResolvedValue({
      id: "order-1",
      status: "DELIVERED",
      version: 4,
      currency: "USD",
      paymentStatus: "PAID",
      activeDeliveryVersionId: "delivery-1",
    })
    prisma.orderDeliveryVersion.findUnique.mockResolvedValue({
      id: "delivery-1",
      orderId: "order-1",
      normalizedUrl: "https://publisher.example/article",
      supersededByVersion: null,
      verificationStatus: "VERIFIED",
      interventionStatus: "NONE",
    })
    prisma.orderDispute.findFirst.mockResolvedValue(null)
    prisma.revision.findFirst.mockResolvedValue(null)
    prisma.orderCancellationRequest.findFirst.mockResolvedValue(null)
    prisma.deliveryFraudFlag.count.mockResolvedValue(0)
    service = new SettlementsService(
      prisma,
      auditMock() as any,
      queueMock() as any,
    )
  })

  it("approves via a status+version-guarded conditional update", async () => {
    prisma.settlement.findUnique.mockResolvedValue(settlement)
    prisma.orderDispute.findFirst.mockResolvedValue(null)
    prisma.settlement.updateMany.mockResolvedValue({ count: 1 })
    prisma.settlement.findUniqueOrThrow.mockResolvedValue({
      ...settlement,
      status: "CUSTOMER_APPROVED",
    })

    const result = await service.customerApprove(
      "set-1",
      "u1",
      "org-1",
      "OWNER",
    )

    expect(result.status).toBe("CUSTOMER_APPROVED")
    expect(prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "set-1",
          status: { in: ["PENDING", "UNDER_REVIEW"] },
          version: 2,
          currency: "USD",
        },
      }),
    )
    // The unguarded settlement.update() path must be gone
    expect(prisma.settlement.update).not.toHaveBeenCalled()
  })

  it("conflicts instead of overwriting when the settlement was concurrently RELEASED", async () => {
    // Stale pre-tx read says PENDING; by the time the tx runs, a concurrent
    // forceApprove chain has already moved the row to RELEASED.
    prisma.settlement.findUnique.mockResolvedValue(settlement)
    prisma.orderDispute.findFirst.mockResolvedValue(null)
    prisma.settlement.updateMany.mockResolvedValue({ count: 0 }) // guard catches it

    await expect(
      service.customerApprove("set-1", "u1", "org-1", "OWNER"),
    ).rejects.toThrow(ConflictException)
    expect(prisma.settlementApproval.upsert).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// FIN-02: provider-aware uniqueness on Transaction
//
// Audit finding: deposit idempotency relied solely on `reference` (Stripe
// session.id), leaving a hole when a replayed webhook returned a new session.id
// but the same `payment_intent`. Sprint 3 closes the race at the DB level with
// a partial unique index on `(provider, providerRef) WHERE providerRef IS NOT
// NULL` (migration 20260716030403). The application MUST set `provider: "stripe"`
// on every row that sets `providerRef` — otherwise the row falls outside the
// partial-unique identity model and the constraint can't see it. The DEPOSIT is
// the sole owner of that identity; dispute holds use a server-owned reference.
// These tests lock in provider-scoped reads for chargebacks and fraud warnings.
//
// Note: the write-time assertions are duplicated in the F-1 / F-6 blocks
// above (so future regression PRs that touch only one path still hear about
// it); this block additionally covers the early-fraud-warning path which has
// no other test coverage of `provider`-awareness.
// ──────────────────────────────────────────────────────────
describe("FIN-02: provider-aware uniqueness on Transaction", () => {
  let service: BillingService
  let prisma: any
  let audit: any

  const depositRow = {
    id: "t-dep",
    walletId: "wallet-1",
    amount: new Decimal(1000),
    currency: "USD",
    reference: "cs_1",
    orderId: null,
    depositAttempt: {
      id: "attempt-fin02",
      walletId: "wallet-1",
      walletCredit: new Decimal(1000),
      currency: "USD",
      provider: "stripe",
      providerPaymentId: "pi_fin02",
      ledgerTransactionId: "t-dep",
      status: "SUCCEEDED",
    },
  }

  beforeEach(() => {
    prisma = makePrismaMock()
    audit = auditMock()
    service = new BillingService(prisma, audit as any)
    prisma.paymentDispute.aggregate.mockResolvedValue({
      _sum: { amount: null },
    })
    prisma.paymentDispute.findMany.mockResolvedValue([{ status: "OPEN" }])
    prisma.transaction.create.mockResolvedValue({ id: "hold-fin02" })
    prisma.paymentDispute.create.mockResolvedValue({ id: "case-fin02" })
    prisma.paymentProviderEvent.findUnique.mockResolvedValue(
      storedDisputeEvent("event-fin02", "charge.dispute.created", {
        id: "dp_fin02",
        charge: "ch_fin02",
        payment_intent: "pi_fin02",
        amount: 10000,
        currency: "usd",
        status: "needs_response",
      }),
    )
  })

  it("handleChargeback filters the deposit lookup by `provider: stripe`", async () => {
    prisma.transaction.findFirst.mockResolvedValueOnce(depositRow)
    prisma.wallet.findUniqueOrThrow.mockResolvedValue({
      id: "wallet-1",
      organizationId: "org-1",
      currency: "USD",
      version: 2,
      availableBalance: new Decimal(1000),
      reservedBalance: new Decimal(0),
    })

    await (service as any).handleChargeback(
      {
        id: "dp_fin02",
        charge: "ch_fin02",
        payment_intent: "pi_fin02",
        amount: 10000,
        currency: "usd",
        reason: "fraudulent",
        status: "needs_response",
      },
      "event-fin02",
    )

    // The in-transaction lookup MUST scope by provider + providerRef + type.
    // Without `provider` in the WHERE, the lookup could miss rows that the
    // partial-unique constraint already anchored on `provider = 'stripe'`.
    const outerLookup = prisma.transaction.findFirst.mock.calls[0][0]
    expect(outerLookup).toEqual({
      where: {
        provider: "stripe",
        providerRef: "pi_fin02",
        type: "DEPOSIT",
      },
      select: {
        id: true,
        walletId: true,
        amount: true,
        currency: true,
        depositAttempt: {
          select: {
            id: true,
            walletId: true,
            walletCredit: true,
            currency: true,
            provider: true,
            providerPaymentId: true,
            ledgerTransactionId: true,
            status: true,
          },
        },
      },
    })
  })

  it("handleEarlyFraudWarning filters the deposit lookup by `provider: stripe`", async () => {
    // The audit-log idempotency precheck returns null so the handler
    // proceeds to the deposit lookup.
    prisma.auditLog.findFirst.mockResolvedValueOnce(null)
    prisma.transaction.findFirst.mockResolvedValueOnce({
      ...depositRow,
      orderId: "order-1",
    })

    await (service as any).handleEarlyFraudWarning({
      id: "evt_fin02",
      type: "radar.early_fraud_warning.created",
      data: {
        object: {
          id: "ifw_fin02",
          payment_intent: "pi_fin02",
          charge: "ch_fin02",
          amount: 10000,
          currency: "usd",
        },
      },
    })

    // The deposit-lookup WHERE must include `provider: "stripe"` — same
    // identity model as the write path. A lookup that forgets the provider
    // would still HIT a matching row today (the backfill set `provider='stripe'`
    // on historical rows), but tying the read to the write identity keeps a
    // future Wise/PayPal integration from cross-pollinating deposit refs.
    const depositLookup = prisma.transaction.findFirst.mock.calls.find(
      (c: any) =>
        c[0]?.where?.providerRef === "pi_fin02" &&
        c[0]?.where?.type === "DEPOSIT",
    )
    expect(depositLookup?.[0]?.where).toEqual({
      provider: "stripe",
      providerRef: "pi_fin02",
      type: "DEPOSIT",
    })
  })
})
