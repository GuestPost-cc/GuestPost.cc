import crypto from "node:crypto"
import {
  finalizeDepositCredit,
  type NormalizedDepositCreditFacts,
} from "@guestpost/shared/dist/deposit-credit-core"
import {
  type FingerprintableStripeDepositRecoveryEvidence,
  stripeDepositRecoveryEvidenceFingerprint,
} from "@guestpost/shared/dist/stripe-deposit-recovery"
import { makeOrganization, makeUser, makeWallet } from "../factories"
import { createTestDatabase, type TestDatabase } from "../helpers/test-db"

describe("[INTEGRATION] Financial — deposit credit recovery", () => {
  let database: TestDatabase | undefined
  let prisma: any
  let previousDatabaseUrl: string | undefined
  let previousStripeKey: string | undefined
  let previousRecoveryKey: string | undefined

  beforeAll(async () => {
    database = await createTestDatabase()
    previousDatabaseUrl = process.env.DATABASE_URL
    previousStripeKey = process.env.STRIPE_SECRET_KEY
    previousRecoveryKey = process.env.STRIPE_DEPOSIT_RECOVERY_KEY
    process.env.DATABASE_URL = database.url
    process.env.STRIPE_SECRET_KEY = "rk_test_webhook_integration"
    process.env.STRIPE_DEPOSIT_RECOVERY_KEY = "rk_test_recovery_integration"
    process.env.STRIPE_LIVE_MODE_ENABLED = "false"
    const { PrismaService } = require("../../../common/prisma.service") as any
    prisma = new PrismaService()
    await prisma.$connect()
  })

  afterAll(async () => {
    try {
      await prisma?.$disconnect()
    } finally {
      await database?.teardown()
      if (previousDatabaseUrl == null) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previousDatabaseUrl
      if (previousStripeKey == null) delete process.env.STRIPE_SECRET_KEY
      else process.env.STRIPE_SECRET_KEY = previousStripeKey
      if (previousRecoveryKey == null)
        delete process.env.STRIPE_DEPOSIT_RECOVERY_KEY
      else process.env.STRIPE_DEPOSIT_RECOVERY_KEY = previousRecoveryKey
    }
  })

  it("credits exactly once when webhook and authenticated polling race", async () => {
    const suffix = crypto.randomUUID()
    const organization = await makeOrganization(prisma)
    const user = await makeUser(prisma)
    const wallet = await makeWallet(prisma, {
      organizationId: organization.id,
      availableBalance: 0,
    })
    const providerSessionId = `cs_test_${suffix}`
    const providerPaymentId = `pi_test_${suffix}`
    const providerChargeId = `ch_test_${suffix}`
    const attempt = await prisma.depositAttempt.create({
      data: {
        publicReference: `DP-${suffix}`.slice(0, 32),
        walletId: wallet.id,
        organizationId: organization.id,
        createdByUserId: user.id,
        method: "CARD",
        provider: "stripe",
        amount: 12.5,
        walletCredit: 12.5,
        customerFee: 0,
        currency: "USD",
        status: "PENDING_CUSTOMER_ACTION",
        idempotencyKey: `deposit-${suffix}`,
        providerSessionId,
      },
    })
    const event = await prisma.paymentProviderEvent.create({
      data: {
        provider: "stripe",
        providerEventId: `evt_${suffix}`,
        eventType: "checkout.session.completed",
        objectId: providerSessionId,
        livemode: false,
        eventFingerprint: crypto.randomBytes(32).toString("hex"),
        status: "PROCESSING",
        attempts: 1,
        lockedAt: new Date(),
      },
    })
    const recoveryPending = await prisma.depositCreditRecovery.create({
      data: { depositAttemptId: attempt.id },
    })
    const recoveryLockedAt = new Date()
    await prisma.depositCreditRecovery.update({
      where: { id: recoveryPending.id },
      data: {
        status: "PROCESSING",
        attempts: { increment: 1 },
        lockedAt: recoveryLockedAt,
      },
    })
    const recovery = await prisma.depositCreditRecovery.findUniqueOrThrow({
      where: { id: recoveryPending.id },
    })

    const base: FingerprintableStripeDepositRecoveryEvidence = {
      source: "AUTHENTICATED_PROVIDER_RETRIEVAL",
      provider: "stripe",
      providerSessionId,
      providerPaymentId,
      providerChargeId,
      clientReferenceId: attempt.id,
      checkoutStatus: "complete",
      checkoutPaymentStatus: "paid",
      checkoutMode: "payment",
      checkoutAmountTotalMinor: 1250n,
      checkoutCurrency: "usd",
      checkoutLivemode: false,
      checkoutMetadataAttemptId: attempt.id,
      checkoutMetadataReference: attempt.publicReference,
      checkoutMetadataWalletId: wallet.id,
      checkoutMetadataUserId: user.id,
      checkoutMetadataOrgId: organization.id,
      paymentIntentStatus: "succeeded",
      paymentIntentAmountMinor: 1250n,
      paymentIntentReceivedMinor: 1250n,
      paymentIntentCurrency: "usd",
      paymentIntentLivemode: false,
      paymentMetadataAttemptId: attempt.id,
      paymentMetadataReference: attempt.publicReference,
      paymentMetadataWalletId: wallet.id,
      chargePaid: true,
      chargeCaptured: true,
      chargeRefunded: false,
      chargeAmountMinor: 1250n,
      chargeAmountCapturedMinor: 1250n,
      chargeCurrency: "usd",
      chargeLivemode: false,
    }
    const evidence = await prisma.depositCreditEvidence.create({
      data: {
        recoveryId: recovery.id,
        depositAttemptId: attempt.id,
        claimAttempt: recovery.attempts,
        claimLockedAt: recovery.lockedAt,
        ...base,
        evidenceFingerprint: stripeDepositRecoveryEvidenceFingerprint(base),
        retrievedAt: new Date(),
      },
    })
    const retrievalFacts: NormalizedDepositCreditFacts = {
      ...base,
      source: "AUTHENTICATED_PROVIDER_RETRIEVAL",
      providerPaymentId,
      providerChargeId,
      clientReferenceId: attempt.id,
      checkoutStatus: "complete",
      checkoutPaymentStatus: "paid",
      checkoutMode: "payment",
      checkoutAmountTotalMinor: 1250n,
      checkoutCurrency: "usd",
      checkoutMetadataAttemptId: attempt.id,
      checkoutMetadataReference: attempt.publicReference,
      checkoutMetadataWalletId: wallet.id,
      checkoutMetadataUserId: user.id,
    }
    const webhookFacts: NormalizedDepositCreditFacts = {
      ...retrievalFacts,
      source: "SIGNED_WEBHOOK",
      providerChargeId: null,
      paymentIntentStatus: null,
      paymentIntentAmountMinor: null,
      paymentIntentReceivedMinor: null,
      paymentIntentCurrency: null,
      paymentIntentLivemode: null,
      paymentMetadataAttemptId: null,
      paymentMetadataReference: null,
      paymentMetadataWalletId: null,
      chargePaid: null,
      chargeCaptured: null,
      chargeRefunded: null,
      chargeAmountMinor: null,
      chargeAmountCapturedMinor: null,
      chargeCurrency: null,
      chargeLivemode: null,
    }
    const hooks = {
      audit: async (tx: any, input: any) => {
        await tx.auditLog.create({ data: input })
      },
      recordSuccess: async () => [],
    }

    const results = await Promise.allSettled([
      finalizeDepositCredit(prisma, hooks, {
        authority: {
          kind: "WEBHOOK_EVENT",
          eventRowId: event.id,
          lease: {
            kind: "lease",
            attempts: event.attempts,
            lockedAt: event.lockedAt,
          },
        },
        facts: webhookFacts,
      }),
      finalizeDepositCredit(prisma, hooks, {
        authority: {
          kind: "RECOVERY",
          recoveryId: recovery.id,
          evidenceId: evidence.id,
          attempts: recovery.attempts,
          lockedAt: recovery.lockedAt,
        },
        facts: retrievalFacts,
      }),
    ])
    expect(results.every((result) => result.status === "fulfilled")).toBe(true)

    const [finalWallet, finalAttempt, ledgers, finalEvent, finalRecovery] =
      await Promise.all([
        prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
        prisma.depositAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
        prisma.transaction.findMany({
          where: {
            OR: [
              { reference: providerSessionId },
              { provider: "stripe", providerRef: providerPaymentId },
            ],
          },
        }),
        prisma.paymentProviderEvent.findUniqueOrThrow({
          where: { id: event.id },
        }),
        prisma.depositCreditRecovery.findUniqueOrThrow({
          where: { id: recovery.id },
        }),
      ])
    expect(finalWallet.availableBalance.toString()).toBe("12.5")
    expect(finalAttempt.status).toBe("SUCCEEDED")
    expect(ledgers).toHaveLength(1)
    expect(finalAttempt.ledgerTransactionId).toBe(ledgers[0].id)
    expect(finalEvent.status).toBe("PROCESSED")
    expect(finalRecovery.status).toBe("PROCESSED")
    expect(finalRecovery.evidenceId).toBe(evidence.id)
  })
})
