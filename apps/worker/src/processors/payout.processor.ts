import { prisma } from "@guestpost/database"
import {
  assertFinanceOperationAllowed,
  assertStripeFinancialObjectMode,
  checkProviderTransferStatus,
  QUEUES,
  StripeConfigurationError,
} from "@guestpost/shared"
import { verifyJobPayload } from "@guestpost/shared/dist/job-signing"
import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"
import { finalizePayoutExecution } from "@guestpost/shared/dist/payout-finalization-core"
import { mergePayoutProviderMetadata } from "@guestpost/shared/dist/payout-provider-metadata"
import { createObservableWorker } from "../lib/queue-observability"
import { connection } from "../redis"
import { isRepeatableJob } from "../repeatable-job-registry"

const logger = createLogger("worker.payout")

interface PayoutWebhookLease {
  attempts: number
  lockedAt: Date
}

function ownsPayoutWebhookLease(
  event: any,
  lease: PayoutWebhookLease,
): boolean {
  return (
    event?.status === "PROCESSING" &&
    event.attempts === lease.attempts &&
    event.lockedAt instanceof Date &&
    event.lockedAt.getTime() === lease.lockedAt.getTime()
  )
}

function payoutWebhookLeaseWhere(
  id: string,
  lease: PayoutWebhookLease,
): Record<string, unknown> {
  return {
    id,
    status: "PROCESSING",
    attempts: lease.attempts,
    lockedAt: lease.lockedAt,
  }
}

async function lockOwnedPayoutWebhookEvent(
  tx: any,
  id: string,
  lease: PayoutWebhookLease,
): Promise<any | null> {
  await tx.$queryRawUnsafe(
    'SELECT "id" FROM "PayoutWebhookEvent" WHERE "id" = $1 FOR UPDATE',
    id,
  )
  const event = await tx.payoutWebhookEvent.findUnique({
    where: { id },
  })
  return ownsPayoutWebhookLease(event, lease) ? event : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function immutableProviderAccountId(execution: any): string | null {
  if (!isRecord(execution?.providerMetadata)) return null
  const snapshot = execution.providerMetadata.destinationSnapshot
  if (!isRecord(snapshot)) return null
  return typeof snapshot.providerAccountExternalId === "string" &&
    snapshot.providerAccountExternalId.length > 0
    ? snapshot.providerAccountExternalId
    : null
}

function exactUsdMinorAmount(
  amount: unknown,
  currency: unknown,
): bigint | null {
  if (String(currency ?? "").toUpperCase() !== "USD") return null
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(amount ?? "").trim())
  if (!match) return null
  const fraction = match[2] ?? ""
  if (fraction.length > 2 && /[1-9]/.test(fraction.slice(2))) return null
  const minor =
    BigInt(match[1]) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2))
  return minor > 0n ? minor : null
}

function normalizedMinorAmount(value: unknown): bigint | null {
  if (typeof value === "bigint" && value > 0n) return value
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return BigInt(value)
  }
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    return BigInt(value)
  }
  return null
}

async function completeExecution(
  client: any,
  execution: any,
  source: "webhook" | "status-poll",
  metadata: Record<string, unknown>,
  webhookEventId?: string,
  webhookLease?: PayoutWebhookLease,
  providerEvidence?: {
    providerAmountMinor?: number
    providerCurrency?: string
  },
) {
  if (source === "webhook" && (!webhookEventId || !webhookLease)) {
    throw new Error("Payout webhook completion requires an exact claim lease")
  }
  const providerReference =
    execution.provider?.name === "stripe_connect"
      ? execution.providerPayoutId
      : execution.providerExecutionId
  if (!providerReference) {
    throw new Error("Terminal provider object reference is missing")
  }
  return finalizePayoutExecution(
    client,
    source === "webhook"
      ? {
          executionId: execution.id,
          withdrawalId: execution.withdrawalId,
          providerName: execution.provider.name,
          providerReference,
          source: "PROVIDER_WEBHOOK",
          webhookEventId: webhookEventId!,
          webhookClaimAttempt: webhookLease!.attempts,
          webhookClaimLockedAt: webhookLease!.lockedAt,
          metadata,
        }
      : {
          executionId: execution.id,
          withdrawalId: execution.withdrawalId,
          providerName: execution.provider.name,
          providerReference,
          source: "PROVIDER_STATUS_POLL",
          evidenceAt: new Date(),
          providerAmountMinor: providerEvidence?.providerAmountMinor,
          providerCurrency: providerEvidence?.providerCurrency,
          fee: metadata.fee,
          metadata,
        },
  )
}

function assertFailureEvidenceMode(
  execution: any,
  webhookLivemode?: boolean | null,
): void {
  if (execution.provider.name === "stripe_connect") {
    if (
      webhookLivemode !== undefined &&
      webhookLivemode !== execution.livemode
    ) {
      throw new StripeConfigurationError(
        "STRIPE_PROVIDER_MODE_MISMATCH",
        "Stripe failure webhook mode does not match its payout execution",
      )
    }
    assertStripeFinancialObjectMode(execution.livemode, {
      secretKey: process.env.STRIPE_SECRET_KEY,
      liveModeEnabled: process.env.STRIPE_LIVE_MODE_ENABLED,
    })
    return
  }
  if (
    execution.livemode !== null ||
    (webhookLivemode !== undefined && webhookLivemode !== null)
  ) {
    throw new StripeConfigurationError(
      "STRIPE_PROVIDER_MODE_MISMATCH",
      "Non-Stripe payout failure evidence cannot contain a Stripe mode",
    )
  }
}

async function quarantineFailedWebhookModeFence(
  tx: any,
  execution: any,
  webhookEventId: string,
  webhookLease: PayoutWebhookLease,
  error: StripeConfigurationError,
): Promise<"quarantined"> {
  const reason = `FailureModeFence:${error.code}`
  const quarantined = await tx.payoutWebhookEvent.updateMany({
    where: payoutWebhookLeaseWhere(webhookEventId, webhookLease),
    data: {
      status: "QUARANTINED",
      lockedAt: null,
      processedAt: new Date(),
      lastError: reason,
    },
  })
  if (quarantined.count !== 1) {
    throw new Error(
      "Payout webhook lease changed during failure mode quarantine",
    )
  }
  const staff = await tx.staffMembership.findMany({
    where: { role: { in: ["FINANCE", "SUPER_ADMIN"] } },
    select: { userId: true },
  })
  if (staff.length > 0) {
    await tx.notification.createMany({
      data: staff.map((member: { userId: string }) => ({
        userId: member.userId,
        organizationId: null,
        type: "PAYOUT_WEBHOOK_QUARANTINED",
        message: `Payout failure webhook ${webhookEventId} failed its provider-mode fence`,
        dedupKey: `payout-webhook-mode-fence:${webhookEventId}:${error.code}:${member.userId}`,
      })),
      skipDuplicates: true,
    })
  }
  await tx.auditLog.create({
    data: {
      action: "PAYOUT_WEBHOOK_MODE_FENCE_QUARANTINED",
      entityType: "PayoutExecution",
      entityId: execution.id,
      metadata: {
        payoutWebhookEventId: webhookEventId,
        webhookClaimAttempt: webhookLease.attempts,
        webhookClaimLockedAt: webhookLease.lockedAt.toISOString(),
        provider: execution.provider.name,
        executionLivemode: execution.livemode,
        configurationErrorCode: error.code,
      },
      userId: null,
      organizationId: execution.withdrawal.publisher.organizationId,
    },
  })
  return "quarantined"
}

async function failExecution(
  client: any,
  execution: any,
  source: "webhook" | "status-poll",
  errorMessage: string,
  metadata: Record<string, unknown>,
  webhookEventId?: string,
  webhookLease?: PayoutWebhookLease,
  webhookLivemode?: boolean | null,
) {
  return client.$transaction(
    async (tx: any) => {
      if (webhookEventId) {
        if (
          !webhookLease ||
          !(await lockOwnedPayoutWebhookEvent(tx, webhookEventId, webhookLease))
        ) {
          return "ownership-lost"
        }
      }
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "Withdrawal" WHERE "id" = $1 FOR UPDATE',
        execution.withdrawalId,
      )
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "PayoutExecution" WHERE "id" = $1 FOR UPDATE',
        execution.id,
      )
      const fresh = await tx.payoutExecution.findUnique({
        where: { id: execution.id },
        include: {
          provider: true,
          withdrawal: { include: { publisher: true } },
        },
      })
      if (
        fresh?.status !== "PROCESSING" ||
        fresh.withdrawal.status !== "PROCESSING" ||
        fresh.stage === "CANCEL_REQUESTED"
      ) {
        if (!webhookEventId || !webhookLease) {
          throw new Error(
            "Terminal failure conflicts with the current payout state",
          )
        }
        const quarantined = await tx.payoutWebhookEvent.updateMany({
          where: payoutWebhookLeaseWhere(webhookEventId, webhookLease),
          data: {
            status: "QUARANTINED",
            lockedAt: null,
            processedAt: new Date(),
            lastError: "TerminalFailureConflictsWithLocalState",
          },
        })
        if (quarantined.count !== 1) {
          throw new Error(
            "Payout webhook lease changed during failure quarantine",
          )
        }
        const staff = await tx.staffMembership.findMany({
          where: { role: { in: ["FINANCE", "SUPER_ADMIN"] } },
          select: { userId: true },
        })
        if (staff.length > 0) {
          await tx.notification.createMany({
            data: staff.map((member: { userId: string }) => ({
              userId: member.userId,
              organizationId: null,
              type: "PAYOUT_WEBHOOK_QUARANTINED",
              message: `Critical terminal payout conflict for execution ${execution.id}`,
              dedupKey: `payout-webhook-quarantine:${webhookEventId}:terminal-failure:${member.userId}`,
            })),
            skipDuplicates: true,
          })
        }
        await tx.auditLog.create({
          data: {
            action: "PAYOUT_WEBHOOK_TERMINAL_CONFLICT_QUARANTINED",
            entityType: "PayoutExecution",
            entityId: execution.id,
            metadata: {
              payoutWebhookEventId: webhookEventId,
              webhookClaimAttempt: webhookLease.attempts,
              webhookClaimLockedAt: webhookLease.lockedAt.toISOString(),
              localExecutionStatus: fresh?.status ?? null,
              localWithdrawalStatus: fresh?.withdrawal?.status ?? null,
              providerStatus: "FAILED",
            },
            userId: null,
            organizationId:
              fresh?.withdrawal?.publisher?.organizationId ?? null,
          },
        })
        return "quarantined"
      }

      try {
        assertFailureEvidenceMode(
          fresh,
          source === "webhook" ? webhookLivemode : undefined,
        )
      } catch (error) {
        if (!(error instanceof StripeConfigurationError)) throw error
        if (!webhookEventId || !webhookLease) throw error
        return quarantineFailedWebhookModeFence(
          tx,
          fresh,
          webhookEventId,
          webhookLease,
          error,
        )
      }

      const observedAt = new Date()
      const terminalFailure = {
        source:
          source === "webhook" ? "PROVIDER_WEBHOOK" : "PROVIDER_STATUS_POLL",
        provider: fresh.provider.name,
        providerExecutionId: fresh.providerExecutionId,
        providerTransferId: fresh.providerTransferId,
        providerPayoutId: fresh.providerPayoutId,
        providerStatus: "FAILED",
        observedAt: observedAt.toISOString(),
        payoutWebhookEventId: webhookEventId ?? null,
        webhookClaimAttempt: webhookLease?.attempts ?? null,
        webhookClaimLockedAt: webhookLease?.lockedAt.toISOString() ?? null,
      }
      const evidenceMetadata = mergePayoutProviderMetadata(
        fresh.providerMetadata,
        metadata,
      )
      const held = await tx.payoutExecution.updateMany({
        where: {
          id: fresh.id,
          status: "PROCESSING",
          version: fresh.version,
        },
        data: {
          stage:
            fresh.provider.name === "stripe_connect" && fresh.providerTransferId
              ? "BANK_PAYOUT_RECOVERY_REQUIRED"
              : "PROVIDER_FAILURE_REVIEW_REQUIRED",
          errorMessage,
          providerMetadata: {
            ...evidenceMetadata,
            terminalFailure,
          } as any,
          version: { increment: 1 },
        },
      })
      if (held.count !== 1) {
        throw new Error("Execution changed while failure evidence was applied")
      }
      if (webhookEventId && webhookLease) {
        const processed = await tx.payoutWebhookEvent.updateMany({
          where: payoutWebhookLeaseWhere(webhookEventId, webhookLease),
          data: {
            status: "PROCESSED",
            lockedAt: null,
            processedAt: observedAt,
            lastError: null,
          },
        })
        if (processed.count !== 1) {
          throw new Error(
            "Payout webhook lease changed while failure evidence was applied",
          )
        }
      }
      await tx.auditLog.create({
        data: {
          action: "PAYOUT_TERMINAL_FAILURE_REVIEW_REQUIRED",
          entityType: "PayoutExecution",
          entityId: fresh.id,
          metadata: terminalFailure,
          userId: null,
          organizationId: fresh.withdrawal.publisher.organizationId,
        },
      })
      return "held"
    },
    { isolationLevel: "Serializable" },
  )
}

async function promoteStalePayoutStages(
  client: any,
  staleBefore: Date,
): Promise<void> {
  const promotions = [
    {
      from: "TRANSFER_CREATED",
      to: "TRANSFER_RECOVERY_REQUIRED",
      referenceWhere: {
        providerTransferId: { not: null },
        providerPayoutId: null,
      },
      errorMessage:
        "Local bank-payout stage did not finalize; recovery required",
    },
    {
      from: "BANK_PAYOUT_CREATED",
      to: "BANK_PAYOUT_RECOVERY_REQUIRED",
      referenceWhere: { providerPayoutId: { not: null } },
      errorMessage:
        "Local payout finalization did not complete; reconcile provider status",
    },
  ] as const

  for (const promotion of promotions) {
    const candidates = await client.payoutExecution.findMany({
      where: {
        status: "PROCESSING",
        stage: promotion.from,
        ...promotion.referenceWhere,
        updatedAt: { lt: staleBefore },
      },
      select: {
        id: true,
        withdrawalId: true,
        version: true,
        updatedAt: true,
      },
    })
    for (const candidate of candidates) {
      await client.$transaction(async (tx: any) => {
        // All payout writers use the same parent-first order. This makes a
        // delayed provider response and stale-stage recovery serialize without
        // deadlocking or overwriting the evidence that won the race.
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "Withdrawal" WHERE "id" = $1 FOR UPDATE',
          candidate.withdrawalId,
        )
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "PayoutExecution" WHERE "id" = $1 AND "withdrawalId" = $2 FOR UPDATE',
          candidate.id,
          candidate.withdrawalId,
        )
        await tx.payoutExecution.updateMany({
          where: {
            id: candidate.id,
            withdrawalId: candidate.withdrawalId,
            version: candidate.version,
            status: "PROCESSING",
            stage: promotion.from,
            ...promotion.referenceWhere,
            updatedAt: candidate.updatedAt,
          },
          data: {
            stage: promotion.to,
            version: { increment: 1 },
            errorMessage: promotion.errorMessage,
          },
        })
      })
    }
  }
}

export async function handleCheckStatus(
  job: any,
  client: any = prisma,
  statusChecker: typeof checkProviderTransferStatus = checkProviderTransferStatus,
) {
  assertFinanceOperationAllowed("recovery")
  const limit = job.data.limit ?? 50
  const staleProviderStage = new Date(Date.now() - 15 * 60 * 1000)
  // If the API process died between Stripe accepting one stage and local
  // finalization, promote the evidence to an explicit recovery state. The
  // original Stripe idempotency keys remain authoritative for any resume.
  await promoteStalePayoutStages(client, staleProviderStage)
  const pendingExecutions = await client.payoutExecution.findMany({
    where: {
      status: "PROCESSING",
      OR: [
        { providerExecutionId: { not: null } },
        { providerPayoutId: { not: null } },
      ],
      stage: {
        notIn: [
          "TRANSFER_RECOVERY_REQUIRED",
          "PROVIDER_SEND_CLAIMED",
          "BANK_PAYOUT_SEND_CLAIMED",
          "BANK_PAYOUT_RESUME_CLAIMED",
          "PROVIDER_SEND_CLAIM_EXPIRED",
          "BANK_PAYOUT_CLAIM_EXPIRED",
          "CANCEL_REQUESTED",
        ],
      },
    },
    take: limit,
    orderBy: { createdAt: "asc" },
    include: { provider: true, withdrawal: { include: { publisher: true } } },
  })
  logger.info("polling provider status", {
    pendingCount: pendingExecutions.length,
  })

  let completed = 0
  let failed = 0
  let skipped = 0
  for (const execution of pendingExecutions) {
    let result
    try {
      const connectedAccountId =
        execution.provider.name === "stripe_connect"
          ? immutableProviderAccountId(execution)
          : null
      const expectedAmountMinor =
        execution.provider.name === "stripe_connect"
          ? exactUsdMinorAmount(
              execution.destinationAmount ?? execution.amount,
              execution.destinationCurrency,
            )
          : null
      if (
        execution.provider.name === "stripe_connect" &&
        (!connectedAccountId ||
          expectedAmountMinor === null ||
          expectedAmountMinor > BigInt(Number.MAX_SAFE_INTEGER) ||
          !execution.requestedReference)
      ) {
        logger.error("immutable Stripe destination snapshot missing", {
          executionId: execution.id,
        })
        skipped++
        continue
      }
      if (execution.provider.name === "stripe_connect") {
        assertStripeFinancialObjectMode(execution.livemode, {
          secretKey: process.env.STRIPE_SECRET_KEY,
          liveModeEnabled: process.env.STRIPE_LIVE_MODE_ENABLED,
        })
      } else if (execution.livemode !== null) {
        logger.error("non-Stripe payout contains Stripe mode evidence", {
          executionId: execution.id,
        })
        skipped++
        continue
      }
      const providerStatusReference =
        execution.provider.name === "stripe_connect"
          ? (execution.providerPayoutId ?? execution.providerExecutionId)
          : execution.providerExecutionId
      if (!providerStatusReference) {
        skipped++
        continue
      }
      result = await statusChecker(
        execution.provider.name,
        providerStatusReference,
        {
          connectedAccountId: connectedAccountId ?? undefined,
          expectedAmountMinor:
            expectedAmountMinor === null
              ? undefined
              : Number(expectedAmountMinor),
          expectedCurrency: execution.destinationCurrency,
          expectedPublicReference: execution.requestedReference ?? undefined,
        },
      )
    } catch (err: any) {
      if (err instanceof StripeConfigurationError) {
        logger.error("Stripe payout polling configuration rejected", {
          code: err.code,
        })
        throw err
      }
      // Provider API hiccup on one transfer must not abort the sweep
      logger.error("status check failed", {
        executionId: execution.id,
        errorType: err instanceof Error ? err.name : typeof err,
      })
      skipped++
      continue
    }
    if (!result) {
      if (execution.provider.name === "stripe_connect") {
        const error = new StripeConfigurationError(
          "STRIPE_KEY_MISSING",
          "Stripe payout polling cannot recover an active execution without a configured key",
        )
        logger.error("Stripe payout polling configuration rejected", {
          code: error.code,
        })
        throw error
      }
      // A non-pollable provider stays reserved for an evidence-aware operator
      // workflow. Never infer completion from a missing provider result.
      skipped++
      continue
    }

    if (
      execution.provider.name === "stripe_connect" &&
      (result.livemode !== execution.livemode ||
        !isRecord(result.metadata) ||
        result.metadata.livemode !== execution.livemode)
    ) {
      logger.error("Stripe payout status mode evidence mismatch", {
        executionId: execution.id,
      })
      skipped++
      continue
    }

    try {
      if (result.status === "COMPLETED") {
        const finalized = await completeExecution(
          client,
          execution,
          "status-poll",
          {
            ...result.metadata,
            fee: result.fee,
          },
          undefined,
          undefined,
          {
            providerAmountMinor: result.providerAmountMinor,
            providerCurrency: result.providerCurrency,
          },
        )
        if (finalized.kind === "conflict") {
          skipped++
          logger.error("provider completion evidence conflicted", {
            executionId: execution.id,
            code: finalized.code,
          })
        } else {
          completed++
          logger.info("execution completed via status poll", {
            executionId: execution.id,
          })
        }
      } else if (result.status === "FAILED") {
        await failExecution(
          client,
          execution,
          "status-poll",
          "Provider reports transfer failed/cancelled",
          result.metadata ?? {},
        )
        failed++
        logger.info("execution failed via status poll", {
          executionId: execution.id,
        })
      }
    } catch (err: any) {
      // Lost a race against a webhook — fine, the state already moved
      logger.warn("transition skipped (lost race against webhook)", {
        executionId: execution.id,
        errorType: err instanceof Error ? err.name : typeof err,
      })
      skipped++
    }
  }

  return { checked: pendingExecutions.length, completed, failed, skipped }
}

const INBOX_LOCK_TIMEOUT_MS = 15 * 60 * 1000
const INBOX_MAX_RETRY_AGE_MS = 72 * 60 * 60 * 1000
// At the capped ten-minute backoff this exceeds the 72-hour age window. It is
// a corruption/clock safety bound, not the normal termination condition.
const INBOX_MAX_ATTEMPTS = 432

function safeInboxError(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError"
  // Provider bodies are never part of inbox processing. Keep only the error
  // class/category so accidental sensitive strings cannot enter this table.
  return name.slice(0, 100)
}

function inboxRetryAt(attempts: number): Date {
  const delaySeconds = Math.min(30 * 2 ** Math.max(attempts - 1, 0), 600)
  return new Date(Date.now() + delaySeconds * 1000)
}

async function markInboxEvent(
  eventStore: any,
  id: string,
  lease: PayoutWebhookLease,
  status: "PROCESSED" | "FAILED" | "IGNORED" | "QUARANTINED",
  data: Record<string, unknown> = {},
): Promise<boolean> {
  const updated = await eventStore.updateMany({
    where: payoutWebhookLeaseWhere(id, lease),
    data: {
      status,
      lockedAt: null,
      processedAt: status === "FAILED" ? null : new Date(),
      ...data,
    },
  })
  return updated.count === 1
}

function failedWebhookEnvelopeMatches(execution: any, event: any): boolean {
  if (execution.provider.name === "stripe_connect") {
    const expectedAccountId = immutableProviderAccountId(execution)
    const expectedAmountMinor = exactUsdMinorAmount(
      execution.destinationAmount ?? execution.amount,
      execution.destinationCurrency,
    )
    return (
      ["payout.failed", "payout.canceled"].includes(event.eventType) &&
      Boolean(expectedAccountId) &&
      typeof execution.livemode === "boolean" &&
      event.livemode === execution.livemode &&
      event.providerAccountExternalId === expectedAccountId &&
      event.providerExecutionId === execution.providerPayoutId &&
      expectedAmountMinor !== null &&
      normalizedMinorAmount(event.payoutAmountMinor) === expectedAmountMinor &&
      String(event.payoutCurrency ?? "").toUpperCase() ===
        String(execution.destinationCurrency).toUpperCase()
    )
  }
  if (execution.provider.name === "wise") {
    return (
      event.eventType === "transfers#state-change" &&
      execution.livemode === null &&
      event.livemode === null &&
      event.providerAccountExternalId === null &&
      event.providerExecutionId === execution.providerExecutionId
    )
  }
  return false
}

async function quarantineWebhookEnvelope(
  client: any,
  execution: any,
  event: any,
  lease: PayoutWebhookLease,
  reason: string,
): Promise<boolean> {
  return client.$transaction(async (tx: any) => {
    if (!(await lockOwnedPayoutWebhookEvent(tx, event.id, lease))) {
      return false
    }
    const quarantined = await tx.payoutWebhookEvent.updateMany({
      where: payoutWebhookLeaseWhere(event.id, lease),
      data: {
        status: "QUARANTINED",
        lockedAt: null,
        processedAt: new Date(),
        lastError: reason,
      },
    })
    if (quarantined.count !== 1) {
      throw new Error("Payout webhook lease changed during envelope quarantine")
    }
    const staff = await tx.staffMembership.findMany({
      where: { role: { in: ["FINANCE", "SUPER_ADMIN"] } },
      select: { userId: true },
    })
    if (staff.length > 0) {
      await tx.notification.createMany({
        data: staff.map((member: { userId: string }) => ({
          userId: member.userId,
          organizationId: null,
          type: "PAYOUT_WEBHOOK_QUARANTINED",
          message: `Payout webhook ${event.id} does not match immutable execution routing`,
          dedupKey: `payout-webhook-envelope:${event.id}:${reason}:${member.userId}`,
        })),
        skipDuplicates: true,
      })
    }
    await tx.auditLog.create({
      data: {
        action: "PAYOUT_WEBHOOK_ENVELOPE_QUARANTINED",
        entityType: "PayoutExecution",
        entityId: execution.id,
        metadata: {
          payoutWebhookEventId: event.id,
          provider: event.provider,
          eventType: event.eventType,
          providerExecutionId: event.providerExecutionId,
          providerAccountExternalId: event.providerAccountExternalId,
          payoutAmountMinor: event.payoutAmountMinor?.toString() ?? null,
          payoutCurrency: event.payoutCurrency,
          webhookClaimAttempt: lease.attempts,
          webhookClaimLockedAt: lease.lockedAt.toISOString(),
          expectedProviderAccountExternalId:
            immutableProviderAccountId(execution),
          reason,
        },
        userId: null,
        organizationId: execution.withdrawal?.publisher?.organizationId ?? null,
      },
    })
    return true
  })
}

async function processInboxEvent(
  client: any,
  event: any,
  lease: PayoutWebhookLease,
): Promise<string> {
  const eventStore = client.payoutWebhookEvent
  if (!event.providerExecutionId) {
    const ignored = await markInboxEvent(
      eventStore,
      event.id,
      lease,
      "IGNORED",
      {
        lastError: "MissingProviderExecutionId",
      },
    )
    return ignored ? "ignored" : "ownership-lost"
  }

  const execution = await client.payoutExecution.findFirst({
    where: {
      OR: [
        { providerExecutionId: event.providerExecutionId },
        { providerPayoutId: event.providerExecutionId },
      ],
      provider: { is: { name: event.provider } },
    },
    include: {
      provider: true,
      withdrawal: { include: { publisher: true } },
    },
  })
  if (!execution) {
    const ageMs = Date.now() - event.receivedAt.getTime()
    if (
      event.attempts >= INBOX_MAX_ATTEMPTS ||
      ageMs >= INBOX_MAX_RETRY_AGE_MS
    ) {
      const terminal = ["COMPLETED", "FAILED"].includes(event.providerStatus)
      const terminalized = await client.$transaction(async (tx: any) => {
        if (!(await lockOwnedPayoutWebhookEvent(tx, event.id, lease))) {
          return false
        }
        const updated = await tx.payoutWebhookEvent.updateMany({
          where: payoutWebhookLeaseWhere(event.id, lease),
          data: {
            status: terminal ? "QUARANTINED" : "IGNORED",
            lockedAt: null,
            processedAt: new Date(),
            lastError: terminal
              ? "TerminalExecutionNotFoundAfterRetryWindow"
              : "ExecutionNotFoundAfterRetryWindow",
          },
        })
        if (updated.count !== 1) {
          throw new Error(
            "Payout webhook lease changed during unmatched-event terminalization",
          )
        }
        if (terminal) {
          const staff = await tx.staffMembership.findMany({
            where: { role: { in: ["FINANCE", "SUPER_ADMIN"] } },
            select: { userId: true },
          })
          if (staff.length > 0) {
            await tx.notification.createMany({
              data: staff.map((member: { userId: string }) => ({
                userId: member.userId,
                organizationId: null,
                type: "PAYOUT_WEBHOOK_QUARANTINED",
                message: `Unmatched terminal payout webhook ${event.id} requires investigation`,
                dedupKey: `payout-webhook-unmatched:${event.id}:${member.userId}`,
              })),
              skipDuplicates: true,
            })
          }
        }
        await tx.auditLog.create({
          data: {
            action: terminal
              ? "PAYOUT_WEBHOOK_UNMATCHED_TERMINAL_QUARANTINED"
              : "PAYOUT_WEBHOOK_UNMATCHED",
            entityType: "PayoutWebhookEvent",
            entityId: event.id,
            metadata: {
              provider: event.provider,
              eventType: event.eventType,
              providerExecutionId: event.providerExecutionId,
              attempts: event.attempts,
              webhookClaimAttempt: lease.attempts,
              webhookClaimLockedAt: lease.lockedAt.toISOString(),
            },
            userId: null,
            organizationId: null,
          },
        })
        return true
      })
      if (!terminalized) return "ownership-lost"
      return terminal ? "quarantined" : "ignored"
    }
    const retried = await markInboxEvent(
      eventStore,
      event.id,
      lease,
      "FAILED",
      {
        availableAt: inboxRetryAt(event.attempts),
        lastError: "ExecutionNotFoundYet",
      },
    )
    return retried ? "retried" : "ownership-lost"
  }

  if (event.providerStatus === "COMPLETED") {
    const finalized = await completeExecution(
      client,
      execution,
      "webhook",
      {
        provider: event.provider,
        event: event.eventType,
        rawStatus: event.rawStatus,
      },
      event.id,
      lease,
    )
    if (
      finalized.kind === "conflict" &&
      finalized.code === "WEBHOOK_LEASE_LOST"
    ) {
      return "ownership-lost"
    }
    return finalized.kind === "conflict" ? "quarantined" : "processed"
  }
  if (event.providerStatus === "FAILED") {
    if (!failedWebhookEnvelopeMatches(execution, event)) {
      const quarantined = await quarantineWebhookEnvelope(
        client,
        execution,
        event,
        lease,
        "TerminalWebhookEnvelopeMismatch",
      )
      return quarantined ? "quarantined" : "ownership-lost"
    }
    return failExecution(
      client,
      execution,
      "webhook",
      "Provider reported transfer failed/cancelled",
      {
        provider: event.provider,
        event: event.eventType,
        rawStatus: event.rawStatus,
      },
      event.id,
      lease,
      event.livemode,
    ).then((result) =>
      result === "ownership-lost"
        ? "ownership-lost"
        : result === "quarantined"
          ? "quarantined"
          : "processed",
    )
  }

  const processed = await markInboxEvent(
    eventStore,
    event.id,
    lease,
    "PROCESSED",
    { lastError: null },
  )
  return processed ? "processed" : "ownership-lost"
}

/** Drain cryptographically verified payout events from the Postgres inbox. */
export async function processPayoutWebhookInbox(
  limit = 50,
  client: any = prisma,
  now = new Date(),
) {
  assertFinanceOperationAllowed("recovery")
  const eventStore = client.payoutWebhookEvent
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 500)
  await eventStore.updateMany({
    where: {
      status: "PROCESSING",
      lockedAt: { lt: new Date(now.getTime() - INBOX_LOCK_TIMEOUT_MS) },
    },
    data: {
      status: "FAILED",
      lockedAt: null,
      availableAt: now,
      lastError: "StaleProcessingLeaseRecovered",
    },
  })

  const candidates = await eventStore.findMany({
    where: {
      status: { in: ["PENDING", "FAILED"] },
      availableAt: { lte: now },
      // Stripe account.updated changes routing eligibility rather than payout
      // completion evidence. The API durably claims and applies those events
      // through StripeConnectService under the recovery runtime gate. Leaving
      // them in the inbox on failure preserves provider redelivery and avoids
      // this generic processor incorrectly terminalizing them as an unmatched
      // payout execution.
      NOT: {
        provider: "stripe_connect",
        eventType: "account.updated",
      },
    },
    orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
    take: safeLimit,
  })

  let processed = 0
  let retried = 0
  let ignored = 0
  let quarantined = 0
  let ownershipLost = 0
  let claimedCount = 0
  for (const candidate of candidates) {
    const claimLockedAt = new Date()
    const claimAttempts = Number(candidate.attempts) + 1
    if (
      !Number.isSafeInteger(candidate.attempts) ||
      candidate.attempts < 0 ||
      !Number.isSafeInteger(claimAttempts)
    ) {
      logger.error("payout inbox candidate attempt state is invalid", {
        eventId: candidate.id,
      })
      continue
    }
    const claimed = await eventStore.updateMany({
      where: {
        id: candidate.id,
        status: { in: ["PENDING", "FAILED"] },
        attempts: candidate.attempts,
        lockedAt: null,
        availableAt: { lte: now },
      },
      data: {
        status: "PROCESSING",
        lockedAt: claimLockedAt,
        attempts: { increment: 1 },
      },
    })
    if (claimed.count === 0) continue
    claimedCount++

    const lease = {
      attempts: claimAttempts,
      lockedAt: claimLockedAt,
    }
    const event = await eventStore.findUnique({
      where: { id: candidate.id },
    })
    if (!ownsPayoutWebhookLease(event, lease)) {
      ownershipLost++
      continue
    }
    try {
      const result = await processInboxEvent(client, event, lease)
      if (result === "processed") processed++
      else if (result === "retried") retried++
      else if (result === "quarantined") quarantined++
      else if (result === "ownership-lost") ownershipLost++
      else ignored++
    } catch (error) {
      const retryOwned = await markInboxEvent(
        eventStore,
        event.id,
        lease,
        "FAILED",
        {
          availableAt: inboxRetryAt(event.attempts),
          lastError: safeInboxError(error),
        },
      )
      if (retryOwned) retried++
      else ownershipLost++
      logger.error("payout inbox event failed", {
        eventId: event.id,
        error: safeInboxError(error),
      })
    }
  }

  return {
    claimed: claimedCount,
    processed,
    retried,
    ignored,
    quarantined,
    ownershipLost,
  }
}

async function handleWebhook(job: any) {
  // Legacy queue jobs are wake signals only. Financial truth enters through
  // the cryptographically verified, durable Postgres inbox; queued payloads
  // are never interpreted as evidence.
  return processPayoutWebhookInbox(job.data?.limit ?? 50)
}

export function createPayoutWorker() {
  const worker = createObservableWorker(
    QUEUES.PAYOUT,
    async (job) => {
      // Phase 7.8 #27 — payout-check-status (repeatable) bypasses
      // freshness; non-repeatable jobs (currently only payout-webhook)
      // get a 72h window to accommodate provider-outage retry storms
      // across long weekends.
      const maxAgeMs = isRepeatableJob(job.name) ? 0 : 72 * 60 * 60 * 1000
      if (!verifyJobPayload(job.data, { maxAgeMs })) {
        logger.error("job signature invalid — rejecting", { jobId: job.id })
        throw new Error("Invalid job signature")
      }
      switch (job.name) {
        case "payout-check-status":
          return handleCheckStatus(job)
        case "payout-webhook":
          return handleWebhook(job)
        default:
          logger.warn("unknown job name", { jobName: job.name })
      }
    },
    { connection, concurrency: 5 },
  )

  worker.on("completed", (job) =>
    logger.info("job completed", { jobId: job.id }),
  )
  worker.on("failed", (job, err) =>
    logger.error("job failed", { jobId: job?.id, err: err?.message }),
  )
  return worker
}
