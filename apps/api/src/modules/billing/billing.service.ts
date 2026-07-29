import { createHash, randomUUID } from "node:crypto"
import {
  customerWalletStatementDescriptor,
  initialStripeFeeDisclosure,
  isCreditablePreCreditDepositStatus,
  isFinanceOperationAllowed,
  isUniqueViolation,
  isWalletCreditBackedDepositStatus,
  resolveFinanceRuntimeMode,
} from "@guestpost/shared"
import { createFinancialReference } from "@guestpost/shared/dist/financial-reference-server"
import {
  type FingerprintablePaymentDisputeEvent,
  lockWalletForUpdate,
  type NormalizedPaymentDisputeEvent,
  type PaymentDisputeOutcome,
  PaymentDisputeTransitionError,
  paymentDisputeEventFingerprint,
  paymentDisputeEventFromStoredRow,
  transitionPaymentDispute,
} from "@guestpost/shared/dist/payment-dispute-core"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/client"
import { assertApiFinanceOperationAllowed } from "../../common/finance-runtime-mode"
import { PrismaService } from "../../common/prisma.service"
import {
  assertStripeObjectMode,
  isStripeFeatureEnabled,
} from "../../common/stripe-client"
import { AuditService } from "../audit/audit.service"
import type { DepositProviderAdapter } from "./providers/deposit-provider.interface"
import { DepositProviderService } from "./providers/deposit-provider.service"
import { StripeDepositAdapter } from "./providers/stripe-deposit.adapter"

// Thrown inside an interactive transaction to force a ROLLBACK when a
// concurrent duplicate is detected via P2002. Returning normally from the
// transaction callback would COMMIT everything done before the constraint
// violation (e.g. a wallet increment) — minting money on duplicate webhooks.
class DuplicateEventError extends Error {
  constructor(reference: string) {
    super(`Duplicate event: ${reference}`)
  }
}

class DepositEvidenceError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "DepositEvidenceError"
  }
}

class PaymentProviderEventOwnershipError extends Error {
  readonly code = "PAYMENT_PROVIDER_EVENT_LEASE_LOST"

  constructor() {
    super("Payment provider event ownership changed; retry from durable state")
    this.name = "PaymentProviderEventOwnershipError"
  }
}

interface PaymentProviderEventLease {
  kind: "lease"
  attempt: number
  lockedAt: Date
}

interface PaymentProviderEventSnapshot {
  kind: "snapshot"
  status: string
  attempts: number
  lockedAt: Date | null
  processedAt: Date | null
}

function logReferenceFingerprint(value: string | null | undefined) {
  if (!value) return null
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

type PaymentProviderEventAuthority =
  | PaymentProviderEventLease
  | PaymentProviderEventSnapshot

type NormalizedStripeDisputeFacts = Omit<
  NormalizedPaymentDisputeEvent,
  | "providerEventRowId"
  | "claimAttempt"
  | "claimLockedAt"
  | "providerEventId"
  | "eventType"
  | "livemode"
  | "eventFingerprint"
>
type PersistablePaymentDisputeEvent = FingerprintablePaymentDisputeEvent & {
  eventFingerprint: string
}

interface PaymentProviderEventEnvelope {
  provider: string
  providerEventId: string
  eventType: string
  objectId: string | null
  providerPaymentId: string | null
  providerChargeId: string | null
  disputeAmountMinor: bigint | null
  disputeCurrency: string | null
  providerStatus: string | null
  livemode: boolean | null
  eventFingerprint: string
}

const PAYMENT_DISPUTE_EVENT_TYPES = new Set([
  "charge.dispute.created",
  "charge.dispute.closed",
])
const STRIPE_DISPUTE_OPEN_STATUSES = new Set([
  "needs_response",
  "under_review",
  "warning_needs_response",
  "warning_under_review",
])
const STRIPE_DISPUTE_TERMINAL_STATUSES = new Set([
  "won",
  "lost",
  "prevented",
  "warning_closed",
])
const PAYMENT_PROVIDER_EVENT_LEASE_MS = 15 * 60 * 1000
const STRIPE_DISPUTE_MINOR_UNIT_FACTORS: Readonly<Record<string, number>> =
  Object.freeze({
    // USD is the only customer-wallet funding currency currently certified by
    // the Stripe adapter. Add currencies here only after their exponent and
    // end-to-end wallet support are explicitly certified.
    USD: 100,
  })

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name)
  private readonly depositProvider: DepositProviderAdapter

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    providerService?: DepositProviderService,
  ) {
    // The fallback keeps isolated unit construction lightweight; Nest runtime
    // always supplies the registry from BillingModule.
    this.depositProvider =
      providerService?.getAdapter("stripe") ?? new StripeDepositAdapter()
  }

  private paymentProviderEventDate(value: unknown): Date | null {
    if (value == null) return null
    const parsed = value instanceof Date ? value : new Date(value as any)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }

  private paymentProviderEventSnapshot(
    event: any,
  ): PaymentProviderEventSnapshot {
    if (
      !event ||
      typeof event.status !== "string" ||
      !Number.isSafeInteger(event.attempts) ||
      event.attempts < 0
    ) {
      throw new PaymentProviderEventOwnershipError()
    }
    const lockedAt = this.paymentProviderEventDate(event.lockedAt)
    const processedAt = this.paymentProviderEventDate(event.processedAt)
    if (
      !["PROCESSED", "IGNORED", "QUARANTINED"].includes(event.status) ||
      event.lockedAt != null ||
      !processedAt
    ) {
      throw new PaymentProviderEventOwnershipError()
    }
    return {
      kind: "snapshot",
      status: event.status,
      attempts: event.attempts,
      lockedAt,
      processedAt,
    }
  }

  private paymentProviderEventLease(event: any): PaymentProviderEventLease {
    const lockedAt = this.paymentProviderEventDate(event?.lockedAt)
    if (
      event?.status !== "PROCESSING" ||
      !Number.isSafeInteger(event?.attempts) ||
      event.attempts <= 0 ||
      !lockedAt
    ) {
      throw new PaymentProviderEventOwnershipError()
    }
    return {
      kind: "lease",
      attempt: event.attempts,
      lockedAt,
    }
  }

  private paymentProviderEventAuthorityWhere(
    providerEventRowId: string,
    authority: PaymentProviderEventAuthority,
  ): Record<string, unknown> {
    if (authority.kind === "lease") {
      return {
        id: providerEventRowId,
        status: "PROCESSING",
        attempts: authority.attempt,
        lockedAt: authority.lockedAt,
      }
    }
    return {
      id: providerEventRowId,
      status: authority.status,
      attempts: authority.attempts,
      lockedAt: authority.lockedAt,
      processedAt: authority.processedAt,
    }
  }

  private paymentProviderEventAuthorityMatches(
    event: any,
    authority: PaymentProviderEventAuthority,
  ): boolean {
    if (!event) return false
    const lockedAt = this.paymentProviderEventDate(event.lockedAt)
    if (authority.kind === "lease") {
      return (
        event.status === "PROCESSING" &&
        event.attempts === authority.attempt &&
        lockedAt?.getTime() === authority.lockedAt.getTime()
      )
    }
    const processedAt = this.paymentProviderEventDate(event.processedAt)
    return (
      event.status === authority.status &&
      event.attempts === authority.attempts &&
      (lockedAt?.getTime() ?? null) ===
        (authority.lockedAt?.getTime() ?? null) &&
      (processedAt?.getTime() ?? null) ===
        (authority.processedAt?.getTime() ?? null)
    )
  }

  private async lockAndAssertPaymentProviderEventAuthority(
    tx: any,
    providerEventRowId: string,
    authority: PaymentProviderEventAuthority,
  ): Promise<any> {
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "PaymentProviderEvent" WHERE "id" = $1 FOR UPDATE',
      providerEventRowId,
    )
    const event = await tx.paymentProviderEvent.findUnique({
      where: { id: providerEventRowId },
    })
    if (!this.paymentProviderEventAuthorityMatches(event, authority)) {
      throw new PaymentProviderEventOwnershipError()
    }
    return event
  }

  private async assertPaymentProviderEventTerminalSnapshot(
    providerEventRowId: string,
    snapshot: PaymentProviderEventSnapshot,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx: any) => {
      await this.lockAndAssertPaymentProviderEventAuthority(
        tx,
        providerEventRowId,
        snapshot,
      )
    })
  }

  private async completePaymentProviderEventLease(
    tx: any,
    providerEventRowId: string,
    lease: PaymentProviderEventLease,
    data: Record<string, unknown>,
  ): Promise<void> {
    const completed = await tx.paymentProviderEvent.updateMany({
      where: this.paymentProviderEventAuthorityWhere(providerEventRowId, lease),
      data,
    })
    if (completed.count !== 1) {
      throw new PaymentProviderEventOwnershipError()
    }
  }

  private async ignoreUnsupportedPaymentProviderEvent(
    providerEvent: any,
    now: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx: any) => {
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "PaymentProviderEvent" WHERE "id" = $1 FOR UPDATE',
        providerEvent.id,
      )
      const current = await tx.paymentProviderEvent.findUnique({
        where: { id: providerEvent.id },
      })
      const expectedLockedAt = this.paymentProviderEventDate(
        providerEvent.lockedAt,
      )
      const currentLockedAt = this.paymentProviderEventDate(current?.lockedAt)
      if (
        !current ||
        current.status !== providerEvent.status ||
        current.attempts !== providerEvent.attempts ||
        (currentLockedAt?.getTime() ?? null) !==
          (expectedLockedAt?.getTime() ?? null)
      ) {
        throw new PaymentProviderEventOwnershipError()
      }

      let claimFromStatus = current.status
      if (current.status === "PROCESSING") {
        if (
          !currentLockedAt ||
          currentLockedAt.getTime() >=
            now.getTime() - PAYMENT_PROVIDER_EVENT_LEASE_MS
        ) {
          throw new PaymentProviderEventOwnershipError()
        }
        const recovered = await tx.paymentProviderEvent.updateMany({
          where: {
            id: current.id,
            status: "PROCESSING",
            attempts: current.attempts,
            lockedAt: currentLockedAt,
          },
          data: {
            status: "FAILED",
            availableAt: now,
            lockedAt: null,
            lastError: "STALE_PROCESSING_LEASE",
          },
        })
        if (recovered.count !== 1) {
          throw new PaymentProviderEventOwnershipError()
        }
        claimFromStatus = "FAILED"
      } else if (
        (current.status !== "PENDING" && current.status !== "FAILED") ||
        current.lockedAt != null
      ) {
        throw new PaymentProviderEventOwnershipError()
      }

      const claimed = await tx.paymentProviderEvent.updateMany({
        where: {
          id: current.id,
          status: claimFromStatus,
          attempts: current.attempts,
          lockedAt: null,
        },
        data: {
          status: "PROCESSING",
          attempts: { increment: 1 },
          lockedAt: now,
          lastError: null,
        },
      })
      if (claimed.count !== 1) {
        throw new PaymentProviderEventOwnershipError()
      }
      await this.completePaymentProviderEventLease(
        tx,
        current.id,
        {
          kind: "lease",
          attempt: current.attempts + 1,
          lockedAt: now,
        },
        {
          status: "IGNORED",
          processedAt: now,
          lockedAt: null,
          lastError: "UNSUPPORTED_EVENT_TYPE",
        },
      )
    })
  }

  private assertWalletOwned(
    wallet: { organizationId: string | null; userId: string | null },
    user: { id: string; organizationId?: string | null },
  ) {
    const owned =
      (wallet.organizationId &&
        wallet.organizationId === user.organizationId) ||
      (!wallet.organizationId && wallet.userId === user.id)
    if (!owned)
      throw new ForbiddenException("Wallet does not belong to this account")
  }

  async createCheckoutSession(
    walletId: string,
    amount: number,
    user: any,
    idempotencyKey?: string,
  ) {
    assertApiFinanceOperationAllowed("new_liability")
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
    })
    if (!wallet) throw new NotFoundException("Wallet not found")

    this.assertWalletOwned(wallet, user)

    if (!isStripeFeatureEnabled("deposits")) {
      throw new BadRequestException("Card deposits are temporarily unavailable")
    }
    if (
      !this.depositProvider.capabilities.supportedCurrencies.includes(
        wallet.currency.toUpperCase(),
      )
    ) {
      throw new BadRequestException(
        `Card deposits do not support ${wallet.currency.toUpperCase()}`,
      )
    }

    const amountDecimal = new Decimal(amount)
    const amountMinorDecimal = amountDecimal.mul(100)
    if (
      !amountDecimal.isFinite() ||
      amountDecimal.lessThanOrEqualTo(0) ||
      !amountMinorDecimal.isInteger()
    ) {
      throw new BadRequestException(
        "Deposit amount must be positive with no more than two decimal places",
      )
    }
    const amountMinor = amountMinorDecimal.toNumber()
    if (!Number.isSafeInteger(amountMinor)) {
      throw new BadRequestException("Deposit amount is outside the safe range")
    }

    const requestKey = (idempotencyKey?.trim() || randomUUID()).slice(0, 191)
    const depositAttempt = (this.prisma as any).depositAttempt
    const existing = await depositAttempt.findUnique({
      where: {
        walletId_idempotencyKey: { walletId, idempotencyKey: requestKey },
      },
    })
    if (
      existing &&
      (!new Decimal(existing.amount).equals(amountDecimal) ||
        existing.currency !== wallet.currency.toUpperCase())
    ) {
      throw new ConflictException(
        "This deposit request key was already used for a different amount or currency",
      )
    }
    if (existing?.providerSessionId) {
      const existingSession = await this.depositProvider.retrieveSession(
        existing.providerSessionId,
      )
      if (existingSession.url && existingSession.status === "open") {
        return {
          url: existingSession.url,
          publicReference: existing.publicReference,
          statementDescriptor: customerWalletStatementDescriptor(
            existing.publicReference,
          ),
          feePolicy: initialStripeFeeDisclosure(amountMinor),
        }
      }
      throw new ConflictException(
        "This deposit request has already been used; start a new deposit",
      )
    }

    let attempt: any
    try {
      attempt = await depositAttempt.create({
        data: {
          publicReference: createFinancialReference("DP"),
          walletId,
          organizationId: wallet.organizationId,
          createdByUserId: user.id,
          method: "CARD",
          provider: "stripe",
          amount: amountDecimal,
          walletCredit: amountDecimal,
          customerFee: 0,
          currency: wallet.currency.toUpperCase(),
          status: "CREATED",
          idempotencyKey: requestKey,
        },
      })
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      attempt = await depositAttempt.findUnique({
        where: {
          walletId_idempotencyKey: { walletId, idempotencyKey: requestKey },
        },
      })
      if (!attempt) throw error
      if (
        !new Decimal(attempt.amount).equals(amountDecimal) ||
        attempt.currency !== wallet.currency.toUpperCase()
      ) {
        throw new ConflictException(
          "This deposit request key was already used for a different amount or currency",
        )
      }
    }

    const portalUrl =
      process.env.NEXT_PUBLIC_PORTAL_URL || "http://localhost:3001"
    try {
      const session = await this.depositProvider.createSession({
        attemptId: attempt.id,
        publicReference: attempt.publicReference,
        walletId,
        organizationId: wallet.organizationId,
        userId: user.id,
        amountMinor,
        currency: wallet.currency,
        idempotencyKey: `deposit-session-${attempt.id}`,
        successUrl: `${portalUrl}/dashboard/billing?success=true`,
        cancelUrl: `${portalUrl}/dashboard/billing?canceled=true`,
      })

      await depositAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "PENDING_CUSTOMER_ACTION",
          providerSessionId: session.providerSessionId,
          providerPaymentId: session.providerPaymentId,
          expiresAt: session.expiresAt,
        },
      })

      return {
        url: session.url,
        publicReference: attempt.publicReference,
        statementDescriptor: customerWalletStatementDescriptor(
          attempt.publicReference,
        ),
        feePolicy: initialStripeFeeDisclosure(amountMinor),
      }
    } catch (error) {
      await depositAttempt.updateMany({
        where: { id: attempt.id, status: "CREATED" },
        data: { status: "FAILED", failedAt: new Date() },
      })
      this.logger.error("Stripe deposit session creation failed", {
        depositAttemptId: attempt.id,
        errorType: error instanceof Error ? error.name : "UnknownError",
      })
      throw new BadRequestException(
        "Unable to start the secure card checkout. Please try again.",
      )
    }
  }

  async handleWebhook(signature: string, payload: Buffer) {
    assertApiFinanceOperationAllowed("inbound_evidence")
    const financeMode = resolveFinanceRuntimeMode(
      process.env.FINANCE_RUNTIME_MODE,
      process.env.NODE_ENV,
    ).mode
    if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
      this.logger.error(
        "Stripe deposit webhook received without verification configuration",
      )
      throw new BadRequestException("Webhook verification is not configured")
    }

    let event: any
    try {
      event = this.depositProvider.verifyWebhook(signature, payload)
      assertStripeObjectMode(event.livemode, "Stripe webhook Event")
    } catch {
      throw new BadRequestException("Invalid Stripe webhook signature or mode")
    }

    const object = event.data?.object ?? {}
    const rawEventType = typeof event.type === "string" ? event.type.trim() : ""
    const eventType = rawEventType
      ? rawEventType.length <= 191
        ? rawEventType
        : `sha256:${createHash("sha256").update(rawEventType).digest("hex")}`
      : "unknown"
    const rawProviderEventId =
      typeof event.id === "string" ? event.id.trim() : ""
    const providerEventId =
      rawProviderEventId.length > 191
        ? `sha256:${createHash("sha256")
            .update(rawProviderEventId)
            .digest("hex")}`
        : rawProviderEventId ||
          `payload:${createHash("sha256").update(payload).digest("hex")}`
    const rawObjectId =
      typeof object.id === "string" &&
      object.id.trim() &&
      object.id.trim().length <= 191
        ? object.id.trim()
        : null
    const isDisputeEvent = this.isPaymentDisputeEventType(eventType)
    const isDepositSuccessEvent =
      eventType === "checkout.session.completed" ||
      eventType === "checkout.session.async_payment_succeeded"
    const isDepositFailureEvent =
      eventType === "checkout.session.expired" ||
      eventType === "checkout.session.async_payment_failed"
    const isEarlyFraudWarningEvent =
      eventType === "radar.early_fraud_warning.created"
    const isReplayableDisputeEvent = isDisputeEvent
    const isSupportedNonReplayableEvent =
      isDepositSuccessEvent || isDepositFailureEvent || isEarlyFraudWarningEvent
    let disputeEnvelope: PersistablePaymentDisputeEvent | null = null
    let quarantineReason: string | null = null

    if (isDisputeEvent) {
      try {
        disputeEnvelope = this.normalizeStripeDisputeEvent(
          object,
          eventType,
          providerEventId,
          event.livemode,
        )
      } catch (error) {
        quarantineReason =
          error instanceof PaymentDisputeTransitionError
            ? error.code
            : "INVALID_DISPUTE_ENVELOPE"
      }
    }

    const receivedAt = new Date()
    const createData = {
      provider: "stripe",
      providerEventId,
      eventType,
      objectId: disputeEnvelope?.providerDisputeId ?? rawObjectId,
      // Correlation is attached only after the signed dispute facts have been
      // matched to a durable deposit. Never trust dispute metadata as an FK.
      depositAttemptId: null,
      providerPaymentId: disputeEnvelope?.providerPaymentId ?? null,
      providerChargeId: disputeEnvelope?.providerChargeId ?? null,
      disputeAmountMinor: disputeEnvelope?.amountMinor ?? null,
      disputeCurrency: disputeEnvelope?.currency ?? null,
      providerStatus: disputeEnvelope?.providerStatus ?? null,
      // Persist mode for every verified Stripe event. Provider event IDs and
      // payload fingerprints are not a substitute for an explicit test/live
      // boundary during replay and incident response.
      livemode: event.livemode,
      eventFingerprint:
        disputeEnvelope?.eventFingerprint ??
        createHash("sha256").update(payload).digest("hex"),
      status: quarantineReason ? "QUARANTINED" : "PENDING",
      attempts: 0,
      lockedAt: null,
      processedAt: quarantineReason ? receivedAt : null,
      lastError: quarantineReason,
    }

    const providerEvents = (this.prisma as any).paymentProviderEvent
    let providerEvent: any
    let duplicate = false
    try {
      providerEvent = await providerEvents.create({ data: createData })
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      duplicate = true
      providerEvent = await providerEvents.findUnique({
        where: {
          provider_providerEventId: {
            provider: "stripe",
            providerEventId,
          },
        },
      })
      if (!providerEvent) throw error
      if (!this.providerEventEnvelopeMatches(providerEvent, createData)) {
        const collision = await this.recordPaymentProviderEventIdentityConflict(
          providerEvent.id,
          createData,
        )
        providerEvent = collision.event
        if (collision.identityConflict) {
          return {
            received: true,
            duplicate: true,
            identityConflict: true,
            quarantined: collision.quarantined,
            canonicalEvidenceRetained: collision.canonicalEvidenceRetained,
          }
        }
      }
      if (
        providerEvent.status === "PROCESSED" ||
        providerEvent.status === "IGNORED" ||
        providerEvent.status === "QUARANTINED"
      ) {
        const terminalSnapshot =
          this.paymentProviderEventSnapshot(providerEvent)
        if (isDepositSuccessEvent && providerEvent.status === "PROCESSED") {
          if (!isFinanceOperationAllowed(financeMode, "recovery")) {
            await this.assertPaymentProviderEventTerminalSnapshot(
              providerEvent.id,
              terminalSnapshot,
            )
            return {
              received: true,
              duplicate: true,
              deferred: true,
            }
          }
          await this.processSuccessfulPayment(
            object,
            providerEvent.id,
            terminalSnapshot,
          )
          const finalEvent = await providerEvents.findUnique({
            where: { id: providerEvent.id },
            select: { status: true },
          })
          return {
            received: true,
            duplicate: true,
            quarantined: finalEvent?.status === "QUARANTINED",
          }
        }
        if (isDepositSuccessEvent && providerEvent.status === "IGNORED") {
          await this.quarantinePaymentProviderEvent(
            providerEvent.id,
            "DEPOSIT_SUCCESS_EVENT_IGNORED",
            terminalSnapshot,
          )
          return {
            received: true,
            duplicate: true,
            quarantined: true,
          }
        }
        await this.assertPaymentProviderEventTerminalSnapshot(
          providerEvent.id,
          terminalSnapshot,
        )
        return {
          received: true,
          duplicate: true,
          quarantined: providerEvent.status === "QUARANTINED",
        }
      }
    }

    if (quarantineReason) {
      await this.quarantinePaymentProviderEvent(
        providerEvent.id,
        quarantineReason,
        this.paymentProviderEventSnapshot(providerEvent),
      )
      return { received: true, duplicate, quarantined: true }
    }

    // Locked mode remains an evidence-ingestion boundary. Dispute envelopes
    // retain every immutable fact needed by the durable worker, so they may be
    // acknowledged and recovered later. The normalized checkout inbox does not
    // retain enough session facts to credit a deposit independently. Returning
    // 2xx for a new/PENDING checkout-success event would stop Stripe redelivery
    // and could strand a paid customer permanently, so persist it and ask the
    // provider to retry.
    if (!isFinanceOperationAllowed(financeMode, "recovery")) {
      if (isReplayableDisputeEvent) {
        if (
          (providerEvent.status === "PENDING" ||
            providerEvent.status === "FAILED") &&
          providerEvent.lockedAt == null
        ) {
          return { received: true, duplicate, deferred: true }
        }
        throw new ServiceUnavailableException(
          "Payment dispute event is already being processed; retry delivery",
        )
      }
      if (!isSupportedNonReplayableEvent) {
        if (
          !Number.isSafeInteger(providerEvent.attempts) ||
          providerEvent.attempts < 0
        ) {
          throw new ServiceUnavailableException(
            "Payment provider event has an invalid claim counter",
          )
        }
        await this.ignoreUnsupportedPaymentProviderEvent(
          providerEvent,
          new Date(),
        )
        return { received: true, duplicate, ignored: true }
      }
      throw new ServiceUnavailableException({
        code: "FINANCE_OPERATION_BLOCKED",
        message:
          isDepositSuccessEvent || isDepositFailureEvent
            ? "Deposit evidence was persisted while finance processing is locked; retry delivery"
            : "Provider evidence was persisted while finance processing is locked; retry delivery",
      })
    }

    const now = new Date()
    await providerEvents.updateMany({
      where: {
        id: providerEvent.id,
        status: "PROCESSING",
        lockedAt: {
          lt: new Date(now.getTime() - PAYMENT_PROVIDER_EVENT_LEASE_MS),
        },
      },
      data: {
        status: "FAILED",
        lockedAt: null,
        availableAt: now,
        lastError: "STALE_PROCESSING_LEASE",
      },
    })
    const previousAttempts = Number(providerEvent.attempts)
    if (!Number.isSafeInteger(previousAttempts) || previousAttempts < 0) {
      throw new ServiceUnavailableException(
        "Payment provider event has an invalid claim counter",
      )
    }
    const claimed = await providerEvents.updateMany({
      where: {
        id: providerEvent.id,
        status: { in: ["PENDING", "FAILED"] },
        attempts: previousAttempts,
        lockedAt: null,
        availableAt: { lte: now },
      },
      data: {
        status: "PROCESSING",
        lockedAt: now,
        attempts: { increment: 1 },
        lastError: null,
      },
    })
    if (claimed.count !== 1) {
      // A PROCESSING row belongs to another exact lease. It is not a terminal
      // replay and must never receive a 2xx acknowledgement: the current owner
      // may still roll back or crash. Provider redelivery is the recovery
      // mechanism for non-dispute payloads that are not stored in this inbox.
      throw new ServiceUnavailableException(
        "Payment provider event is already being processed; retry delivery",
      )
    }
    const lease: PaymentProviderEventLease = {
      kind: "lease",
      attempt: previousAttempts + 1,
      lockedAt: now,
    }

    try {
      if (
        eventType === "checkout.session.completed" ||
        eventType === "checkout.session.async_payment_succeeded"
      ) {
        await this.processSuccessfulPayment(object, providerEvent.id, lease)
      } else if (
        eventType === "checkout.session.expired" ||
        eventType === "checkout.session.async_payment_failed"
      ) {
        await this.markDepositAttemptFromSession(
          object,
          "EXPIRED",
          providerEvent.id,
          lease,
        )
      } else if (isDisputeEvent) {
        await this.processPaymentDisputeEvent(providerEvent.id, lease)
      } else if (isEarlyFraudWarningEvent) {
        await this.handleEarlyFraudWarning(event, providerEvent.id, lease)
      } else {
        const ignored = await providerEvents.updateMany({
          where: this.paymentProviderEventAuthorityWhere(
            providerEvent.id,
            lease,
          ),
          data: {
            status: "IGNORED",
            lockedAt: null,
            processedAt: new Date(),
            lastError: "UNSUPPORTED_EVENT_TYPE",
          },
        })
        if (ignored.count !== 1) {
          throw new PaymentProviderEventOwnershipError()
        }
        return { received: true, ignored: true }
      }
    } catch (error) {
      if (
        isDisputeEvent &&
        error instanceof PaymentDisputeTransitionError &&
        !error.retryable
      ) {
        await this.quarantinePaymentProviderEvent(
          providerEvent.id,
          error.code,
          lease,
        )
        return { received: true, quarantined: true }
      }
      const retryDelayMs = Math.min(
        10 * 60 * 1000,
        30 * 1000 * 2 ** Math.max(0, lease.attempt - 1),
      )
      const failed = await providerEvents.updateMany({
        where: {
          ...this.paymentProviderEventAuthorityWhere(providerEvent.id, lease),
        },
        data: {
          status: "FAILED",
          lockedAt: null,
          availableAt: new Date(Date.now() + retryDelayMs),
          lastError: this.safeProviderEventError(error),
        },
      })
      if (failed.count !== 1) {
        throw new ServiceUnavailableException({
          code: "PAYMENT_PROVIDER_EVENT_LEASE_LOST",
          message:
            "Payment provider event ownership changed; retry from durable state",
        })
      }
      throw error
    }

    return { received: true }
  }

  private async markDepositAttemptFromSession(
    session: any,
    status: "EXPIRED",
    providerEventRowId: string,
    lease: PaymentProviderEventLease,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx: any) => {
      await this.lockAndAssertPaymentProviderEventAuthority(
        tx,
        providerEventRowId,
        lease,
      )
      await tx.depositAttempt.updateMany({
        where: {
          OR: [
            { id: session.metadata?.depositAttemptId ?? "__missing__" },
            { providerSessionId: session.id },
          ],
          status: { in: ["CREATED", "PENDING_CUSTOMER_ACTION", "PROCESSING"] },
        },
        data: { status, failedAt: new Date() },
      })
      await this.completePaymentProviderEventLease(
        tx,
        providerEventRowId,
        lease,
        {
          status: "PROCESSED",
          processedAt: new Date(),
          lockedAt: null,
          lastError: null,
        },
      )
    })
  }

  private isPaymentDisputeEventType(
    eventType: string,
  ): eventType is NormalizedPaymentDisputeEvent["eventType"] {
    return PAYMENT_DISPUTE_EVENT_TYPES.has(eventType)
  }

  private stripeObjectId(value: unknown, field: string): string {
    const id =
      typeof value === "string"
        ? value.trim()
        : value &&
            typeof value === "object" &&
            typeof (value as { id?: unknown }).id === "string"
          ? (value as { id: string }).id.trim()
          : ""
    if (!id || id.length > 191) {
      throw new BadRequestException(`Stripe dispute has an invalid ${field}`)
    }
    return id
  }

  private normalizeStripeDispute(
    dispute: unknown,
  ): NormalizedStripeDisputeFacts {
    const payload =
      dispute && typeof dispute === "object"
        ? (dispute as Record<string, unknown>)
        : {}
    const providerDisputeId = this.stripeObjectId(payload.id, "id")
    const providerPaymentId = this.stripeObjectId(
      payload.payment_intent,
      "payment_intent",
    )
    const providerChargeId =
      payload.charge == null
        ? null
        : this.stripeObjectId(payload.charge, "charge")
    if (
      typeof payload.amount !== "number" ||
      !Number.isSafeInteger(payload.amount) ||
      payload.amount <= 0
    ) {
      throw new BadRequestException(
        "Stripe dispute amount must be a positive safe integer",
      )
    }
    const currency =
      typeof payload.currency === "string"
        ? payload.currency.trim().toUpperCase()
        : ""
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new BadRequestException("Stripe dispute currency is invalid")
    }
    const minorUnitFactor = STRIPE_DISPUTE_MINOR_UNIT_FACTORS[currency]
    if (
      !minorUnitFactor ||
      !this.depositProvider.capabilities.supportedCurrencies.includes(currency)
    ) {
      throw new BadRequestException(
        `Stripe dispute currency ${currency} is not certified for customer wallets`,
      )
    }
    const providerStatus =
      typeof payload.status === "string" ? payload.status.trim() : ""
    if (!providerStatus || providerStatus.length > 64) {
      throw new BadRequestException("Stripe dispute status is invalid")
    }
    return {
      provider: "stripe",
      providerDisputeId,
      providerPaymentId,
      providerChargeId,
      amountMinor: BigInt(payload.amount),
      amount: new Decimal(payload.amount).div(minorUnitFactor).toFixed(2),
      currency,
      providerStatus,
    }
  }

  private assertDisputeStatusMatchesEvent(
    eventType: NormalizedPaymentDisputeEvent["eventType"],
    providerStatus: string,
  ): void {
    const valid =
      eventType === "charge.dispute.created"
        ? STRIPE_DISPUTE_OPEN_STATUSES.has(providerStatus)
        : STRIPE_DISPUTE_TERMINAL_STATUSES.has(providerStatus)
    if (!valid) {
      throw new PaymentDisputeTransitionError(
        "EVENT_ENVELOPE_MISMATCH",
        "Stripe dispute event type does not match its provider status",
        false,
      )
    }
  }

  private normalizeStripeDisputeEvent(
    dispute: unknown,
    eventType: NormalizedPaymentDisputeEvent["eventType"],
    providerEventId: string,
    livemode: boolean,
  ): PersistablePaymentDisputeEvent {
    const facts = this.normalizeStripeDispute(dispute)
    this.assertDisputeStatusMatchesEvent(eventType, facts.providerStatus)
    const fingerprintable: FingerprintablePaymentDisputeEvent = {
      ...facts,
      providerEventId,
      eventType,
      livemode,
    }
    return {
      ...fingerprintable,
      eventFingerprint: paymentDisputeEventFingerprint(fingerprintable),
    }
  }

  private providerEventEnvelopeMatches(
    existing: any,
    expected: PaymentProviderEventEnvelope,
  ): boolean {
    return (
      existing.provider === expected.provider &&
      existing.providerEventId === expected.providerEventId &&
      existing.eventType === expected.eventType &&
      (existing.objectId ?? null) === expected.objectId &&
      (existing.providerPaymentId ?? null) === expected.providerPaymentId &&
      (existing.providerChargeId ?? null) === expected.providerChargeId &&
      (existing.disputeAmountMinor == null
        ? null
        : String(existing.disputeAmountMinor)) ===
        (expected.disputeAmountMinor == null
          ? null
          : String(expected.disputeAmountMinor)) &&
      (existing.disputeCurrency ?? null) === expected.disputeCurrency &&
      (existing.providerStatus ?? null) === expected.providerStatus &&
      (existing.livemode ?? null) === expected.livemode &&
      (existing.eventFingerprint ?? null) === expected.eventFingerprint
    )
  }

  /**
   * Resolve a verified duplicate identity under the inbox-row lock.
   *
   * A designated dispute role event is canonical accounting evidence: the
   * deferred database constraint requires it to remain PROCESSED for as long
   * as the case points at it. A later signed envelope that reuses its provider
   * identity is therefore recorded as a durable incident without rewriting
   * that evidence. Non-canonical collisions may still be quarantined.
   */
  private async recordPaymentProviderEventIdentityConflict(
    providerEventRowId: string,
    incoming: PaymentProviderEventEnvelope,
  ): Promise<{
    event: any
    identityConflict: boolean
    quarantined: boolean
    canonicalEvidenceRetained: boolean
  }> {
    return this.prisma.$transaction(async (tx: any) => {
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "PaymentProviderEvent" WHERE "id" = $1 FOR UPDATE',
        providerEventRowId,
      )
      const event = await tx.paymentProviderEvent.findUnique({
        where: { id: providerEventRowId },
        include: {
          openedPaymentDispute: { select: { id: true } },
          resolvedPaymentDispute: { select: { id: true } },
        },
      })
      if (!event) throw new PaymentProviderEventOwnershipError()

      // Recheck only after obtaining the row lock. This prevents a stale
      // pre-lock observation from authorizing either quarantine or an alert.
      if (this.providerEventEnvelopeMatches(event, incoming)) {
        return {
          event,
          identityConflict: false,
          quarantined: event.status === "QUARANTINED",
          canonicalEvidenceRetained: false,
        }
      }

      const openedPaymentDisputeId = event.openedPaymentDispute?.id ?? null
      const resolvedPaymentDisputeId = event.resolvedPaymentDispute?.id ?? null
      const canonicalEvidenceRetained =
        event.status === "PROCESSED" &&
        (openedPaymentDisputeId != null || resolvedPaymentDisputeId != null)

      if (!canonicalEvidenceRetained && event.status !== "QUARANTINED") {
        const quarantined = await tx.paymentProviderEvent.updateMany({
          where: {
            id: event.id,
            status: event.status,
            attempts: event.attempts,
            lockedAt: event.lockedAt,
            processedAt: event.processedAt,
          },
          data: {
            status: "QUARANTINED",
            processedAt: ["PROCESSED", "IGNORED"].includes(event.status)
              ? event.processedAt
              : new Date(),
            lockedAt: null,
            lastError: "DUPLICATE_EVENT_ENVELOPE_MISMATCH",
          },
        })
        if (quarantined.count !== 1) {
          throw new PaymentProviderEventOwnershipError()
        }
      }

      const action = canonicalEvidenceRetained
        ? "PAYMENT_PROVIDER_EVENT_IDENTITY_CONFLICT_DETECTED"
        : "PAYMENT_PROVIDER_EVENT_IDENTITY_CONFLICT_QUARANTINED"
      const existingIncident = await tx.auditLog.findFirst({
        where: {
          action,
          entityType: "PaymentProviderEvent",
          entityId: event.id,
        },
        select: { id: true },
      })
      if (!existingIncident) {
        await this.audit.log(
          {
            action,
            entityType: "PaymentProviderEvent",
            entityId: event.id,
            metadata: {
              provider: event.provider,
              providerEventId: event.providerEventId,
              canonicalEvidenceRetained,
              openedPaymentDisputeId,
              resolvedPaymentDisputeId,
              existingStatus: event.status,
              existingEventType: event.eventType,
              incomingEventType: incoming.eventType,
              existingObjectId: event.objectId ?? null,
              incomingObjectId: incoming.objectId,
              existingProviderPaymentId: event.providerPaymentId ?? null,
              incomingProviderPaymentId: incoming.providerPaymentId,
              existingProviderChargeId: event.providerChargeId ?? null,
              incomingProviderChargeId: incoming.providerChargeId,
              existingDisputeAmountMinor:
                event.disputeAmountMinor == null
                  ? null
                  : String(event.disputeAmountMinor),
              incomingDisputeAmountMinor:
                incoming.disputeAmountMinor == null
                  ? null
                  : String(incoming.disputeAmountMinor),
              existingDisputeCurrency: event.disputeCurrency ?? null,
              incomingDisputeCurrency: incoming.disputeCurrency,
              existingProviderStatus: event.providerStatus ?? null,
              incomingProviderStatus: incoming.providerStatus,
              existingLivemode: event.livemode ?? null,
              incomingLivemode: incoming.livemode,
              existingEventFingerprint: event.eventFingerprint ?? null,
              incomingEventFingerprint: incoming.eventFingerprint,
            },
            userId: null,
            organizationId: null,
          },
          tx,
        )
      }
      await this.notifyStaffInTransaction(
        tx,
        "PAYMENT_PROVIDER_EVENT_IDENTITY_CONFLICT",
        canonicalEvidenceRetained
          ? `Verified payment provider event identity conflict for ${event.providerEventId}; canonical dispute evidence was retained.`
          : `Verified payment provider event identity conflict for ${event.providerEventId}; the non-canonical inbox event was quarantined.`,
        `payment-provider-event-identity-conflict:${event.id}`,
      )

      return {
        event,
        identityConflict: true,
        quarantined: !canonicalEvidenceRetained,
        canonicalEvidenceRetained,
      }
    })
  }

  private paymentDisputeInputFromProviderEvent(
    event: any,
  ): NormalizedPaymentDisputeEvent {
    return paymentDisputeEventFromStoredRow(event)
  }
  private async processPaymentDisputeEvent(
    providerEventRowId: string,
    lease: PaymentProviderEventLease,
  ): Promise<PaymentDisputeOutcome> {
    assertApiFinanceOperationAllowed("recovery")
    const event = await (this.prisma as any).paymentProviderEvent.findUnique({
      where: { id: providerEventRowId },
    })
    if (!this.paymentProviderEventAuthorityMatches(event, lease)) {
      throw new PaymentProviderEventOwnershipError()
    }
    const input = this.paymentDisputeInputFromProviderEvent(event)
    return transitionPaymentDispute(
      this.prisma,
      {
        audit: async (tx, auditInput) => {
          await this.audit.log(auditInput, tx)
        },
        notifyFinance: async (tx, notification) => {
          await this.notifyStaffInTransaction(
            tx,
            notification.type,
            notification.message,
            notification.dedupKeyPrefix,
          )
        },
      },
      input,
    )
  }

  private safeProviderEventError(error: unknown): string {
    if (error instanceof PaymentDisputeTransitionError) return error.code
    if (error instanceof PaymentProviderEventOwnershipError) return error.code
    if (error instanceof BadRequestException) return "INVALID_PROVIDER_EVENT"
    return "PROVIDER_EVENT_PROCESSING_FAILED"
  }

  private async quarantinePaymentProviderEvent(
    providerEventRowId: string,
    reason: string,
    authority: PaymentProviderEventAuthority,
  ): Promise<void> {
    const safeReason = reason.slice(0, 100)
    await this.prisma.$transaction(async (tx: any) => {
      const event = await this.lockAndAssertPaymentProviderEventAuthority(
        tx,
        providerEventRowId,
        authority,
      )
      if (event.status !== "QUARANTINED") {
        const quarantined = await tx.paymentProviderEvent.updateMany({
          where: this.paymentProviderEventAuthorityWhere(
            providerEventRowId,
            authority,
          ),
          data: {
            status: "QUARANTINED",
            processedAt: event.processedAt ?? new Date(),
            lockedAt: null,
            lastError: safeReason,
          },
        })
        if (quarantined.count !== 1) {
          throw new PaymentProviderEventOwnershipError()
        }
      }
      await this.audit.log(
        {
          action: "PAYMENT_PROVIDER_EVENT_QUARANTINED",
          entityType: "PaymentProviderEvent",
          entityId: event.id,
          metadata: {
            provider: event.provider,
            providerEventId: event.providerEventId,
            eventType: event.eventType,
            previousStatus: event.status,
            reason: safeReason,
          },
          userId: null,
          organizationId: null,
        },
        tx,
      )
      await this.notifyStaffInTransaction(
        tx,
        "PAYMENT_PROVIDER_EVENT_QUARANTINED",
        `Payment provider event ${event.providerEventId} was quarantined (${safeReason}). Finance review is required.`,
        `payment-provider-event-quarantine:${event.id}:${safeReason}`,
      )
    })
  }

  private async notifyStaffInTransaction(
    tx: any,
    type: string,
    message: string,
    dedupKeyPrefix: string,
  ): Promise<void> {
    const staff = await tx.staffMembership.findMany({
      where: { role: { in: ["FINANCE", "SUPER_ADMIN"] } },
      select: { userId: true },
    })
    if (staff.length === 0) return
    await tx.notification.createMany({
      data: staff.map((member: { userId: string }) => ({
        userId: member.userId,
        organizationId: null,
        type,
        message,
        dedupKey: `${dedupKeyPrefix}:${member.userId}`,
      })),
      skipDuplicates: true,
    })
  }

  // These wrappers preserve a narrow test seam while still proving that the
  // supplied provider object exactly matches the durable normalized inbox row.
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: exercised through the intentionally narrow regression-test seam
  private async handleChargeback(
    dispute: unknown,
    providerEventRowId: string,
  ): Promise<PaymentDisputeOutcome> {
    return this.handleDisputeTestSeam(
      dispute,
      providerEventRowId,
      "charge.dispute.created",
    )
  }

  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: exercised through the intentionally narrow regression-test seam
  private async handleChargebackClosed(
    dispute: unknown,
    providerEventRowId: string,
  ): Promise<PaymentDisputeOutcome> {
    return this.handleDisputeTestSeam(
      dispute,
      providerEventRowId,
      "charge.dispute.closed",
    )
  }

  private async handleDisputeTestSeam(
    dispute: unknown,
    providerEventRowId: string,
    eventType: NormalizedPaymentDisputeEvent["eventType"],
  ): Promise<PaymentDisputeOutcome> {
    const event = await (this.prisma as any).paymentProviderEvent.findUnique({
      where: { id: providerEventRowId },
    })
    if (!event || event.eventType !== eventType) {
      throw new PaymentDisputeTransitionError(
        "EVENT_EVIDENCE_MISSING",
        "Payment dispute processing requires exact durable provider-event evidence",
        false,
      )
    }
    const expected = this.normalizeStripeDisputeEvent(
      dispute,
      eventType,
      event.providerEventId,
      event.livemode,
    )
    const persisted = this.paymentDisputeInputFromProviderEvent(event)
    if (
      expected.eventFingerprint !== persisted.eventFingerprint ||
      expected.providerDisputeId !== persisted.providerDisputeId
    ) {
      throw new PaymentDisputeTransitionError(
        "EVENT_ENVELOPE_MISMATCH",
        "Provider dispute object does not match the durable signed event facts",
        false,
      )
    }
    return this.processPaymentDisputeEvent(
      providerEventRowId,
      this.paymentProviderEventLease(event),
    )
  }

  // Stripe Radar flags a payment as potentially fraudulent before a chargeback
  // is filed. This handler logs, audits, and notifies Operations — no financial
  // state changes (wallet holds, settlement freezes, payout blocks) are made
  // until a confirmed chargeback or a business decision.
  //
  // Idempotency: uses the Stripe event ID as the audit record entityId, checked
  // before creating duplicate audit entries or notifications.
  private async handleEarlyFraudWarning(
    event: any,
    providerEventRowId?: string,
    lease?: PaymentProviderEventLease,
  ): Promise<void> {
    if ((providerEventRowId == null) !== (lease == null)) {
      throw new PaymentProviderEventOwnershipError()
    }
    const eventId: string = event.id ?? "unknown"
    const object = event.data?.object
    await this.prisma.$transaction(async (tx: any) => {
      if (providerEventRowId && lease) {
        await this.lockAndAssertPaymentProviderEventAuthority(
          tx,
          providerEventRowId,
          lease,
        )
      }

      if (!object || typeof object !== "object") {
        this.logger.warn({
          eventId,
          eventType: event.type,
          message:
            "Early fraud warning missing data.object — malformed payload",
        })
      } else {
        const paymentIntent: string | null =
          typeof object.payment_intent === "string"
            ? object.payment_intent
            : null
        const chargeId: string | null =
          typeof object.charge === "string" ? object.charge : null
        const amount: number =
          typeof object.amount === "number" &&
          Number.isSafeInteger(object.amount) &&
          object.amount >= 0
            ? object.amount
            : 0
        const currency: string =
          typeof object.currency === "string"
            ? object.currency.toUpperCase()
            : "UNKNOWN"

        this.logger.log({
          providerEventRowId: providerEventRowId ?? null,
          eventFingerprint: logReferenceFingerprint(eventId),
          eventType: event.type,
          paymentIntentFingerprint: logReferenceFingerprint(paymentIntent),
          chargeFingerprint: logReferenceFingerprint(chargeId),
          message: "Early fraud warning received",
        })

        const existing = await tx.auditLog.findFirst({
          where: { entityId: eventId, action: "STRIPE_EARLY_FRAUD_WARNING" },
          select: { id: true },
        })
        if (!existing) {
          // FIN-02: `provider: "stripe"` aligns with the provider-aware
          // transaction identity used by the deposit write path.
          const depositTx = paymentIntent
            ? await tx.transaction.findFirst({
                where: {
                  provider: "stripe",
                  providerRef: paymentIntent,
                  type: "DEPOSIT",
                },
                select: {
                  id: true,
                  walletId: true,
                  orderId: true,
                  reference: true,
                },
              })
            : null

          if (!depositTx) {
            this.logger.warn({
              providerEventRowId: providerEventRowId ?? null,
              eventFingerprint: logReferenceFingerprint(eventId),
              eventType: event.type,
              paymentIntentFingerprint: logReferenceFingerprint(paymentIntent),
              chargeFingerprint: logReferenceFingerprint(chargeId),
              message:
                "Early fraud warning — no matching deposit transaction found",
            })
          }

          await this.audit.log(
            {
              action: "STRIPE_EARLY_FRAUD_WARNING",
              entityType: "StripeRadarWarning",
              entityId: eventId,
              metadata: {
                paymentIntent,
                chargeId,
                amount,
                currency,
                depositTransactionId: depositTx?.id ?? null,
                walletId: depositTx?.walletId ?? null,
                orderId: depositTx?.orderId ?? null,
              },
              userId: null,
              organizationId: null,
            },
            tx,
          )

          // Exact amount and provider identifiers are Finance-restricted data.
          const amountFormatted = `${currency} ${(amount / 100).toFixed(2)}`
          await this.notifyStaffInTransaction(
            tx,
            "STRIPE_EARLY_FRAUD_WARNING",
            depositTx
              ? `Early fraud warning for ${amountFormatted} — linked to deposit ${depositTx.reference}. Payment intent: ${paymentIntent ?? "N/A"}`
              : `Early fraud warning for ${amountFormatted} — no deposit match, manual review needed. Payment intent: ${paymentIntent ?? "N/A"}`,
            `efw:${eventId}`,
          )
        }
      }

      if (providerEventRowId && lease) {
        await this.completePaymentProviderEventLease(
          tx,
          providerEventRowId,
          lease,
          {
            status: "PROCESSED",
            processedAt: new Date(),
            lockedAt: null,
            lastError: null,
          },
        )
      }
    })
  }

  private async completeDepositReplayEvent(
    providerEventRowId: string | undefined,
    depositAttemptId: string,
    authority?: PaymentProviderEventAuthority,
  ): Promise<void> {
    if (!providerEventRowId) return
    if (!authority) throw new PaymentProviderEventOwnershipError()

    let terminalEvidenceMismatch = false
    await this.prisma.$transaction(async (tx: any) => {
      const event = await this.lockAndAssertPaymentProviderEventAuthority(
        tx,
        providerEventRowId,
        authority,
      )
      if (authority.kind === "snapshot") {
        terminalEvidenceMismatch =
          authority.status !== "PROCESSED" ||
          event.depositAttemptId !== depositAttemptId
        return
      }
      await this.completePaymentProviderEventLease(
        tx,
        providerEventRowId,
        authority,
        {
          status: "PROCESSED",
          processedAt: new Date(),
          lockedAt: null,
          lastError: null,
          depositAttemptId,
        },
      )
    })

    if (terminalEvidenceMismatch) {
      await this.quarantinePaymentProviderEvent(
        providerEventRowId,
        "DEPOSIT_PROCESSED_EVIDENCE_MISMATCH",
        authority,
      )
    }
  }

  private async resolveDepositLedgerReplay(input: {
    providerEventRowId?: string
    providerEventAuthority?: PaymentProviderEventAuthority
    attempt: any
    walletId: string
    amount: Decimal
    currency: string
    sessionId: string
    providerPaymentId: string
  }): Promise<void> {
    const candidates = await (this.prisma as any).transaction.findMany({
      where: {
        OR: [
          { reference: input.sessionId },
          {
            provider: "stripe",
            providerRef: input.providerPaymentId,
          },
        ],
      },
      include: { depositAttempt: true },
    })
    const candidate = candidates.length === 1 ? candidates[0] : null
    const linkedAttempt = candidate?.depositAttempt
    const exact =
      candidate?.type === "DEPOSIT" &&
      candidate.reference === input.sessionId &&
      candidate.provider === "stripe" &&
      candidate.providerRef === input.providerPaymentId &&
      candidate.walletId === input.walletId &&
      String(candidate.currency).toUpperCase() === input.currency &&
      new Decimal(candidate.amount).equals(input.amount) &&
      linkedAttempt?.id === input.attempt.id &&
      linkedAttempt.walletId === input.walletId &&
      linkedAttempt.provider === "stripe" &&
      linkedAttempt.providerSessionId === input.sessionId &&
      linkedAttempt.providerPaymentId === input.providerPaymentId &&
      linkedAttempt.ledgerTransactionId === candidate.id &&
      isWalletCreditBackedDepositStatus(linkedAttempt.status) &&
      String(linkedAttempt.currency).toUpperCase() === input.currency &&
      new Decimal(linkedAttempt.amount).equals(input.amount) &&
      new Decimal(linkedAttempt.walletCredit).equals(input.amount)

    if (exact) {
      await this.completeDepositReplayEvent(
        input.providerEventRowId,
        input.attempt.id,
        input.providerEventAuthority,
      )
      return
    }

    this.logger.error("Stripe deposit idempotency collision quarantined", {
      providerEventRowId: input.providerEventRowId ?? null,
      depositAttemptId: input.attempt.id,
    })
    if (input.providerEventRowId) {
      if (!input.providerEventAuthority) {
        throw new PaymentProviderEventOwnershipError()
      }
      await this.quarantinePaymentProviderEvent(
        input.providerEventRowId,
        "DEPOSIT_IDEMPOTENCY_COLLISION",
        input.providerEventAuthority,
      )
      return
    }
    throw new ConflictException(
      "Deposit identity conflicts with existing financial evidence",
    )
  }

  private async rejectMalformedDepositEvent(
    providerEventRowId: string | undefined,
    reason: string,
    authority?: PaymentProviderEventAuthority,
  ): Promise<void> {
    if (providerEventRowId) {
      if (!authority) throw new PaymentProviderEventOwnershipError()
      await this.quarantinePaymentProviderEvent(
        providerEventRowId,
        reason,
        authority,
      )
      return
    }
    throw new BadRequestException("Stripe deposit evidence is invalid")
  }

  private async processSuccessfulPayment(
    session: any,
    providerEventRowId?: string,
    authority?: PaymentProviderEventAuthority,
  ) {
    assertApiFinanceOperationAllowed("recovery")
    if ((providerEventRowId == null) !== (authority == null)) {
      throw new PaymentProviderEventOwnershipError()
    }
    const sessionId = typeof session?.id === "string" ? session.id.trim() : ""
    const paymentIntent =
      typeof session?.payment_intent === "string"
        ? session.payment_intent.trim()
        : typeof session?.payment_intent?.id === "string"
          ? session.payment_intent.id.trim()
          : ""
    if (
      !sessionId ||
      sessionId.length > 191 ||
      !paymentIntent ||
      paymentIntent.length > 191
    ) {
      await this.rejectMalformedDepositEvent(
        providerEventRowId,
        "INVALID_DEPOSIT_IDENTITY",
        authority,
      )
      return
    }

    const depositAttemptDelegate = (this.prisma as any).depositAttempt
    const attemptId = session.metadata?.depositAttemptId
    const attempt = depositAttemptDelegate
      ? await depositAttemptDelegate.findFirst({
          where: {
            OR: [
              { id: attemptId ?? "__missing__" },
              { providerSessionId: sessionId },
            ],
          },
        })
      : null
    if (!attempt) {
      await this.rejectMalformedDepositEvent(
        providerEventRowId,
        "DEPOSIT_ATTEMPT_NOT_FOUND",
        authority,
      )
      return
    }
    const walletId = attempt.walletId

    // Amount from Stripe authoritative source (amount_total is in cents).
    // Exact Decimal division — Math.round(cents/100) would round $10.50 to
    // $11 and mint money on every non-whole-dollar deposit.
    const amountCents = session.amount_total ?? 0
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      this.logger.warn({
        providerEventRowId: providerEventRowId ?? null,
        depositAttemptId: attempt.id,
        sessionFingerprint: logReferenceFingerprint(sessionId),
        reason: !Number.isInteger(amountCents)
          ? "amount_not_integer"
          : "amount_not_positive",
        message: "Rejected invalid Stripe deposit amount evidence",
      })
      await this.rejectMalformedDepositEvent(
        providerEventRowId,
        "INVALID_DEPOSIT_AMOUNT",
        authority,
      )
      return
    }
    const amount = new Decimal(amountCents).div(100)
    const currency =
      typeof session.currency === "string"
        ? session.currency.trim().toUpperCase()
        : ""
    if (
      !/^[A-Z]{3}$/.test(currency) ||
      !this.depositProvider.capabilities.supportedCurrencies.includes(currency)
    ) {
      await this.rejectMalformedDepositEvent(
        providerEventRowId,
        "INVALID_DEPOSIT_CURRENCY",
        authority,
      )
      return
    }

    // Never infer payment from the event name alone. Checkout can emit a
    // completion event before delayed methods settle, and malformed fixtures
    // may omit payment_status. Only Stripe's explicit `paid` state can mint
    // wallet value.
    if (session.payment_status !== "paid") {
      if (providerEventRowId && authority) {
        if (authority.kind !== "lease") {
          await this.rejectMalformedDepositEvent(
            providerEventRowId,
            "DEPOSIT_TERMINAL_REPLAY_STATE_MISMATCH",
            authority,
          )
          return
        }
        await this.prisma.$transaction(async (tx: any) => {
          await this.lockAndAssertPaymentProviderEventAuthority(
            tx,
            providerEventRowId,
            authority,
          )
          await tx.depositAttempt.updateMany({
            where: {
              id: attempt.id,
              status: {
                in: ["CREATED", "PENDING_CUSTOMER_ACTION", "PROCESSING"],
              },
            },
            data: { status: "PROCESSING" },
          })
        })
      } else {
        await depositAttemptDelegate.update({
          where: { id: attempt.id },
          data: { status: "PROCESSING" },
        })
      }
      throw new BadRequestException("Stripe Checkout payment is not paid")
    }

    if (attempt) {
      if (
        attempt.provider !== "stripe" ||
        attempt.providerSessionId !== sessionId ||
        (attempt.providerPaymentId != null &&
          attempt.providerPaymentId !== paymentIntent) ||
        (attemptId != null && attemptId !== attempt.id) ||
        !new Decimal(attempt.amount).equals(amount) ||
        !new Decimal(attempt.walletCredit).equals(amount) ||
        String(attempt.currency).toUpperCase() !== currency
      ) {
        await this.rejectMalformedDepositEvent(
          providerEventRowId,
          "DEPOSIT_ATTEMPT_EVIDENCE_MISMATCH",
          authority,
        )
        return
      }
      const isCreditedReplay = isWalletCreditBackedDepositStatus(attempt.status)
      const isCreditableAttempt = isCreditablePreCreditDepositStatus(
        attempt.status,
      )
      if (
        (!isCreditedReplay && !isCreditableAttempt) ||
        (isCreditableAttempt && attempt.ledgerTransactionId != null)
      ) {
        await this.rejectMalformedDepositEvent(
          providerEventRowId,
          "DEPOSIT_ATTEMPT_STATE_MISMATCH",
          authority,
        )
        return
      }
      if (isCreditedReplay) {
        await this.resolveDepositLedgerReplay({
          providerEventRowId,
          providerEventAuthority: authority,
          attempt,
          walletId,
          amount,
          currency,
          sessionId,
          providerPaymentId: paymentIntent,
        })
        return
      }
    }

    if (providerEventRowId && authority && authority.kind !== "lease") {
      await this.rejectMalformedDepositEvent(
        providerEventRowId,
        "DEPOSIT_TERMINAL_REPLAY_STATE_MISMATCH",
        authority,
      )
      return
    }

    const orgId = attempt.organizationId

    try {
      await this.prisma.$transaction(async (tx: any) => {
        if (providerEventRowId && authority) {
          await this.lockAndAssertPaymentProviderEventAuthority(
            tx,
            providerEventRowId,
            authority,
          )
        }
        // Idempotency: unique constraint on Transaction.reference prevents duplicates
        // Even if two webhooks arrive concurrently, only one tx.reference = session.id commits
        const existingTx = await tx.transaction.findFirst({
          where: { reference: sessionId },
        })
        if (existingTx) throw new DuplicateEventError(sessionId)

        const wallet = await tx.wallet.findUniqueOrThrow({
          where: { id: walletId },
        })
        if (String(wallet.currency).toUpperCase() !== currency) {
          throw new DepositEvidenceError("DEPOSIT_WALLET_CURRENCY_MISMATCH")
        }
        const updated = await tx.wallet.updateMany({
          where: { id: walletId, version: wallet.version },
          data: {
            availableBalance: { increment: amount },
            version: { increment: 1 },
          },
        })
        if (updated.count === 0) {
          throw new ConflictException(
            "Wallet was modified by another request. Retry.",
          )
        }

        // P2002 here MUST propagate and roll the transaction back — catching
        // it and returning would commit the wallet increment above without a
        // ledger row (double credit). The unique constraint on
        // `reference` (session.id) is the primary idempotency guarantee; the
        // provider-aware partial unique on `(provider, providerRef)` added in
        // FIN-02 is a defense-in-depth backstop for the rare case where a
        // Stripe event replays under a new session.id but the same
        // payment_intent. Either constraint firing surfaces as P2002 here.
        // The findFirst above is only the fast path.
        const ledgerTransaction = await tx.transaction.create({
          data: {
            walletId,
            amount,
            type: "DEPOSIT",
            reference: sessionId,
            // FIN-02: explicit provider label pairs with `providerRef` to
            // populate the `(provider, providerRef)` unique key — identical
            // row identity for write and lookup paths.
            provider: "stripe",
            // payment_intent linkage lets chargeback webhooks find this deposit
            providerRef: paymentIntent,
            description: `GuestPost wallet deposit ${attempt.publicReference}`,
          },
        })

        const completedAttempt = await tx.depositAttempt.updateMany({
          where: {
            id: attempt.id,
            walletId,
            provider: "stripe",
            providerSessionId: sessionId,
            amount,
            walletCredit: amount,
            currency,
            status: {
              in: [
                "CREATED",
                "PENDING_CUSTOMER_ACTION",
                "PROCESSING",
                "FAILED",
              ],
            },
          },
          data: {
            status: "SUCCEEDED",
            providerPaymentId: paymentIntent,
            ledgerTransactionId: ledgerTransaction.id,
            completedAt: new Date(),
            failedAt: null,
          },
        })
        if (completedAttempt.count !== 1) {
          throw new ConflictException(
            "Deposit attempt changed while applying the provider payment",
          )
        }
        if (providerEventRowId && authority) {
          await this.completePaymentProviderEventLease(
            tx,
            providerEventRowId,
            authority as PaymentProviderEventLease,
            {
              status: "PROCESSED",
              processedAt: new Date(),
              lockedAt: null,
              depositAttemptId: attempt.id,
              lastError: null,
            },
          )
        }

        await this.audit.log(
          {
            action: "WALLET_DEPOSIT",
            entityType: "Wallet",
            entityId: walletId,
            metadata: {
              amount: amount.toNumber(),
              reference: attempt.publicReference,
              providerSessionId: sessionId,
              method: "stripe",
            },
            userId: session.metadata?.userId || null,
            organizationId: orgId,
          },
          tx,
        )
      })
    } catch (err: any) {
      if (err instanceof DepositEvidenceError) {
        await this.rejectMalformedDepositEvent(
          providerEventRowId,
          err.code,
          authority,
        )
        return
      }
      if (err instanceof DuplicateEventError || isUniqueViolation(err)) {
        this.logger.warn({
          providerEventRowId: providerEventRowId ?? null,
          depositAttemptId: attempt.id,
          sessionFingerprint: logReferenceFingerprint(sessionId),
          message:
            "Potential duplicate Stripe deposit rolled back pending exact evidence comparison",
        })
        await this.resolveDepositLedgerReplay({
          providerEventRowId,
          providerEventAuthority: authority,
          attempt,
          walletId,
          amount,
          currency,
          sessionId,
          providerPaymentId: paymentIntent,
        })
        return
      }
      throw err
    }
  }

  async getWallet(organizationId: string | null, userId: string) {
    const include = {
      transactions: { orderBy: { createdAt: "desc" as const }, take: 50 },
    }

    if (organizationId) {
      const wallet = await this.prisma.wallet.findUnique({
        where: { organizationId },
        include,
      })
      if (!wallet) throw new NotFoundException("Wallet is not provisioned")
      return wallet
    }

    // Legacy customer accounts without an active organization use a personal
    // wallet. A partial unique index covers only these rows
    // (organizationId IS NULL), preserving multi-organization wallets that may
    // legitimately share the same creator userId.
    const wallet = await this.prisma.wallet.findFirst({
      where: { userId, organizationId: null },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      include,
    })
    if (!wallet) throw new NotFoundException("Wallet is not provisioned")
    return wallet
  }

  async listTransactions(organizationId: string | null, userId: string) {
    const wallet = await this.getWallet(organizationId, userId)
    if (!wallet) throw new NotFoundException("Wallet not found")

    return this.prisma.transaction.findMany({
      where: { walletId: wallet.id },
      orderBy: { createdAt: "desc" },
      take: 100,
    })
  }

  private async lockOwnedSpendableWallet(tx: any, walletId: string, user: any) {
    // Dispute booking and every path that consumes customer funds serialize
    // through this row. A Wallet.version check alone is insufficient because
    // a zero-held dispute records uncovered exposure without changing it.
    await lockWalletForUpdate(tx, walletId)
    const wallet = await tx.wallet.findUniqueOrThrow({
      where: { id: walletId },
    })
    this.assertWalletOwned(wallet, user)

    const uncoveredDispute = await tx.paymentDispute.findFirst({
      where: {
        walletId,
        status: { in: ["OPEN", "LOST"] },
        currentExposureAmount: { gt: 0 },
      },
      select: { id: true },
    })
    if (uncoveredDispute) {
      throw new ConflictException({
        code: "WALLET_SPEND_BLOCKED_BY_DISPUTE",
        message:
          "Wallet spending is unavailable while a payment dispute has uncovered exposure",
      })
    }

    return wallet
  }

  // `existingTx`: when the caller already holds a transaction (e.g. order
  // payment capture), run inside it so the wallet movement commits or rolls
  // back atomically with the caller's state change. Passing a separate
  // transaction here would let a debit survive a rolled-back order capture —
  // the double-charge bug under concurrent submit-payment.
  async reserve(
    walletId: string,
    amount: number,
    orderId: string,
    user: any,
    existingTx?: any,
  ) {
    assertApiFinanceOperationAllowed("new_liability")
    const run = async (tx: any) => {
      const wallet = await this.lockOwnedSpendableWallet(tx, walletId, user)

      const available = new Decimal(wallet.availableBalance)
      if (available.lessThan(amount)) {
        throw new BadRequestException(
          "Insufficient available balance to reserve",
        )
      }

      const updated = await tx.wallet.updateMany({
        where: { id: walletId, version: wallet.version },
        data: {
          availableBalance: { decrement: amount },
          reservedBalance: { increment: amount },
          version: { increment: 1 },
        },
      })
      if (updated.count === 0) {
        throw new ConflictException(
          "Wallet was modified by another request. Retry.",
        )
      }

      const fresh = await tx.wallet.findUniqueOrThrow({
        where: { id: walletId },
      })

      await tx.transaction.create({
        data: {
          walletId,
          amount: -amount,
          type: "RESERVATION",
          orderId,
          description: `Reservation of ${amount} for order ${orderId}`,
        },
      })

      return fresh
    }
    return existingTx ? run(existingTx) : this.prisma.$transaction(run)
  }

  async payFromReserved(
    walletId: string,
    amount: number,
    orderId: string,
    user: any,
    existingTx?: any,
  ) {
    assertApiFinanceOperationAllowed("new_liability")
    const run = async (tx: any) => {
      const wallet = await this.lockOwnedSpendableWallet(tx, walletId, user)

      const reserved = new Decimal(wallet.reservedBalance)
      if (reserved.lessThan(amount)) {
        throw new BadRequestException("Insufficient reserved balance")
      }

      const updated = await tx.wallet.updateMany({
        where: { id: walletId, version: wallet.version },
        data: {
          reservedBalance: { decrement: amount },
          version: { increment: 1 },
        },
      })
      if (updated.count === 0) {
        throw new ConflictException(
          "Wallet was modified by another request. Retry.",
        )
      }

      const fresh = await tx.wallet.findUniqueOrThrow({
        where: { id: walletId },
      })

      await tx.transaction.create({
        data: {
          walletId,
          amount: -amount,
          type: "PURCHASE",
          orderId,
          description: `Payment of ${amount} from reserved funds for order ${orderId}`,
        },
      })

      return fresh
    }
    return existingTx ? run(existingTx) : this.prisma.$transaction(run)
  }

  async refund(walletId: string, amount: number, orderId: string, user: any) {
    assertApiFinanceOperationAllowed("new_liability")
    const result = await this.prisma.$transaction(async (tx: any) => {
      const wallet = await tx.wallet.findUniqueOrThrow({
        where: { id: walletId },
      })
      this.assertWalletOwned(wallet, user)

      // Idempotency check using unique reference — database-level @@unique prevents race
      const existingRefund = await tx.transaction.findFirst({
        where: { orderId, type: "REFUND" },
      })
      if (existingRefund) {
        throw new BadRequestException("Order already refunded")
      }

      // Refund is for CAPTURED payments only (callers enforce paymentStatus=PAID).
      // Capture already consumed this order's reservation, so reservedBalance must
      // NOT be touched here — any reserved funds belong to other orders. The full
      // amount returns from the platform to availableBalance.
      const updated = await tx.wallet.updateMany({
        where: { id: walletId, version: wallet.version },
        data: {
          availableBalance: { increment: amount },
          version: { increment: 1 },
        },
      })
      if (updated.count === 0) {
        throw new ConflictException("Concurrent wallet modification")
      }

      const fresh = await tx.wallet.findUniqueOrThrow({
        where: { id: walletId },
      })

      await tx.transaction.create({
        data: {
          walletId,
          amount,
          type: "REFUND",
          orderId,
          reference: `refund-${orderId}`,
          description: `Refund of ${amount} for order ${orderId}`,
        },
      })

      return fresh
    })

    await this.audit.log({
      action: "WALLET_REFUND",
      entityType: "Wallet",
      entityId: walletId,
      metadata: { amount, orderId },
      userId: user.id,
      organizationId: user.organizationId,
    })

    return result
  }

  // Read-only and owner-scoped. It intentionally returns neither the wallet
  // balance nor internal transaction identifiers; the normal wallet endpoint
  // remains the only authenticated source for those values.
  async checkDepositStatus(publicReference: string, user: any) {
    const attempt = await (this.prisma as any).depositAttempt.findUnique({
      where: { publicReference },
      include: { wallet: true },
    })
    if (!attempt) throw new NotFoundException("Deposit not found")
    this.assertWalletOwned(attempt.wallet, user)

    const terminalMap: Record<string, string> = {
      SUCCEEDED: "COMPLETED",
      FAILED: "FAILED",
      EXPIRED: "FAILED",
      REFUNDED: "REFUNDED",
      PARTIALLY_REFUNDED: "REFUNDED",
      DISPUTED: "DISPUTED",
      CHARGEBACK: "DISPUTED",
    }
    const normalized = terminalMap[attempt.status] ?? "PENDING"
    return {
      publicReference: attempt.publicReference,
      status: normalized,
      // `processed` is the checkout-success signal consumed by the portal.
      // Derivative refund/dispute states still have wallet-credit evidence,
      // but must never be rendered as a newly completed deposit.
      processed: attempt.status === "SUCCEEDED",
      amount: Number(attempt.amount),
      walletCredit: Number(attempt.walletCredit),
      customerFee: Number(attempt.customerFee),
      currency: attempt.currency,
      statementDescriptor: customerWalletStatementDescriptor(
        attempt.publicReference,
      ),
      completedAt: attempt.completedAt,
    }
  }
}
