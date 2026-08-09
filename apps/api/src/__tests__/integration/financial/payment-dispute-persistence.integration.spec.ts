import crypto from "node:crypto"
import {
  type FingerprintablePaymentDisputeEvent,
  lockWalletForUpdate,
  paymentDisputeEventFingerprint,
  paymentDisputeEventFromStoredRow,
  transitionPaymentDispute,
} from "@guestpost/shared/dist/payment-dispute-core"
import {
  ReconciliationCode,
  runReconciliation,
} from "@guestpost/shared/dist/reconciliation-core"
import {
  makeOrder,
  makeOrderItem,
  makeOrganization,
  makeTransaction,
  makeUser,
  makeWallet,
  makeWebsite,
} from "../factories"
import { createTestDatabase, type TestDatabase } from "../helpers/test-db"

interface DepositFixture {
  organization: { id: string }
  user: { id: string }
  wallet: { id: string }
  depositAttempt: { id: string }
  depositTransaction: { id: string; amount: unknown }
  providerSessionId: string
  paymentIntentId: string
}

describe("[INTEGRATION] Financial — payment dispute persistence", () => {
  let database: TestDatabase | undefined
  let previousDatabaseUrl: string | undefined
  let previousStripeSecretKey: string | undefined
  let previousStripeLiveMode: string | undefined
  let prisma: any
  let billing: any

  beforeAll(async () => {
    database = await createTestDatabase()
    previousDatabaseUrl = process.env.DATABASE_URL
    previousStripeSecretKey = process.env.STRIPE_SECRET_KEY
    previousStripeLiveMode = process.env.STRIPE_LIVE_MODE_ENABLED
    process.env.DATABASE_URL = database.url
    process.env.STRIPE_SECRET_KEY = "rk_test_dispute_integration"
    process.env.STRIPE_LIVE_MODE_ENABLED = "false"
    const { PrismaService } = require("../../../common/prisma.service") as any
    const { AuditService } =
      require("../../../modules/audit/audit.service") as any
    const { BillingService } =
      require("../../../modules/billing/billing.service") as any
    prisma = new PrismaService()
    await prisma.$connect()
    billing = new BillingService(prisma, new AuditService(prisma))
  })

  afterAll(async () => {
    try {
      await prisma?.$disconnect()
    } finally {
      await database?.teardown()
      if (previousDatabaseUrl !== undefined) {
        process.env.DATABASE_URL = previousDatabaseUrl
      } else {
        delete process.env.DATABASE_URL
      }
      if (previousStripeSecretKey !== undefined) {
        process.env.STRIPE_SECRET_KEY = previousStripeSecretKey
      } else {
        delete process.env.STRIPE_SECRET_KEY
      }
      if (previousStripeLiveMode !== undefined) {
        process.env.STRIPE_LIVE_MODE_ENABLED = previousStripeLiveMode
      } else {
        delete process.env.STRIPE_LIVE_MODE_ENABLED
      }
    }
  })

  async function makeDepositFixture(options: {
    depositAmount: number
    availableBalance: number
  }): Promise<DepositFixture> {
    const suffix = crypto.randomUUID()
    const organization = await makeOrganization(prisma)
    const user = await makeUser(prisma, { userType: "CUSTOMER" })
    const wallet = await makeWallet(prisma, {
      organizationId: organization.id,
      availableBalance: options.availableBalance,
    })
    const paymentIntentId = `pi_integration_${suffix}`
    const providerSessionId = `cs_integration_${suffix}`
    const depositTransaction = await makeTransaction(prisma, {
      walletId: wallet.id,
      amount: options.depositAmount,
      type: "DEPOSIT",
      reference: providerSessionId,
      description: "Integration-test Stripe deposit",
      provider: "stripe",
      providerRef: paymentIntentId,
    })
    const depositAttempt = await prisma.depositAttempt.create({
      data: {
        publicReference: `DP-${suffix}`.slice(0, 32),
        walletId: wallet.id,
        organizationId: organization.id,
        createdByUserId: user.id,
        method: "CARD",
        provider: "stripe",
        amount: options.depositAmount,
        walletCredit: options.depositAmount,
        currency: "USD",
        status: "SUCCEEDED",
        idempotencyKey: `deposit-${suffix}`,
        providerSessionId,
        providerPaymentId: paymentIntentId,
        ledgerTransactionId: depositTransaction.id,
        completedAt: new Date(),
      },
    })

    return {
      organization,
      user,
      wallet,
      depositAttempt,
      depositTransaction,
      providerSessionId,
      paymentIntentId,
    }
  }

  async function makeRefundableOrder(
    fixture: DepositFixture,
    website: { id: string },
  ) {
    const suffix = crypto.randomUUID()
    const listing = await prisma.marketplaceListing.create({
      data: {
        title: `Refund fixture ${suffix}`,
        slug: `refund-fixture-${suffix}`,
        description: "Captured refund integration fixture",
        status: "APPROVED",
        fulfillmentType: "PUBLISHER",
        ownerType: "PUBLISHER",
        currency: "USD",
        websiteId: website.id,
        organizationId: fixture.organization.id,
      },
    })
    const listingService = await prisma.listingService.create({
      data: {
        listingId: listing.id,
        serviceType: "GUEST_POST",
        price: 25,
        currency: "USD",
        turnaroundDays: 3,
        availability: "AVAILABLE",
      },
    })
    const order = await makeOrder(prisma, {
      organizationId: fixture.organization.id,
      customerId: fixture.user.id,
      websiteId: website.id,
      status: "DRAFT",
      paymentStatus: "PENDING",
      amount: 25,
      fulfillmentChannel: "PUBLISHER",
      listingId: listing.id,
      listingServiceId: listingService.id,
      revisionRoundsSnapshot: listingService.revisionRounds,
      turnaroundDays: listingService.turnaroundDays,
    })
    await makeOrderItem(prisma, {
      orderId: order.id,
      websiteId: website.id,
      price: 25,
      status: "PENDING_PAYMENT",
    })
    await prisma.$transaction(async (tx: any) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "PAID", paymentStatus: "PAID" },
      })
      await makeTransaction(tx, {
        walletId: fixture.wallet.id,
        amount: -25,
        type: "PURCHASE",
        reference: `refund-purchase-${suffix}`,
        orderId: order.id,
      })
    })
    return order
  }

  async function makeCheckoutProviderEvent(objectId: string): Promise<any> {
    const eventFingerprint = crypto
      .createHash("sha256")
      .update(`checkout.session.completed:${objectId}`)
      .digest("hex")
    const event = await prisma.paymentProviderEvent.create({
      data: {
        provider: "stripe",
        providerEventId: `evt_checkout_${crypto.randomUUID()}`,
        eventType: "checkout.session.completed",
        objectId,
        livemode: false,
        eventFingerprint,
        status: "PENDING",
      },
    })
    const claimed = await prisma.paymentProviderEvent.updateMany({
      where: { id: event.id, status: "PENDING" },
      data: {
        status: "PROCESSING",
        attempts: { increment: 1 },
        lockedAt: new Date(),
      },
    })
    expect(claimed.count).toBe(1)
    return prisma.paymentProviderEvent.findUniqueOrThrow({
      where: { id: event.id },
    })
  }

  async function makeProviderEvent(
    fixture: DepositFixture,
    providerDisputeId: string,
    eventType: "charge.dispute.created" | "charge.dispute.closed",
    amountInCents = 60_000,
    providerStatus = eventType === "charge.dispute.created"
      ? "needs_response"
      : "won",
  ) {
    const providerEventId = `evt_${crypto.randomUUID()}`
    const amountMinor = BigInt(amountInCents)
    const fingerprintable: FingerprintablePaymentDisputeEvent = {
      provider: "stripe",
      providerEventId,
      eventType,
      providerDisputeId,
      providerPaymentId: fixture.paymentIntentId,
      providerChargeId: `ch_${providerDisputeId}`,
      amountMinor,
      amount: `${amountMinor / 100n}.${(amountMinor % 100n)
        .toString()
        .padStart(2, "0")}`,
      currency: "USD",
      providerStatus,
      livemode: false,
    }
    const event = await prisma.paymentProviderEvent.create({
      data: {
        provider: "stripe",
        providerEventId,
        eventType,
        objectId: providerDisputeId,
        providerPaymentId: fixture.paymentIntentId,
        providerChargeId: fingerprintable.providerChargeId,
        disputeAmountMinor: amountMinor,
        disputeCurrency: "USD",
        providerStatus,
        livemode: false,
        eventFingerprint: paymentDisputeEventFingerprint(fingerprintable),
        status: "PENDING",
      },
    })
    const claimed = await prisma.paymentProviderEvent.updateMany({
      where: { id: event.id, status: "PENDING" },
      data: {
        status: "PROCESSING",
        attempts: { increment: 1 },
        lockedAt: new Date(),
      },
    })
    expect(claimed.count).toBe(1)
    return prisma.paymentProviderEvent.findUniqueOrThrow({
      where: { id: event.id },
    })
  }

  function stripeDispute(
    fixture: DepositFixture,
    providerDisputeId: string,
    amountInCents: number,
    status = "needs_response",
  ) {
    return {
      id: providerDisputeId,
      charge: `ch_${providerDisputeId}`,
      payment_intent: fixture.paymentIntentId,
      amount: amountInCents,
      currency: "usd",
      reason: "fraudulent",
      status,
    }
  }

  it("validates historical dispute classification and the exact credited-status predicate", async () => {
    const constraints = await prisma.$queryRawUnsafe(
      `SELECT convalidated
         FROM pg_constraint
        WHERE conname = 'PaymentProviderEvent_dispute_facts_check'`,
    )
    expect(constraints).toEqual([{ convalidated: true }])

    const rows = await prisma.$queryRawUnsafe(
      `SELECT status,
              "is_wallet_credit_backed_deposit_status"(
                status::"DepositAttemptStatus"
              ) AS credited
         FROM unnest(ARRAY[
           'CREATED',
           'PENDING_CUSTOMER_ACTION',
           'PROCESSING',
           'SUCCEEDED',
           'FAILED',
           'EXPIRED',
           'PARTIALLY_REFUNDED',
           'REFUNDED',
           'DISPUTED',
           'CHARGEBACK'
         ]) AS statuses(status)`,
    )
    expect(
      rows.filter((row: any) => row.credited).map((row: any) => row.status),
    ).toEqual([
      "SUCCEEDED",
      "PARTIALLY_REFUNDED",
      "REFUNDED",
      "DISPUTED",
      "CHARGEBACK",
    ])
  }, 30_000)

  it("persists a hold beside its DEPOSIT without reusing providerRef and enforces unique dispute identity", async () => {
    const fixture = await makeDepositFixture({
      depositAmount: 1000,
      availableBalance: 1000,
    })
    const providerDisputeId = `dp_${crypto.randomUUID()}`
    const openedEvent = await makeProviderEvent(
      fixture,
      providerDisputeId,
      "charge.dispute.created",
    )

    await billing.handleChargeback(
      stripeDispute(fixture, providerDisputeId, 60_000),
      openedEvent.id,
    )

    const paymentDispute = await prisma.paymentDispute.findUniqueOrThrow({
      where: {
        provider_providerDisputeId: {
          provider: "stripe",
          providerDisputeId,
        },
      },
      include: {
        depositTransaction: true,
        holdTransaction: true,
      },
    })
    expect(paymentDispute.depositTransactionId).toBe(
      fixture.depositTransaction.id,
    )
    expect(paymentDispute.depositTransaction).toMatchObject({
      type: "DEPOSIT",
      provider: "stripe",
      providerRef: fixture.paymentIntentId,
    })
    expect(paymentDispute.holdTransaction).toMatchObject({
      type: "RESERVATION",
      provider: null,
      providerRef: null,
    })
    expect(paymentDispute.holdTransaction.amount.toString()).toBe("-600")
    await expect(
      prisma.transaction.count({
        where: {
          provider: "stripe",
          providerRef: fixture.paymentIntentId,
        },
      }),
    ).resolves.toBe(1)

    const duplicateResolvedEvent = await makeProviderEvent(
      fixture,
      providerDisputeId,
      "charge.dispute.closed",
    )
    await expect(
      prisma.paymentDispute.create({
        data: {
          provider: "stripe",
          providerDisputeId,
          providerPaymentId: fixture.paymentIntentId,
          providerChargeId: `ch_${providerDisputeId}`,
          depositAttemptId: fixture.depositAttempt.id,
          depositTransactionId: fixture.depositTransaction.id,
          walletId: fixture.wallet.id,
          amount: 600,
          currency: "USD",
          heldAmount: 0,
          shortfallAmount: 600,
          currentExposureAmount: 0,
          status: "WON",
          providerStatus: "won",
          resolvedByEventId: duplicateResolvedEvent.id,
          resolvedAt: new Date(),
        },
      }),
    ).rejects.toBeDefined()
    await expect(
      prisma.paymentDispute.count({
        where: { provider: "stripe", providerDisputeId },
      }),
    ).resolves.toBe(1)
  }, 30_000)

  it("persists a zero-held OPEN case without a zero-value ledger row", async () => {
    const fixture = await makeDepositFixture({
      depositAmount: 1000,
      availableBalance: 0,
    })
    const providerDisputeId = `dp_${crypto.randomUUID()}`
    const openedEvent = await makeProviderEvent(
      fixture,
      providerDisputeId,
      "charge.dispute.created",
    )

    const outcome = await billing.handleChargeback(
      stripeDispute(fixture, providerDisputeId, 60_000),
      openedEvent.id,
    )

    expect(outcome).toMatchObject({
      status: "OPEN",
      held: "0.00",
      shortfall: "600.00",
    })
    const paymentDispute = await prisma.paymentDispute.findUniqueOrThrow({
      where: {
        provider_providerDisputeId: {
          provider: "stripe",
          providerDisputeId,
        },
      },
    })
    expect(paymentDispute.holdTransactionId).toBeNull()
    expect(paymentDispute.shortfallAmount.toString()).toBe("600")
    expect(paymentDispute.currentExposureAmount.toString()).toBe("600")
    await expect(
      prisma.transaction.count({
        where: {
          walletId: fixture.wallet.id,
          type: "RESERVATION",
        },
      }),
    ).resolves.toBe(0)
    await expect(
      prisma.auditLog.count({
        where: {
          entityType: "PaymentDispute",
          entityId: paymentDispute.id,
          action: "STRIPE_CHARGEBACK_HOLD_PLACED",
        },
      }),
    ).resolves.toBe(1)
    await expect(
      prisma.paymentProviderEvent.findUniqueOrThrow({
        where: { id: openedEvent.id },
        select: { status: true },
      }),
    ).resolves.toMatchObject({ status: "PROCESSED" })
    await expect(
      prisma.transaction.count({
        where: {
          reference: `payment-dispute:stripe:${providerDisputeId}:hold`,
        },
      }),
    ).resolves.toBe(0)
  }, 30_000)

  it.each([
    "OPEN",
    "LOST",
  ] as const)("blocks new reservations after a future refund exposes an uncovered %s dispute", async (terminalStatus) => {
    const fixture = await makeDepositFixture({
      depositAmount: 100,
      availableBalance: 0,
    })
    const providerDisputeId = `dp_exposure_${crypto.randomUUID()}`
    const openedEvent = await makeProviderEvent(
      fixture,
      providerDisputeId,
      "charge.dispute.created",
      10_000,
    )
    await billing.handleChargeback(
      stripeDispute(fixture, providerDisputeId, 10_000),
      openedEvent.id,
    )
    if (terminalStatus === "LOST") {
      const resolvedEvent = await makeProviderEvent(
        fixture,
        providerDisputeId,
        "charge.dispute.closed",
        10_000,
        "lost",
      )
      await billing.handleChargebackClosed(
        stripeDispute(fixture, providerDisputeId, 10_000, "lost"),
        resolvedEvent.id,
      )
    }

    const website = await makeWebsite(prisma)
    const refundOrder = await makeRefundableOrder(fixture, website)
    const spendOrder = await makeOrder(prisma, {
      organizationId: fixture.organization.id,
      customerId: fixture.user.id,
      websiteId: website.id,
      status: "DRAFT",
      amount: 25,
    })
    const actor = {
      id: fixture.user.id,
      organizationId: fixture.organization.id,
    }
    await billing.refund(fixture.wallet.id, 25, refundOrder.id, actor)

    let blocked: any
    try {
      await billing.reserve(fixture.wallet.id, 25, spendOrder.id, actor)
    } catch (error) {
      blocked = error
    }
    expect(blocked?.getStatus()).toBe(409)
    expect(blocked?.getResponse()).toMatchObject({
      code: "WALLET_SPEND_BLOCKED_BY_DISPUTE",
    })
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { id: fixture.wallet.id },
    })
    expect(wallet.availableBalance.toString()).toBe("25")
    expect(wallet.reservedBalance.toString()).toBe("0")
    await expect(
      prisma.transaction.count({
        where: {
          walletId: fixture.wallet.id,
          orderId: spendOrder.id,
          type: "RESERVATION",
        },
      }),
    ).resolves.toBe(0)
  }, 30_000)

  it("allows reservation after a WON dispute clears current exposure", async () => {
    const fixture = await makeDepositFixture({
      depositAmount: 100,
      availableBalance: 0,
    })
    const providerDisputeId = `dp_won_exposure_${crypto.randomUUID()}`
    const openedEvent = await makeProviderEvent(
      fixture,
      providerDisputeId,
      "charge.dispute.created",
      10_000,
    )
    await billing.handleChargeback(
      stripeDispute(fixture, providerDisputeId, 10_000),
      openedEvent.id,
    )
    const resolvedEvent = await makeProviderEvent(
      fixture,
      providerDisputeId,
      "charge.dispute.closed",
      10_000,
      "won",
    )
    await billing.handleChargebackClosed(
      stripeDispute(fixture, providerDisputeId, 10_000, "won"),
      resolvedEvent.id,
    )

    const website = await makeWebsite(prisma)
    const refundOrder = await makeRefundableOrder(fixture, website)
    const spendOrder = await makeOrder(prisma, {
      organizationId: fixture.organization.id,
      customerId: fixture.user.id,
      websiteId: website.id,
      status: "DRAFT",
      amount: 25,
    })
    const actor = {
      id: fixture.user.id,
      organizationId: fixture.organization.id,
    }
    await billing.refund(fixture.wallet.id, 25, refundOrder.id, actor)

    const reserved = await billing.reserve(
      fixture.wallet.id,
      25,
      spendOrder.id,
      actor,
    )
    expect(reserved.availableBalance.toString()).toBe("0")
    expect(reserved.reservedBalance.toString()).toBe("25")
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { id: fixture.wallet.id },
    })
    expect(wallet.availableBalance.toString()).toBe("0")
    expect(wallet.reservedBalance.toString()).toBe("25")
  }, 30_000)

  it("serializes a zero-held dispute ahead of concurrent credit and spend", async () => {
    const fixture = await makeDepositFixture({
      depositAmount: 100,
      availableBalance: 0,
    })
    const providerDisputeId = `dp_dispute_first_${crypto.randomUUID()}`
    const openedEvent = await makeProviderEvent(
      fixture,
      providerDisputeId,
      "charge.dispute.created",
      10_000,
    )
    const spendOrder = await makeOrder(prisma, {
      organizationId: fixture.organization.id,
      customerId: fixture.user.id,
      status: "DRAFT",
      amount: 25,
    })
    const actor = {
      id: fixture.user.id,
      organizationId: fixture.organization.id,
    }
    let signalCaseInserted!: () => void
    let releaseDispute!: () => void
    const caseInserted = new Promise<void>((resolve) => {
      signalCaseInserted = resolve
    })
    const allowDisputeCommit = new Promise<void>((resolve) => {
      releaseDispute = resolve
    })
    const disputePromise = transitionPaymentDispute(
      prisma,
      {
        audit: async (_tx: any, data: { action: string }) => {
          if (data.action === "STRIPE_CHARGEBACK_HOLD_PLACED") {
            signalCaseInserted()
            await allowDisputeCommit
          }
        },
        notifyFinance: async () => undefined,
      },
      paymentDisputeEventFromStoredRow(openedEvent),
    )
    await caseInserted

    const creditPromise = Promise.resolve(
      prisma.wallet.update({
        where: { id: fixture.wallet.id },
        data: {
          availableBalance: { increment: 25 },
          version: { increment: 1 },
        },
      }),
    )
    const reservePromise = billing.reserve(
      fixture.wallet.id,
      25,
      spendOrder.id,
      actor,
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    releaseDispute()

    const [disputeResult, creditResult, reserveResult] =
      await Promise.allSettled([disputePromise, creditPromise, reservePromise])
    expect(disputeResult.status).toBe("fulfilled")
    expect(creditResult.status).toBe("fulfilled")
    expect(reserveResult.status).toBe("rejected")
    if (reserveResult.status === "rejected") {
      expect(reserveResult.reason?.getResponse()).toMatchObject({
        code: "WALLET_SPEND_BLOCKED_BY_DISPUTE",
      })
    }
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { id: fixture.wallet.id },
    })
    expect(wallet.availableBalance.toString()).toBe("25")
    expect(wallet.reservedBalance.toString()).toBe("0")
    const paymentDispute = await prisma.paymentDispute.findUniqueOrThrow({
      where: {
        provider_providerDisputeId: {
          provider: "stripe",
          providerDisputeId,
        },
      },
    })
    expect(paymentDispute.heldAmount.toString()).toBe("0")
    expect(paymentDispute.currentExposureAmount.toString()).toBe("100")
  }, 30_000)

  it("preserves the valid spend-first serial order before a zero-held dispute", async () => {
    const fixture = await makeDepositFixture({
      depositAmount: 100,
      availableBalance: 100,
    })
    const providerDisputeId = `dp_spend_first_${crypto.randomUUID()}`
    const openedEvent = await makeProviderEvent(
      fixture,
      providerDisputeId,
      "charge.dispute.created",
      10_000,
    )
    const spendOrder = await makeOrder(prisma, {
      organizationId: fixture.organization.id,
      customerId: fixture.user.id,
      status: "DRAFT",
      amount: 100,
    })
    const actor = {
      id: fixture.user.id,
      organizationId: fixture.organization.id,
    }
    let signalSpendLock!: () => void
    let releaseSpend!: () => void
    const spendLocked = new Promise<void>((resolve) => {
      signalSpendLock = resolve
    })
    const allowSpend = new Promise<void>((resolve) => {
      releaseSpend = resolve
    })
    const spendPromise = prisma.$transaction(async (tx: any) => {
      await lockWalletForUpdate(tx, fixture.wallet.id)
      signalSpendLock()
      await allowSpend
      return billing.reserve(fixture.wallet.id, 100, spendOrder.id, actor, tx)
    })
    await spendLocked
    const disputePromise = transitionPaymentDispute(
      prisma,
      {
        audit: async () => undefined,
        notifyFinance: async () => undefined,
      },
      paymentDisputeEventFromStoredRow(openedEvent),
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    releaseSpend()

    const [spend, dispute] = await Promise.all([spendPromise, disputePromise])
    expect(spend.availableBalance.toString()).toBe("0")
    expect(dispute).toMatchObject({
      status: "OPEN",
      held: "0.00",
      shortfall: "100.00",
    })
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { id: fixture.wallet.id },
    })
    expect(wallet.availableBalance.toString()).toBe("0")
    expect(wallet.reservedBalance.toString()).toBe("100")
    const paymentDispute = await prisma.paymentDispute.findUniqueOrThrow({
      where: {
        provider_providerDisputeId: {
          provider: "stripe",
          providerDisputeId,
        },
      },
    })
    expect(paymentDispute.heldAmount.toString()).toBe("0")
    expect(paymentDispute.currentExposureAmount.toString()).toBe("100")
  }, 30_000)

  it("serializes distinct partial disputes so their cumulative amount cannot exceed the deposit", async () => {
    const fixture = await makeDepositFixture({
      depositAmount: 100,
      availableBalance: 100,
    })
    const disputeIds = [
      `dp_${crypto.randomUUID()}`,
      `dp_${crypto.randomUUID()}`,
    ]
    const events = await Promise.all(
      disputeIds.map((providerDisputeId) =>
        makeProviderEvent(
          fixture,
          providerDisputeId,
          "charge.dispute.created",
          6_000,
        ),
      ),
    )

    const results = await Promise.allSettled(
      disputeIds.map((providerDisputeId, index) =>
        billing.handleChargeback(
          stripeDispute(fixture, providerDisputeId, 6_000),
          events[index].id,
        ),
      ),
    )

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1)
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1)
    const cases = await prisma.paymentDispute.findMany({
      where: { depositTransactionId: fixture.depositTransaction.id },
      include: { holdTransaction: true },
    })
    expect(cases).toHaveLength(1)
    expect(cases[0].amount.toString()).toBe("60")
    expect(cases[0].shortfallAmount.toString()).toBe("0")
    expect(cases[0].currentExposureAmount.toString()).toBe("0")
    expect(cases[0].holdTransaction?.amount.toString()).toBe("-60")
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { id: fixture.wallet.id },
    })
    expect(wallet.availableBalance.toString()).toBe("40")
    expect(wallet.reservedBalance.toString()).toBe("60")
  }, 30_000)

  it("keeps terminal provider-event and ledger evidence immutable", async () => {
    const fixture = await makeDepositFixture({
      depositAmount: 1000,
      availableBalance: 100,
    })
    const providerDisputeId = `dp_${crypto.randomUUID()}`
    const openedEvent = await makeProviderEvent(
      fixture,
      providerDisputeId,
      "charge.dispute.created",
    )
    await billing.handleChargeback(
      stripeDispute(fixture, providerDisputeId, 60_000),
      openedEvent.id,
    )
    const resolvedEvent = await makeProviderEvent(
      fixture,
      providerDisputeId,
      "charge.dispute.closed",
    )

    await billing.handleChargebackClosed(
      stripeDispute(fixture, providerDisputeId, 60_000, "won"),
      resolvedEvent.id,
    )

    const paymentDispute = await prisma.paymentDispute.findUniqueOrThrow({
      where: {
        provider_providerDisputeId: {
          provider: "stripe",
          providerDisputeId,
        },
      },
    })
    expect(paymentDispute).toMatchObject({
      status: "WON",
      openedByEventId: openedEvent.id,
      resolvedByEventId: resolvedEvent.id,
    })
    expect(paymentDispute.heldAmount.toString()).toBe("100")
    expect(paymentDispute.shortfallAmount.toString()).toBe("500")
    expect(paymentDispute.currentExposureAmount.toString()).toBe("0")
    expect(paymentDispute.holdTransactionId).not.toBeNull()
    expect(paymentDispute.resolutionTransactionId).not.toBeNull()
    await expect(
      prisma.auditLog.count({
        where: {
          entityType: "PaymentDispute",
          entityId: paymentDispute.id,
        },
      }),
    ).resolves.toBe(2)

    const replacementResolvedEvent = await makeProviderEvent(
      fixture,
      providerDisputeId,
      "charge.dispute.closed",
    )
    for (const data of [
      {
        resolvedByEventId: replacementResolvedEvent.id,
        version: { increment: 1 },
      },
      { currentExposureAmount: 1, version: { increment: 1 } },
      { amount: 601, version: { increment: 1 } },
    ]) {
      await expect(
        prisma.paymentDispute.update({
          where: { id: paymentDispute.id },
          data,
        }),
      ).rejects.toBeDefined()
    }
    await expect(
      prisma.paymentDispute.delete({
        where: { id: paymentDispute.id },
      }),
    ).rejects.toBeDefined()
    await expect(
      prisma.paymentProviderEvent.delete({
        where: { id: resolvedEvent.id },
      }),
    ).rejects.toBeDefined()
    await expect(
      prisma.paymentProviderEvent.update({
        where: { id: resolvedEvent.id },
        data: { processedAt: new Date("2030-01-01T00:00:00.000Z") },
      }),
    ).rejects.toBeDefined()
    await expect(
      prisma.transaction.delete({
        where: { id: paymentDispute.resolutionTransactionId },
      }),
    ).rejects.toBeDefined()

    const persisted = await prisma.paymentDispute.findUniqueOrThrow({
      where: { id: paymentDispute.id },
    })
    expect(persisted.resolvedByEventId).toBe(resolvedEvent.id)
    expect(persisted.resolutionTransactionId).toBe(
      paymentDispute.resolutionTransactionId,
    )
  }, 30_000)

  it("attaches close-before-open evidence once without rewriting the terminal outcome", async () => {
    const fixture = await makeDepositFixture({
      depositAmount: 1000,
      availableBalance: 1000,
    })
    const providerDisputeId = `dp_${crypto.randomUUID()}`
    const resolvedEvent = await makeProviderEvent(
      fixture,
      providerDisputeId,
      "charge.dispute.closed",
    )

    await billing.handleChargebackClosed(
      stripeDispute(fixture, providerDisputeId, 60_000, "won"),
      resolvedEvent.id,
    )

    const beforeOpen = await prisma.paymentDispute.findUniqueOrThrow({
      where: {
        provider_providerDisputeId: {
          provider: "stripe",
          providerDisputeId,
        },
      },
    })
    expect(beforeOpen.status).toBe("WON")
    expect(beforeOpen.heldAmount.toString()).toBe("0")
    expect(beforeOpen.shortfallAmount.toString()).toBe("600")
    expect(beforeOpen.currentExposureAmount.toString()).toBe("0")
    expect(beforeOpen.openedByEventId).toBeNull()

    const openedEvent = await makeProviderEvent(
      fixture,
      providerDisputeId,
      "charge.dispute.created",
    )
    await billing.handleChargeback(
      stripeDispute(fixture, providerDisputeId, 60_000),
      openedEvent.id,
    )

    const afterOpen = await prisma.paymentDispute.findUniqueOrThrow({
      where: { id: beforeOpen.id },
    })
    expect(afterOpen).toMatchObject({
      status: "WON",
      providerStatus: "won",
      openedByEventId: openedEvent.id,
      resolvedByEventId: resolvedEvent.id,
      version: beforeOpen.version + 1,
    })
    expect(afterOpen.shortfallAmount.toString()).toBe("600")
    expect(afterOpen.currentExposureAmount.toString()).toBe("0")

    const replacementOpenedEvent = await makeProviderEvent(
      fixture,
      providerDisputeId,
      "charge.dispute.created",
    )
    await expect(
      prisma.paymentDispute.update({
        where: { id: afterOpen.id },
        data: {
          openedByEventId: replacementOpenedEvent.id,
          openedAt: new Date(),
          version: { increment: 1 },
        },
      }),
    ).rejects.toBeDefined()
  }, 30_000)

  it("accepts malformed signed disputes only as durable quarantine evidence", async () => {
    const previousKey = process.env.STRIPE_SECRET_KEY
    const previousSecret = process.env.STRIPE_WEBHOOK_SECRET
    const previousAdapter = (billing as any).depositProvider
    const providerEventId = `evt_malformed_${crypto.randomUUID()}`
    process.env.STRIPE_SECRET_KEY = "sk_test_integration"
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_integration"
    ;(billing as any).depositProvider = {
      capabilities: { supportedCurrencies: ["USD"] },
      verifyWebhook: () => ({
        id: providerEventId,
        type: "charge.dispute.created",
        livemode: false,
        data: {
          object: {
            id: `dp_malformed_${crypto.randomUUID()}`,
            payment_intent: null,
            amount: 1000,
            currency: "usd",
            status: "needs_response",
            metadata: { depositAttemptId: "does-not-exist" },
          },
        },
      }),
    }

    try {
      await expect(
        billing.handleWebhook("signed", Buffer.from("{}")),
      ).resolves.toEqual({
        received: true,
        duplicate: false,
        quarantined: true,
      })
      const persisted = await prisma.paymentProviderEvent.findUniqueOrThrow({
        where: {
          provider_providerEventId: {
            provider: "stripe",
            providerEventId,
          },
        },
      })
      expect(persisted).toMatchObject({
        status: "QUARANTINED",
        depositAttemptId: null,
        paymentDisputeId: null,
        providerPaymentId: null,
        lastError: "INVALID_DISPUTE_ENVELOPE",
      })
      expect(persisted.processedAt).not.toBeNull()
      await expect(
        prisma.auditLog.count({
          where: {
            action: "PAYMENT_PROVIDER_EVENT_QUARANTINED",
            entityId: persisted.id,
          },
        }),
      ).resolves.toBe(1)
    } finally {
      ;(billing as any).depositProvider = previousAdapter
      if (previousKey == null) delete process.env.STRIPE_SECRET_KEY
      else process.env.STRIPE_SECRET_KEY = previousKey
      if (previousSecret == null) delete process.env.STRIPE_WEBHOOK_SECRET
      else process.env.STRIPE_WEBHOOK_SECRET = previousSecret
    }
  }, 30_000)

  it("API replay exact-lease quarantines mode drift before moving wallet funds", async () => {
    const fixture = await makeDepositFixture({
      depositAmount: 100,
      availableBalance: 100,
    })
    const previousSecret = process.env.STRIPE_WEBHOOK_SECRET
    const previousAdapter = (billing as any).depositProvider
    const providerDisputeId = `dp_api_mode_drift_${crypto.randomUUID()}`
    const providerEventId = `evt_api_mode_drift_${crypto.randomUUID()}`
    const walletBefore = await prisma.wallet.findUniqueOrThrow({
      where: { id: fixture.wallet.id },
    })
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_integration"
    ;(billing as any).depositProvider = {
      capabilities: { supportedCurrencies: ["USD"] },
      verifyWebhook: () => ({
        id: providerEventId,
        type: "charge.dispute.created",
        livemode: false,
        data: {
          object: {
            id: providerDisputeId,
            charge: `ch_${providerDisputeId}`,
            payment_intent: fixture.paymentIntentId,
            amount: 1_000,
            currency: "usd",
            status: "needs_response",
          },
        },
      }),
    }
    const updateMany = prisma.paymentProviderEvent.updateMany.bind(
      prisma.paymentProviderEvent,
    )
    const claimSpy = jest
      .spyOn(prisma.paymentProviderEvent, "updateMany")
      .mockImplementationOnce(async (input: any) => {
        const claimed = await updateMany(input)
        // Simulate a credential promotion after signature/mode verification
        // but before the shared dispute core reaches its wallet boundary.
        process.env.STRIPE_SECRET_KEY = "rk_live_dispute_integration"
        process.env.STRIPE_LIVE_MODE_ENABLED = "true"
        return claimed
      })

    try {
      await expect(
        billing.handleWebhook("signed", Buffer.from("{}")),
      ).resolves.toEqual({
        received: true,
        quarantined: true,
      })
      await expect(
        prisma.paymentProviderEvent.findUniqueOrThrow({
          where: {
            provider_providerEventId: {
              provider: "stripe",
              providerEventId,
            },
          },
          select: {
            status: true,
            attempts: true,
            lockedAt: true,
            paymentDisputeId: true,
            lastError: true,
          },
        }),
      ).resolves.toMatchObject({
        status: "QUARANTINED",
        attempts: 1,
        lockedAt: null,
        paymentDisputeId: null,
        lastError: "STRIPE_PROVIDER_MODE_MISMATCH",
      })
      await expect(
        prisma.wallet.findUniqueOrThrow({
          where: { id: fixture.wallet.id },
          select: {
            availableBalance: true,
            reservedBalance: true,
            version: true,
          },
        }),
      ).resolves.toMatchObject({
        availableBalance: walletBefore.availableBalance,
        reservedBalance: walletBefore.reservedBalance,
        version: walletBefore.version,
      })
      await expect(
        prisma.paymentDispute.count({
          where: { provider: "stripe", providerDisputeId },
        }),
      ).resolves.toBe(0)
    } finally {
      claimSpy.mockRestore()
      process.env.STRIPE_SECRET_KEY = "rk_test_dispute_integration"
      process.env.STRIPE_LIVE_MODE_ENABLED = "false"
      ;(billing as any).depositProvider = previousAdapter
      if (previousSecret == null) delete process.env.STRIPE_WEBHOOK_SECRET
      else process.env.STRIPE_WEBHOOK_SECRET = previousSecret
    }
  }, 30_000)

  it.each([
    "SUCCEEDED",
    "PARTIALLY_REFUNDED",
    "REFUNDED",
    "DISPUTED",
    "CHARGEBACK",
  ] as const)("accepts concurrent exact deposit replay in %s without moving money", async (status) => {
    const fixture = await makeDepositFixture({
      depositAmount: 100,
      availableBalance: 100,
    })
    if (status === "PARTIALLY_REFUNDED" || status === "REFUNDED") {
      await prisma.depositAttempt.update({
        where: { id: fixture.depositAttempt.id },
        data: { status },
      })
    } else if (status === "DISPUTED" || status === "CHARGEBACK") {
      const providerDisputeId = `dp_replay_${crypto.randomUUID()}`
      const openedEvent = await makeProviderEvent(
        fixture,
        providerDisputeId,
        "charge.dispute.created",
        1_000,
      )
      await billing.handleChargeback(
        stripeDispute(fixture, providerDisputeId, 1_000),
        openedEvent.id,
      )
      if (status === "CHARGEBACK") {
        const closedEvent = await makeProviderEvent(
          fixture,
          providerDisputeId,
          "charge.dispute.closed",
          1_000,
          "lost",
        )
        await billing.handleChargebackClosed(
          stripeDispute(fixture, providerDisputeId, 1_000, "lost"),
          closedEvent.id,
        )
      }
    }
    const providerEvent = await makeCheckoutProviderEvent(
      fixture.providerSessionId,
    )
    const before = await prisma.wallet.findUniqueOrThrow({
      where: { id: fixture.wallet.id },
    })

    const replaySession = {
      id: fixture.providerSessionId,
      amount_total: 10_000,
      currency: "usd",
      payment_status: "paid",
      payment_intent: fixture.paymentIntentId,
      metadata: {
        depositAttemptId: fixture.depositAttempt.id,
      },
    }
    const lease = {
      kind: "lease",
      attempt: providerEvent.attempts,
      lockedAt: providerEvent.lockedAt,
    }
    const exactReplay = () =>
      (billing as any).processSuccessfulPayment(
        replaySession,
        providerEvent.id,
        lease,
      )
    const concurrent = await Promise.allSettled([exactReplay(), exactReplay()])
    expect(
      concurrent.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1)
    expect(
      concurrent.filter((result) => result.status === "rejected"),
    ).toHaveLength(1)

    const terminalEvent = await prisma.paymentProviderEvent.findUniqueOrThrow({
      where: { id: providerEvent.id },
    })
    await expect(
      (billing as any).processSuccessfulPayment(
        replaySession,
        providerEvent.id,
        {
          kind: "snapshot",
          status: terminalEvent.status,
          attempts: terminalEvent.attempts,
          lockedAt: terminalEvent.lockedAt,
          processedAt: terminalEvent.processedAt,
        },
      ),
    ).resolves.toBeUndefined()

    await expect(
      prisma.wallet.findUniqueOrThrow({
        where: { id: fixture.wallet.id },
        select: {
          availableBalance: true,
          reservedBalance: true,
          version: true,
        },
      }),
    ).resolves.toMatchObject({
      availableBalance: before.availableBalance,
      reservedBalance: before.reservedBalance,
      version: before.version,
    })
    await expect(
      prisma.paymentProviderEvent.findUniqueOrThrow({
        where: { id: providerEvent.id },
        select: { status: true, lastError: true },
      }),
    ).resolves.toEqual({
      status: "PROCESSED",
      lastError: null,
    })
    await expect(
      prisma.transaction.count({
        where: {
          OR: [
            { reference: fixture.providerSessionId },
            {
              provider: "stripe",
              providerRef: fixture.paymentIntentId,
            },
          ],
        },
      }),
    ).resolves.toBe(1)
    await expect(
      prisma.depositAttempt.findUniqueOrThrow({
        where: { id: fixture.depositAttempt.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status })
  }, 30_000)

  it.each([
    ["PARTIALLY_REFUNDED", "won"],
    ["REFUNDED", "lost"],
  ] as const)(
    "preserves the independent %s projection when a dispute closes as %s",
    async (refundStatus, providerStatus) => {
      const fixture = await makeDepositFixture({
        depositAmount: 100,
        availableBalance: 100,
      })
      await prisma.depositAttempt.update({
        where: { id: fixture.depositAttempt.id },
        data: { status: refundStatus },
      })
      const providerDisputeId = `dp_refund_projection_${crypto.randomUUID()}`
      const openedEvent = await makeProviderEvent(
        fixture,
        providerDisputeId,
        "charge.dispute.created",
        1_000,
      )
      await billing.handleChargeback(
        stripeDispute(fixture, providerDisputeId, 1_000),
        openedEvent.id,
      )
      const closedEvent = await makeProviderEvent(
        fixture,
        providerDisputeId,
        "charge.dispute.closed",
        1_000,
        providerStatus,
      )
      await billing.handleChargebackClosed(
        stripeDispute(fixture, providerDisputeId, 1_000, providerStatus),
        closedEvent.id,
      )

      await expect(
        prisma.depositAttempt.findUniqueOrThrow({
          where: { id: fixture.depositAttempt.id },
          select: { status: true },
        }),
      ).resolves.toEqual({ status: refundStatus })

      const report = await runReconciliation(prisma)
      expect(
        report.orderPaymentRecon.some(
          (row) =>
            row.entityId === fixture.depositAttempt.id &&
            row.code ===
              ReconciliationCode.PAYMENT_DISPUTE_DEPOSIT_EVIDENCE_MISMATCH,
        ),
      ).toBe(false)
    },
    30_000,
  )

  it("keeps exact success redelivery clean across an OPEN dispute and WON recovery", async () => {
    const fixture = await makeDepositFixture({
      depositAmount: 100,
      availableBalance: 100,
    })
    const providerDisputeId = `dp_success_redelivery_${crypto.randomUUID()}`
    const openedEvent = await makeProviderEvent(
      fixture,
      providerDisputeId,
      "charge.dispute.created",
      1_000,
    )
    await billing.handleChargeback(
      stripeDispute(fixture, providerDisputeId, 1_000),
      openedEvent.id,
    )

    const previousKey = process.env.STRIPE_SECRET_KEY
    const previousSecret = process.env.STRIPE_WEBHOOK_SECRET
    const previousAdapter = (billing as any).depositProvider
    const providerEventId = `evt_success_redelivery_${crypto.randomUUID()}`
    const signedPayload = Buffer.from('{"verified":"checkout-success"}')
    process.env.STRIPE_SECRET_KEY = "sk_test_integration"
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_integration"
    ;(billing as any).depositProvider = {
      capabilities: { supportedCurrencies: ["USD"] },
      verifyWebhook: () => ({
        id: providerEventId,
        type: "checkout.session.completed",
        livemode: false,
        data: {
          object: {
            id: fixture.providerSessionId,
            amount_total: 10_000,
            currency: "usd",
            payment_status: "paid",
            payment_intent: fixture.paymentIntentId,
            metadata: { depositAttemptId: fixture.depositAttempt.id },
          },
        },
      }),
    }

    try {
      const heldBeforeReplay = await prisma.wallet.findUniqueOrThrow({
        where: { id: fixture.wallet.id },
        select: {
          availableBalance: true,
          reservedBalance: true,
          version: true,
        },
      })
      await expect(
        billing.handleWebhook("signed", signedPayload),
      ).resolves.toEqual({ received: true })
      await expect(
        billing.handleWebhook("signed", signedPayload),
      ).resolves.toMatchObject({
        received: true,
        duplicate: true,
        quarantined: false,
      })
      await expect(
        prisma.wallet.findUniqueOrThrow({
          where: { id: fixture.wallet.id },
          select: {
            availableBalance: true,
            reservedBalance: true,
            version: true,
          },
        }),
      ).resolves.toEqual(heldBeforeReplay)

      const closedEvent = await makeProviderEvent(
        fixture,
        providerDisputeId,
        "charge.dispute.closed",
        1_000,
        "won",
      )
      await billing.handleChargebackClosed(
        stripeDispute(fixture, providerDisputeId, 1_000, "won"),
        closedEvent.id,
      )
      const afterWon = await prisma.wallet.findUniqueOrThrow({
        where: { id: fixture.wallet.id },
        select: {
          availableBalance: true,
          reservedBalance: true,
          version: true,
        },
      })
      expect(afterWon.availableBalance.toString()).toBe("100")
      expect(afterWon.reservedBalance.toString()).toBe("0")
      expect(afterWon.version).toBe(heldBeforeReplay.version + 1)

      await expect(
        billing.handleWebhook("signed", signedPayload),
      ).resolves.toMatchObject({
        received: true,
        duplicate: true,
        quarantined: false,
      })

      await expect(
        prisma.wallet.findUniqueOrThrow({
          where: { id: fixture.wallet.id },
          select: {
            availableBalance: true,
            reservedBalance: true,
            version: true,
          },
        }),
      ).resolves.toEqual(afterWon)
      const providerEvent = await prisma.paymentProviderEvent.findUniqueOrThrow(
        {
          where: {
            provider_providerEventId: {
              provider: "stripe",
              providerEventId,
            },
          },
        },
      )
      expect(providerEvent).toMatchObject({
        status: "PROCESSED",
        livemode: false,
        lastError: null,
        depositAttemptId: fixture.depositAttempt.id,
      })
      await expect(
        prisma.depositAttempt.findUniqueOrThrow({
          where: { id: fixture.depositAttempt.id },
          select: { status: true },
        }),
      ).resolves.toEqual({ status: "SUCCEEDED" })

      const report = await runReconciliation(prisma)
      expect(
        report.orderPaymentRecon.some(
          (row) =>
            (row.entityId === providerEvent.id ||
              row.entityId === fixture.depositAttempt.id) &&
            [
              ReconciliationCode.DEPOSIT_PROCESSED_EVIDENCE_MISMATCH,
              ReconciliationCode.PAYMENT_PROVIDER_EVENT_MODE_UNVERIFIED,
              ReconciliationCode.PAYMENT_DISPUTE_DEPOSIT_EVIDENCE_MISMATCH,
            ].includes(row.code),
        ),
      ).toBe(false)
    } finally {
      ;(billing as any).depositProvider = previousAdapter
      if (previousKey == null) delete process.env.STRIPE_SECRET_KEY
      else process.env.STRIPE_SECRET_KEY = previousKey
      if (previousSecret == null) delete process.env.STRIPE_WEBHOOK_SECRET
      else process.env.STRIPE_WEBHOOK_SECRET = previousSecret
    }
  }, 30_000)

  it("atomically claims and ignores an unsupported signed event while finance is locked", async () => {
    const previousMode = process.env.FINANCE_RUNTIME_MODE
    const previousEnv = process.env.NODE_ENV
    const previousKey = process.env.STRIPE_SECRET_KEY
    const previousSecret = process.env.STRIPE_WEBHOOK_SECRET
    const previousAdapter = (billing as any).depositProvider
    const providerEventId = `evt_locked_unsupported_${crypto.randomUUID()}`
    process.env.FINANCE_RUNTIME_MODE = "locked"
    process.env.NODE_ENV = "production"
    process.env.STRIPE_SECRET_KEY = "rk_test_integration"
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_integration"
    ;(billing as any).depositProvider = {
      capabilities: { supportedCurrencies: ["USD"] },
      verifyWebhook: () => ({
        id: providerEventId,
        type: "customer.updated",
        livemode: false,
        data: { object: { id: `cus_${crypto.randomUUID()}` } },
      }),
    }

    try {
      await expect(
        billing.handleWebhook(
          "signed",
          Buffer.from('{"verified":"unsupported"}'),
        ),
      ).resolves.toEqual({
        received: true,
        duplicate: false,
        ignored: true,
      })
      await expect(
        prisma.paymentProviderEvent.findUniqueOrThrow({
          where: {
            provider_providerEventId: {
              provider: "stripe",
              providerEventId,
            },
          },
          select: {
            status: true,
            attempts: true,
            lockedAt: true,
            processedAt: true,
            lastError: true,
          },
        }),
      ).resolves.toMatchObject({
        status: "IGNORED",
        attempts: 1,
        lockedAt: null,
        processedAt: expect.any(Date),
        lastError: "UNSUPPORTED_EVENT_TYPE",
      })
    } finally {
      ;(billing as any).depositProvider = previousAdapter
      if (previousMode == null) delete process.env.FINANCE_RUNTIME_MODE
      else process.env.FINANCE_RUNTIME_MODE = previousMode
      if (previousEnv == null) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previousEnv
      if (previousKey == null) delete process.env.STRIPE_SECRET_KEY
      else process.env.STRIPE_SECRET_KEY = previousKey
      if (previousSecret == null) delete process.env.STRIPE_WEBHOOK_SECRET
      else process.env.STRIPE_WEBHOOK_SECRET = previousSecret
    }
  }, 30_000)

  it("quarantines a conflicting deposit identity and rolls back its wallet credit", async () => {
    const fixture = await makeDepositFixture({
      depositAmount: 100,
      availableBalance: 100,
    })
    const conflictingSessionId = `cs_conflict_${crypto.randomUUID()}`
    const conflictingAttempt = await prisma.depositAttempt.create({
      data: {
        publicReference: `DP-${crypto.randomUUID()}`.slice(0, 32),
        walletId: fixture.wallet.id,
        organizationId: fixture.organization.id,
        createdByUserId: fixture.user.id,
        method: "CARD",
        provider: "stripe",
        amount: 100,
        walletCredit: 100,
        currency: "USD",
        status: "PROCESSING",
        idempotencyKey: `deposit-conflict-${crypto.randomUUID()}`,
        providerSessionId: conflictingSessionId,
      },
    })
    const providerEvent = await makeCheckoutProviderEvent(conflictingSessionId)
    const before = await prisma.wallet.findUniqueOrThrow({
      where: { id: fixture.wallet.id },
    })

    await expect(
      (billing as any).processSuccessfulPayment(
        {
          id: conflictingSessionId,
          amount_total: 10_000,
          currency: "usd",
          payment_status: "paid",
          payment_intent: fixture.paymentIntentId,
          metadata: {
            depositAttemptId: conflictingAttempt.id,
          },
        },
        providerEvent.id,
        {
          kind: "lease",
          attempt: providerEvent.attempts,
          lockedAt: providerEvent.lockedAt,
        },
      ),
    ).resolves.toBeUndefined()

    await expect(
      prisma.wallet.findUniqueOrThrow({
        where: { id: fixture.wallet.id },
        select: { availableBalance: true, version: true },
      }),
    ).resolves.toMatchObject({
      availableBalance: before.availableBalance,
      version: before.version,
    })
    await expect(
      prisma.depositAttempt.findUniqueOrThrow({
        where: { id: conflictingAttempt.id },
        select: {
          status: true,
          providerPaymentId: true,
          ledgerTransactionId: true,
        },
      }),
    ).resolves.toEqual({
      status: "PROCESSING",
      providerPaymentId: null,
      ledgerTransactionId: null,
    })
    await expect(
      prisma.paymentProviderEvent.findUniqueOrThrow({
        where: { id: providerEvent.id },
        select: { status: true, lastError: true },
      }),
    ).resolves.toEqual({
      status: "QUARANTINED",
      lastError: "DEPOSIT_IDEMPOTENCY_COLLISION",
    })
    await expect(
      prisma.transaction.count({
        where: {
          provider: "stripe",
          providerRef: fixture.paymentIntentId,
        },
      }),
    ).resolves.toBe(1)
  }, 30_000)

  it("rejects synthetic processing rows and conversion into dispute evidence", async () => {
    const fixture = await makeDepositFixture({
      depositAmount: 100,
      availableBalance: 100,
    })
    const providerDisputeId = `dp_guard_${crypto.randomUUID()}`
    const providerEventId = `evt_guard_${crypto.randomUUID()}`
    const amountMinor = 1_000n
    const fingerprintable: FingerprintablePaymentDisputeEvent = {
      provider: "stripe",
      providerEventId,
      eventType: "charge.dispute.created",
      providerDisputeId,
      providerPaymentId: fixture.paymentIntentId,
      providerChargeId: `ch_${providerDisputeId}`,
      amountMinor,
      amount: "10.00",
      currency: "USD",
      providerStatus: "needs_response",
      livemode: false,
    }
    const normalizedFacts = {
      eventType: fingerprintable.eventType,
      objectId: providerDisputeId,
      providerPaymentId: fixture.paymentIntentId,
      providerChargeId: fingerprintable.providerChargeId,
      disputeAmountMinor: amountMinor,
      disputeCurrency: "USD",
      providerStatus: "needs_response",
      livemode: false,
      eventFingerprint: paymentDisputeEventFingerprint(fingerprintable),
    }

    await expect(
      prisma.paymentProviderEvent.create({
        data: {
          provider: "stripe",
          providerEventId,
          ...normalizedFacts,
          status: "PROCESSING",
          attempts: 1,
          lockedAt: new Date(),
        },
      }),
    ).rejects.toBeDefined()
    await expect(
      prisma.paymentProviderEvent.create({
        data: {
          provider: "stripe",
          providerEventId: `evt_synthetic_checkout_${crypto.randomUUID()}`,
          eventType: "checkout.session.completed",
          objectId: `cs_synthetic_${crypto.randomUUID()}`,
          livemode: false,
          eventFingerprint: crypto
            .createHash("sha256")
            .update("synthetic-checkout")
            .digest("hex"),
          status: "PROCESSED",
          attempts: 1,
          processedAt: new Date(),
        },
      }),
    ).rejects.toBeDefined()
    await expect(
      prisma.paymentProviderEvent.create({
        data: {
          provider: "stripe",
          providerEventId: `evt_missing_fingerprint_${crypto.randomUUID()}`,
          eventType: "checkout.session.expired",
          objectId: `cs_${crypto.randomUUID()}`,
          livemode: false,
          status: "PENDING",
        },
      }),
    ).rejects.toBeDefined()
    const unlinkedCheckoutEvent = await makeCheckoutProviderEvent(
      `cs_unlinked_${crypto.randomUUID()}`,
    )
    await expect(
      prisma.paymentProviderEvent.update({
        where: { id: unlinkedCheckoutEvent.id },
        data: {
          status: "PROCESSED",
          processedAt: new Date(),
          lockedAt: null,
        },
      }),
    ).rejects.toBeDefined()

    const ordinaryEvent = await prisma.paymentProviderEvent.create({
      data: {
        provider: "stripe",
        providerEventId: `evt_ordinary_${crypto.randomUUID()}`,
        eventType: "checkout.session.expired",
        objectId: `cs_${crypto.randomUUID()}`,
        livemode: false,
        eventFingerprint: crypto
          .createHash("sha256")
          .update("ordinary-event")
          .digest("hex"),
        status: "PENDING",
      },
    })
    await expect(
      prisma.paymentProviderEvent.update({
        where: { id: ordinaryEvent.id },
        data: normalizedFacts,
      }),
    ).rejects.toBeDefined()
    await expect(
      prisma.paymentProviderEvent.findUniqueOrThrow({
        where: { id: ordinaryEvent.id },
        select: { eventType: true },
      }),
    ).resolves.toEqual({ eventType: "checkout.session.expired" })
    await expect(
      prisma.paymentProviderEvent.update({
        where: { id: ordinaryEvent.id },
        data: { objectId: `cs_rewritten_${crypto.randomUUID()}` },
      }),
    ).rejects.toBeDefined()
    await expect(
      prisma.paymentProviderEvent.delete({
        where: { id: ordinaryEvent.id },
      }),
    ).rejects.toBeDefined()
  }, 30_000)

  it("rolls back the wallet hold and case when opening evidence stays nonterminal", async () => {
    const fixture = await makeDepositFixture({
      depositAmount: 100,
      availableBalance: 100,
    })
    const providerDisputeId = `dp_nonterminal_${crypto.randomUUID()}`
    const openedEvent = await makeProviderEvent(
      fixture,
      providerDisputeId,
      "charge.dispute.created",
      1_000,
    )
    const reference = `payment-dispute:stripe:${providerDisputeId}:hold`
    const walletBefore = await prisma.wallet.findUniqueOrThrow({
      where: { id: fixture.wallet.id },
    })

    await expect(
      prisma.$transaction(async (tx: any) => {
        await tx.wallet.update({
          where: { id: fixture.wallet.id },
          data: {
            availableBalance: { decrement: 10 },
            reservedBalance: { increment: 10 },
            version: { increment: 1 },
          },
        })
        const hold = await tx.transaction.create({
          data: {
            walletId: fixture.wallet.id,
            amount: -10,
            currency: "USD",
            type: "RESERVATION",
            reference,
          },
        })
        await tx.paymentDispute.create({
          data: {
            provider: "stripe",
            providerDisputeId,
            providerPaymentId: fixture.paymentIntentId,
            providerChargeId: `ch_${providerDisputeId}`,
            depositAttemptId: fixture.depositAttempt.id,
            depositTransactionId: fixture.depositTransaction.id,
            walletId: fixture.wallet.id,
            amount: 10,
            currency: "USD",
            heldAmount: 10,
            shortfallAmount: 0,
            currentExposureAmount: 0,
            status: "OPEN",
            providerStatus: "needs_response",
            openedByEventId: openedEvent.id,
            holdTransactionId: hold.id,
            openedAt: new Date(),
          },
        })
        await tx.depositAttempt.update({
          where: { id: fixture.depositAttempt.id },
          data: { status: "DISPUTED" },
        })
        // Deliberately omit the PROCESSING -> PROCESSED event transition.
      }),
    ).rejects.toBeDefined()

    await expect(
      prisma.wallet.findUniqueOrThrow({
        where: { id: fixture.wallet.id },
        select: {
          availableBalance: true,
          reservedBalance: true,
          version: true,
        },
      }),
    ).resolves.toMatchObject({
      availableBalance: walletBefore.availableBalance,
      reservedBalance: walletBefore.reservedBalance,
      version: walletBefore.version,
    })
    await expect(
      prisma.paymentDispute.count({
        where: { provider: "stripe", providerDisputeId },
      }),
    ).resolves.toBe(0)
    await expect(
      prisma.transaction.count({ where: { reference } }),
    ).resolves.toBe(0)
    await expect(
      prisma.depositAttempt.findUniqueOrThrow({
        where: { id: fixture.depositAttempt.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "SUCCEEDED" })
    await expect(
      prisma.paymentProviderEvent.findUniqueOrThrow({
        where: { id: openedEvent.id },
        select: {
          status: true,
          depositAttemptId: true,
          paymentDisputeId: true,
        },
      }),
    ).resolves.toEqual({
      status: "PROCESSING",
      depositAttemptId: null,
      paymentDisputeId: null,
    })
  }, 30_000)

  it("rolls back a processed event and case without the exact deposit projection", async () => {
    const fixture = await makeDepositFixture({
      depositAmount: 100,
      availableBalance: 0,
    })
    const providerDisputeId = `dp_missing_projection_${crypto.randomUUID()}`
    const openedEvent = await makeProviderEvent(
      fixture,
      providerDisputeId,
      "charge.dispute.created",
      1_000,
    )

    await expect(
      prisma.$transaction(async (tx: any) => {
        const paymentDispute = await tx.paymentDispute.create({
          data: {
            provider: "stripe",
            providerDisputeId,
            providerPaymentId: fixture.paymentIntentId,
            providerChargeId: `ch_${providerDisputeId}`,
            depositAttemptId: fixture.depositAttempt.id,
            depositTransactionId: fixture.depositTransaction.id,
            walletId: fixture.wallet.id,
            amount: 10,
            currency: "USD",
            heldAmount: 0,
            shortfallAmount: 10,
            currentExposureAmount: 10,
            status: "OPEN",
            providerStatus: "needs_response",
            openedByEventId: openedEvent.id,
            openedAt: new Date(),
          },
        })
        await tx.paymentProviderEvent.update({
          where: { id: openedEvent.id },
          data: {
            status: "PROCESSED",
            processedAt: new Date(),
            lockedAt: null,
            depositAttemptId: fixture.depositAttempt.id,
            paymentDisputeId: paymentDispute.id,
          },
        })
        // Deliberately leave the credited attempt at SUCCEEDED instead of the
        // aggregate-derived DISPUTED projection.
      }),
    ).rejects.toBeDefined()

    await expect(
      prisma.paymentDispute.count({
        where: { provider: "stripe", providerDisputeId },
      }),
    ).resolves.toBe(0)
    await expect(
      prisma.paymentProviderEvent.findUniqueOrThrow({
        where: { id: openedEvent.id },
        select: {
          status: true,
          depositAttemptId: true,
          paymentDisputeId: true,
        },
      }),
    ).resolves.toEqual({
      status: "PROCESSING",
      depositAttemptId: null,
      paymentDisputeId: null,
    })
    await expect(
      prisma.depositAttempt.findUniqueOrThrow({
        where: { id: fixture.depositAttempt.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "SUCCEEDED" })
  }, 30_000)

  it("cannot invalidate a processed event selected as durable case evidence", async () => {
    const fixture = await makeDepositFixture({
      depositAmount: 100,
      availableBalance: 100,
    })
    const providerDisputeId = `dp_role_event_${crypto.randomUUID()}`
    const openedEvent = await makeProviderEvent(
      fixture,
      providerDisputeId,
      "charge.dispute.created",
      1_000,
    )
    await billing.handleChargeback(
      stripeDispute(fixture, providerDisputeId, 1_000),
      openedEvent.id,
    )
    const paymentDispute = await prisma.paymentDispute.findUniqueOrThrow({
      where: {
        provider_providerDisputeId: {
          provider: "stripe",
          providerDisputeId,
        },
      },
    })

    await expect(
      prisma.paymentProviderEvent.update({
        where: { id: openedEvent.id },
        data: {
          status: "QUARANTINED",
          lastError: "TEST_ROLE_EVIDENCE_INVALIDATION",
        },
      }),
    ).rejects.toBeDefined()
    await expect(
      prisma.paymentProviderEvent.findUniqueOrThrow({
        where: { id: openedEvent.id },
        select: { status: true, paymentDisputeId: true, lastError: true },
      }),
    ).resolves.toEqual({
      status: "PROCESSED",
      paymentDisputeId: paymentDispute.id,
      lastError: null,
    })
    await expect(
      prisma.paymentDispute.findUniqueOrThrow({
        where: { id: paymentDispute.id },
        select: { openedByEventId: true },
      }),
    ).resolves.toEqual({ openedByEventId: openedEvent.id })
  }, 30_000)

  it("records repeated signed identity collisions without invalidating canonical dispute-role evidence", async () => {
    const fixture = await makeDepositFixture({
      depositAmount: 100,
      availableBalance: 100,
    })
    const providerDisputeId = `dp_role_collision_${crypto.randomUUID()}`
    const openedEvent = await makeProviderEvent(
      fixture,
      providerDisputeId,
      "charge.dispute.created",
      1_000,
    )
    await billing.handleChargeback(
      stripeDispute(fixture, providerDisputeId, 1_000),
      openedEvent.id,
    )
    const paymentDispute = await prisma.paymentDispute.findUniqueOrThrow({
      where: {
        provider_providerDisputeId: {
          provider: "stripe",
          providerDisputeId,
        },
      },
      select: { id: true, openedByEventId: true },
    })
    expect(paymentDispute.openedByEventId).toBe(openedEvent.id)

    const canonicalBefore = await prisma.paymentProviderEvent.findUniqueOrThrow(
      {
        where: { id: openedEvent.id },
      },
    )
    const finance = await makeUser(prisma, { userType: "STAFF" })
    await prisma.staffMembership.create({
      data: { userId: finance.id, role: "FINANCE" },
    })

    const previousSecret = process.env.STRIPE_WEBHOOK_SECRET
    const previousAdapter = (billing as any).depositProvider
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_dispute_collision"
    const signedPayload = Buffer.from(
      '{"verified":"canonical-dispute-identity-collision"}',
    )
    const conflictingPaymentIntentId = `pi_conflicting_${crypto.randomUUID()}`
    ;(billing as any).depositProvider = {
      capabilities: { supportedCurrencies: ["USD"] },
      verifyWebhook: () => ({
        id: openedEvent.providerEventId,
        type: "charge.dispute.created",
        livemode: false,
        data: {
          object: {
            id: providerDisputeId,
            payment_intent: conflictingPaymentIntentId,
            charge: `ch_${providerDisputeId}`,
            amount: 1_000,
            currency: "usd",
            status: "needs_response",
          },
        },
      }),
    }

    const expectedResponse = {
      received: true,
      duplicate: true,
      identityConflict: true,
      quarantined: false,
      canonicalEvidenceRetained: true,
    }
    try {
      await expect(
        billing.handleWebhook("signed", signedPayload),
      ).resolves.toEqual(expectedResponse)
      await expect(
        billing.handleWebhook("signed", signedPayload),
      ).resolves.toEqual(expectedResponse)

      await expect(
        prisma.paymentProviderEvent.findUniqueOrThrow({
          where: { id: openedEvent.id },
        }),
      ).resolves.toEqual(canonicalBefore)
      await expect(
        prisma.paymentDispute.findUniqueOrThrow({
          where: { id: paymentDispute.id },
          select: { openedByEventId: true },
        }),
      ).resolves.toEqual({ openedByEventId: openedEvent.id })
      await expect(
        prisma.auditLog.count({
          where: {
            action: "PAYMENT_PROVIDER_EVENT_IDENTITY_CONFLICT_DETECTED",
            entityType: "PaymentProviderEvent",
            entityId: openedEvent.id,
          },
        }),
      ).resolves.toBe(1)
      await expect(
        prisma.notification.count({
          where: {
            userId: finance.id,
            type: "PAYMENT_PROVIDER_EVENT_IDENTITY_CONFLICT",
            dedupKey: `payment-provider-event-identity-conflict:${openedEvent.id}:${finance.id}`,
          },
        }),
      ).resolves.toBe(1)
    } finally {
      ;(billing as any).depositProvider = previousAdapter
      if (previousSecret == null) {
        delete process.env.STRIPE_WEBHOOK_SECRET
      } else {
        process.env.STRIPE_WEBHOOK_SECRET = previousSecret
      }
    }
  }, 30_000)

  it("allows correlated duplicate events without replacing designated evidence", async () => {
    const fixture = await makeDepositFixture({
      depositAmount: 100,
      availableBalance: 100,
    })
    const providerDisputeId = `dp_correlated_duplicate_${crypto.randomUUID()}`
    const designatedEvent = await makeProviderEvent(
      fixture,
      providerDisputeId,
      "charge.dispute.created",
      1_000,
    )
    await billing.handleChargeback(
      stripeDispute(fixture, providerDisputeId, 1_000),
      designatedEvent.id,
    )
    const duplicateEvent = await makeProviderEvent(
      fixture,
      providerDisputeId,
      "charge.dispute.created",
      1_000,
    )
    await billing.handleChargeback(
      stripeDispute(fixture, providerDisputeId, 1_000),
      duplicateEvent.id,
    )

    const paymentDispute = await prisma.paymentDispute.findUniqueOrThrow({
      where: {
        provider_providerDisputeId: {
          provider: "stripe",
          providerDisputeId,
        },
      },
    })
    expect(paymentDispute.openedByEventId).toBe(designatedEvent.id)
    await expect(
      prisma.paymentProviderEvent.findUniqueOrThrow({
        where: { id: duplicateEvent.id },
        select: { status: true, paymentDisputeId: true },
      }),
    ).resolves.toEqual({
      status: "PROCESSED",
      paymentDisputeId: paymentDispute.id,
    })
  }, 30_000)

  it("rejects forged attempt increments while terminalizing an inbox event", async () => {
    const event = await makeCheckoutProviderEvent(
      `cs_attempt_fence_${crypto.randomUUID()}`,
    )
    await expect(
      prisma.paymentProviderEvent.update({
        where: { id: event.id },
        data: {
          status: "IGNORED",
          attempts: { increment: 1 },
          processedAt: new Date(),
          lockedAt: null,
        },
      }),
    ).rejects.toBeDefined()
    await expect(
      prisma.paymentProviderEvent.findUniqueOrThrow({
        where: { id: event.id },
        select: { status: true, attempts: true, lockedAt: true },
      }),
    ).resolves.toMatchObject({
      status: "PROCESSING",
      attempts: event.attempts,
      lockedAt: event.lockedAt,
    })
  }, 30_000)

  it("enforces USD whole-cent dispute evidence at the database boundary", async () => {
    const fixture = await makeDepositFixture({
      depositAmount: 100,
      availableBalance: 100,
    })
    const eurDisputeId = `dp_eur_${crypto.randomUUID()}`
    const eurProviderEventId = `evt_eur_${crypto.randomUUID()}`
    const eurFacts: FingerprintablePaymentDisputeEvent = {
      provider: "stripe",
      providerEventId: eurProviderEventId,
      eventType: "charge.dispute.created",
      providerDisputeId: eurDisputeId,
      providerPaymentId: fixture.paymentIntentId,
      providerChargeId: `ch_${eurDisputeId}`,
      amountMinor: 1_000n,
      amount: "10.00",
      currency: "EUR",
      providerStatus: "needs_response",
      livemode: false,
    }
    await expect(
      prisma.paymentProviderEvent.create({
        data: {
          provider: "stripe",
          providerEventId: eurProviderEventId,
          eventType: eurFacts.eventType,
          objectId: eurDisputeId,
          providerPaymentId: fixture.paymentIntentId,
          providerChargeId: eurFacts.providerChargeId,
          disputeAmountMinor: eurFacts.amountMinor,
          disputeCurrency: eurFacts.currency,
          providerStatus: eurFacts.providerStatus,
          livemode: false,
          eventFingerprint: paymentDisputeEventFingerprint(eurFacts),
          status: "PENDING",
        },
      }),
    ).rejects.toBeDefined()

    const subCentDisputeId = `dp_subcent_${crypto.randomUUID()}`
    const subCentEvent = await makeProviderEvent(
      fixture,
      subCentDisputeId,
      "charge.dispute.created",
      1_001,
    )
    await expect(
      prisma.paymentDispute.create({
        data: {
          provider: "stripe",
          providerDisputeId: subCentDisputeId,
          providerPaymentId: fixture.paymentIntentId,
          providerChargeId: `ch_${subCentDisputeId}`,
          depositAttemptId: fixture.depositAttempt.id,
          depositTransactionId: fixture.depositTransaction.id,
          walletId: fixture.wallet.id,
          amount: "10.005",
          currency: "USD",
          heldAmount: 0,
          shortfallAmount: "10.005",
          currentExposureAmount: "10.005",
          status: "OPEN",
          providerStatus: "needs_response",
          openedByEventId: subCentEvent.id,
          openedAt: new Date(),
        },
      }),
    ).rejects.toBeDefined()
    await expect(
      prisma.paymentDispute.count({
        where: {
          provider: "stripe",
          providerDisputeId: subCentDisputeId,
        },
      }),
    ).resolves.toBe(0)
  }, 30_000)

  it("freezes credited deposit identity and enforces the case aggregate projection", async () => {
    const fixture = await makeDepositFixture({
      depositAmount: 100,
      availableBalance: 100,
    })
    const providerDisputeId = `dp_attempt_guard_${crypto.randomUUID()}`
    const openedEvent = await makeProviderEvent(
      fixture,
      providerDisputeId,
      "charge.dispute.created",
      1_000,
    )
    await billing.handleChargeback(
      stripeDispute(fixture, providerDisputeId, 1_000),
      openedEvent.id,
    )

    for (const data of [
      { providerPaymentId: `pi_rewritten_${crypto.randomUUID()}` },
      { ledgerTransactionId: null },
      { walletCredit: 99 },
      { currency: "EUR" },
      { status: "CHARGEBACK" },
      { status: "FAILED" },
    ]) {
      await expect(
        prisma.depositAttempt.update({
          where: { id: fixture.depositAttempt.id },
          data,
        }),
      ).rejects.toBeDefined()
    }
    await expect(
      prisma.depositAttempt.findUniqueOrThrow({
        where: { id: fixture.depositAttempt.id },
        select: {
          providerPaymentId: true,
          ledgerTransactionId: true,
          walletCredit: true,
          currency: true,
          status: true,
        },
      }),
    ).resolves.toMatchObject({
      providerPaymentId: fixture.paymentIntentId,
      ledgerTransactionId: fixture.depositTransaction.id,
      walletCredit: fixture.depositTransaction.amount,
      currency: "USD",
      status: "DISPUTED",
    })
  }, 30_000)

  it("preserves credited DepositAttempt evidence before any dispute exists", async () => {
    const fixture = await makeDepositFixture({
      depositAmount: 100,
      availableBalance: 100,
    })
    await expect(
      prisma.depositAttempt.delete({
        where: { id: fixture.depositAttempt.id },
      }),
    ).rejects.toBeDefined()
    await expect(
      prisma.depositAttempt.count({
        where: { id: fixture.depositAttempt.id },
      }),
    ).resolves.toBe(1)
    await expect(
      prisma.transaction.update({
        where: { id: fixture.depositTransaction.id },
        data: { description: "rewritten credited evidence" },
      }),
    ).rejects.toBeDefined()
    await expect(
      prisma.transaction.delete({
        where: { id: fixture.depositTransaction.id },
      }),
    ).rejects.toBeDefined()
    await expect(
      prisma.transaction.count({
        where: { id: fixture.depositTransaction.id },
      }),
    ).resolves.toBe(1)
  }, 30_000)

  it("serializes case creation against a stale credited-deposit identity rewrite", async () => {
    const fixture = await makeDepositFixture({
      depositAmount: 100,
      availableBalance: 100,
    })
    const providerDisputeId = `dp_attempt_race_${crypto.randomUUID()}`
    const openedEvent = await makeProviderEvent(
      fixture,
      providerDisputeId,
      "charge.dispute.created",
      1_000,
    )
    let signalAttemptLocked!: () => void
    let releaseAttempt!: () => void
    const attemptLocked = new Promise<void>((resolve) => {
      signalAttemptLocked = resolve
    })
    const allowAttemptMutation = new Promise<void>((resolve) => {
      releaseAttempt = resolve
    })
    const staleRewrite = prisma.$transaction(async (tx: any) => {
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "DepositAttempt" WHERE "id" = $1 FOR UPDATE',
        fixture.depositAttempt.id,
      )
      signalAttemptLocked()
      await allowAttemptMutation
      return tx.depositAttempt.update({
        where: { id: fixture.depositAttempt.id },
        data: { walletCredit: 99 },
      })
    })
    await attemptLocked

    const createCase = billing.handleChargeback(
      stripeDispute(fixture, providerDisputeId, 1_000),
      openedEvent.id,
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    releaseAttempt()

    const [rewriteResult, caseResult] = await Promise.allSettled([
      staleRewrite,
      createCase,
    ])
    expect(rewriteResult.status).toBe("rejected")
    expect(caseResult.status).toBe("fulfilled")
    await expect(
      prisma.depositAttempt.findUniqueOrThrow({
        where: { id: fixture.depositAttempt.id },
        select: {
          walletCredit: true,
          providerPaymentId: true,
          ledgerTransactionId: true,
          status: true,
        },
      }),
    ).resolves.toMatchObject({
      walletCredit: fixture.depositTransaction.amount,
      providerPaymentId: fixture.paymentIntentId,
      ledgerTransactionId: fixture.depositTransaction.id,
      status: "DISPUTED",
    })
    await expect(
      prisma.paymentDispute.count({
        where: { provider: "stripe", providerDisputeId },
      }),
    ).resolves.toBe(1)
  }, 30_000)

  it("rolls back orphan and legacy dispute ledger mutations", async () => {
    const fixture = await makeDepositFixture({
      depositAmount: 100,
      availableBalance: 100,
    })
    const orphanReference = `payment-dispute:stripe:dp_${crypto.randomUUID()}:hold`
    await expect(
      prisma.$transaction(async (tx: any) => {
        await tx.transaction.create({
          data: {
            walletId: fixture.wallet.id,
            amount: -10,
            currency: "USD",
            type: "RESERVATION",
            reference: orphanReference,
          },
        })
      }),
    ).rejects.toBeDefined()
    await expect(
      prisma.transaction.count({
        where: { reference: orphanReference },
      }),
    ).resolves.toBe(0)

    for (const legacyReference of [
      `chargeback-hold-${crypto.randomUUID()}`,
      `chargeback-release-${crypto.randomUUID()}`,
      `chargeback-lost-${crypto.randomUUID()}`,
    ]) {
      const before = await prisma.wallet.findUniqueOrThrow({
        where: { id: fixture.wallet.id },
      })
      await expect(
        prisma.$transaction(async (tx: any) => {
          await tx.wallet.update({
            where: { id: fixture.wallet.id },
            data: {
              availableBalance: { decrement: 1 },
              version: { increment: 1 },
            },
          })
          await tx.transaction.create({
            data: {
              walletId: fixture.wallet.id,
              amount: -1,
              currency: "USD",
              type: "CHARGEBACK",
              reference: legacyReference,
            },
          })
        }),
      ).rejects.toBeDefined()
      await expect(
        prisma.wallet.findUniqueOrThrow({
          where: { id: fixture.wallet.id },
          select: { availableBalance: true, version: true },
        }),
      ).resolves.toMatchObject({
        availableBalance: before.availableBalance,
        version: before.version,
      })
      await expect(
        prisma.transaction.count({
          where: { reference: legacyReference },
        }),
      ).resolves.toBe(0)
    }
  }, 30_000)

  it("requires durable cases before publishing dispute-derived deposit status", async () => {
    const fixture = await makeDepositFixture({
      depositAmount: 100,
      availableBalance: 100,
    })
    for (const status of ["DISPUTED", "CHARGEBACK"]) {
      await expect(
        prisma.depositAttempt.update({
          where: { id: fixture.depositAttempt.id },
          data: { status },
        }),
      ).rejects.toBeDefined()
    }

    const providerDisputeId = `dp_status_${crypto.randomUUID()}`
    const openedEvent = await makeProviderEvent(
      fixture,
      providerDisputeId,
      "charge.dispute.created",
      1_000,
    )
    await billing.handleChargeback(
      stripeDispute(fixture, providerDisputeId, 1_000),
      openedEvent.id,
    )
    await expect(
      prisma.depositAttempt.findUniqueOrThrow({
        where: { id: fixture.depositAttempt.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "DISPUTED" })
    await expect(
      prisma.depositAttempt.update({
        where: { id: fixture.depositAttempt.id },
        data: { status: "SUCCEEDED" },
      }),
    ).rejects.toBeDefined()
  }, 30_000)
})
