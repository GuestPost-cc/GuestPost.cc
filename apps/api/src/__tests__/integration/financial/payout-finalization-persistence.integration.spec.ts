import crypto from "node:crypto"
import { finalizePayoutExecution } from "@guestpost/shared/dist/payout-finalization-core"
import {
  isRetryablePrismaTransactionError,
  prismaTransactionRetryDelayMs,
} from "@guestpost/shared/dist/prisma-transaction-retry"
import { makeOrganization, makePublisher, makeUser } from "../factories"
import { createTestDatabase, type TestDatabase } from "../helpers/test-db"

interface PayoutFixture {
  organizationId: string
  publisherId: string
  requesterId: string
  approverId: string
  initiatorId: string
  checkerId: string
  balanceId: string
  withdrawalId: string
  executionId: string
  executionVersion: number
  providerId: string
  payoutMethodId: string
  providerName: "stripe_connect" | "manual"
  livemode: boolean | null
  providerReference: string
  providerAccountExternalId: string | null
  publicReference: string
  amount: number
}

describe("[INTEGRATION] Financial — canonical payout completion persistence", () => {
  let database: TestDatabase | undefined
  let previousDatabaseUrl: string | undefined
  let previousStripeKey: string | undefined
  let previousStripeLiveMode: string | undefined
  let prisma: any

  beforeAll(async () => {
    database = await createTestDatabase()
    previousDatabaseUrl = process.env.DATABASE_URL
    previousStripeKey = process.env.STRIPE_SECRET_KEY
    previousStripeLiveMode = process.env.STRIPE_LIVE_MODE_ENABLED
    process.env.DATABASE_URL = database.url
    process.env.STRIPE_SECRET_KEY = "sk_test_payout_persistence"
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
      if (previousDatabaseUrl !== undefined) {
        process.env.DATABASE_URL = previousDatabaseUrl
      } else {
        delete process.env.DATABASE_URL
      }
      if (previousStripeKey !== undefined) {
        process.env.STRIPE_SECRET_KEY = previousStripeKey
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

  async function makePayoutFixture(
    options: {
      providerName?: "stripe_connect" | "manual"
      amount?: number
      executionStatus?: "PROCESSING" | "FAILED"
      leaveExecutionAtCreated?: boolean
    } = {},
  ): Promise<PayoutFixture> {
    const suffix = crypto.randomUUID()
    const amount = options.amount ?? 125
    const providerName = options.providerName ?? "stripe_connect"
    const organization = await makeOrganization(prisma)
    const publisher = await makePublisher(prisma, {
      organizationId: organization.id,
    })
    const requester = await makeUser(prisma, { userType: "PUBLISHER" })
    const approver = await makeUser(prisma, { userType: "STAFF" })
    const initiator = await makeUser(prisma, { userType: "STAFF" })
    const checker = await makeUser(prisma, { userType: "STAFF" })
    await Promise.all(
      [approver, initiator, checker].map((staff) =>
        prisma.staffMembership.create({
          data: { userId: staff.id, role: "FINANCE" },
        }),
      ),
    )
    await prisma.publisherMembership.create({
      data: {
        publisherId: publisher.id,
        userId: requester.id,
        role: "PUBLISHER_OWNER",
      },
    })
    const balance = await prisma.publisherBalance.create({
      data: {
        publisherId: publisher.id,
        withdrawableBalance: 0,
        lifetimeEarnings: amount,
        lifetimePaid: 0,
        allocationCutoverAt: new Date(),
        allocationCarryForward: amount,
        allocationCarryForwardUsed: amount,
      },
    })
    const provider = await prisma.payoutProvider.upsert({
      where: { name: providerName },
      create: {
        name: providerName,
        displayName:
          providerName === "stripe_connect"
            ? "Stripe Connect"
            : "Manual Bank Transfer",
        config: {},
        isActive: true,
      },
      update: { isActive: true },
    })
    const providerAccountExternalId =
      providerName === "stripe_connect" ? `acct_integration_${suffix}` : null
    const providerAccount =
      providerName === "stripe_connect"
        ? await prisma.publisherProviderAccount.create({
            data: {
              publisherId: publisher.id,
              provider: "stripe_connect",
              providerAccountId: providerAccountExternalId,
              status: "ENABLED",
              defaultCurrency: "USD",
              transfersEnabled: true,
              payoutsEnabled: true,
              detailsSubmitted: true,
              payoutScheduleConfigured: true,
              isActive: true,
            },
          })
        : null
    const payoutMethod = await prisma.payoutMethod.create({
      data: {
        publisherId: publisher.id,
        type:
          providerName === "stripe_connect"
            ? "stripe_connect"
            : "bank_transfer",
        label: `Integration ${suffix}`,
        details: { ciphertext: `integration-${suffix}` },
        encryptionKeyVersion: 1,
        isActive: true,
        providerAccountId: providerAccount?.id ?? null,
      },
    })
    const publicReference = `WD-${suffix}`
    const requestedWithdrawal = await prisma.$transaction(async (tx: any) => {
      const created = await tx.withdrawal.create({
        data: {
          publisherId: publisher.id,
          amount,
          currency: "USD",
          publicReference,
          netAmount: amount,
          feePolicyVersion: "integration-v1",
          method: payoutMethod.type,
          status: "PENDING",
          idempotencyKey: `withdrawal-${suffix}`,
          payoutMethodId: payoutMethod.id,
          requestedBy: requester.id,
          availableAt: new Date(Date.now() - 120_000),
        },
      })
      await tx.withdrawalAllocation.create({
        data: {
          withdrawalId: created.id,
          sourceType: "CARRY_FORWARD",
          amount,
          currency: "USD",
          sequence: 0,
        },
      })
      return created
    })
    await prisma.withdrawal.update({
      where: { id: requestedWithdrawal.id },
      data: {
        status: "APPROVED",
        approvedBy: approver.id,
        approvedAt: new Date(),
        version: { increment: 1 },
      },
    })
    const providerReference =
      providerName === "stripe_connect"
        ? `po_integration_${suffix}`
        : `manual-send-${suffix}`
    const hash = (value: string) =>
      crypto.createHash("sha256").update(value).digest("hex")
    const initialProviderMetadata = {
      destinationSnapshot: {
        payoutMethodId: payoutMethod.id,
        payoutMethodVersion: payoutMethod.version,
        encryptionKeyVersion: payoutMethod.encryptionKeyVersion,
        encryptedDetailsFingerprint: hash(`details-${suffix}`),
        providerAccountRowId: providerAccount?.id ?? null,
        providerAccountExternalId,
        providerAccountProvider:
          providerName === "stripe_connect" ? "stripe_connect" : null,
        providerAccountFingerprint: providerAccount
          ? hash(`account-${suffix}`)
          : hash("null"),
        destinationCurrency: "USD",
        recipientFingerprint: null,
      },
      providerSnapshot: {
        providerId: provider.id,
        providerName,
        providerVersion: provider.version,
        configEncryptionKeyVersion: provider.configEncryptionKeyVersion,
        configFingerprint: hash(`config-${suffix}`),
      },
    }
    const { withdrawal, createdExecution } = await prisma.$transaction(
      async (tx: any) => {
        const processingWithdrawal = await tx.withdrawal.update({
          where: { id: requestedWithdrawal.id },
          data: { status: "PROCESSING", version: { increment: 1 } },
        })
        const execution = await tx.payoutExecution.create({
          data: {
            withdrawalId: processingWithdrawal.id,
            providerId: provider.id,
            livemode: providerName === "stripe_connect" ? false : null,
            status: "PROCESSING",
            amount,
            fee: 0,
            sourceCurrency: "USD",
            destinationCurrency: "USD",
            destinationAmount: amount,
            requestedReference: publicReference,
            stage: "CREATED",
            idempotencyKey: `payout-${processingWithdrawal.id}-v2`,
            initiatedByUserId: initiator.id,
            providerMetadata: initialProviderMetadata,
          },
        })
        return {
          withdrawal: processingWithdrawal,
          createdExecution: execution,
        }
      },
      { isolationLevel: "Serializable" },
    )
    let execution = createdExecution
    if (!options.leaveExecutionAtCreated) {
      const validatedProviderMetadata = {
        ...initialProviderMetadata,
        destinationSnapshot: {
          ...initialProviderMetadata.destinationSnapshot,
          recipientFingerprint: hash(`recipient-${suffix}`),
        },
      }
      await prisma.payoutExecution.update({
        where: { id: createdExecution.id },
        data: {
          stage: "DESTINATION_VALIDATED",
          providerMetadata: validatedProviderMetadata,
          version: { increment: 1 },
        },
      })
      const providerClaimedAt = new Date()
      await prisma.$transaction(async (tx: any) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "PayoutExecutionClaim" (
             "id", "executionId", "kind", "idempotencyKey",
             "idempotencyKeyFingerprint", "claimedAt", "lastClaimedAt",
             "claimedByUserId"
           ) VALUES ($1, $2, CAST($3 AS "PayoutExecutionClaimKind"), $4, $5, $6, $6, $7)`,
          crypto.randomUUID(),
          createdExecution.id,
          "PROVIDER_SEND",
          `payout-${withdrawal.id}-v2`,
          hash(`payout-${withdrawal.id}-v2`),
          providerClaimedAt,
          initiator.id,
        )
        await tx.payoutExecution.update({
          where: { id: createdExecution.id },
          data: {
            stage: "PROVIDER_SEND_CLAIMED",
            version: { increment: 1 },
          },
        })
      })
      if (providerName === "stripe_connect") {
        const providerTransferId = `tr_integration_${suffix}`
        const providerEvidenceMetadata = {
          ...validatedProviderMetadata,
          providerEvidence: {
            connectedAccountId: providerAccountExternalId,
            providerAmountMinor: amount * 100,
            providerCurrency: "USD",
            providerPublicReference: publicReference,
            livemode: false,
          },
        }
        await prisma.payoutExecution.update({
          where: { id: createdExecution.id },
          data: {
            providerExecutionId: providerTransferId,
            providerTransferId,
            stage: "TRANSFER_CREATED",
            providerMetadata: providerEvidenceMetadata,
            version: { increment: 1 },
          },
        })
        const bankClaimedAt = new Date()
        await prisma.$transaction(async (tx: any) => {
          await tx.$executeRawUnsafe(
            `INSERT INTO "PayoutExecutionClaim" (
               "id", "executionId", "kind", "idempotencyKey",
               "idempotencyKeyFingerprint", "claimedAt", "lastClaimedAt",
               "claimedByUserId"
             ) VALUES ($1, $2, CAST($3 AS "PayoutExecutionClaimKind"), $4, $5, $6, $6, $7)`,
            crypto.randomUUID(),
            createdExecution.id,
            "BANK_PAYOUT_SEND",
            `payout-bank-${withdrawal.id}-v2`,
            hash(`payout-bank-${withdrawal.id}-v2`),
            bankClaimedAt,
            initiator.id,
          )
          await tx.payoutExecution.update({
            where: { id: createdExecution.id },
            data: {
              stage: "BANK_PAYOUT_SEND_CLAIMED",
              version: { increment: 1 },
            },
          })
        })
        execution = await prisma.$transaction(async (tx: any) => {
          const updated = await tx.payoutExecution.update({
            where: { id: createdExecution.id },
            data: {
              status: options.executionStatus ?? "PROCESSING",
              providerPayoutId: providerReference,
              stage: "BANK_PAYOUT_CREATED",
              providerMetadata: providerEvidenceMetadata,
              version: { increment: 1 },
            },
          })
          if (options.executionStatus === "FAILED") {
            await tx.withdrawal.update({
              where: { id: withdrawal.id },
              data: { status: "FAILED", version: { increment: 1 } },
            })
          }
          return updated
        })
      } else {
        execution = await prisma.$transaction(async (tx: any) => {
          const updated = await tx.payoutExecution.update({
            where: { id: createdExecution.id },
            data: {
              status: options.executionStatus ?? "PROCESSING",
              providerExecutionId: providerReference,
              stage: "PROVIDER_SENT",
              providerMetadata: validatedProviderMetadata,
              version: { increment: 1 },
            },
          })
          if (options.executionStatus === "FAILED") {
            await tx.withdrawal.update({
              where: { id: withdrawal.id },
              data: { status: "FAILED", version: { increment: 1 } },
            })
          }
          return updated
        })
      }
    }

    return {
      organizationId: organization.id,
      publisherId: publisher.id,
      requesterId: requester.id,
      approverId: approver.id,
      initiatorId: initiator.id,
      checkerId: checker.id,
      balanceId: balance.id,
      withdrawalId: withdrawal.id,
      executionId: execution.id,
      executionVersion: execution.version,
      providerId: provider.id,
      payoutMethodId: payoutMethod.id,
      providerName,
      livemode: providerName === "stripe_connect" ? false : null,
      providerReference,
      providerAccountExternalId,
      publicReference,
      amount,
    }
  }

  async function makeCompletedWebhook(
    fixture: PayoutFixture,
    options: {
      eventType?: string
      providerAccountExternalId?: string | null
      payoutAmountMinor?: bigint
      payoutCurrency?: string
      livemode?: boolean | null
    } = {},
  ) {
    const eventSeed = crypto.randomUUID()
    const hasOption = (key: keyof typeof options) =>
      Object.getOwnPropertyDescriptor(options, key) !== undefined
    const event = await prisma.payoutWebhookEvent.create({
      data: {
        provider: fixture.providerName,
        dedupKey: crypto.createHash("sha256").update(eventSeed).digest("hex"),
        eventType:
          options.eventType ??
          (fixture.providerName === "stripe_connect"
            ? "payout.paid"
            : "transfers#state-change"),
        providerExecutionId: fixture.providerReference,
        providerAccountExternalId: hasOption("providerAccountExternalId")
          ? options.providerAccountExternalId
          : fixture.providerAccountExternalId,
        payoutAmountMinor: hasOption("payoutAmountMinor")
          ? options.payoutAmountMinor
          : fixture.providerName === "stripe_connect"
            ? BigInt(fixture.amount * 100)
            : null,
        payoutCurrency: hasOption("payoutCurrency")
          ? options.payoutCurrency
          : fixture.providerName === "stripe_connect"
            ? "USD"
            : null,
        livemode: hasOption("livemode") ? options.livemode : fixture.livemode,
        providerStatus: "COMPLETED",
        rawStatus: "paid",
      },
    })
    return prisma.payoutWebhookEvent.update({
      where: { id: event.id },
      data: {
        status: "PROCESSING",
        attempts: { increment: 1 },
        lockedAt: new Date(),
      },
    })
  }

  function providerResponseInput(fixture: PayoutFixture, evidenceAt: Date) {
    return {
      executionId: fixture.executionId,
      withdrawalId: fixture.withdrawalId,
      providerName: fixture.providerName,
      providerReference: fixture.providerReference,
      source: "PROVIDER_RESPONSE" as const,
      evidenceAt,
      providerAmountMinor: fixture.amount * 100,
      providerCurrency: "USD",
      metadata: { outcome: "confirmed" },
    }
  }

  function webhookInput(
    fixture: PayoutFixture,
    webhook: { id: string; attempts: number; lockedAt: Date | null },
  ) {
    if (!webhook.lockedAt) {
      throw new Error("Webhook fixture must own a processing lease")
    }
    return {
      executionId: fixture.executionId,
      withdrawalId: fixture.withdrawalId,
      providerName: fixture.providerName,
      providerReference: fixture.providerReference,
      source: "PROVIDER_WEBHOOK" as const,
      webhookEventId: webhook.id,
      webhookClaimAttempt: webhook.attempts,
      webhookClaimLockedAt: webhook.lockedAt,
      metadata: { outcome: "confirmed" },
    }
  }

  async function expectDatabaseRejection(
    operation: Promise<unknown>,
    expectedMessage: RegExp,
  ) {
    let rejected: unknown
    try {
      await operation
    } catch (error) {
      rejected = error
    }
    expect(rejected).toBeDefined()
    expect(
      String((rejected as { message?: unknown })?.message ?? rejected),
    ).toMatch(expectedMessage)
  }

  function directManualCompletion(
    fixture: PayoutFixture,
    evidenceAt: Date,
    completedAt: Date,
  ) {
    const reference = `RECEIPT-TIME-${crypto.randomUUID()}`
    return prisma.$executeRawUnsafe(
      `UPDATE "PayoutExecution"
       SET
         "status" = 'COMPLETED',
         "stage" = 'MANUAL_CONFIRMED',
         "completionSource" = 'MANUAL_BANK_CONFIRMATION',
         "completionEvidenceRef" = $1::text,
         "completionEvidenceAt" = ($2::timestamptz AT TIME ZONE 'UTC'),
         "completedAt" = ($3::timestamptz AT TIME ZONE 'UTC'),
         "completionActorUserId" = $4::text,
         "acceptedReference" = $1::text,
         "bankTraceReference" = $1::text,
         "providerMetadata" = "providerMetadata" ||
           jsonb_build_object(
             'completion',
             jsonb_build_object(
               'source', 'MANUAL_BANK_CONFIRMATION',
               'evidenceReference', $1::text,
               'actorUserId', $4::text,
               'reason', 'Bank operations verified the settled transfer receipt.',
               'evidenceAt', to_jsonb($2::timestamptz),
               'completedAt', to_jsonb($3::timestamptz)
             )
           ),
         "version" = "version" + 1
       WHERE "id" = $5`,
      reference,
      evidenceAt,
      completedAt,
      fixture.checkerId,
      fixture.executionId,
    )
  }

  async function runSerializableTestTransaction<T>(
    operation: (tx: any) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        return await prisma.$transaction(operation, {
          isolationLevel: "Serializable",
        })
      } catch (error) {
        if (!isRetryablePrismaTransactionError(error) || attempt === 5) {
          throw error
        }
        await new Promise((resolve) =>
          setTimeout(resolve, prismaTransactionRetryDelayMs(attempt)),
        )
      }
    }
    throw new Error("Serializable payout test transaction retry exhausted")
  }

  function makePublisherPayoutsService(auditOverride?: {
    log: (...args: any[]) => Promise<void>
  }) {
    const { AuditService } =
      require("../../../modules/audit/audit.service") as any
    const { PublisherPayoutsService } =
      require("../../../modules/publisher-payouts/publisher-payouts.service") as any
    const queue = { addJob: jest.fn().mockResolvedValue(undefined) }
    const service = new PublisherPayoutsService(
      prisma,
      auditOverride ?? new AuditService(prisma),
      queue,
      {},
      {},
    )
    return { queue, service }
  }

  async function moveToClaimFreeApproved(fixture: PayoutFixture) {
    await prisma.$transaction(
      async (tx: any) => {
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "Withdrawal" WHERE "id" = $1 FOR UPDATE',
          fixture.withdrawalId,
        )
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "PayoutExecution" WHERE "id" = $1 FOR UPDATE',
          fixture.executionId,
        )
        const withdrawal = await tx.withdrawal.findUniqueOrThrow({
          where: { id: fixture.withdrawalId },
        })
        await tx.payoutExecution.update({
          where: { id: fixture.executionId },
          data: {
            status: "CANCELLED",
            stage: "PRE_PROVIDER_ABORTED",
            cancellationSource: "PRE_PROVIDER_ABORT",
            cancelledAt: new Date(),
            cancellationActorUserId: fixture.checkerId,
            version: { increment: 1 },
          },
        })
        await tx.withdrawal.update({
          where: { id: fixture.withdrawalId },
          data: {
            status: "APPROVED",
            version: withdrawal.version + 1,
          },
        })
      },
      { isolationLevel: "Serializable" },
    )
  }

  async function addReservedCapacity(fixture: PayoutFixture, amount: number) {
    return prisma.publisherBalance.update({
      where: { id: fixture.balanceId },
      data: {
        withdrawableBalance: { increment: amount },
        allocationCarryForward: { increment: amount },
        version: { increment: 1 },
      },
    })
  }

  async function makeReadyReservationFixture(amount: number) {
    const suffix = crypto.randomUUID()
    const organization = await makeOrganization(prisma)
    const publisher = await makePublisher(prisma, {
      organizationId: organization.id,
    })
    const requester = await makeUser(prisma, { userType: "PUBLISHER" })
    await prisma.publisherMembership.create({
      data: {
        publisherId: publisher.id,
        userId: requester.id,
        role: "PUBLISHER_OWNER",
      },
    })
    const balance = await prisma.publisherBalance.create({
      data: {
        publisherId: publisher.id,
        withdrawableBalance: amount,
        lifetimeEarnings: amount,
        allocationCutoverAt: new Date(),
        allocationCarryForward: amount,
        allocationCarryForwardUsed: 0,
      },
    })
    const account = await prisma.publisherProviderAccount.create({
      data: {
        publisherId: publisher.id,
        provider: "stripe_connect",
        providerAccountId: `acct_reservation_${suffix}`,
        status: "ENABLED",
        defaultCurrency: "USD",
        transfersEnabled: true,
        payoutsEnabled: true,
        detailsSubmitted: true,
        payoutScheduleConfigured: true,
        isActive: true,
      },
    })
    const method = await prisma.payoutMethod.create({
      data: {
        publisherId: publisher.id,
        type: "stripe_connect",
        label: "Reservation race destination",
        details: { ciphertext: `integration-${suffix}` },
        encryptionKeyVersion: 1,
        isActive: true,
        providerAccountId: account.id,
      },
    })
    return {
      accountId: account.id,
      balanceId: balance.id,
      methodId: method.id,
      publisherId: publisher.id,
      requesterId: requester.id,
    }
  }

  it("serializes provider response and webhook completion into one liability release", async () => {
    const fixture = await makePayoutFixture()
    const webhook = await makeCompletedWebhook(fixture)
    const evidenceAt = new Date(Date.now() - 5_000)

    const outcomes = await Promise.all([
      finalizePayoutExecution(
        prisma,
        providerResponseInput(fixture, evidenceAt),
      ),
      finalizePayoutExecution(prisma, webhookInput(fixture, webhook)),
    ])

    expect(
      outcomes.filter((outcome) => outcome.kind === "completed"),
    ).toHaveLength(1)
    expect(
      outcomes.filter((outcome) => outcome.kind === "corroborated"),
    ).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.applied)).toHaveLength(1)

    const [balance, withdrawal, execution, persistedWebhook] =
      await Promise.all([
        prisma.publisherBalance.findUniqueOrThrow({
          where: { id: fixture.balanceId },
        }),
        prisma.withdrawal.findUniqueOrThrow({
          where: { id: fixture.withdrawalId },
        }),
        prisma.payoutExecution.findUniqueOrThrow({
          where: { id: fixture.executionId },
        }),
        prisma.payoutWebhookEvent.findUniqueOrThrow({
          where: { id: webhook.id },
        }),
      ])

    expect(balance.lifetimePaid.toString()).toBe(String(fixture.amount))
    expect(balance.version).toBe(1)
    expect(withdrawal).toMatchObject({ status: "COMPLETED", version: 3 })
    expect(execution).toMatchObject({
      status: "COMPLETED",
      completionEvidenceRef: fixture.providerReference,
      version: fixture.executionVersion + 1,
    })
    expect(["PROVIDER_RESPONSE", "PROVIDER_WEBHOOK"]).toContain(
      execution.completionSource,
    )
    if (execution.completionSource === "PROVIDER_WEBHOOK") {
      expect(execution.completionWebhookEventId).toBe(webhook.id)
      expect(persistedWebhook).toMatchObject({
        status: "PROCESSED",
        lastError: null,
      })
    } else {
      expect(execution.completionWebhookEventId).toBeNull()
      expect(persistedWebhook).toMatchObject({
        status: "IGNORED",
        lastError: "CorroboratesExistingCompletion",
      })
    }
    await expect(
      prisma.payoutExecution.count({
        where: {
          withdrawalId: fixture.withdrawalId,
          status: "COMPLETED",
        },
      }),
    ).resolves.toBe(1)
    await expect(
      prisma.auditLog.count({
        where: {
          entityType: "PayoutExecution",
          entityId: fixture.executionId,
          action: "PAYOUT_EXECUTION_COMPLETED",
        },
      }),
    ).resolves.toBe(1)
  }, 30_000)

  it("retains provider-response completion and records a later paid webhook as ignored corroboration", async () => {
    const fixture = await makePayoutFixture()
    await expect(
      finalizePayoutExecution(
        prisma,
        providerResponseInput(fixture, new Date(Date.now() - 5_000)),
      ),
    ).resolves.toMatchObject({ kind: "completed", applied: true })
    const canonical = await prisma.payoutExecution.findUniqueOrThrow({
      where: { id: fixture.executionId },
      select: {
        completionSource: true,
        completionEvidenceRef: true,
        completionWebhookEventId: true,
        version: true,
        updatedAt: true,
      },
    })
    const webhook = await makeCompletedWebhook(fixture)

    await expect(
      finalizePayoutExecution(prisma, webhookInput(fixture, webhook)),
    ).resolves.toMatchObject({ kind: "corroborated", applied: false })

    await expect(
      prisma.payoutExecution.findUniqueOrThrow({
        where: { id: fixture.executionId },
        select: {
          completionSource: true,
          completionEvidenceRef: true,
          completionWebhookEventId: true,
          version: true,
          updatedAt: true,
        },
      }),
    ).resolves.toEqual(canonical)
    await expect(
      prisma.payoutWebhookEvent.findUniqueOrThrow({
        where: { id: webhook.id },
        select: { status: true, lastError: true, processedAt: true },
      }),
    ).resolves.toMatchObject({
      status: "IGNORED",
      lastError: "CorroboratesExistingCompletion",
      processedAt: expect.any(Date),
    })
    await expect(
      prisma.auditLog.count({
        where: {
          entityId: fixture.executionId,
          action: "PAYOUT_COMPLETION_CORROBORATED",
        },
      }),
    ).resolves.toBe(1)
  }, 30_000)

  it("retains the linked webhook completion when a provider response arrives later", async () => {
    const fixture = await makePayoutFixture()
    const webhook = await makeCompletedWebhook(fixture)
    await expect(
      finalizePayoutExecution(prisma, webhookInput(fixture, webhook)),
    ).resolves.toMatchObject({ kind: "completed", applied: true })
    const canonical = await prisma.payoutExecution.findUniqueOrThrow({
      where: { id: fixture.executionId },
      select: {
        completionSource: true,
        completionEvidenceRef: true,
        completionWebhookEventId: true,
        version: true,
        updatedAt: true,
      },
    })

    await expect(
      finalizePayoutExecution(
        prisma,
        providerResponseInput(fixture, new Date(Date.now() - 5_000)),
      ),
    ).resolves.toMatchObject({ kind: "corroborated", applied: false })

    expect(canonical).toMatchObject({
      completionSource: "PROVIDER_WEBHOOK",
      completionWebhookEventId: webhook.id,
    })
    await expect(
      prisma.payoutExecution.findUniqueOrThrow({
        where: { id: fixture.executionId },
        select: {
          completionSource: true,
          completionEvidenceRef: true,
          completionWebhookEventId: true,
          version: true,
          updatedAt: true,
        },
      }),
    ).resolves.toEqual(canonical)
    await expect(
      prisma.payoutWebhookEvent.findUniqueOrThrow({
        where: { id: webhook.id },
        select: { status: true, lastError: true },
      }),
    ).resolves.toEqual({ status: "PROCESSED", lastError: null })
  }, 30_000)

  it("fails closed when a test-mode execution is observed after promotion to live credentials", async () => {
    const responseFixture = await makePayoutFixture()
    const webhookFixture = await makePayoutFixture()
    const webhook = await makeCompletedWebhook(webhookFixture)
    process.env.STRIPE_SECRET_KEY = "sk_live_payout_persistence"
    process.env.STRIPE_LIVE_MODE_ENABLED = "true"
    try {
      await expect(
        finalizePayoutExecution(
          prisma,
          providerResponseInput(responseFixture, new Date(Date.now() - 5_000)),
        ),
      ).resolves.toMatchObject({
        kind: "conflict",
        code: "PROVIDER_MODE_MISMATCH",
        applied: false,
      })
      await expect(
        finalizePayoutExecution(prisma, webhookInput(webhookFixture, webhook)),
      ).resolves.toMatchObject({
        kind: "conflict",
        code: "PROVIDER_MODE_MISMATCH",
        applied: false,
      })
    } finally {
      process.env.STRIPE_SECRET_KEY = "sk_test_payout_persistence"
      process.env.STRIPE_LIVE_MODE_ENABLED = "false"
    }

    const balances = await prisma.publisherBalance.findMany({
      where: {
        id: { in: [responseFixture.balanceId, webhookFixture.balanceId] },
      },
    })
    expect(
      balances.map((balance: any) => balance.lifetimePaid.toString()),
    ).toEqual(["0", "0"])
    await expect(
      prisma.payoutWebhookEvent.findUniqueOrThrow({
        where: { id: webhook.id },
        select: { status: true, lastError: true },
      }),
    ).resolves.toEqual({
      status: "QUARANTINED",
      lastError: "PROVIDER_MODE_MISMATCH",
    })
  }, 30_000)

  it("quarantines a webhook whose immutable mode differs from its execution", async () => {
    const fixture = await makePayoutFixture()
    const webhook = await makeCompletedWebhook(fixture, { livemode: true })

    await expect(
      finalizePayoutExecution(prisma, webhookInput(fixture, webhook)),
    ).resolves.toMatchObject({
      kind: "conflict",
      code: "WEBHOOK_EVIDENCE_MISMATCH",
      applied: false,
    })
    await expect(
      prisma.payoutWebhookEvent.findUniqueOrThrow({
        where: { id: webhook.id },
        select: { status: true, lastError: true },
      }),
    ).resolves.toEqual({
      status: "QUARANTINED",
      lastError: "WEBHOOK_EVIDENCE_MISMATCH",
    })
    const balance = await prisma.publisherBalance.findUniqueOrThrow({
      where: { id: fixture.balanceId },
    })
    expect(balance.lifetimePaid.toString()).toBe("0")
  }, 30_000)

  it("fences a stalled webhook claimant after a recovered lease is claimed", async () => {
    const fixture = await makePayoutFixture()
    const staleClaim = await makeCompletedWebhook(fixture)
    expect(staleClaim.lockedAt).toBeInstanceOf(Date)

    await prisma.payoutWebhookEvent.update({
      where: { id: staleClaim.id },
      data: {
        status: "FAILED",
        lockedAt: null,
        processedAt: null,
        availableAt: new Date(),
        lastError: "StaleProcessingLeaseRecovered",
      },
    })
    const recoveredClaim = await prisma.payoutWebhookEvent.update({
      where: { id: staleClaim.id },
      data: {
        status: "PROCESSING",
        attempts: { increment: 1 },
        lockedAt: new Date(),
        lastError: null,
      },
    })

    await expect(
      finalizePayoutExecution(prisma, webhookInput(fixture, staleClaim)),
    ).resolves.toMatchObject({
      kind: "conflict",
      code: "WEBHOOK_LEASE_LOST",
      applied: false,
    })

    const [
      balanceBeforeRecovery,
      executionBeforeRecovery,
      eventBeforeRecovery,
    ] = await Promise.all([
      prisma.publisherBalance.findUniqueOrThrow({
        where: { id: fixture.balanceId },
      }),
      prisma.payoutExecution.findUniqueOrThrow({
        where: { id: fixture.executionId },
      }),
      prisma.payoutWebhookEvent.findUniqueOrThrow({
        where: { id: staleClaim.id },
      }),
    ])
    expect(balanceBeforeRecovery.lifetimePaid.toString()).toBe("0")
    expect(executionBeforeRecovery.status).toBe("PROCESSING")
    expect(eventBeforeRecovery).toMatchObject({
      status: "PROCESSING",
      attempts: recoveredClaim.attempts,
      lockedAt: recoveredClaim.lockedAt,
    })

    await expect(
      finalizePayoutExecution(prisma, webhookInput(fixture, recoveredClaim)),
    ).resolves.toMatchObject({ kind: "completed", applied: true })
  }, 30_000)

  it("keeps terminal payout inbox evidence immutable except timestamp-preserving quarantine escalation", async () => {
    const fixture = await makePayoutFixture()
    const claimed = await makeCompletedWebhook(fixture)
    const processedAt = new Date()
    const ignored = await prisma.payoutWebhookEvent.update({
      where: { id: claimed.id },
      data: {
        status: "IGNORED",
        lockedAt: null,
        processedAt,
        lastError: "NonterminalProviderStatus",
      },
    })

    await expectDatabaseRejection(
      prisma.payoutWebhookEvent.update({
        where: { id: ignored.id },
        data: { lastError: "RewrittenTerminalReason" },
      }),
      /Terminal payout webhook operational evidence is immutable/,
    )
    await expectDatabaseRejection(
      prisma.payoutWebhookEvent.update({
        where: { id: ignored.id },
        data: {
          status: "QUARANTINED",
          processedAt: new Date(processedAt.getTime() + 1_000),
          lastError: "ContradictoryTerminalEvidence",
        },
      }),
      /quarantine escalation must preserve terminal timestamps/,
    )

    const quarantined = await prisma.payoutWebhookEvent.update({
      where: { id: ignored.id },
      data: {
        status: "QUARANTINED",
        lastError: "ContradictoryTerminalEvidence",
      },
    })
    expect(quarantined.processedAt?.getTime()).toBe(processedAt.getTime())
    expect(quarantined.availableAt.getTime()).toBe(
      ignored.availableAt.getTime(),
    )
  }, 30_000)

  it("treats identical evidence as replay or corroboration without paying twice", async () => {
    const fixture = await makePayoutFixture()
    const evidenceAt = new Date(Date.now() - 5_000)
    const initial = await finalizePayoutExecution(
      prisma,
      providerResponseInput(fixture, evidenceAt),
    )
    const completedExecution = await prisma.payoutExecution.findUniqueOrThrow({
      where: { id: fixture.executionId },
    })

    const replay = await finalizePayoutExecution(
      prisma,
      providerResponseInput(fixture, evidenceAt),
    )
    const webhook = await makeCompletedWebhook(fixture)
    const corroboration = await finalizePayoutExecution(
      prisma,
      webhookInput(fixture, webhook),
    )

    expect(initial).toMatchObject({ kind: "completed", applied: true })
    expect(replay).toMatchObject({ kind: "replayed", applied: false })
    expect(corroboration).toMatchObject({
      kind: "corroborated",
      applied: false,
    })

    const [balance, afterReplay] = await Promise.all([
      prisma.publisherBalance.findUniqueOrThrow({
        where: { id: fixture.balanceId },
      }),
      prisma.payoutExecution.findUniqueOrThrow({
        where: { id: fixture.executionId },
      }),
    ])
    expect(balance.lifetimePaid.toString()).toBe(String(fixture.amount))
    expect(balance.version).toBe(1)
    expect(afterReplay).toMatchObject({
      completionSource: "PROVIDER_RESPONSE",
      completionWebhookEventId: null,
      version: completedExecution.version,
    })
    expect(afterReplay.completedAt.getTime()).toBe(
      completedExecution.completedAt.getTime(),
    )
    await expect(
      prisma.auditLog.count({
        where: {
          entityType: "PayoutExecution",
          entityId: fixture.executionId,
          action: "PAYOUT_EXECUTION_COMPLETED",
        },
      }),
    ).resolves.toBe(1)
    await expect(
      prisma.auditLog.count({
        where: {
          entityType: "PayoutExecution",
          entityId: fixture.executionId,
          action: "PAYOUT_COMPLETION_REPLAYED",
        },
      }),
    ).resolves.toBe(1)
    await expect(
      prisma.auditLog.count({
        where: {
          entityType: "PayoutExecution",
          entityId: fixture.executionId,
          action: "PAYOUT_COMPLETION_CORROBORATED",
        },
      }),
    ).resolves.toBe(1)
  }, 30_000)

  it.each([
    {
      name: "wrong Stripe event type",
      expectedCode: "WEBHOOK_EVIDENCE_MISMATCH",
      webhook: {
        eventType: "transfer.updated",
      },
    },
    {
      name: "wrong Stripe connected account",
      expectedCode: "WEBHOOK_EVIDENCE_MISMATCH",
      webhook: {
        providerAccountExternalId: "acct_other",
      },
    },
    {
      name: "wrong Stripe payout amount",
      expectedCode: "PROVIDER_AMOUNT_CURRENCY_MISMATCH",
      webhook: {
        payoutAmountMinor: 1n,
      },
    },
    {
      name: "wrong Stripe payout currency",
      expectedCode: "PROVIDER_AMOUNT_CURRENCY_MISMATCH",
      webhook: {
        payoutCurrency: "EUR",
      },
    },
  ])("quarantines $name without releasing liability", async ({
    webhook,
    expectedCode,
  }) => {
    const fixture = await makePayoutFixture()
    const event = await makeCompletedWebhook(fixture, webhook)

    const outcome = await finalizePayoutExecution(
      prisma,
      webhookInput(fixture, event),
    )

    expect(outcome).toMatchObject({
      kind: "conflict",
      applied: false,
      code: expectedCode,
    })
    const [balance, withdrawal, execution, persistedEvent] = await Promise.all([
      prisma.publisherBalance.findUniqueOrThrow({
        where: { id: fixture.balanceId },
      }),
      prisma.withdrawal.findUniqueOrThrow({
        where: { id: fixture.withdrawalId },
      }),
      prisma.payoutExecution.findUniqueOrThrow({
        where: { id: fixture.executionId },
      }),
      prisma.payoutWebhookEvent.findUniqueOrThrow({
        where: { id: event.id },
      }),
    ])
    expect(balance.lifetimePaid.toString()).toBe("0")
    expect(withdrawal.status).toBe("PROCESSING")
    expect(execution.status).toBe("PROCESSING")
    expect(persistedEvent).toMatchObject({
      status: "QUARANTINED",
      lastError: expectedCode,
    })
  }, 30_000)

  it("rejects a normalized manual receipt reused by another withdrawal", async () => {
    const first = await makePayoutFixture({ providerName: "manual" })
    const second = await makePayoutFixture({ providerName: "manual" })
    const paidAt = new Date(Date.now() - 5_000)
    const commonInput = {
      providerName: "manual",
      source: "MANUAL_BANK_CONFIRMATION" as const,
      evidenceAt: paidAt,
      actorUserId: first.checkerId,
      reason: "Bank operations verified the settled transfer receipt.",
    }

    const firstOutcome = await finalizePayoutExecution(prisma, {
      ...commonInput,
      executionId: first.executionId,
      withdrawalId: first.withdrawalId,
      withdrawalPublicReference: first.publicReference,
      providerReference: "  bank receipt 000001  ",
    })
    const secondOutcome = await finalizePayoutExecution(prisma, {
      ...commonInput,
      executionId: second.executionId,
      withdrawalId: second.withdrawalId,
      withdrawalPublicReference: second.publicReference,
      providerReference: "BANK   RECEIPT 000001",
    })

    expect(firstOutcome).toMatchObject({ kind: "completed", applied: true })
    expect(secondOutcome).toMatchObject({
      kind: "conflict",
      applied: false,
      code: "EVIDENCE_ALREADY_USED",
    })
    const firstBalance = await prisma.publisherBalance.findUniqueOrThrow({
      where: { id: first.balanceId },
    })
    expect(firstBalance.lifetimePaid.toString()).toBe(String(first.amount))
    const secondBalance = await prisma.publisherBalance.findUniqueOrThrow({
      where: { id: second.balanceId },
    })
    expect(secondBalance.lifetimePaid.toString()).toBe("0")
    await expect(
      prisma.withdrawal.findUniqueOrThrow({
        where: { id: second.withdrawalId },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "PROCESSING" })
    await expect(
      prisma.payoutExecution.findUniqueOrThrow({
        where: { id: second.executionId },
        select: { status: true, completionEvidenceRef: true },
      }),
    ).resolves.toEqual({
      status: "PROCESSING",
      completionEvidenceRef: null,
    })
  }, 30_000)

  it("enforces one active-or-completed execution for each withdrawal", async () => {
    const fixture = await makePayoutFixture()
    await finalizePayoutExecution(
      prisma,
      providerResponseInput(fixture, new Date(Date.now() - 5_000)),
    )
    const suffix = crypto.randomUUID()
    const canonical = await prisma.payoutExecution.findUniqueOrThrow({
      where: { id: fixture.executionId },
    })
    const metadata = canonical.providerMetadata as {
      destinationSnapshot: Record<string, unknown>
      providerSnapshot: Record<string, unknown>
    }

    await expect(
      prisma.payoutExecution.create({
        data: {
          withdrawalId: fixture.withdrawalId,
          providerId: fixture.providerId,
          livemode: fixture.livemode,
          status: "PROCESSING",
          amount: fixture.amount,
          sourceCurrency: "USD",
          destinationCurrency: "USD",
          destinationAmount: fixture.amount,
          requestedReference: canonical.requestedReference,
          stage: "CREATED",
          idempotencyKey: `competing-${suffix}`,
          initiatedByUserId: fixture.initiatorId,
          providerMetadata: {
            destinationSnapshot: {
              ...metadata.destinationSnapshot,
              recipientFingerprint: null,
            },
            providerSnapshot: metadata.providerSnapshot,
          },
        },
      }),
    ).rejects.toThrow(/command does not match its locked withdrawal/)
    await expect(
      prisma.payoutExecution.count({
        where: { withdrawalId: fixture.withdrawalId },
      }),
    ).resolves.toBe(1)
  }, 30_000)

  it("makes completed payout evidence and terminal withdrawals immutable", async () => {
    const fixture = await makePayoutFixture()
    await finalizePayoutExecution(
      prisma,
      providerResponseInput(fixture, new Date(Date.now() - 5_000)),
    )

    await expectDatabaseRejection(
      prisma.$executeRawUnsafe(
        'UPDATE "PayoutExecution" SET "errorMessage" = $1 WHERE "id" = $2',
        "tampered",
        fixture.executionId,
      ),
      /Completed payout execution rows are immutable/,
    )
    await expectDatabaseRejection(
      prisma.$executeRawUnsafe(
        'DELETE FROM "PayoutExecution" WHERE "id" = $1',
        fixture.executionId,
      ),
      /Payout execution rows are financial evidence and cannot be deleted/,
    )
    await expectDatabaseRejection(
      prisma.$executeRawUnsafe(
        'UPDATE "Withdrawal" SET "amount" = $1 WHERE "id" = $2',
        fixture.amount + 1,
        fixture.withdrawalId,
      ),
      /Terminal withdrawal rows are immutable/,
    )
    await expectDatabaseRejection(
      prisma.$executeRawUnsafe(
        'DELETE FROM "Withdrawal" WHERE "id" = $1',
        fixture.withdrawalId,
      ),
      /Withdrawal rows are financial evidence and cannot be deleted/,
    )

    const [execution, withdrawal, balance] = await Promise.all([
      prisma.payoutExecution.findUniqueOrThrow({
        where: { id: fixture.executionId },
      }),
      prisma.withdrawal.findUniqueOrThrow({
        where: { id: fixture.withdrawalId },
      }),
      prisma.publisherBalance.findUniqueOrThrow({
        where: { id: fixture.balanceId },
      }),
    ])
    expect(execution).toMatchObject({
      status: "COMPLETED",
      errorMessage: null,
      completionEvidenceRef: fixture.providerReference,
    })
    expect(withdrawal.amount.toString()).toBe(String(fixture.amount))
    expect(withdrawal.status).toBe("COMPLETED")
    expect(balance.lifetimePaid.toString()).toBe(String(fixture.amount))
  }, 30_000)

  it("rejects atomic mutation of payout command identity and JSON shadow authority", async () => {
    const fixture = await makePayoutFixture()
    const before = await prisma.payoutExecution.findUniqueOrThrow({
      where: { id: fixture.executionId },
    })

    await expectDatabaseRejection(
      prisma.$executeRawUnsafe(
        `UPDATE "PayoutExecution"
         SET
           "idempotencyKey" = $1,
           "providerMetadata" = "providerMetadata" ||
             jsonb_build_object(
               'externalClaims',
               jsonb_build_object(
                 'providerSend',
                 jsonb_build_object(
                   'idempotencyKeyFingerprint',
                   'attacker-controlled'
                 )
               )
             )
         WHERE "id" = $2`,
        `changed-${crypto.randomUUID()}`,
        fixture.executionId,
      ),
      /Payout execution command identity is immutable/,
    )

    const after = await prisma.payoutExecution.findUniqueOrThrow({
      where: { id: fixture.executionId },
    })
    expect(after.idempotencyKey).toBe(before.idempotencyKey)
    expect(after.providerMetadata).toEqual(before.providerMetadata)
  }, 30_000)

  it("makes first-class send claims immutable, non-deletable, and monotonic", async () => {
    const fixture = await makePayoutFixture()
    const [claim] = (await prisma.$queryRawUnsafe(
      `SELECT *
       FROM "PayoutExecutionClaim"
       WHERE "executionId" = $1
         AND "kind" = 'PROVIDER_SEND'`,
      fixture.executionId,
    )) as Array<{
      id: string
      idempotencyKeyFingerprint: string
      claimedAt: Date
      lastClaimedAt: Date
    }>
    expect(claim).toBeDefined()

    await expectDatabaseRejection(
      prisma.$executeRawUnsafe(
        `UPDATE "PayoutExecutionClaim"
         SET "idempotencyKeyFingerprint" = $1
         WHERE "id" = $2`,
        "0".repeat(64),
        claim.id,
      ),
      /claim identity is immutable/,
    )
    await expectDatabaseRejection(
      prisma.$executeRawUnsafe(
        `UPDATE "PayoutExecutionClaim"
         SET "claimedAt" = "claimedAt" + INTERVAL '1 second'
         WHERE "id" = $1`,
        claim.id,
      ),
      /claim identity is immutable/,
    )
    await expectDatabaseRejection(
      prisma.$executeRawUnsafe(
        `UPDATE "PayoutExecutionClaim"
         SET "lastClaimedAt" = "lastClaimedAt" - INTERVAL '1 second'
         WHERE "id" = $1`,
        claim.id,
      ),
      /must advance monotonically/,
    )
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "PayoutExecutionClaim"
         SET "lastClaimedAt" = "lastClaimedAt" + INTERVAL '1 second'
         WHERE "id" = $1`,
        claim.id,
      ),
    ).resolves.toBe(1)
    await expectDatabaseRejection(
      prisma.$executeRawUnsafe(
        'DELETE FROM "PayoutExecutionClaim" WHERE "id" = $1',
        claim.id,
      ),
      /claims are financial authority and cannot be deleted/,
    )
  }, 30_000)

  it("blocks claim erasure, stage regression, and pre-provider liability reopen", async () => {
    const fixture = await makePayoutFixture()

    await expectDatabaseRejection(
      prisma.$executeRawUnsafe(
        `UPDATE "PayoutExecution"
         SET
           "stage" = 'DESTINATION_VALIDATED',
           "providerMetadata" = "providerMetadata" - 'externalClaims',
           "version" = "version" + 1
         WHERE "id" = $1`,
        fixture.executionId,
      ),
      /Invalid payout execution stage transition/,
    )
    await expectDatabaseRejection(
      prisma.$transaction(async (tx: any) => {
        await tx.$executeRawUnsafe(
          'DELETE FROM "PayoutExecutionClaim" WHERE "executionId" = $1',
          fixture.executionId,
        )
        await tx.payoutExecution.update({
          where: { id: fixture.executionId },
          data: {
            status: "CANCELLED",
            stage: "PRE_PROVIDER_ABORTED",
            cancellationSource: "PRE_PROVIDER_ABORT",
            cancelledAt: new Date(),
            cancellationActorUserId: fixture.checkerId,
            version: { increment: 1 },
          },
        })
        await tx.withdrawal.update({
          where: { id: fixture.withdrawalId },
          data: { status: "APPROVED", version: { increment: 1 } },
        })
      }),
      /claims are financial authority and cannot be deleted/,
    )

    await expect(
      prisma.payoutExecution.findUniqueOrThrow({
        where: { id: fixture.executionId },
        select: { status: true, stage: true },
      }),
    ).resolves.toEqual({
      status: "PROCESSING",
      stage: "BANK_PAYOUT_CREATED",
    })
    await expect(
      prisma.withdrawal.findUniqueOrThrow({
        where: { id: fixture.withdrawalId },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "PROCESSING" })
  }, 30_000)

  it("makes provider references and routing snapshots append-once", async () => {
    const fixture = await makePayoutFixture()

    await expectDatabaseRejection(
      prisma.$executeRawUnsafe(
        `UPDATE "PayoutExecution"
         SET "providerExecutionId" = $1, "version" = "version" + 1
         WHERE "id" = $2`,
        `tr_replaced_${crypto.randomUUID()}`,
        fixture.executionId,
      ),
      /Payout provider references are append-once/,
    )
    await expectDatabaseRejection(
      prisma.$executeRawUnsafe(
        `UPDATE "PayoutExecution"
         SET "providerMetadata" = jsonb_set(
           "providerMetadata",
           '{providerSnapshot,providerName}',
           '"tampered-provider"'::jsonb
         ),
         "version" = "version" + 1
         WHERE "id" = $1`,
        fixture.executionId,
      ),
      /Payout provider routing snapshot is immutable/,
    )
    await expectDatabaseRejection(
      prisma.$executeRawUnsafe(
        `UPDATE "PayoutExecution"
         SET "providerMetadata" = jsonb_set(
           "providerMetadata",
           '{destinationSnapshot,providerAccountExternalId}',
           '"acct_tampered"'::jsonb
         ),
         "version" = "version" + 1
         WHERE "id" = $1`,
        fixture.executionId,
      ),
      /Payout destination routing snapshot is immutable after validation/,
    )
  }, 30_000)

  it("rejects cancellation provenance from an ineligible Finance actor", async () => {
    const fixture = await makePayoutFixture({ leaveExecutionAtCreated: true })
    await prisma.user.update({
      where: { id: fixture.checkerId },
      data: { banned: true },
    })

    await expectDatabaseRejection(
      prisma.$transaction(async (tx: any) => {
        await tx.payoutExecution.update({
          where: { id: fixture.executionId },
          data: {
            status: "CANCELLED",
            stage: "PRE_PROVIDER_ABORTED",
            cancellationSource: "PRE_PROVIDER_ABORT",
            cancelledAt: new Date(),
            cancellationActorUserId: fixture.checkerId,
            version: { increment: 1 },
          },
        })
        await tx.withdrawal.update({
          where: { id: fixture.withdrawalId },
          data: { status: "APPROVED", version: { increment: 1 } },
        })
      }),
      /Payout cancellation actor must be a current unbanned Finance or Super Admin/,
    )

    await expect(
      prisma.payoutExecution.findUniqueOrThrow({
        where: { id: fixture.executionId },
        select: { status: true, stage: true },
      }),
    ).resolves.toEqual({ status: "PROCESSING", stage: "CREATED" })
  }, 30_000)

  it.each([
    ["\"publisherId\" = 'other-publisher'", "publisherId"],
    ['"amount" = "amount" + 1', "amount"],
    ["\"currency\" = 'EUR'", "currency"],
    ["\"publicReference\" = 'WD-TAMPERED'", "publicReference"],
    ['"payoutFee" = "payoutFee" + 1', "payoutFee"],
    ['"netAmount" = "netAmount" + 1', "netAmount"],
    ["\"feePolicyVersion\" = 'tampered'", "feePolicyVersion"],
    ["\"method\" = 'wise'", "method"],
    ['"availableAt" = "availableAt" + INTERVAL \'1 hour\'', "availableAt"],
    ["\"idempotencyKey\" = 'tampered-key'", "idempotencyKey"],
    ["\"payoutMethodId\" = 'tampered-method'", "payoutMethodId"],
    ["\"payoutBatchId\" = 'tampered-batch'", "payoutBatchId"],
    ["\"requestedBy\" = 'tampered-requester'", "requestedBy"],
    ['"createdAt" = "createdAt" + INTERVAL \'1 second\'', "createdAt"],
  ])("freezes withdrawal command field %s", async (assignment) => {
    const fixture = await makePayoutFixture()
    await expectDatabaseRejection(
      prisma.$executeRawUnsafe(
        `UPDATE "Withdrawal"
         SET ${assignment}, "version" = "version" + 1
         WHERE "id" = $1`,
        fixture.withdrawalId,
      ),
      /Withdrawal command envelope is immutable/,
    )
  }, 30_000)

  it("rejects stale-main withdrawal and payout-execution inserts", async () => {
    const fixture = await makePayoutFixture()
    const suffix = crypto.randomUUID()

    await expectDatabaseRejection(
      prisma.withdrawal.create({
        data: {
          publisherId: fixture.publisherId,
          amount: 10,
          currency: "USD",
          method: "stripe_connect",
          status: "PENDING",
        },
      }),
      /Withdrawals must be inserted as canonical provenance-backed requests/,
    )
    await expectDatabaseRejection(
      prisma.payoutExecution.create({
        data: {
          withdrawalId: fixture.withdrawalId,
          providerId: fixture.providerId,
          livemode: fixture.livemode,
          status: "PROCESSING",
          amount: fixture.amount,
          sourceCurrency: "USD",
          destinationCurrency: "USD",
          destinationAmount: fixture.amount,
          stage: "CREATED",
          idempotencyKey: `stale-${suffix}`,
        },
      }),
      /Payout executions must be inserted from a canonical immutable command snapshot/,
    )
    await expect(
      prisma.payoutExecution.count({
        where: { withdrawalId: fixture.withdrawalId },
      }),
    ).resolves.toBe(1)
  }, 30_000)

  it("rejects a self-consistent execution snapshot that is not anchored to current rows", async () => {
    const fixture = await makePayoutFixture({ leaveExecutionAtCreated: true })
    const canonical = await prisma.payoutExecution.findUniqueOrThrow({
      where: { id: fixture.executionId },
    })
    const metadata = canonical.providerMetadata as {
      destinationSnapshot: Record<string, unknown>
      providerSnapshot: Record<string, unknown>
    }

    await expectDatabaseRejection(
      prisma.payoutExecution.create({
        data: {
          withdrawalId: fixture.withdrawalId,
          providerId: fixture.providerId,
          livemode: fixture.livemode,
          status: "PROCESSING",
          amount: fixture.amount,
          sourceCurrency: "USD",
          destinationCurrency: "USD",
          destinationAmount: fixture.amount,
          requestedReference: fixture.publicReference,
          stage: "CREATED",
          idempotencyKey: `forged-snapshot-${crypto.randomUUID()}`,
          initiatedByUserId: fixture.checkerId,
          providerMetadata: {
            destinationSnapshot: metadata.destinationSnapshot,
            providerSnapshot: {
              ...metadata.providerSnapshot,
              providerVersion:
                Number(metadata.providerSnapshot.providerVersion) + 1,
            },
          },
        },
      }),
      /does not match its locked withdrawal, method, or provider/,
    )
  }, 30_000)

  it("rejects execution creation by a non-Finance staff actor at the database boundary", async () => {
    const fixture = await makePayoutFixture({ leaveExecutionAtCreated: true })
    const operations = await makeUser(prisma, { userType: "STAFF" })
    await prisma.staffMembership.create({
      data: { userId: operations.id, role: "OPERATIONS" },
    })
    const canonical = await prisma.payoutExecution.findUniqueOrThrow({
      where: { id: fixture.executionId },
    })
    const metadata = canonical.providerMetadata as {
      destinationSnapshot: Record<string, unknown>
      providerSnapshot: Record<string, unknown>
    }

    await expectDatabaseRejection(
      prisma.payoutExecution.create({
        data: {
          withdrawalId: fixture.withdrawalId,
          providerId: fixture.providerId,
          livemode: fixture.livemode,
          status: "PROCESSING",
          amount: fixture.amount,
          sourceCurrency: "USD",
          destinationCurrency: "USD",
          destinationAmount: fixture.amount,
          requestedReference: fixture.publicReference,
          stage: "CREATED",
          idempotencyKey: `operations-${crypto.randomUUID()}`,
          initiatedByUserId: operations.id,
          providerMetadata: metadata,
        },
      }),
      /initiator must be a current unbanned Finance or Super Admin/,
    )
  }, 30_000)

  it("keeps populated legacy NULL and newly ineligible requesters from approval", async () => {
    const fixture = await makePayoutFixture({ leaveExecutionAtCreated: true })
    const source = await prisma.withdrawal.findUniqueOrThrow({
      where: { id: fixture.withdrawalId },
      select: { method: true, payoutMethodId: true },
    })
    const createPending = (label: string) =>
      prisma.$transaction(async (tx: any) => {
        const withdrawal = await tx.withdrawal.create({
          data: {
            publisherId: fixture.publisherId,
            amount: 10,
            currency: "USD",
            publicReference: `WD-${label}-${crypto.randomUUID()}`,
            netAmount: 10,
            feePolicyVersion: "integration-v1",
            method: source.method,
            idempotencyKey: `${label}-${crypto.randomUUID()}`,
            payoutMethodId: source.payoutMethodId,
            requestedBy: fixture.requesterId,
            availableAt: new Date(Date.now() - 60_000),
          },
        })
        await tx.withdrawalAllocation.create({
          data: {
            withdrawalId: withdrawal.id,
            sourceType: "CARRY_FORWARD",
            amount: 10,
            currency: "USD",
            sequence: 0,
          },
        })
        return withdrawal
      })
    const legacy = await createPending("LEGACY-NULL")
    const demoted = await createPending("DEMOTED")

    // Simulate a populated row that predates the migration's nullable
    // requestedBy column. The post-upgrade approval trigger must fail closed.
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Withdrawal" DISABLE TRIGGER "Withdrawal_financial_provenance_guard"',
    )
    try {
      await prisma.$executeRawUnsafe(
        'UPDATE "Withdrawal" SET "requestedBy" = NULL WHERE "id" = $1',
        legacy.id,
      )
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "Withdrawal" ENABLE TRIGGER "Withdrawal_financial_provenance_guard"',
      )
    }
    await prisma.publisherMembership.update({
      where: {
        userId_publisherId: {
          userId: fixture.requesterId,
          publisherId: fixture.publisherId,
        },
      },
      data: { role: "PUBLISHER_MEMBER" },
    })

    for (const withdrawalId of [legacy.id, demoted.id]) {
      await expectDatabaseRejection(
        prisma.withdrawal.update({
          where: { id: withdrawalId },
          data: {
            status: "APPROVED",
            approvedBy: fixture.approverId,
            approvedAt: new Date(),
            version: { increment: 1 },
          },
        }),
        /Withdrawal approval requires a current unbanned publisher-owner requester/,
      )
    }
    await expect(
      prisma.withdrawal.count({
        where: { id: { in: [legacy.id, demoted.id] }, status: "PENDING" },
      }),
    ).resolves.toBe(2)
  }, 30_000)

  it("rejects payout initiation by the same Finance actor who approved it", async () => {
    const fixture = await makePayoutFixture({ leaveExecutionAtCreated: true })
    const originalWithdrawal = await prisma.withdrawal.findUniqueOrThrow({
      where: { id: fixture.withdrawalId },
    })
    const originalExecution = await prisma.payoutExecution.findUniqueOrThrow({
      where: { id: fixture.executionId },
    })
    const suffix = crypto.randomUUID()
    const requested = await prisma.$transaction(async (tx: any) => {
      const withdrawal = await tx.withdrawal.create({
        data: {
          publisherId: fixture.publisherId,
          amount: fixture.amount,
          currency: "USD",
          publicReference: `WD-MAKER-${suffix}`,
          netAmount: fixture.amount,
          feePolicyVersion: "integration-v1",
          method: originalWithdrawal.method,
          idempotencyKey: `maker-${suffix}`,
          payoutMethodId: originalWithdrawal.payoutMethodId,
          requestedBy: fixture.requesterId,
          availableAt: new Date(Date.now() - 60_000),
        },
      })
      await tx.withdrawalAllocation.create({
        data: {
          withdrawalId: withdrawal.id,
          sourceType: "CARRY_FORWARD",
          amount: fixture.amount,
          currency: "USD",
          sequence: 0,
        },
      })
      return withdrawal
    })
    await prisma.withdrawal.update({
      where: { id: requested.id },
      data: {
        status: "APPROVED",
        approvedBy: fixture.approverId,
        approvedAt: new Date(),
        version: { increment: 1 },
      },
    })
    const metadata = originalExecution.providerMetadata as {
      destinationSnapshot: Record<string, unknown>
      providerSnapshot: Record<string, unknown>
    }

    await expectDatabaseRejection(
      prisma.$transaction(async (tx: any) => {
        const processing = await tx.withdrawal.update({
          where: { id: requested.id },
          data: { status: "PROCESSING", version: { increment: 1 } },
        })
        await tx.payoutExecution.create({
          data: {
            withdrawalId: requested.id,
            providerId: fixture.providerId,
            livemode: fixture.livemode,
            status: "PROCESSING",
            amount: fixture.amount,
            sourceCurrency: "USD",
            destinationCurrency: "USD",
            destinationAmount: fixture.amount,
            requestedReference: requested.publicReference,
            stage: "CREATED",
            idempotencyKey: `payout-${requested.id}-v${processing.version}`,
            initiatedByUserId: fixture.approverId,
            providerMetadata: {
              destinationSnapshot: {
                ...metadata.destinationSnapshot,
                recipientFingerprint: null,
              },
              providerSnapshot: metadata.providerSnapshot,
            },
          },
        })
      }),
      /eligible approver distinct from its initiator/,
    )
    await expect(
      prisma.withdrawal.findUniqueOrThrow({
        where: { id: requested.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "APPROVED" })
  }, 30_000)

  it("rejects a replacement execution after an unevidenced failed attempt", async () => {
    const fixture = await makePayoutFixture()
    const existing = await prisma.$transaction(async (tx: any) => {
      const failed = await tx.payoutExecution.update({
        where: { id: fixture.executionId },
        data: {
          status: "FAILED",
          stage: "BANK_PAYOUT_RECOVERY_REQUIRED",
          version: { increment: 1 },
        },
      })
      await tx.withdrawal.update({
        where: { id: fixture.withdrawalId },
        data: { status: "FAILED", version: { increment: 1 } },
      })
      return failed
    })
    const metadata = existing.providerMetadata as {
      destinationSnapshot: Record<string, unknown>
      providerSnapshot: Record<string, unknown>
    }

    await expectDatabaseRejection(
      prisma.payoutExecution.create({
        data: {
          withdrawalId: fixture.withdrawalId,
          providerId: fixture.providerId,
          livemode: fixture.livemode,
          status: "PROCESSING",
          amount: fixture.amount,
          sourceCurrency: "USD",
          destinationCurrency: "USD",
          destinationAmount: fixture.amount,
          requestedReference: existing.requestedReference,
          stage: "CREATED",
          idempotencyKey: `replacement-${crypto.randomUUID()}`,
          initiatedByUserId: fixture.initiatorId,
          providerMetadata: {
            destinationSnapshot: {
              ...metadata.destinationSnapshot,
              recipientFingerprint: null,
            },
            providerSnapshot: metadata.providerSnapshot,
          },
        },
      }),
      /command does not match its locked withdrawal|typed cancellation/,
    )
    await expect(
      prisma.payoutExecution.count({
        where: { withdrawalId: fixture.withdrawalId },
      }),
    ).resolves.toBe(1)
  }, 30_000)

  it("rolls back a stale cancellation writer that has no provider reversal evidence", async () => {
    const fixture = await makePayoutFixture()
    await prisma.payoutExecution.update({
      where: { id: fixture.executionId },
      data: { stage: "CANCEL_REQUESTED", version: { increment: 1 } },
    })

    await expectDatabaseRejection(
      prisma.$transaction(async (tx: any) => {
        await tx.payoutExecution.update({
          where: { id: fixture.executionId },
          data: {
            status: "CANCELLED",
            stage: "CANCELLED_REVERSED",
            cancelledAt: new Date(),
            cancellationActorUserId: fixture.checkerId,
            version: { increment: 1 },
          },
        })
        await tx.withdrawal.update({
          where: { id: fixture.withdrawalId },
          data: { status: "APPROVED", version: { increment: 1 } },
        })
      }),
      /cancellation_evidence_check|supported evidence source/,
    )

    const [withdrawal, execution, balance] = await Promise.all([
      prisma.withdrawal.findUniqueOrThrow({
        where: { id: fixture.withdrawalId },
      }),
      prisma.payoutExecution.findUniqueOrThrow({
        where: { id: fixture.executionId },
      }),
      prisma.publisherBalance.findUniqueOrThrow({
        where: { id: fixture.balanceId },
      }),
    ])
    expect(withdrawal.status).toBe("PROCESSING")
    expect(execution).toMatchObject({
      status: "PROCESSING",
      stage: "CANCEL_REQUESTED",
      cancellationSource: null,
    })
    expect(balance.withdrawableBalance.toString()).toBe("0")
    expect(balance.lifetimePaid.toString()).toBe("0")
  }, 30_000)

  it("accepts a matching typed Stripe reversal and reopens atomically", async () => {
    const fixture = await makePayoutFixture()
    const claimed = await prisma.payoutExecution.update({
      where: { id: fixture.executionId },
      data: { stage: "CANCEL_REQUESTED", version: { increment: 1 } },
    })
    const cancelledAt = new Date()
    const reversalId = `trr_${crypto.randomUUID()}`
    const cancellation = {
      source: "PROVIDER_RESPONSE",
      provider: "stripe_connect",
      providerExecutionId: claimed.providerExecutionId,
      providerTransferId: claimed.providerTransferId,
      providerPayoutId: claimed.providerPayoutId,
      reversalId,
      payoutStatus: "canceled",
      connectedAccountId: fixture.providerAccountExternalId,
      providerAmountMinor: fixture.amount * 100,
      providerCurrency: "USD",
      providerPublicReference: fixture.publicReference,
      livemode: false,
      evidenceAt: cancelledAt.toISOString(),
      cancelledAt: cancelledAt.toISOString(),
      actorUserId: fixture.approverId,
    }

    await prisma.$transaction(async (tx: any) => {
      await tx.payoutExecution.update({
        where: { id: fixture.executionId },
        data: {
          status: "CANCELLED",
          stage: "CANCELLED_REVERSED",
          cancellationSource: "PROVIDER_RESPONSE",
          cancellationEvidenceRef: reversalId,
          cancellationEvidenceAt: cancelledAt,
          cancellationPayoutStatus: "canceled",
          cancelledAt,
          cancellationActorUserId: fixture.approverId,
          providerMetadata: {
            ...(claimed.providerMetadata as Record<string, unknown>),
            cancellation,
          },
          version: { increment: 1 },
        },
      })
      await tx.withdrawal.update({
        where: { id: fixture.withdrawalId },
        data: { status: "APPROVED", version: { increment: 1 } },
      })
    })

    const [withdrawal, execution] = await Promise.all([
      prisma.withdrawal.findUniqueOrThrow({
        where: { id: fixture.withdrawalId },
      }),
      prisma.payoutExecution.findUniqueOrThrow({
        where: { id: fixture.executionId },
      }),
    ])
    expect(withdrawal.status).toBe("APPROVED")
    expect(execution).toMatchObject({
      status: "CANCELLED",
      stage: "CANCELLED_REVERSED",
      cancellationSource: "PROVIDER_RESPONSE",
      cancellationEvidenceRef: reversalId,
    })
  }, 30_000)

  it("rejects typed cancellation timestamps outside the trusted command window", async () => {
    const fixture = await makePayoutFixture()
    const claimed = await prisma.payoutExecution.update({
      where: { id: fixture.executionId },
      data: { stage: "CANCEL_REQUESTED", version: { increment: 1 } },
    })
    const attemptCancellation = (timestamp: Date) => {
      const reversalId = `trr_${crypto.randomUUID()}`
      const cancellation = {
        source: "PROVIDER_RESPONSE",
        provider: "stripe_connect",
        providerExecutionId: claimed.providerExecutionId,
        providerTransferId: claimed.providerTransferId,
        providerPayoutId: claimed.providerPayoutId,
        reversalId,
        payoutStatus: "canceled",
        connectedAccountId: fixture.providerAccountExternalId,
        providerAmountMinor: fixture.amount * 100,
        providerCurrency: "USD",
        providerPublicReference: fixture.publicReference,
        livemode: false,
        evidenceAt: timestamp.toISOString(),
        cancelledAt: timestamp.toISOString(),
        actorUserId: fixture.approverId,
      }
      return prisma.payoutExecution.update({
        where: { id: fixture.executionId },
        data: {
          status: "CANCELLED",
          stage: "CANCELLED_REVERSED",
          cancellationSource: "PROVIDER_RESPONSE",
          cancellationEvidenceRef: reversalId,
          cancellationEvidenceAt: timestamp,
          cancellationPayoutStatus: "canceled",
          cancelledAt: timestamp,
          cancellationActorUserId: fixture.approverId,
          providerMetadata: {
            ...(claimed.providerMetadata as Record<string, unknown>),
            cancellation,
          },
          version: { increment: 1 },
        },
      })
    }

    await expectDatabaseRejection(
      attemptCancellation(
        new Date(claimed.createdAt.getTime() - 5 * 60_000 - 1_000),
      ),
      /cancellation timestamps fall outside the trusted command window/,
    )
    await expectDatabaseRejection(
      attemptCancellation(new Date(Date.now() + 5 * 60_000 + 5_000)),
      /cancellation timestamps fall outside the trusted command window/,
    )
    await expect(
      prisma.payoutExecution.findUniqueOrThrow({
        where: { id: fixture.executionId },
        select: { status: true, stage: true, cancellationSource: true },
      }),
    ).resolves.toEqual({
      status: "PROCESSING",
      stage: "CANCEL_REQUESTED",
      cancellationSource: null,
    })
  }, 30_000)

  it("lets a locked pre-provider abort beat an overlapping send claim before external I/O", async () => {
    const fixture = await makePayoutFixture({
      leaveExecutionAtCreated: true,
    })
    const created = await prisma.payoutExecution.findUniqueOrThrow({
      where: { id: fixture.executionId },
    })
    const createdMetadata = created.providerMetadata as {
      destinationSnapshot: Record<string, unknown>
      providerSnapshot: Record<string, unknown>
    }
    await prisma.payoutExecution.update({
      where: { id: fixture.executionId },
      data: {
        stage: "DESTINATION_VALIDATED",
        providerMetadata: {
          destinationSnapshot: {
            ...createdMetadata.destinationSnapshot,
            recipientFingerprint: "a".repeat(64),
          },
          providerSnapshot: createdMetadata.providerSnapshot,
        },
        version: { increment: 1 },
      },
    })
    let notifyAbortLocked!: () => void
    const abortLocked = new Promise<void>((resolve) => {
      notifyAbortLocked = resolve
    })
    let notifyClaimStarted!: () => void
    const claimStarted = new Promise<void>((resolve) => {
      notifyClaimStarted = resolve
    })
    const providerCall = jest.fn()

    const abort = prisma.$transaction(async (tx: any) => {
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "Withdrawal" WHERE "id" = $1 FOR UPDATE',
        fixture.withdrawalId,
      )
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "PayoutExecution" WHERE "id" = $1 FOR UPDATE',
        fixture.executionId,
      )
      notifyAbortLocked()
      await claimStarted
      const execution = await tx.payoutExecution.findUniqueOrThrow({
        where: { id: fixture.executionId },
      })
      const withdrawal = await tx.withdrawal.findUniqueOrThrow({
        where: { id: fixture.withdrawalId },
      })
      const cancelledAt = new Date()
      await tx.payoutExecution.update({
        where: { id: fixture.executionId },
        data: {
          status: "CANCELLED",
          stage: "PRE_PROVIDER_ABORTED",
          cancellationSource: "PRE_PROVIDER_ABORT",
          cancelledAt,
          cancellationActorUserId: fixture.approverId,
          version: { increment: 1 },
        },
      })
      await tx.withdrawal.update({
        where: { id: fixture.withdrawalId },
        data: { status: "APPROVED", version: withdrawal.version + 1 },
      })
      return execution.version
    })

    await abortLocked
    const claim = (async () => {
      notifyClaimStarted()
      let claimed = false
      try {
        claimed = await prisma.$transaction(async (tx: any) => {
          await tx.$queryRawUnsafe(
            'SELECT "id" FROM "Withdrawal" WHERE "id" = $1 FOR UPDATE',
            fixture.withdrawalId,
          )
          await tx.$queryRawUnsafe(
            'SELECT "id" FROM "PayoutExecution" WHERE "id" = $1 FOR UPDATE',
            fixture.executionId,
          )
          const execution = await tx.payoutExecution.findUniqueOrThrow({
            where: { id: fixture.executionId },
          })
          const claimedAt = new Date()
          const key = String(execution.idempotencyKey)
          await tx.$executeRawUnsafe(
            `INSERT INTO "PayoutExecutionClaim" (
               "id", "executionId", "kind", "idempotencyKey",
               "idempotencyKeyFingerprint", "claimedAt", "lastClaimedAt",
               "claimedByUserId"
             ) VALUES ($1, $2, 'PROVIDER_SEND', $3, $4, $5, $5, $6)`,
            crypto.randomUUID(),
            fixture.executionId,
            key,
            crypto
              .createHash("sha256")
              .update(JSON.stringify(key))
              .digest("hex"),
            claimedAt,
            fixture.initiatorId,
          )
          const updated = await tx.payoutExecution.updateMany({
            where: {
              id: fixture.executionId,
              status: "PROCESSING",
              stage: "DESTINATION_VALIDATED",
            },
            data: {
              stage: "PROVIDER_SEND_CLAIMED",
              version: { increment: 1 },
            },
          })
          return updated.count === 1
        })
      } catch {
        claimed = false
      }
      if (claimed) await providerCall()
      return claimed
    })()

    await abort
    await expect(claim).resolves.toBe(false)
    expect(providerCall).not.toHaveBeenCalled()
    const [execution, withdrawal] = await Promise.all([
      prisma.payoutExecution.findUniqueOrThrow({
        where: { id: fixture.executionId },
      }),
      prisma.withdrawal.findUniqueOrThrow({
        where: { id: fixture.withdrawalId },
      }),
    ])
    expect(execution).toMatchObject({
      status: "CANCELLED",
      stage: "PRE_PROVIDER_ABORTED",
      cancellationSource: "PRE_PROVIDER_ABORT",
    })
    expect(withdrawal.status).toBe("APPROVED")
  }, 30_000)

  it("lets a durable send claim beat an overlapping abort without releasing liability", async () => {
    const fixture = await makePayoutFixture({
      leaveExecutionAtCreated: true,
    })
    const created = await prisma.payoutExecution.findUniqueOrThrow({
      where: { id: fixture.executionId },
    })
    const metadata = created.providerMetadata as {
      destinationSnapshot: Record<string, unknown>
      providerSnapshot: Record<string, unknown>
    }
    await prisma.payoutExecution.update({
      where: { id: fixture.executionId },
      data: {
        stage: "DESTINATION_VALIDATED",
        providerMetadata: {
          destinationSnapshot: {
            ...metadata.destinationSnapshot,
            recipientFingerprint: "b".repeat(64),
          },
          providerSnapshot: metadata.providerSnapshot,
        },
        version: { increment: 1 },
      },
    })

    let notifyClaimLocked!: () => void
    const claimLocked = new Promise<void>((resolve) => {
      notifyClaimLocked = resolve
    })
    let notifyAbortStarted!: () => void
    const abortStarted = new Promise<void>((resolve) => {
      notifyAbortStarted = resolve
    })
    const providerCall = jest.fn().mockResolvedValue(undefined)

    const claim = prisma.$transaction(async (tx: any) => {
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "Withdrawal" WHERE "id" = $1 FOR UPDATE',
        fixture.withdrawalId,
      )
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "PayoutExecution" WHERE "id" = $1 FOR UPDATE',
        fixture.executionId,
      )
      notifyClaimLocked()
      await abortStarted
      const execution = await tx.payoutExecution.findUniqueOrThrow({
        where: { id: fixture.executionId },
      })
      const key = String(execution.idempotencyKey)
      const claimedAt = new Date()
      await tx.$executeRawUnsafe(
        `INSERT INTO "PayoutExecutionClaim" (
           "id", "executionId", "kind", "idempotencyKey",
           "idempotencyKeyFingerprint", "claimedAt", "lastClaimedAt",
           "claimedByUserId"
         ) VALUES ($1, $2, 'PROVIDER_SEND', $3, $4, $5, $5, $6)`,
        crypto.randomUUID(),
        fixture.executionId,
        key,
        crypto.createHash("sha256").update(JSON.stringify(key)).digest("hex"),
        claimedAt,
        fixture.initiatorId,
      )
      await tx.payoutExecution.update({
        where: { id: fixture.executionId },
        data: {
          stage: "PROVIDER_SEND_CLAIMED",
          version: { increment: 1 },
        },
      })
    })

    await claimLocked
    const abort = (async () => {
      notifyAbortStarted()
      return prisma.$transaction(async (tx: any) => {
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "Withdrawal" WHERE "id" = $1 FOR UPDATE',
          fixture.withdrawalId,
        )
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "PayoutExecution" WHERE "id" = $1 FOR UPDATE',
          fixture.executionId,
        )
        const durableClaims = (await tx.$queryRawUnsafe(
          `SELECT COUNT(*)::INTEGER AS count
           FROM "PayoutExecutionClaim"
           WHERE "executionId" = $1`,
          fixture.executionId,
        )) as Array<{ count: number }>
        const aborted = await tx.payoutExecution.updateMany({
          where: {
            id: fixture.executionId,
            status: "PROCESSING",
            stage: { in: ["CREATED", "DESTINATION_VALIDATED"] },
          },
          data: {
            status: "CANCELLED",
            stage: "PRE_PROVIDER_ABORTED",
            cancellationSource: "PRE_PROVIDER_ABORT",
            cancelledAt: new Date(),
            cancellationActorUserId: fixture.checkerId,
            version: { increment: 1 },
          },
        })
        return {
          changed: aborted.count === 1,
          durableClaimCount: durableClaims[0]?.count ?? 0,
        }
      })
    })()

    await claim
    await providerCall()
    await expect(abort).resolves.toEqual({
      changed: false,
      durableClaimCount: 1,
    })
    expect(providerCall).toHaveBeenCalledTimes(1)
    await expect(
      prisma.withdrawal.findUniqueOrThrow({
        where: { id: fixture.withdrawalId },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "PROCESSING" })
  }, 30_000)

  it("rejects unsupported FAILED-to-REVERSED liability restoration", async () => {
    const fixture = await makePayoutFixture()
    await prisma.$transaction(async (tx: any) => {
      await tx.payoutExecution.update({
        where: { id: fixture.executionId },
        data: {
          status: "FAILED",
          stage: "BANK_PAYOUT_RECOVERY_REQUIRED",
          version: { increment: 1 },
        },
      })
      await tx.withdrawal.update({
        where: { id: fixture.withdrawalId },
        data: { status: "FAILED", version: { increment: 1 } },
      })
    })

    await expectDatabaseRejection(
      prisma.withdrawal.update({
        where: { id: fixture.withdrawalId },
        data: {
          status: "REVERSED",
          reversedBy: fixture.approverId,
          reversedAt: new Date(),
          version: { increment: 1 },
        },
      }),
      /Withdrawal reversal requires typed provider cancellation or reversal evidence/,
    )
    const [withdrawal, balance] = await Promise.all([
      prisma.withdrawal.findUniqueOrThrow({
        where: { id: fixture.withdrawalId },
      }),
      prisma.publisherBalance.findUniqueOrThrow({
        where: { id: fixture.balanceId },
      }),
    ])
    expect(withdrawal.status).toBe("FAILED")
    expect(balance.withdrawableBalance.toString()).toBe("0")
    expect(balance.lifetimePaid.toString()).toBe("0")
  }, 30_000)

  it("rejects a stale FAILED-to-APPROVED retry without typed cancellation", async () => {
    const fixture = await makePayoutFixture()
    await prisma.$transaction(async (tx: any) => {
      await tx.payoutExecution.update({
        where: { id: fixture.executionId },
        data: {
          status: "FAILED",
          stage: "BANK_PAYOUT_RECOVERY_REQUIRED",
          version: { increment: 1 },
        },
      })
      await tx.withdrawal.update({
        where: { id: fixture.withdrawalId },
        data: { status: "FAILED", version: { increment: 1 } },
      })
    })

    await expectDatabaseRejection(
      prisma.withdrawal.update({
        where: { id: fixture.withdrawalId },
        data: { status: "APPROVED", version: { increment: 1 } },
      }),
      /Withdrawal reopen requires the latest payout execution to have typed cancellation evidence/,
    )
    await expect(
      prisma.withdrawal.findUniqueOrThrow({
        where: { id: fixture.withdrawalId },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "FAILED" })
  }, 30_000)

  it("makes allocation evidence immutable and release-only after rejection", async () => {
    const fixture = await makePayoutFixture()
    const originalWithdrawal = await prisma.withdrawal.findUniqueOrThrow({
      where: { id: fixture.withdrawalId },
    })
    const suffix = crypto.randomUUID()
    const { withdrawal, allocation } = await prisma.$transaction(
      async (tx: any) => {
        const createdWithdrawal = await tx.withdrawal.create({
          data: {
            publisherId: fixture.publisherId,
            amount: 25,
            currency: "USD",
            publicReference: `WD-ALLOCATION-${suffix}`,
            netAmount: 25,
            feePolicyVersion: "integration-v1",
            method: originalWithdrawal.method,
            status: "PENDING",
            idempotencyKey: `allocation-${suffix}`,
            payoutMethodId: originalWithdrawal.payoutMethodId,
            requestedBy: fixture.requesterId,
            availableAt: new Date(),
          },
        })
        const createdAllocation = await tx.withdrawalAllocation.create({
          data: {
            withdrawalId: createdWithdrawal.id,
            sourceType: "CARRY_FORWARD",
            amount: 25,
            currency: "USD",
            sequence: 0,
          },
        })
        return {
          withdrawal: createdWithdrawal,
          allocation: createdAllocation,
        }
      },
    )

    await expectDatabaseRejection(
      prisma.withdrawalAllocation.update({
        where: { id: allocation.id },
        data: { amount: 26 },
      }),
      /Withdrawal allocation source and amount evidence is immutable/,
    )
    await expectDatabaseRejection(
      prisma.withdrawalAllocation.delete({ where: { id: allocation.id } }),
      /Withdrawal allocations are financial evidence and cannot be deleted/,
    )
    await expectDatabaseRejection(
      prisma.withdrawalAllocation.update({
        where: { id: allocation.id },
        data: { releasedAt: new Date() },
      }),
      /Withdrawal allocation release requires a rejected parent withdrawal/,
    )
    await expectDatabaseRejection(
      prisma.withdrawal.update({
        where: { id: withdrawal.id },
        data: {
          status: "REJECTED",
          rejectedBy: fixture.approverId,
          rejectedAt: new Date(),
          version: { increment: 1 },
        },
      }),
      /Rejected withdrawals require every reserved allocation to be released/,
    )

    const releasedAt = new Date()
    await prisma.$transaction(async (tx: any) => {
      await tx.withdrawal.update({
        where: { id: withdrawal.id },
        data: {
          status: "REJECTED",
          rejectedBy: fixture.approverId,
          rejectedAt: new Date(),
          version: { increment: 1 },
        },
      })
      await tx.withdrawalAllocation.update({
        where: { id: allocation.id },
        data: { releasedAt },
      })
    })
    await expectDatabaseRejection(
      prisma.withdrawalAllocation.update({
        where: { id: allocation.id },
        data: { releasedAt: new Date(releasedAt.getTime() + 1_000) },
      }),
      /Withdrawal allocation release evidence is append-only/,
    )
    const persisted = await prisma.withdrawalAllocation.findUniqueOrThrow({
      where: { id: allocation.id },
    })
    expect(persisted.amount.toString()).toBe("25")
    expect(persisted.releasedAt?.getTime()).toBe(releasedAt.getTime())
  }, 30_000)

  it("enforces current Finance eligibility and manual maker-checker in application and database", async () => {
    const fixture = await makePayoutFixture({ providerName: "manual" })
    const evidenceAt = new Date(Date.now() - 5_000)
    const baseInput = {
      executionId: fixture.executionId,
      withdrawalId: fixture.withdrawalId,
      withdrawalPublicReference: fixture.publicReference,
      providerName: "manual",
      providerReference: `receipt-${crypto.randomUUID()}`,
      source: "MANUAL_BANK_CONFIRMATION" as const,
      evidenceAt,
      reason: "Bank operations verified the settled transfer receipt.",
    }

    await expect(
      finalizePayoutExecution(prisma, {
        ...baseInput,
        actorUserId: fixture.requesterId,
      }),
    ).resolves.toMatchObject({
      kind: "conflict",
      code: "MANUAL_ACTOR_UNAUTHORIZED",
      applied: false,
    })
    await expect(
      finalizePayoutExecution(prisma, {
        ...baseInput,
        actorUserId: fixture.initiatorId,
      }),
    ).resolves.toMatchObject({
      kind: "conflict",
      code: "MAKER_CHECKER_VIOLATION",
      applied: false,
    })

    const dbReference = `RECEIPT-DB-${crypto.randomUUID()}`
    const completedAt = new Date()
    await expectDatabaseRejection(
      prisma.$executeRawUnsafe(
        `UPDATE "PayoutExecution"
         SET
           "status" = 'COMPLETED',
           "stage" = 'MANUAL_CONFIRMED',
           "completionSource" = 'MANUAL_BANK_CONFIRMATION',
           "completionEvidenceRef" = $1::text,
           "completionEvidenceAt" = $2::timestamptz,
           "completedAt" = $3::timestamptz,
           "completionActorUserId" = $4::text,
           "acceptedReference" = $1::text,
           "bankTraceReference" = $1::text,
           "providerMetadata" = "providerMetadata" ||
             jsonb_build_object(
               'completion',
               jsonb_build_object(
                 'source', 'MANUAL_BANK_CONFIRMATION',
                 'evidenceReference', $1::text,
                 'actorUserId', $4::text,
                 'reason', 'Bank operations verified the settled transfer receipt.',
                 'evidenceAt', to_jsonb($2::timestamptz),
                 'completedAt', to_jsonb($3::timestamptz)
               )
             ),
           "version" = "version" + 1
         WHERE "id" = $5`,
        dbReference,
        evidenceAt,
        completedAt,
        fixture.initiatorId,
        fixture.executionId,
      ),
      /Manual payout completion requires known requester, approver, and initiator provenance, with the checker distinct from each/,
    )
    const balance = await prisma.publisherBalance.findUniqueOrThrow({
      where: { id: fixture.balanceId },
      select: { lifetimePaid: true },
    })
    expect(balance.lifetimePaid.toString()).toBe("0")
  }, 30_000)

  it("rejects manual completion timestamps outside the trusted command window at the database boundary", async () => {
    const fixture = await makePayoutFixture({ providerName: "manual" })
    const execution = await prisma.payoutExecution.findUniqueOrThrow({
      where: { id: fixture.executionId },
      select: { createdAt: true },
    })

    await expectDatabaseRejection(
      directManualCompletion(
        fixture,
        new Date(execution.createdAt.getTime() - 5 * 60_000 - 1_000),
        new Date(),
      ),
      /Manual payout completion requires the sent manual bank route and matching bank evidence/,
    )
    await expectDatabaseRejection(
      directManualCompletion(
        fixture,
        new Date(),
        new Date(Date.now() + 5 * 60_000 + 5_000),
      ),
      /Manual payout completion requires the sent manual bank route and matching bank evidence/,
    )
    await expect(
      prisma.payoutExecution.findUniqueOrThrow({
        where: { id: fixture.executionId },
        select: { status: true, completionSource: true },
      }),
    ).resolves.toEqual({ status: "PROCESSING", completionSource: null })
  }, 30_000)

  it("blocks legacy manual completion when requester provenance is missing", async () => {
    const fixture = await makePayoutFixture({ providerName: "manual" })
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Withdrawal" DISABLE TRIGGER "Withdrawal_financial_provenance_guard"',
    )
    try {
      await prisma.$executeRawUnsafe(
        'UPDATE "Withdrawal" SET "requestedBy" = NULL WHERE "id" = $1',
        fixture.withdrawalId,
      )
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "Withdrawal" ENABLE TRIGGER "Withdrawal_financial_provenance_guard"',
      )
    }

    const evidenceAt = new Date(Date.now() - 5_000)
    const providerReference = `receipt-${crypto.randomUUID()}`
    await expect(
      finalizePayoutExecution(prisma, {
        executionId: fixture.executionId,
        withdrawalId: fixture.withdrawalId,
        withdrawalPublicReference: fixture.publicReference,
        providerName: "manual",
        providerReference,
        source: "MANUAL_BANK_CONFIRMATION",
        evidenceAt,
        actorUserId: fixture.checkerId,
        reason: "Bank operations verified the settled transfer receipt.",
      }),
    ).resolves.toMatchObject({
      kind: "conflict",
      code: "MAKER_CHECKER_VIOLATION",
      applied: false,
    })

    const dbReference = `RECEIPT-DB-${crypto.randomUUID()}`
    const completedAt = new Date()
    await expectDatabaseRejection(
      prisma.$executeRawUnsafe(
        `UPDATE "PayoutExecution"
         SET
           "status" = 'COMPLETED',
           "stage" = 'MANUAL_CONFIRMED',
           "completionSource" = 'MANUAL_BANK_CONFIRMATION',
           "completionEvidenceRef" = $1::text,
           "completionEvidenceAt" = $2::timestamptz,
           "completedAt" = $3::timestamptz,
           "completionActorUserId" = $4::text,
           "acceptedReference" = $1::text,
           "bankTraceReference" = $1::text,
           "providerMetadata" = "providerMetadata" ||
             jsonb_build_object(
               'completion',
               jsonb_build_object(
                 'source', 'MANUAL_BANK_CONFIRMATION',
                 'evidenceReference', $1::text,
                 'actorUserId', $4::text,
                 'reason', 'Bank operations verified the settled transfer receipt.',
                 'evidenceAt', to_jsonb($2::timestamptz),
                 'completedAt', to_jsonb($3::timestamptz)
               )
             )
         WHERE "id" = $5`,
        dbReference,
        evidenceAt,
        completedAt,
        fixture.checkerId,
        fixture.executionId,
      ),
      /Manual payout completion requires known requester, approver, and initiator provenance, with the checker distinct from each/,
    )
    const balance = await prisma.publisherBalance.findUniqueOrThrow({
      where: { id: fixture.balanceId },
      select: { lifetimePaid: true },
    })
    expect(balance.lifetimePaid.toString()).toBe("0")
  }, 30_000)

  it("validates ISO completion evidence independently of the database session timezone", async () => {
    const fixture = await makePayoutFixture({ providerName: "manual" })
    const evidenceAt = new Date(Date.now() - 5_000)
    const completedAt = new Date()
    const dbReference = `RECEIPT-TZ-${crypto.randomUUID()}`
    let completionGuardAccepted = false

    await expect(
      prisma.$transaction(async (tx: any) => {
        await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Asia/Dhaka'")
        const updated = await tx.$executeRawUnsafe(
          `UPDATE "PayoutExecution"
           SET
             "status" = 'COMPLETED',
             "stage" = 'MANUAL_CONFIRMED',
             "completionSource" = 'MANUAL_BANK_CONFIRMATION',
             "completionEvidenceRef" = $1::text,
             "completionEvidenceAt" =
               ($2::timestamptz AT TIME ZONE 'UTC'),
             "completedAt" = ($3::timestamptz AT TIME ZONE 'UTC'),
             "completionActorUserId" = $4::text,
             "acceptedReference" = $1::text,
             "bankTraceReference" = $1::text,
             "providerMetadata" = "providerMetadata" ||
               jsonb_build_object(
                 'completion',
                 jsonb_build_object(
                   'source', 'MANUAL_BANK_CONFIRMATION',
                   'evidenceReference', $1::text,
                   'actorUserId', $4::text,
                   'reason', 'Bank operations verified the settled transfer receipt.',
                   'evidenceAt', to_jsonb($2::timestamptz),
                   'completedAt', to_jsonb($3::timestamptz)
                 )
               ),
             "version" = "version" + 1
          WHERE "id" = $5`,
          dbReference,
          evidenceAt.toISOString(),
          completedAt.toISOString(),
          fixture.checkerId,
          fixture.executionId,
        )
        completionGuardAccepted = updated === 1
        throw new Error("ROLLBACK_NON_UTC_COMPLETION_TEST")
      }),
    ).rejects.toThrow("ROLLBACK_NON_UTC_COMPLETION_TEST")
    expect(completionGuardAccepted).toBe(true)

    const [execution, balance] = await Promise.all([
      prisma.payoutExecution.findUniqueOrThrow({
        where: { id: fixture.executionId },
        select: { status: true },
      }),
      prisma.publisherBalance.findUniqueOrThrow({
        where: { id: fixture.balanceId },
        select: { lifetimePaid: true },
      }),
    ])
    expect(execution.status).toBe("PROCESSING")
    expect(balance.lifetimePaid.toString()).toBe("0")
  }, 30_000)

  it("rejects a manual completion from a banned Finance checker", async () => {
    const fixture = await makePayoutFixture({ providerName: "manual" })
    await prisma.user.update({
      where: { id: fixture.checkerId },
      data: { banned: true },
    })

    await expect(
      finalizePayoutExecution(prisma, {
        executionId: fixture.executionId,
        withdrawalId: fixture.withdrawalId,
        withdrawalPublicReference: fixture.publicReference,
        providerName: "manual",
        providerReference: `receipt-${crypto.randomUUID()}`,
        source: "MANUAL_BANK_CONFIRMATION",
        evidenceAt: new Date(Date.now() - 5_000),
        actorUserId: fixture.checkerId,
        reason: "Bank operations verified the settled transfer receipt.",
      }),
    ).resolves.toMatchObject({
      kind: "conflict",
      code: "MANUAL_ACTOR_UNAUTHORIZED",
      applied: false,
    })
  }, 30_000)

  it("rejects a stale direct nonterminal-to-COMPLETED withdrawal writer", async () => {
    const fixture = await makePayoutFixture()

    await expectDatabaseRejection(
      prisma.$executeRawUnsafe(
        `UPDATE "Withdrawal"
         SET "status" = $1, "version" = "version" + 1
         WHERE "id" = $2`,
        "COMPLETED",
        fixture.withdrawalId,
      ),
      /Withdrawal completion requires exactly one completed payout execution/,
    )

    const [withdrawal, execution, balance] = await Promise.all([
      prisma.withdrawal.findUniqueOrThrow({
        where: { id: fixture.withdrawalId },
        select: { status: true },
      }),
      prisma.payoutExecution.findUniqueOrThrow({
        where: { id: fixture.executionId },
        select: { status: true, completionSource: true },
      }),
      prisma.publisherBalance.findUniqueOrThrow({
        where: { id: fixture.balanceId },
        select: { lifetimePaid: true },
      }),
    ])
    expect(withdrawal.status).toBe("PROCESSING")
    expect(execution).toEqual({
      status: "PROCESSING",
      completionSource: null,
    })
    expect(balance.lifetimePaid.toString()).toBe("0")
  }, 30_000)

  it("makes verified payout webhook evidence immutable and terminal lifecycle one-way", async () => {
    const suffix = crypto.randomUUID()
    const event = await prisma.payoutWebhookEvent.create({
      data: {
        provider: "stripe_connect",
        dedupKey: crypto.createHash("sha256").update(suffix).digest("hex"),
        eventType: "payout.failed",
        providerExecutionId: `po_evidence_${suffix}`,
        providerAccountExternalId: `acct_evidence_${suffix}`,
        livemode: false,
        payoutAmountMinor: 10_000n,
        payoutCurrency: "USD",
        providerStatus: "FAILED",
        rawStatus: "failed",
      },
    })
    await prisma.payoutWebhookEvent.update({
      where: { id: event.id },
      data: {
        status: "PROCESSING",
        attempts: { increment: 1 },
        lockedAt: new Date(),
      },
    })
    await prisma.payoutWebhookEvent.update({
      where: { id: event.id },
      data: {
        status: "PROCESSED",
        lockedAt: null,
        processedAt: new Date(),
      },
    })

    await expectDatabaseRejection(
      prisma.$executeRawUnsafe(
        'UPDATE "PayoutWebhookEvent" SET "providerStatus" = $1 WHERE "id" = $2',
        "COMPLETED",
        event.id,
      ),
      /Payout webhook normalized evidence is immutable/,
    )
    await expectDatabaseRejection(
      prisma.$executeRawUnsafe(
        `UPDATE "PayoutWebhookEvent"
         SET "status" = 'PROCESSING', "lockedAt" = NOW(), "processedAt" = NULL
         WHERE "id" = $1`,
        event.id,
      ),
      /Invalid payout webhook inbox lifecycle transition/,
    )
    await expectDatabaseRejection(
      prisma.$executeRawUnsafe(
        'DELETE FROM "PayoutWebhookEvent" WHERE "id" = $1',
        event.id,
      ),
      /Payout webhook events are financial evidence and cannot be deleted/,
    )

    await expect(
      prisma.payoutWebhookEvent.findUniqueOrThrow({
        where: { id: event.id },
        select: {
          eventType: true,
          providerStatus: true,
          status: true,
          attempts: true,
        },
      }),
    ).resolves.toEqual({
      eventType: "payout.failed",
      providerStatus: "FAILED",
      status: "PROCESSED",
      attempts: 1,
    })
  }, 30_000)

  it("rejects an unlinked processed success webhook at deferred commit", async () => {
    const suffix = crypto.randomUUID()
    const event = await prisma.payoutWebhookEvent.create({
      data: {
        provider: "stripe_connect",
        dedupKey: crypto.createHash("sha256").update(suffix).digest("hex"),
        eventType: "payout.paid",
        providerExecutionId: `po_unmatched_${suffix}`,
        providerAccountExternalId: `acct_unmatched_${suffix}`,
        livemode: false,
        payoutAmountMinor: 10_000n,
        payoutCurrency: "USD",
        providerStatus: "COMPLETED",
        rawStatus: "paid",
      },
    })
    await prisma.payoutWebhookEvent.update({
      where: { id: event.id },
      data: {
        status: "PROCESSING",
        attempts: { increment: 1 },
        lockedAt: new Date(),
      },
    })

    await expectDatabaseRejection(
      prisma.payoutWebhookEvent.update({
        where: { id: event.id },
        data: {
          status: "PROCESSED",
          lockedAt: null,
          processedAt: new Date(),
        },
      }),
      /cannot be processed without its completed execution/,
    )
    await expect(
      prisma.payoutWebhookEvent.findUniqueOrThrow({
        where: { id: event.id },
        select: { status: true, processedAt: true },
      }),
    ).resolves.toEqual({ status: "PROCESSING", processedAt: null })
  }, 30_000)

  it("rejects runtime insertion of a synthetic LEGACY_UNVERIFIED completion", async () => {
    const fixture = await makePayoutFixture({ executionStatus: "FAILED" })
    const suffix = crypto.randomUUID()

    await expectDatabaseRejection(
      prisma.$executeRawUnsafe(
        `INSERT INTO "PayoutExecution" (
          "id",
          "withdrawalId",
          "providerId",
          "status",
          "providerExecutionId",
          "amount",
          "sourceCurrency",
          "destinationCurrency",
          "destinationAmount",
          "stage",
          "completionSource",
          "completedAt",
          "version",
          "createdAt",
          "updatedAt"
        ) VALUES ($1, $2, $3, 'COMPLETED', $4, $5, 'USD', 'USD', $5,
          'BANK_PAID', 'LEGACY_UNVERIFIED', NOW(), 0, NOW(), NOW())`,
        `runtime-legacy-${suffix}`,
        fixture.withdrawalId,
        fixture.providerId,
        `po_runtime_legacy_${suffix}`,
        fixture.amount,
      ),
      /Payout executions cannot be inserted in a terminal state/,
    )
    await expect(
      prisma.payoutExecution.count({
        where: {
          withdrawalId: fixture.withdrawalId,
          status: "COMPLETED",
        },
      }),
    ).resolves.toBe(0)
    const balance = await prisma.publisherBalance.findUniqueOrThrow({
      where: { id: fixture.balanceId },
    })
    expect(balance.lifetimePaid.toString()).toBe("0")
  }, 30_000)

  it("rejects new Wise execution authority and new claims while preserving historical rows", async () => {
    const suffix = crypto.randomUUID()
    const amount = 40
    const organization = await makeOrganization(prisma)
    const publisher = await makePublisher(prisma, {
      organizationId: organization.id,
    })
    const requester = await makeUser(prisma, { userType: "PUBLISHER" })
    const approver = await makeUser(prisma, { userType: "STAFF" })
    const initiator = await makeUser(prisma, { userType: "STAFF" })
    await Promise.all(
      [approver, initiator].map((staff) =>
        prisma.staffMembership.create({
          data: { userId: staff.id, role: "FINANCE" },
        }),
      ),
    )
    await prisma.publisherMembership.create({
      data: {
        publisherId: publisher.id,
        userId: requester.id,
        role: "PUBLISHER_OWNER",
      },
    })
    await prisma.publisherBalance.create({
      data: {
        publisherId: publisher.id,
        withdrawableBalance: 0,
        lifetimeEarnings: amount,
        allocationCutoverAt: new Date(),
        allocationCarryForward: amount,
        allocationCarryForwardUsed: amount,
      },
    })
    const provider = await prisma.payoutProvider.upsert({
      where: { name: "wise" },
      create: {
        name: "wise",
        displayName: "Wise",
        config: {},
        isActive: true,
      },
      update: { isActive: true },
    })
    const method = await prisma.payoutMethod.create({
      data: {
        publisherId: publisher.id,
        type: "wise",
        label: `Historical Wise ${suffix}`,
        details: { ciphertext: `wise-${suffix}` },
        encryptionKeyVersion: 1,
        isActive: true,
      },
    })
    const publicReference = `WD-WISE-${suffix}`
    const withdrawal = await prisma.$transaction(async (tx: any) => {
      const created = await tx.withdrawal.create({
        data: {
          publisherId: publisher.id,
          amount,
          netAmount: amount,
          currency: "USD",
          publicReference,
          feePolicyVersion: "integration-v1",
          method: "wise",
          status: "PENDING",
          idempotencyKey: `wise-${suffix}`,
          payoutMethodId: method.id,
          requestedBy: requester.id,
          availableAt: new Date(Date.now() - 60_000),
        },
      })
      await tx.withdrawalAllocation.create({
        data: {
          withdrawalId: created.id,
          sourceType: "CARRY_FORWARD",
          amount,
          currency: "USD",
          sequence: 0,
        },
      })
      return created
    })
    const approved = await prisma.withdrawal.update({
      where: { id: withdrawal.id },
      data: {
        status: "APPROVED",
        approvedBy: approver.id,
        approvedAt: new Date(),
        version: { increment: 1 },
      },
    })
    const nullFingerprint = crypto
      .createHash("sha256")
      .update("null")
      .digest("hex")
    const providerMetadata = {
      destinationSnapshot: {
        payoutMethodId: method.id,
        payoutMethodVersion: method.version,
        encryptionKeyVersion: method.encryptionKeyVersion,
        encryptedDetailsFingerprint: "a".repeat(64),
        providerAccountRowId: null,
        providerAccountExternalId: null,
        providerAccountProvider: null,
        providerAccountFingerprint: nullFingerprint,
        destinationCurrency: "USD",
        recipientFingerprint: null,
      },
      providerSnapshot: {
        providerId: provider.id,
        providerName: "wise",
        providerVersion: provider.version,
        configEncryptionKeyVersion: provider.configEncryptionKeyVersion,
        configFingerprint: "b".repeat(64),
      },
    }
    const executionData = {
      withdrawalId: withdrawal.id,
      providerId: provider.id,
      status: "PROCESSING" as const,
      amount,
      fee: 0,
      sourceCurrency: "USD",
      destinationCurrency: "USD",
      destinationAmount: amount,
      requestedReference: publicReference,
      stage: "CREATED",
      idempotencyKey: `payout-${withdrawal.id}-v${approved.version + 1}`,
      initiatedByUserId: initiator.id,
      providerMetadata,
    }

    await expectDatabaseRejection(
      prisma.$transaction(async (tx: any) => {
        await tx.withdrawal.update({
          where: { id: withdrawal.id },
          data: { status: "PROCESSING", version: { increment: 1 } },
        })
        return tx.payoutExecution.create({ data: executionData })
      }),
      /New Wise payout executions are not certified/,
    )
    await expect(
      prisma.withdrawal.findUniqueOrThrow({
        where: { id: withdrawal.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "APPROVED" })

    await prisma.$executeRawUnsafe(
      'ALTER TABLE "PayoutExecution" DISABLE TRIGGER "PayoutExecution_identity_guard"',
    )
    let historicalExecution: any
    try {
      historicalExecution = await prisma.$transaction(async (tx: any) => {
        await tx.withdrawal.update({
          where: { id: withdrawal.id },
          data: { status: "PROCESSING", version: { increment: 1 } },
        })
        return tx.payoutExecution.create({
          data: {
            ...executionData,
            stage: "DESTINATION_VALIDATED",
            providerMetadata: {
              ...providerMetadata,
              destinationSnapshot: {
                ...providerMetadata.destinationSnapshot,
                recipientFingerprint: "c".repeat(64),
              },
            },
          },
        })
      })
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "PayoutExecution" ENABLE TRIGGER "PayoutExecution_identity_guard"',
      )
    }

    await expectDatabaseRejection(
      prisma.payoutExecutionClaim.create({
        data: {
          executionId: historicalExecution.id,
          kind: "PROVIDER_SEND",
          idempotencyKey: historicalExecution.idempotencyKey,
          idempotencyKeyFingerprint: "d".repeat(64),
          claimedByUserId: initiator.id,
          claimedAt: new Date(),
          lastClaimedAt: new Date(),
        },
      }),
      /New payout execution claims require a certified provider/,
    )
    await expect(
      prisma.payoutExecutionClaim.count({
        where: { executionId: historicalExecution.id },
      }),
    ).resolves.toBe(0)
    await expect(
      prisma.payoutExecution.findUniqueOrThrow({
        where: { id: historicalExecution.id },
        select: { stage: true, providerExecutionId: true },
      }),
    ).resolves.toEqual({
      stage: "DESTINATION_VALIDATED",
      providerExecutionId: null,
    })
  }, 30_000)

  it("keeps managed routing identities immutable and reactivation readiness-gated", async () => {
    const fixture = await makeReadyReservationFixture(25)
    const { service } = makePublisherPayoutsService()

    await expect(
      service.deactivatePayoutMethod(
        fixture.publisherId,
        fixture.requesterId,
        fixture.methodId,
      ),
    ).resolves.toEqual({
      id: fixture.methodId,
      isActive: false,
      replayed: false,
    })
    await prisma.publisherProviderAccount.update({
      where: { id: fixture.accountId },
      data: { status: "RESTRICTED" },
    })

    await expect(
      service.reactivatePayoutMethod(
        fixture.publisherId,
        fixture.requesterId,
        fixture.methodId,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "PAYOUT_METHOD_PROVIDER_NOT_READY",
      }),
    })
    await expectDatabaseRejection(
      prisma.payoutMethod.update({
        where: { id: fixture.methodId },
        data: { isActive: true, version: { increment: 1 } },
      }),
      /Managed Stripe payout method requires a fully ready provider account/,
    )
    await expectDatabaseRejection(
      prisma.payoutMethod.update({
        where: { id: fixture.methodId },
        data: { type: "wise", version: { increment: 1 } },
      }),
      /Payout method routing identity is immutable/,
    )
    await expectDatabaseRejection(
      prisma.publisherProviderAccount.update({
        where: { id: fixture.accountId },
        data: {
          providerAccountId: `acct_rebound_${crypto.randomUUID()}`,
        },
      }),
      /Publisher provider account routing identity is immutable/,
    )
    await expectDatabaseRejection(
      prisma.publisherProviderAccount.delete({
        where: { id: fixture.accountId },
      }),
      /Publisher provider accounts are routing evidence and cannot be deleted/,
    )

    await prisma.publisherProviderAccount.update({
      where: { id: fixture.accountId },
      data: { status: "ENABLED" },
    })
    await expect(
      service.reactivatePayoutMethod(
        fixture.publisherId,
        fixture.requesterId,
        fixture.methodId,
      ),
    ).resolves.toEqual({
      id: fixture.methodId,
      isActive: true,
      replayed: false,
    })
    await expect(
      prisma.auditLog.count({
        where: {
          action: "PAYOUT_METHOD_REACTIVATED",
          entityId: fixture.methodId,
          userId: fixture.requesterId,
        },
      }),
    ).resolves.toBe(1)

    await prisma.publisherProviderAccount.update({
      where: { id: fixture.accountId },
      data: { status: "RESTRICTED" },
    })
    const idempotencyKey = `not-ready-${crypto.randomUUID()}`
    await expect(
      service.requestWithdrawal(
        fixture.publisherId,
        25,
        "stripe_connect",
        fixture.requesterId,
        idempotencyKey,
        fixture.methodId,
      ),
    ).rejects.toThrow(/not fully enabled or manually scheduled/i)
    await expect(
      prisma.withdrawal.count({
        where: { publisherId: fixture.publisherId, idempotencyKey },
      }),
    ).resolves.toBe(0)
    await expect(
      prisma.publisherBalance.findUniqueOrThrow({
        where: { id: fixture.balanceId },
        select: { withdrawableBalance: true },
      }),
    ).resolves.toMatchObject({ withdrawableBalance: expect.anything() })
    const balance = await prisma.publisherBalance.findUniqueOrThrow({
      where: { id: fixture.balanceId },
    })
    expect(balance.withdrawableBalance.toString()).toBe("25")
  }, 30_000)

  it("rejects activation of a historically inactive method that still has reserved liability", async () => {
    const fixture = await makePayoutFixture({ leaveExecutionAtCreated: true })

    await prisma.$executeRawUnsafe(
      'ALTER TABLE "PayoutMethod" DISABLE TRIGGER "PayoutMethod_liability_state_guard"',
    )
    try {
      await prisma.payoutMethod.update({
        where: { id: fixture.payoutMethodId },
        data: {
          isActive: false,
          isDefault: false,
          version: { increment: 1 },
        },
      })
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "PayoutMethod" ENABLE TRIGGER "PayoutMethod_liability_state_guard"',
      )
    }

    await expectDatabaseRejection(
      prisma.payoutMethod.update({
        where: { id: fixture.payoutMethodId },
        data: { isActive: true, version: { increment: 1 } },
      }),
      /Payout method with reserved withdrawal liability cannot be activated/,
    )
    await expect(
      prisma.payoutMethod.findUniqueOrThrow({
        where: { id: fixture.payoutMethodId },
        select: { isActive: true, nonterminalWithdrawalCount: true },
      }),
    ).resolves.toEqual({
      isActive: false,
      nonterminalWithdrawalCount: 1,
    })
  }, 30_000)

  it("blocks payout-method deactivation for PROCESSING and APPROVED liability but atomically deactivates an unused method", async () => {
    const fixture = await makePayoutFixture({ leaveExecutionAtCreated: true })
    const { service } = makePublisherPayoutsService()

    await expect(
      service.deactivatePayoutMethod(
        fixture.publisherId,
        fixture.requesterId,
        fixture.payoutMethodId,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "PAYOUT_METHOD_HAS_RESERVED_WITHDRAWALS",
      }),
    })
    await expect(
      prisma.payoutMethod.findUniqueOrThrow({
        where: { id: fixture.payoutMethodId },
        select: { isActive: true, nonterminalWithdrawalCount: true },
      }),
    ).resolves.toEqual({
      isActive: true,
      nonterminalWithdrawalCount: 1,
    })

    await moveToClaimFreeApproved(fixture)
    await expect(
      service.deactivatePayoutMethod(
        fixture.publisherId,
        fixture.requesterId,
        fixture.payoutMethodId,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "PAYOUT_METHOD_HAS_RESERVED_WITHDRAWALS",
      }),
    })

    const unused = await prisma.payoutMethod.create({
      data: {
        publisherId: fixture.publisherId,
        type: "bank_transfer",
        label: "Unused audited method",
        details: { ciphertext: `unused-${crypto.randomUUID()}` },
        encryptionKeyVersion: 1,
      },
    })
    await expect(
      service.deactivatePayoutMethod(
        fixture.publisherId,
        fixture.requesterId,
        unused.id,
      ),
    ).resolves.toEqual({
      id: unused.id,
      isActive: false,
      replayed: false,
    })
    await expect(
      prisma.payoutMethod.findUniqueOrThrow({
        where: { id: unused.id },
        select: {
          isActive: true,
          isDefault: true,
          nonterminalWithdrawalCount: true,
          version: true,
        },
      }),
    ).resolves.toEqual({
      isActive: false,
      isDefault: false,
      nonterminalWithdrawalCount: 0,
      version: unused.version + 1,
    })
    await expect(
      prisma.auditLog.count({
        where: {
          action: "PAYOUT_METHOD_DEACTIVATED",
          entityType: "PayoutMethod",
          entityId: unused.id,
          userId: fixture.requesterId,
        },
      }),
    ).resolves.toBe(1)
  }, 30_000)

  it("serializes payout-method deactivation against a new withdrawal reservation with no ghost liability", async () => {
    const fixture = await makeReadyReservationFixture(25)
    const { service } = makePublisherPayoutsService()
    const idempotencyKey = `method-deactivation-race-${crypto.randomUUID()}`

    const [deactivation, reservation] = await Promise.allSettled([
      service.deactivatePayoutMethod(
        fixture.publisherId,
        fixture.requesterId,
        fixture.methodId,
      ),
      service.requestWithdrawal(
        fixture.publisherId,
        25,
        "stripe_connect",
        fixture.requesterId,
        idempotencyKey,
        fixture.methodId,
      ),
    ])

    expect(
      [deactivation, reservation].filter(
        (outcome) => outcome.status === "fulfilled",
      ),
    ).toHaveLength(1)
    const [persistedMethod, withdrawals, balance, allocations] =
      await Promise.all([
        prisma.payoutMethod.findUniqueOrThrow({
          where: { id: fixture.methodId },
          select: { isActive: true, nonterminalWithdrawalCount: true },
        }),
        prisma.withdrawal.findMany({
          where: { publisherId: fixture.publisherId, idempotencyKey },
        }),
        prisma.publisherBalance.findUniqueOrThrow({
          where: { id: fixture.balanceId },
        }),
        prisma.withdrawalAllocation.findMany({
          where: {
            withdrawal: {
              publisherId: fixture.publisherId,
              idempotencyKey,
            },
          },
        }),
      ])

    if (reservation.status === "fulfilled") {
      expect(deactivation.status).toBe("rejected")
      expect(persistedMethod).toEqual({
        isActive: true,
        nonterminalWithdrawalCount: 1,
      })
      expect(withdrawals).toHaveLength(1)
      expect(allocations).toHaveLength(1)
      expect(allocations[0].releasedAt).toBeNull()
      expect(balance.withdrawableBalance.toString()).toBe("0")
    } else {
      expect(deactivation.status).toBe("fulfilled")
      expect(persistedMethod).toEqual({
        isActive: false,
        nonterminalWithdrawalCount: 0,
      })
      expect(withdrawals).toHaveLength(0)
      expect(allocations).toHaveLength(0)
      expect(balance.withdrawableBalance.toString()).toBe("25")
    }
  }, 30_000)

  it("keeps request and provider-claim writers on a deadlock-free Balance-to-Method suffix", async () => {
    const fixture = await makePayoutFixture({ leaveExecutionAtCreated: true })
    await addReservedCapacity(fixture, 25)
    const created = await prisma.payoutExecution.findUniqueOrThrow({
      where: { id: fixture.executionId },
    })
    const metadata = created.providerMetadata as {
      destinationSnapshot: Record<string, unknown>
      providerSnapshot: Record<string, unknown>
    }
    await prisma.payoutExecution.update({
      where: { id: fixture.executionId },
      data: {
        stage: "DESTINATION_VALIDATED",
        providerMetadata: {
          destinationSnapshot: {
            ...metadata.destinationSnapshot,
            recipientFingerprint: "d".repeat(64),
          },
          providerSnapshot: metadata.providerSnapshot,
        },
        version: { increment: 1 },
      },
    })
    const { service } = makePublisherPayoutsService()
    const idempotencyKey = `request-claim-race-${crypto.randomUUID()}`

    const claim = runSerializableTestTransaction(async (tx: any) => {
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "Withdrawal" WHERE "id" = $1 FOR UPDATE',
        fixture.withdrawalId,
      )
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "PayoutExecution" WHERE "id" = $1 FOR UPDATE',
        fixture.executionId,
      )
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "PublisherBalance" WHERE "publisherId" = $1 FOR UPDATE',
        fixture.publisherId,
      )
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "PayoutProvider" WHERE "id" = $1 FOR UPDATE',
        fixture.providerId,
      )
      const payoutMethod = await tx.payoutMethod.findUniqueOrThrow({
        where: { id: fixture.payoutMethodId },
        select: { providerAccountId: true },
      })
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "PublisherProviderAccount" WHERE "id" = $1 FOR UPDATE',
        payoutMethod.providerAccountId,
      )
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "PayoutMethod" WHERE "id" = $1 FOR UPDATE',
        fixture.payoutMethodId,
      )
      const execution = await tx.payoutExecution.findUniqueOrThrow({
        where: { id: fixture.executionId },
      })
      const claimedAt = new Date()
      await tx.$executeRawUnsafe(
        `INSERT INTO "PayoutExecutionClaim" (
             "id", "executionId", "kind", "idempotencyKey",
             "idempotencyKeyFingerprint", "claimedAt", "lastClaimedAt",
             "claimedByUserId"
           ) VALUES ($1, $2, 'PROVIDER_SEND', $3, $4, $5, $5, $6)`,
        crypto.randomUUID(),
        fixture.executionId,
        execution.idempotencyKey,
        crypto
          .createHash("sha256")
          .update(String(execution.idempotencyKey))
          .digest("hex"),
        claimedAt,
        fixture.initiatorId,
      )
      await tx.payoutExecution.update({
        where: { id: fixture.executionId },
        data: {
          stage: "PROVIDER_SEND_CLAIMED",
          version: { increment: 1 },
        },
      })
    })
    const reservation = service.requestWithdrawal(
      fixture.publisherId,
      25,
      "stripe_connect",
      fixture.requesterId,
      idempotencyKey,
      fixture.payoutMethodId,
    )

    await expect(Promise.all([claim, reservation])).resolves.toHaveLength(2)
    await expect(
      prisma.payoutExecutionClaim.count({
        where: { executionId: fixture.executionId, kind: "PROVIDER_SEND" },
      }),
    ).resolves.toBe(1)
    await expect(
      prisma.withdrawal.count({
        where: { publisherId: fixture.publisherId, idempotencyKey },
      }),
    ).resolves.toBe(1)
    await expect(
      prisma.payoutMethod.findUniqueOrThrow({
        where: { id: fixture.payoutMethodId },
        select: { nonterminalWithdrawalCount: true },
      }),
    ).resolves.toEqual({ nonterminalWithdrawalCount: 2 })
    await expect(
      prisma.publisherBalance.findUniqueOrThrow({
        where: { id: fixture.balanceId },
        select: { withdrawableBalance: true },
      }),
    ).resolves.toMatchObject({ withdrawableBalance: expect.anything() })
    const racedBalance = await prisma.publisherBalance.findUniqueOrThrow({
      where: { id: fixture.balanceId },
    })
    expect(racedBalance.withdrawableBalance.toString()).toBe("0")
  }, 30_000)

  it("serializes delayed provider evidence against exact-claim recovery with Withdrawal before Execution", async () => {
    const fixture = await makePayoutFixture({ leaveExecutionAtCreated: true })
    const created = await prisma.payoutExecution.findUniqueOrThrow({
      where: { id: fixture.executionId },
    })
    const metadata = created.providerMetadata as {
      destinationSnapshot: Record<string, unknown>
      providerSnapshot: Record<string, unknown>
    }
    const validatedMetadata = {
      ...metadata,
      destinationSnapshot: {
        ...metadata.destinationSnapshot,
        recipientFingerprint: "f".repeat(64),
      },
    }
    await prisma.payoutExecution.update({
      where: { id: fixture.executionId },
      data: {
        stage: "DESTINATION_VALIDATED",
        providerMetadata: validatedMetadata,
        version: { increment: 1 },
      },
    })
    const claimedAt = new Date()
    await prisma.$transaction(async (tx: any) => {
      await tx.payoutExecutionClaim.create({
        data: {
          executionId: fixture.executionId,
          kind: "PROVIDER_SEND",
          idempotencyKey: String(created.idempotencyKey),
          idempotencyKeyFingerprint: crypto
            .createHash("sha256")
            .update(String(created.idempotencyKey))
            .digest("hex"),
          claimedByUserId: fixture.initiatorId,
          claimedAt,
          lastClaimedAt: claimedAt,
        },
      })
      await tx.payoutExecution.update({
        where: { id: fixture.executionId },
        data: {
          stage: "PROVIDER_SEND_CLAIMED",
          version: { increment: 1 },
        },
      })
    })
    const claimed = await prisma.payoutExecution.findUniqueOrThrow({
      where: { id: fixture.executionId },
    })
    const providerTransferId = `tr_delayed_${crypto.randomUUID()}`
    let notifyParentLocked!: () => void
    const parentLocked = new Promise<void>((resolve) => {
      notifyParentLocked = resolve
    })
    let releaseProviderResponse!: () => void
    const release = new Promise<void>((resolve) => {
      releaseProviderResponse = resolve
    })

    const delayedProviderResponse = prisma.$transaction(async (tx: any) => {
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "Withdrawal" WHERE "id" = $1 FOR UPDATE',
        fixture.withdrawalId,
      )
      notifyParentLocked()
      await release
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "PayoutExecution" WHERE "id" = $1 AND "withdrawalId" = $2 FOR UPDATE',
        fixture.executionId,
        fixture.withdrawalId,
      )
      return tx.payoutExecution.updateMany({
        where: {
          id: fixture.executionId,
          withdrawalId: fixture.withdrawalId,
          status: "PROCESSING",
          stage: "PROVIDER_SEND_CLAIMED",
          version: claimed.version,
        },
        data: {
          providerExecutionId: providerTransferId,
          providerTransferId,
          stage: "TRANSFER_CREATED",
          providerMetadata: {
            ...validatedMetadata,
            providerEvidence: {
              connectedAccountId: fixture.providerAccountExternalId,
              providerAmountMinor: fixture.amount * 100,
              providerCurrency: "USD",
              providerPublicReference: fixture.publicReference,
              livemode: false,
            },
          },
          version: { increment: 1 },
        },
      })
    })
    await parentLocked
    const recoveryClaim = prisma.$transaction(async (tx: any) => {
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "Withdrawal" WHERE "id" = $1 FOR UPDATE',
        fixture.withdrawalId,
      )
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "PayoutExecution" WHERE "id" = $1 AND "withdrawalId" = $2 FOR UPDATE',
        fixture.executionId,
        fixture.withdrawalId,
      )
      const fresh = await tx.payoutExecution.findUniqueOrThrow({
        where: { id: fixture.executionId },
      })
      if (
        fresh.stage !== "PROVIDER_SEND_CLAIMED" ||
        fresh.version !== claimed.version
      ) {
        return false
      }
      const replayed = await tx.payoutExecution.updateMany({
        where: {
          id: fixture.executionId,
          withdrawalId: fixture.withdrawalId,
          stage: "PROVIDER_SEND_CLAIMED",
          version: claimed.version,
        },
        data: { version: { increment: 1 } },
      })
      return replayed.count === 1
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    releaseProviderResponse()

    await expect(delayedProviderResponse).resolves.toMatchObject({ count: 1 })
    await expect(recoveryClaim).resolves.toBe(false)
    await expect(
      prisma.payoutExecution.findUniqueOrThrow({
        where: { id: fixture.executionId },
        select: {
          stage: true,
          providerExecutionId: true,
          providerTransferId: true,
        },
      }),
    ).resolves.toEqual({
      stage: "TRANSFER_CREATED",
      providerExecutionId: providerTransferId,
      providerTransferId,
    })
  }, 30_000)

  it("serializes approved abandonment against replacement execution claim and never releases beside provider authority", async () => {
    const fixture = await makePayoutFixture({
      providerName: "manual",
      leaveExecutionAtCreated: true,
    })
    await moveToClaimFreeApproved(fixture)
    const cancelled = await prisma.payoutExecution.findUniqueOrThrow({
      where: { id: fixture.executionId },
    })
    const metadata = cancelled.providerMetadata as {
      destinationSnapshot: Record<string, unknown>
      providerSnapshot: Record<string, unknown>
    }
    const { service } = makePublisherPayoutsService()
    const providerCall = jest.fn().mockResolvedValue(undefined)

    const claimReplacement = (async () => {
      const claimed = await runSerializableTestTransaction(async (tx: any) => {
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "Withdrawal" WHERE "id" = $1 FOR UPDATE',
          fixture.withdrawalId,
        )
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "PayoutExecution" WHERE "withdrawalId" = $1 ORDER BY "id" FOR UPDATE',
          fixture.withdrawalId,
        )
        const withdrawal = await tx.withdrawal.findUniqueOrThrow({
          where: { id: fixture.withdrawalId },
        })
        if (withdrawal.status !== "APPROVED") return false
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "PublisherBalance" WHERE "publisherId" = $1 FOR UPDATE',
          fixture.publisherId,
        )
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "PayoutProvider" WHERE "id" = $1 FOR UPDATE',
          fixture.providerId,
        )
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "PayoutMethod" WHERE "id" = $1 FOR UPDATE',
          fixture.payoutMethodId,
        )
        const processing = await tx.withdrawal.update({
          where: { id: fixture.withdrawalId },
          data: {
            status: "PROCESSING",
            version: { increment: 1 },
          },
        })
        const execution = await tx.payoutExecution.create({
          data: {
            withdrawalId: fixture.withdrawalId,
            providerId: fixture.providerId,
            livemode: fixture.livemode,
            status: "PROCESSING",
            amount: fixture.amount,
            fee: 0,
            sourceCurrency: "USD",
            destinationCurrency: "USD",
            destinationAmount: fixture.amount,
            requestedReference: fixture.publicReference,
            stage: "CREATED",
            idempotencyKey: `payout-${fixture.withdrawalId}-v${processing.version}`,
            initiatedByUserId: fixture.initiatorId,
            providerMetadata: metadata,
          },
        })
        await tx.payoutExecution.update({
          where: { id: execution.id },
          data: {
            stage: "DESTINATION_VALIDATED",
            providerMetadata: {
              destinationSnapshot: {
                ...metadata.destinationSnapshot,
                recipientFingerprint: "e".repeat(64),
              },
              providerSnapshot: metadata.providerSnapshot,
            },
            version: { increment: 1 },
          },
        })
        const claimedAt = new Date()
        await tx.$executeRawUnsafe(
          `INSERT INTO "PayoutExecutionClaim" (
               "id", "executionId", "kind", "idempotencyKey",
               "idempotencyKeyFingerprint", "claimedAt", "lastClaimedAt",
               "claimedByUserId"
             ) VALUES ($1, $2, 'PROVIDER_SEND', $3, $4, $5, $5, $6)`,
          crypto.randomUUID(),
          execution.id,
          execution.idempotencyKey,
          crypto
            .createHash("sha256")
            .update(String(execution.idempotencyKey))
            .digest("hex"),
          claimedAt,
          fixture.initiatorId,
        )
        await tx.payoutExecution.update({
          where: { id: execution.id },
          data: {
            stage: "PROVIDER_SEND_CLAIMED",
            version: { increment: 1 },
          },
        })
        return true
      })
      if (claimed) await providerCall()
      return claimed
    })()
    const abandonment = service.abandonApprovedWithdrawal(
      fixture.withdrawalId,
      fixture.checkerId,
      "Finance verified a pre-provider stop and requested safe abandonment.",
    )

    const [claimOutcome, abandonmentOutcome] = await Promise.allSettled([
      claimReplacement,
      abandonment,
    ])
    expect(claimOutcome.status).toBe("fulfilled")
    const claimed =
      claimOutcome.status === "fulfilled" && claimOutcome.value === true
    const [withdrawal, allocations, claimCount, balance] = await Promise.all([
      prisma.withdrawal.findUniqueOrThrow({
        where: { id: fixture.withdrawalId },
      }),
      prisma.withdrawalAllocation.findMany({
        where: { withdrawalId: fixture.withdrawalId },
      }),
      prisma.payoutExecutionClaim.count({
        where: { execution: { withdrawalId: fixture.withdrawalId } },
      }),
      prisma.publisherBalance.findUniqueOrThrow({
        where: { id: fixture.balanceId },
      }),
    ])

    if (claimed) {
      expect(abandonmentOutcome.status).toBe("rejected")
      expect(providerCall).toHaveBeenCalledTimes(1)
      expect(withdrawal.status).toBe("PROCESSING")
      expect(claimCount).toBe(1)
      expect(allocations).toHaveLength(1)
      expect(allocations[0].releasedAt).toBeNull()
      expect(balance.withdrawableBalance.toString()).toBe("0")
      expect(balance.allocationCarryForwardUsed.toString()).toBe(
        String(fixture.amount),
      )
    } else {
      expect(abandonmentOutcome.status).toBe("fulfilled")
      expect(providerCall).not.toHaveBeenCalled()
      expect(withdrawal.status).toBe("REJECTED")
      expect(claimCount).toBe(0)
      expect(allocations).toHaveLength(1)
      expect(allocations[0].releasedAt).not.toBeNull()
      expect(balance.withdrawableBalance.toString()).toBe(
        String(fixture.amount),
      )
      expect(balance.allocationCarryForwardUsed.toString()).toBe("0")
    }
  }, 30_000)

  it("rejects approved abandonment when any historical execution carries provider authority", async () => {
    const fixture = await makePayoutFixture({
      providerName: "manual",
      leaveExecutionAtCreated: true,
    })
    await moveToClaimFreeApproved(fixture)
    const execution = await prisma.payoutExecution.findUniqueOrThrow({
      where: { id: fixture.executionId },
    })
    const claimedAt = new Date()

    await prisma.$executeRawUnsafe(
      'ALTER TABLE "PayoutExecutionClaim" DISABLE TRIGGER "PayoutExecutionClaim_authority_guard"',
    )
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "PayoutExecutionClaim" DISABLE TRIGGER "PayoutExecutionClaim_stage_commit_guard"',
    )
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "PayoutExecutionClaim" (
           "id", "executionId", "kind", "idempotencyKey",
           "idempotencyKeyFingerprint", "claimedAt", "lastClaimedAt",
           "claimedByUserId"
         ) VALUES ($1, $2, 'PROVIDER_SEND', $3, $4, $5, $5, $6)`,
        crypto.randomUUID(),
        fixture.executionId,
        execution.idempotencyKey,
        crypto
          .createHash("sha256")
          .update(String(execution.idempotencyKey))
          .digest("hex"),
        claimedAt,
        fixture.initiatorId,
      )
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "PayoutExecutionClaim" ENABLE TRIGGER "PayoutExecutionClaim_stage_commit_guard"',
      )
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "PayoutExecutionClaim" ENABLE TRIGGER "PayoutExecutionClaim_authority_guard"',
      )
    }

    const { service } = makePublisherPayoutsService()
    await expect(
      service.abandonApprovedWithdrawal(
        fixture.withdrawalId,
        fixture.checkerId,
        "Historical provider authority makes this abandonment unsafe.",
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "WITHDRAWAL_ABANDONMENT_NOT_PROVABLY_PRE_PROVIDER",
      }),
    })
    await expectDatabaseRejection(
      prisma.withdrawal.update({
        where: { id: fixture.withdrawalId },
        data: {
          status: "REJECTED",
          rejectedBy: fixture.checkerId,
          rejectedAt: new Date(),
          version: { increment: 1 },
        },
      }),
      /exclusively claim-free pre-provider-aborted execution history/,
    )
    const [withdrawal, allocations, balance] = await Promise.all([
      prisma.withdrawal.findUniqueOrThrow({
        where: { id: fixture.withdrawalId },
      }),
      prisma.withdrawalAllocation.findMany({
        where: { withdrawalId: fixture.withdrawalId },
      }),
      prisma.publisherBalance.findUniqueOrThrow({
        where: { id: fixture.balanceId },
      }),
    ])
    expect(withdrawal.status).toBe("APPROVED")
    expect(allocations).toHaveLength(1)
    expect(allocations[0].releasedAt).toBeNull()
    expect(balance.withdrawableBalance.toString()).toBe("0")
    expect(balance.allocationCarryForwardUsed.toString()).toBe(
      String(fixture.amount),
    )
  }, 30_000)
})
