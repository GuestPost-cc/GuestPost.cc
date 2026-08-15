import { createHash, randomUUID } from "node:crypto"
import {
  customerWalletStatementDescriptor,
  initialStripeFeeDisclosure,
  isFinanceOperationAllowed,
  isSupportedMoneyCurrency,
  isUniqueViolation,
  normalizeFinancialReference,
  resolveFinanceRuntimeMode,
  USD_CURRENCY,
} from "@guestpost/shared"
import {
  type DepositCreditAuthority,
  DepositCreditFinalizationError,
  depositCreditFactsFromSignedCheckoutSession,
  finalizeDepositCredit,
} from "@guestpost/shared/dist/deposit-credit-core"
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
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/client"
import { assertApiFinanceOperationAllowed } from "../../common/finance-runtime-mode"
import {
  notificationFlag,
  notificationThreshold,
} from "../../common/notification-config"
import { PrismaService } from "../../common/prisma.service"
import {
  assertStripeObjectMode,
  isStripeFeatureEnabled,
} from "../../common/stripe-client"
import { AuditService } from "../audit/audit.service"
import { CommunicationsService } from "../communications/communications.service"
import {
  type DepositProviderAdapter,
  DepositProviderError,
} from "./providers/deposit-provider.interface"
import { DepositProviderService } from "./providers/deposit-provider.service"
import { StripeDepositAdapter } from "./providers/stripe-deposit.adapter"

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

interface DepositCommandEvidence {
  walletId: string
  organizationId: string | null
  createdByUserId: string
  amount: Decimal
  currency: typeof USD_CURRENCY
  idempotencyKey: string
}

type ExactDepositAttemptPhase = "PRE_SESSION" | "ATTACHED"

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
    @Optional() providerService?: DepositProviderService,
    @Optional() private readonly communications?: CommunicationsService,
  ) {
    // The fallback keeps isolated unit construction lightweight; Nest runtime
    // always supplies the registry from BillingModule.
    this.depositProvider =
      providerService?.getAdapter("stripe") ?? new StripeDepositAdapter()
  }

  private async recordDepositFailure(
    tx: any,
    attempt: any,
    status: "FAILED" | "EXPIRED",
  ): Promise<string[]> {
    if (!this.communications || !attempt) return []
    const communicationEventIds: string[] = []
    const organizationRecipients =
      await this.communications.organizationRecipients(
        attempt.organizationId,
        true,
        tx,
      )
    const recipients = [
      ...new Set<string>([attempt.createdByUserId, ...organizationRecipients]),
    ]
    const amount = new Decimal(attempt.amount).toFixed(2)
    const event = await this.communications.record(
      {
        type:
          status === "FAILED"
            ? "BILLING_DEPOSIT_FAILED"
            : "BILLING_DEPOSIT_EXPIRED",
        aggregateType: "DepositAttempt",
        aggregateId: attempt.id,
        organizationId: attempt.organizationId,
        title:
          status === "FAILED" ? "Wallet deposit failed" : "Deposit expired",
        message:
          status === "FAILED"
            ? `The ${amount} ${attempt.currency} wallet deposit could not be completed. No wallet funds were added.`
            : `The ${amount} ${attempt.currency} wallet deposit expired before payment completed. No wallet funds were added.`,
        actionPath: "/dashboard/billing",
        dedupKey: `deposit:${attempt.id}:${status.toLowerCase()}`,
        recipientUserIds: recipients,
      },
      tx,
    )
    communicationEventIds.push(event.eventId)

    if (
      status === "FAILED" &&
      notificationFlag("ADMIN_DEPOSIT_FAILED_NOTIFICATION", true)
    ) {
      const staffRecipients = await this.communications.staffRecipients(
        ["SUPER_ADMIN", "FINANCE"],
        tx,
      )
      const staffEvent = await this.communications.record(
        {
          type: "STAFF_DEPOSIT_FAILED",
          aggregateType: "DepositAttempt",
          aggregateId: attempt.id,
          organizationId: attempt.organizationId,
          title: "Deposit failure requires monitoring",
          message: `A ${amount} ${attempt.currency} wallet deposit failed.`,
          actionPath: "/dashboard/finance",
          payload: { amount, currency: attempt.currency },
          dedupKey: `staff:deposit:${attempt.id}:failed`,
          recipientUserIds: staffRecipients,
        },
        tx,
      )
      communicationEventIds.push(staffEvent.eventId)
    }
    return communicationEventIds
  }

  private async recordDepositDispute(tx: any, attempt: any) {
    if (!this.communications || !attempt) return null
    const recipients = [
      ...new Set<string>([
        attempt.createdByUserId,
        ...(await this.communications.organizationRecipients(
          attempt.organizationId,
          true,
          tx,
        )),
      ]),
    ]
    const amount = new Decimal(attempt.amount).toFixed(2)
    const event = await this.communications.record(
      {
        type: "BILLING_DEPOSIT_DISPUTED",
        aggregateType: "DepositAttempt",
        aggregateId: attempt.id,
        organizationId: attempt.organizationId,
        title: "Wallet deposit disputed",
        message: `The ${amount} ${attempt.currency} deposit is under payment dispute review. Available wallet funds may be restricted while it is investigated.`,
        actionPath: "/dashboard/billing",
        dedupKey: `deposit:${attempt.id}:disputed`,
        recipientUserIds: recipients,
      },
      tx,
    )
    return event.eventId
  }

  getDepositCapability() {
    const enabled = isStripeFeatureEnabled("deposits")
    const supportsUsd =
      this.depositProvider.capabilities.supportedCurrencies.includes(
        USD_CURRENCY,
      )
    const financeMode = resolveFinanceRuntimeMode(
      process.env.FINANCE_RUNTIME_MODE,
      process.env.NODE_ENV,
    ).mode
    const financeAvailable = isFinanceOperationAllowed(
      financeMode,
      "new_liability",
    )
    const available = enabled && supportsUsd && financeAvailable
    return {
      available,
      provider: "stripe" as const,
      currency: USD_CURRENCY,
      code: available
        ? ("AVAILABLE" as const)
        : !financeAvailable
          ? ("FINANCE_OPERATIONS_UNAVAILABLE" as const)
          : enabled
            ? ("DEPOSIT_CURRENCY_UNAVAILABLE" as const)
            : ("CARD_DEPOSITS_DISABLED" as const),
      message: available
        ? "Secure card deposits are available."
        : !financeAvailable
          ? "Card deposits are temporarily paused while financial operations are in recovery mode."
          : enabled
            ? "Card deposits are not available for USD wallets."
            : "Card deposits are temporarily unavailable.",
    }
  }

  private depositProviderFailure(error: unknown): DepositProviderError {
    return error instanceof DepositProviderError
      ? error
      : new DepositProviderError("PROVIDER_UNAVAILABLE", true)
  }

  private depositProviderUnavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: "DEPOSIT_PROVIDER_UNAVAILABLE",
      message:
        "Secure card checkout is temporarily unavailable. Please try again later.",
    })
  }

  private depositStateUnavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: "DEPOSIT_STATE_UNAVAILABLE",
      message:
        "Secure card checkout could not be recorded safely. Please try again later.",
    })
  }

  private depositIdempotencyConflict(): ConflictException {
    return new ConflictException({
      code: "DEPOSIT_IDEMPOTENCY_CONFLICT",
      message:
        "This deposit request key is already bound to different deposit evidence.",
    })
  }

  private decimalEquals(value: unknown, expected: Decimal): boolean {
    try {
      return new Decimal(value as any).equals(expected)
    } catch {
      return false
    }
  }

  private isValidDate(value: unknown): value is Date {
    return value instanceof Date && !Number.isNaN(value.getTime())
  }

  private isBoundedProviderId(value: unknown): value is string {
    return (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= 191 &&
      value.trim() === value
    )
  }

  /**
   * The only accepted local replay shapes for checkout creation. This binds a
   * client key to its original actor, tenant, wallet, fee snapshot, and empty
   * pre-credit linkage before any provider lookup or call is permitted.
   */
  private assertExactDepositAttempt(
    attempt: any,
    expected: DepositCommandEvidence,
    requiredPhase?: ExactDepositAttemptPhase,
    expectedSession?: Awaited<
      ReturnType<DepositProviderAdapter["createSession"]>
    >,
  ): ExactDepositAttemptPhase {
    const publicReference = attempt?.publicReference
    const commonMatches =
      this.isBoundedProviderId(attempt?.id) &&
      typeof publicReference === "string" &&
      publicReference.length > 0 &&
      publicReference.length <= 32 &&
      normalizeFinancialReference(publicReference, 32) === publicReference &&
      attempt.walletId === expected.walletId &&
      attempt.organizationId === expected.organizationId &&
      attempt.createdByUserId === expected.createdByUserId &&
      attempt.method === "CARD" &&
      attempt.provider === "stripe" &&
      this.decimalEquals(attempt.amount, expected.amount) &&
      this.decimalEquals(attempt.walletCredit, expected.amount) &&
      this.decimalEquals(attempt.customerFee, new Decimal(0)) &&
      attempt.providerFee === null &&
      attempt.currency === expected.currency &&
      attempt.idempotencyKey === expected.idempotencyKey &&
      attempt.providerChargeId === null &&
      attempt.intendedOrderId === null &&
      attempt.ledgerTransactionId === null &&
      attempt.completedAt === null

    if (!commonMatches) throw this.depositIdempotencyConflict()

    const isCreated =
      attempt.status === "CREATED" &&
      attempt.providerSessionId === null &&
      attempt.providerPaymentId === null &&
      attempt.expiresAt === null &&
      attempt.failedAt === null &&
      attempt.failureCode === null
    const isFailed =
      attempt.status === "FAILED" &&
      attempt.providerSessionId === null &&
      attempt.providerPaymentId === null &&
      attempt.expiresAt === null &&
      this.isValidDate(attempt.failedAt) &&
      typeof attempt.failureCode === "string" &&
      attempt.failureCode.length > 0
    const isAttached =
      attempt.status === "PENDING_CUSTOMER_ACTION" &&
      this.isBoundedProviderId(attempt.providerSessionId) &&
      (attempt.providerPaymentId === null ||
        this.isBoundedProviderId(attempt.providerPaymentId)) &&
      this.isValidDate(attempt.expiresAt) &&
      attempt.failedAt === null &&
      attempt.failureCode === null

    const phase: ExactDepositAttemptPhase | null =
      isCreated || isFailed ? "PRE_SESSION" : isAttached ? "ATTACHED" : null
    if (!phase || (requiredPhase && phase !== requiredPhase)) {
      throw this.depositIdempotencyConflict()
    }
    if (
      expectedSession &&
      (phase !== "ATTACHED" ||
        attempt.providerSessionId !== expectedSession.providerSessionId ||
        attempt.providerPaymentId !== expectedSession.providerPaymentId ||
        attempt.expiresAt.getTime() !== expectedSession.expiresAt?.getTime())
    ) {
      throw this.depositIdempotencyConflict()
    }
    return phase
  }

  private assertExactDepositSessionEvidence(
    session: Awaited<ReturnType<DepositProviderAdapter["createSession"]>>,
    attempt: any,
    expected: DepositCommandEvidence,
    amountMinor: number,
    expectedProviderSessionId?: string,
  ): void {
    let modeMatches = false
    try {
      assertStripeObjectMode(session?.livemode, "Stripe Checkout Session")
      modeMatches = true
    } catch {
      modeMatches = false
    }

    const exact =
      modeMatches &&
      this.isBoundedProviderId(session?.providerSessionId) &&
      session.providerObjectType === "checkout.session" &&
      (!expectedProviderSessionId ||
        session.providerSessionId === expectedProviderSessionId) &&
      (!expectedProviderSessionId ||
        ((attempt.providerPaymentId === null ||
          session.providerPaymentId === attempt.providerPaymentId) &&
          this.isValidDate(attempt.expiresAt) &&
          attempt.expiresAt.getTime() === session.expiresAt?.getTime())) &&
      (session.providerPaymentId === null ||
        this.isBoundedProviderId(session.providerPaymentId)) &&
      session.clientReferenceId === attempt.id &&
      session.metadata?.depositAttemptId === attempt.id &&
      session.metadata?.publicReference === attempt.publicReference &&
      session.metadata?.walletId === expected.walletId &&
      session.metadata?.userId === expected.createdByUserId &&
      session.metadata?.organizationId === (expected.organizationId ?? "") &&
      session.amountTotalMinor === amountMinor &&
      session.currency === expected.currency &&
      session.mode === "payment" &&
      ["open", "complete", "expired"].includes(session.status ?? "") &&
      this.isValidDate(session.expiresAt)

    if (!exact) {
      throw new DepositProviderError("PROVIDER_RESPONSE_INVALID", false)
    }
  }

  private assertReturnableDepositSession(
    session: Awaited<ReturnType<DepositProviderAdapter["createSession"]>>,
  ): asserts session is Awaited<
    ReturnType<DepositProviderAdapter["createSession"]>
  > & { url: string; status: "open" } {
    if (session.status !== "open" || typeof session.url !== "string") {
      throw new DepositProviderError("PROVIDER_RESPONSE_INVALID", false)
    }
    try {
      const url = new URL(session.url)
      const trustedCheckoutHost =
        url.hostname === "checkout.stripe.com" ||
        (process.env.NODE_ENV === "test" &&
          url.hostname === "checkout.stripe.test")
      if (
        url.protocol !== "https:" ||
        !trustedCheckoutHost ||
        url.username ||
        url.password ||
        session.url.length > 2048
      ) {
        throw new Error("invalid checkout URL")
      }
    } catch {
      throw new DepositProviderError("PROVIDER_RESPONSE_INVALID", false)
    }
  }

  private async recordDepositProviderFailure(
    attempt: any,
    expected: DepositCommandEvidence,
    failure: DepositProviderError,
  ): Promise<{ recorded: boolean; communicationEventIds: string[] }> {
    try {
      return await this.prisma.$transaction(async (tx: any) => {
        const recorded = await tx.depositAttempt.updateMany({
          where: {
            id: attempt.id,
            providerSessionId: null,
            status: { in: ["CREATED", "FAILED"] },
          },
          data: {
            status: "FAILED",
            failureCode: failure.code,
            failedAt: new Date(),
          },
        })
        if (recorded.count === 1) {
          const communicationEventIds = await this.recordDepositFailure(
            tx,
            attempt,
            "FAILED",
          )
          return { recorded: true, communicationEventIds }
        }

        const successor = await tx.depositAttempt.findUnique({
          where: { id: attempt.id },
        })
        this.assertExactDepositAttempt(successor, expected, "ATTACHED")
        return { recorded: false, communicationEventIds: [] }
      })
    } catch (error) {
      this.logger.error(
        "Deposit provider failure evidence could not be stored",
        {
          depositAttemptId: attempt.id,
          failureCode: failure.code,
        },
      )
      throw this.depositStateUnavailable()
    }
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

  private assertCanonicalUsdCurrency(
    currency: unknown,
    code: string,
    message: string,
  ) {
    if (!isSupportedMoneyCurrency(currency)) {
      throw new ConflictException({ code, message })
    }
  }

  private canonicalMoneyAmount(
    amount: Decimal | number | string,
    operation: string,
  ): Decimal {
    let value: Decimal
    try {
      value = new Decimal(amount)
    } catch {
      throw new BadRequestException({
        code: "MONEY_AMOUNT_INVALID",
        message: `${operation} amount is invalid`,
      })
    }
    if (
      !value.isFinite() ||
      value.lessThanOrEqualTo(0) ||
      !value.mul(100).isInteger()
    ) {
      throw new BadRequestException({
        code: "MONEY_AMOUNT_INVALID",
        message: `${operation} amount must be positive with no more than two decimal places`,
      })
    }
    return value
  }

  private async assertOrderMatchesWallet(
    tx: any,
    orderId: string,
    wallet: { organizationId: string | null },
  ) {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { id: true, organizationId: true, currency: true },
    })
    if (!order) throw new NotFoundException("Order not found")
    this.assertCanonicalUsdCurrency(
      order.currency,
      "ORDER_CURRENCY_UNSUPPORTED",
      "Order currency is not supported by USD-only wallet movements",
    )
    if (
      !wallet.organizationId ||
      order.organizationId !== wallet.organizationId
    ) {
      throw new ConflictException({
        code: "ORDER_WALLET_OWNERSHIP_MISMATCH",
        message: "Order and wallet do not belong to the same organization",
      })
    }
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
    this.assertCanonicalUsdCurrency(
      wallet.currency,
      "WALLET_CURRENCY_UNSUPPORTED",
      "Card deposits require a canonical USD wallet",
    )

    if (!isStripeFeatureEnabled("deposits")) {
      throw new BadRequestException("Card deposits are temporarily unavailable")
    }
    if (
      !this.depositProvider.capabilities.supportedCurrencies.includes(
        USD_CURRENCY,
      )
    ) {
      throw new BadRequestException("Card deposits do not support USD")
    }

    const amountDecimal = this.canonicalMoneyAmount(amount, "Deposit")
    const amountMinorDecimal = amountDecimal.mul(100)
    const amountMinor = amountMinorDecimal.toNumber()
    if (!Number.isSafeInteger(amountMinor)) {
      throw new BadRequestException("Deposit amount is outside the safe range")
    }

    const suppliedRequestKey = idempotencyKey?.trim()
    if (
      idempotencyKey != null &&
      (!suppliedRequestKey ||
        suppliedRequestKey.length > 191 ||
        !/^[A-Za-z0-9_-]+$/.test(suppliedRequestKey))
    ) {
      throw new BadRequestException({
        code: "DEPOSIT_IDEMPOTENCY_KEY_INVALID",
        message:
          "Deposit idempotency key must be 1-191 letters, numbers, underscores, or hyphens.",
      })
    }
    const requestKey = suppliedRequestKey ?? randomUUID()
    const commandEvidence: DepositCommandEvidence = {
      walletId,
      organizationId: wallet.organizationId,
      createdByUserId: user.id,
      amount: amountDecimal,
      currency: USD_CURRENCY,
      idempotencyKey: requestKey,
    }
    const depositAttempt = (this.prisma as any).depositAttempt
    let attempt = await depositAttempt.findUnique({
      where: {
        walletId_idempotencyKey: { walletId, idempotencyKey: requestKey },
      },
    })
    if (!attempt) {
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
            currency: USD_CURRENCY,
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
      }
    }

    const attemptPhase = this.assertExactDepositAttempt(
      attempt,
      commandEvidence,
    )
    if (attemptPhase === "ATTACHED") {
      let existingSession: Awaited<
        ReturnType<DepositProviderAdapter["retrieveSession"]>
      >
      try {
        existingSession = await this.depositProvider.retrieveSession(
          attempt.providerSessionId,
        )
        this.assertExactDepositSessionEvidence(
          existingSession,
          attempt,
          commandEvidence,
          amountMinor,
          attempt.providerSessionId,
        )
        if (existingSession.status === "open") {
          this.assertReturnableDepositSession(existingSession)
        }
      } catch (error) {
        const failure = this.depositProviderFailure(error)
        this.logger.error("Stripe deposit session recovery failed", {
          depositAttemptId: attempt.id,
          failureCode: failure.code,
          retryable: failure.retryable,
        })
        throw this.depositProviderUnavailable()
      }
      if (existingSession.status !== "open") {
        throw new ConflictException(
          "This deposit request has already been used; start a new deposit",
        )
      }
      return {
        url: existingSession.url,
        publicReference: attempt.publicReference,
        statementDescriptor: customerWalletStatementDescriptor(
          attempt.publicReference,
        ),
        feePolicy: initialStripeFeeDisclosure(amountMinor),
      }
    }

    const portalUrl =
      process.env.NEXT_PUBLIC_PORTAL_URL || "http://localhost:3001"
    let session: Awaited<ReturnType<DepositProviderAdapter["createSession"]>>
    try {
      session = await this.depositProvider.createSession({
        attemptId: attempt.id,
        publicReference: attempt.publicReference,
        walletId,
        organizationId: wallet.organizationId,
        userId: user.id,
        amountMinor,
        currency: USD_CURRENCY,
        idempotencyKey: `deposit-session-${attempt.id}`,
        successUrl: `${portalUrl}/dashboard/billing?success=true`,
        cancelUrl: `${portalUrl}/dashboard/billing?canceled=true`,
      })
      this.assertExactDepositSessionEvidence(
        session,
        attempt,
        commandEvidence,
        amountMinor,
      )
      this.assertReturnableDepositSession(session)
    } catch (error) {
      const failure = this.depositProviderFailure(error)
      const failureRecord = await this.recordDepositProviderFailure(
        attempt,
        commandEvidence,
        failure,
      )
      if (failureRecord.recorded) {
        this.communications?.dispatchManyBestEffort(
          failureRecord.communicationEventIds,
        )
      } else {
        this.logger.warn("Deposit provider failure evidence was superseded", {
          depositAttemptId: attempt.id,
          failureCode: failure.code,
        })
      }
      this.logger.error("Stripe deposit session creation failed", {
        depositAttemptId: attempt.id,
        failureCode: failure.code,
        retryable: failure.retryable,
      })
      throw this.depositProviderUnavailable()
    }

    try {
      const attached = await depositAttempt.updateMany({
        where: {
          id: attempt.id,
          publicReference: attempt.publicReference,
          walletId,
          organizationId: wallet.organizationId,
          createdByUserId: user.id,
          method: "CARD",
          provider: "stripe",
          amount: amountDecimal,
          walletCredit: amountDecimal,
          customerFee: new Decimal(0),
          providerFee: null,
          currency: USD_CURRENCY,
          idempotencyKey: requestKey,
          providerSessionId: null,
          providerPaymentId: null,
          providerChargeId: null,
          intendedOrderId: null,
          ledgerTransactionId: null,
          expiresAt: null,
          completedAt: null,
          status: { in: ["CREATED", "FAILED"] },
        },
        data: {
          status: "PENDING_CUSTOMER_ACTION",
          providerSessionId: session.providerSessionId,
          providerPaymentId: session.providerPaymentId,
          expiresAt: session.expiresAt,
          failedAt: null,
          failureCode: null,
        },
      })
      if (attached.count !== 1) {
        const current = await depositAttempt.findUnique({
          where: { id: attempt.id },
        })
        try {
          this.assertExactDepositAttempt(
            current,
            commandEvidence,
            "ATTACHED",
            session,
          )
        } catch {
          throw new ConflictException({
            code: "DEPOSIT_SESSION_ATTACHMENT_RACE",
            message:
              "Deposit checkout state changed concurrently. Start a new deposit.",
          })
        }
      }

      return {
        url: session.url,
        publicReference: attempt.publicReference,
        statementDescriptor: customerWalletStatementDescriptor(
          attempt.publicReference,
        ),
        feePolicy: initialStripeFeeDisclosure(amountMinor),
      }
    } catch (error) {
      if (error instanceof ConflictException) throw error
      this.logger.error("Stripe deposit session evidence attachment failed", {
        depositAttemptId: attempt.id,
        errorType: error instanceof Error ? error.name : "UnknownError",
      })
      throw this.depositStateUnavailable()
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
            event.livemode,
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
        await this.processSuccessfulPayment(
          object,
          providerEvent.id,
          lease,
          event.livemode,
        )
      } else if (
        eventType === "checkout.session.expired" ||
        eventType === "checkout.session.async_payment_failed"
      ) {
        await this.markDepositAttemptFromSession(
          object,
          eventType === "checkout.session.expired" ? "EXPIRED" : "FAILED",
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
    status: "FAILED" | "EXPIRED",
    providerEventRowId: string,
    lease: PaymentProviderEventLease,
  ): Promise<void> {
    const { communicationEventIds } = await this.prisma.$transaction(
      async (tx: any) => {
        await this.lockAndAssertPaymentProviderEventAuthority(
          tx,
          providerEventRowId,
          lease,
        )
        const attempt = await tx.depositAttempt.findFirst({
          where: {
            OR: [
              { id: session.metadata?.depositAttemptId ?? "__missing__" },
              { providerSessionId: session.id },
            ],
            status: {
              in: ["CREATED", "PENDING_CUSTOMER_ACTION", "PROCESSING"],
            },
          },
        })
        const updated = attempt
          ? await tx.depositAttempt.updateMany({
              where: {
                id: attempt.id,
                status: {
                  in: ["CREATED", "PENDING_CUSTOMER_ACTION", "PROCESSING"],
                },
              },
              data: { status, failedAt: new Date() },
            })
          : { count: 0 }
        const communicationEventIds =
          updated.count === 1
            ? await this.recordDepositFailure(tx, attempt, status)
            : []
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
        return { communicationEventIds }
      },
    )
    this.communications?.dispatchManyBestEffort(communicationEventIds)
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
    // Stripe currency values are lowercase by contract. Accept exactly that
    // provider representation, then cross the adapter boundary once into the
    // canonical application representation. Mixed case/whitespace is rejected
    // instead of being silently repaired.
    if (
      typeof payload.currency !== "string" ||
      !/^[a-z]{3}$/.test(payload.currency)
    ) {
      throw new BadRequestException("Stripe dispute currency is invalid")
    }
    if (payload.currency !== "usd") {
      throw new BadRequestException(
        `Stripe dispute currency ${payload.currency} is not certified for customer wallets`,
      )
    }
    const currency = USD_CURRENCY
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
    const result = await this.prisma.$transaction(async (tx: any) => {
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
    if (result.identityConflict) {
      this.communications?.dispatchByDedupKeyBestEffort(
        `staff-alert:payment-provider-event-identity-conflict:${result.event.id}`,
      )
    }
    return result
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
    const financeCommunicationDedupKeys = new Set<string>()
    const outcome = await transitionPaymentDispute(
      this.prisma,
      {
        audit: async (tx, auditInput) => {
          await this.audit.log(auditInput, tx)
        },
        notifyFinance: async (tx, notification) => {
          const dedupKey = await this.notifyStaffInTransaction(
            tx,
            notification.type,
            notification.message,
            notification.dedupKeyPrefix,
          )
          if (dedupKey) financeCommunicationDedupKeys.add(dedupKey)
        },
        notifyCustomer: async (tx, notification) => {
          const attempt = await tx.depositAttempt.findUnique({
            where: { id: notification.depositAttemptId },
          })
          await this.recordDepositDispute(tx, attempt)
        },
      },
      input,
    )
    if (outcome.status === "OPEN" && event.depositAttemptId) {
      this.communications?.dispatchByDedupKeyBestEffort(
        `deposit:${event.depositAttemptId}:disputed`,
      )
    }
    this.communications?.dispatchManyByDedupKeyBestEffort(
      financeCommunicationDedupKeys,
    )
    return outcome
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
    const communicationDedupKeys = new Set<string>()
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
      const dedupKey = await this.notifyStaffInTransaction(
        tx,
        "PAYMENT_PROVIDER_EVENT_QUARANTINED",
        `Payment provider event ${event.providerEventId} was quarantined (${safeReason}). Finance review is required.`,
        `payment-provider-event-quarantine:${event.id}:${safeReason}`,
      )
      if (dedupKey) communicationDedupKeys.add(dedupKey)
    })
    this.communications?.dispatchManyByDedupKeyBestEffort(
      communicationDedupKeys,
    )
  }

  private async notifyStaffInTransaction(
    tx: any,
    type: string,
    message: string,
    dedupKeyPrefix: string,
  ): Promise<string | null> {
    if (this.communications) {
      const recipients = await this.communications.staffRecipients(
        ["SUPER_ADMIN", "OPERATIONS", "FINANCE"],
        tx,
      )
      const source =
        dedupKeyPrefix ??
        createHash("sha256")
          .update(`${type}:${message}`)
          .digest("hex")
          .slice(0, 32)
      const dedupKey = `staff-alert:${source.replace(/[^A-Za-z0-9:._-]/g, "-")}`
      await this.communications.record(
        {
          type: type.includes("CHARGEBACK")
            ? "STAFF_CHARGEBACK_ALERT"
            : "STAFF_FRAUD_ALERT",
          aggregateType: type.includes("CHARGEBACK")
            ? "StripeDispute"
            : "RiskAlert",
          aggregateId: source,
          title: type.includes("CHARGEBACK")
            ? "Chargeback requires review"
            : "Fraud risk alert",
          message,
          actionPath: "/dashboard/finance",
          dedupKey,
          recipientUserIds: recipients,
        },
        tx,
      )
      return dedupKey
    }
    const staff = await tx.staffMembership.findMany({
      where: { role: { in: ["FINANCE", "SUPER_ADMIN"] } },
      select: { userId: true },
    })
    if (staff.length === 0) return null
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
    return null
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
    this.communications?.dispatchByDedupKeyBestEffort(
      `staff-alert:efw:${eventId}`,
    )
  }

  private async processSuccessfulPayment(
    session: any,
    providerEventRowId?: string,
    authority?: PaymentProviderEventAuthority,
    eventLivemode: boolean = session?.livemode,
  ): Promise<void> {
    assertApiFinanceOperationAllowed("recovery")
    if ((providerEventRowId == null) !== (authority == null)) {
      throw new PaymentProviderEventOwnershipError()
    }

    let facts
    try {
      facts = depositCreditFactsFromSignedCheckoutSession(
        session,
        eventLivemode,
      )
    } catch (error) {
      if (
        providerEventRowId &&
        authority &&
        error instanceof DepositCreditFinalizationError
      ) {
        await this.quarantinePaymentProviderEvent(
          providerEventRowId,
          error.code,
          authority,
        )
        return
      }
      throw new BadRequestException("Stripe deposit evidence is invalid")
    }

    const canonicalAuthority: DepositCreditAuthority | null =
      providerEventRowId && authority
        ? {
            kind: "WEBHOOK_EVENT",
            eventRowId: providerEventRowId,
            lease:
              authority.kind === "lease"
                ? {
                    kind: "lease",
                    attempts: authority.attempt,
                    lockedAt: authority.lockedAt,
                  }
                : {
                    kind: "snapshot",
                    status: authority.status,
                    attempts: authority.attempts,
                    lockedAt: authority.lockedAt,
                    processedAt: authority.processedAt,
                  },
          }
        : null
    if (!canonicalAuthority) {
      throw new PaymentProviderEventOwnershipError()
    }

    try {
      const outcome = await finalizeDepositCredit(
        this.prisma,
        {
          audit: async (tx, auditInput) => {
            await this.audit.log(auditInput, tx)
          },
          recordSuccess: async (tx, input) => {
            if (!this.communications) return []
            const organizationRecipients =
              await this.communications.organizationRecipients(
                input.organizationId,
                true,
                tx,
              )
            const recipients = [
              ...new Set<string>([
                input.createdByUserId,
                ...organizationRecipients,
              ]),
            ]
            const event = await this.communications.record(
              {
                type: "BILLING_DEPOSIT_SUCCEEDED",
                aggregateType: "DepositAttempt",
                aggregateId: input.depositAttemptId,
                organizationId: input.organizationId,
                title: "Wallet deposit completed",
                message:
                  new Decimal(input.amount).toFixed(2) +
                  " " +
                  input.currency +
                  " was added to your wallet.",
                actionPath: "/dashboard/billing",
                dedupKey: `deposit:${input.depositAttemptId}:succeeded`,
                recipientUserIds: recipients,
              },
              tx,
            )
            const eventIds = [event.eventId]
            if (
              new Decimal(input.amount).greaterThan(
                notificationThreshold(
                  "ADMIN_HIGH_VALUE_DEPOSIT_THRESHOLD",
                  1000,
                ),
              )
            ) {
              const staffRecipients = await this.communications.staffRecipients(
                ["SUPER_ADMIN", "FINANCE"],
                tx,
              )
              const staffEvent = await this.communications.record(
                {
                  type: "STAFF_HIGH_VALUE_DEPOSIT",
                  aggregateType: "DepositAttempt",
                  aggregateId: input.depositAttemptId,
                  organizationId: input.organizationId,
                  title: "High-value wallet deposit",
                  message:
                    new Decimal(input.amount).toFixed(2) +
                    " " +
                    input.currency +
                    " was deposited into a customer wallet.",
                  actionPath: "/dashboard/finance",
                  payload: {
                    amount: input.amount,
                    currency: input.currency,
                    walletId: input.walletId,
                  },
                  dedupKey: `staff:deposit:${input.depositAttemptId}:high-value`,
                  recipientUserIds: staffRecipients,
                },
                tx,
              )
              eventIds.push(staffEvent.eventId)
            }
            return eventIds
          },
        },
        { authority: canonicalAuthority, facts },
      )
      this.communications?.dispatchManyBestEffort(outcome.communicationEventIds)
    } catch (error) {
      if (error instanceof DepositCreditFinalizationError) {
        if (error.code === "AUTHORITY_LEASE_LOST") {
          throw new PaymentProviderEventOwnershipError()
        }
        if (!error.retryable) {
          await this.quarantinePaymentProviderEvent(
            providerEventRowId!,
            error.code,
            authority!,
          )
          return
        }
        if (error.code === "DEPOSIT_PROVIDER_STATE_NOT_PAID") {
          throw new BadRequestException("Stripe Checkout payment is not paid")
        }
      }
      throw error
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
      return this.projectCustomerWallet(wallet)
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
    return this.projectCustomerWallet(wallet)
  }

  async listTransactions(organizationId: string | null, userId: string) {
    const wallet = await this.getWallet(organizationId, userId)
    if (!wallet) throw new NotFoundException("Wallet not found")

    const transactions = await this.prisma.transaction.findMany({
      where: { walletId: wallet.id },
      orderBy: { createdAt: "desc" },
      take: 100,
    })
    return transactions.map((transaction: any) =>
      this.projectCustomerTransaction(transaction),
    )
  }

  /**
   * Old refund rows may contain free-form Ops/Finance rationale. Wallet APIs
   * are customer-facing, so never return that legacy text; derive the label
   * only from structured, tenant-owned transaction fields.
   */
  private projectCustomerTransaction(transaction: any) {
    if (transaction?.type !== "REFUND") return transaction
    return {
      ...transaction,
      description:
        typeof transaction.orderId === "string" && transaction.orderId
          ? `Refund for order ${transaction.orderId}`
          : "Refund",
    }
  }

  private projectCustomerWallet(wallet: any) {
    if (!Array.isArray(wallet.transactions)) return wallet
    return {
      ...wallet,
      transactions: wallet.transactions.map((transaction: any) =>
        this.projectCustomerTransaction(transaction),
      ),
    }
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
    this.assertCanonicalUsdCurrency(
      wallet.currency,
      "WALLET_CURRENCY_UNSUPPORTED",
      "Wallet spending requires a canonical USD wallet",
    )

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
    amount: Decimal | number | string,
    orderId: string,
    user: any,
    existingTx?: any,
  ) {
    assertApiFinanceOperationAllowed("new_liability")
    const amountDecimal = this.canonicalMoneyAmount(amount, "Reservation")
    const run = async (tx: any) => {
      const wallet = await this.lockOwnedSpendableWallet(tx, walletId, user)
      await this.assertOrderMatchesWallet(tx, orderId, wallet)

      const available = new Decimal(wallet.availableBalance)
      if (available.lessThan(amountDecimal)) {
        throw new BadRequestException(
          "Insufficient available balance to reserve",
        )
      }

      const updated = await tx.wallet.updateMany({
        where: { id: walletId, version: wallet.version },
        data: {
          availableBalance: { decrement: amountDecimal },
          reservedBalance: { increment: amountDecimal },
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
          amount: amountDecimal.negated(),
          type: "RESERVATION",
          currency: USD_CURRENCY,
          orderId,
          description: `Reservation of ${amountDecimal.toFixed(2)} USD for order ${orderId}`,
        },
      })

      return fresh
    }
    return existingTx ? run(existingTx) : this.prisma.$transaction(run)
  }

  async payFromReserved(
    walletId: string,
    amount: Decimal | number | string,
    orderId: string,
    user: any,
    existingTx?: any,
  ) {
    assertApiFinanceOperationAllowed("new_liability")
    const amountDecimal = this.canonicalMoneyAmount(amount, "Payment")
    const run = async (tx: any) => {
      const wallet = await this.lockOwnedSpendableWallet(tx, walletId, user)
      await this.assertOrderMatchesWallet(tx, orderId, wallet)

      const reserved = new Decimal(wallet.reservedBalance)
      if (reserved.lessThan(amountDecimal)) {
        throw new BadRequestException("Insufficient reserved balance")
      }

      const updated = await tx.wallet.updateMany({
        where: { id: walletId, version: wallet.version },
        data: {
          reservedBalance: { decrement: amountDecimal },
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
          amount: amountDecimal.negated(),
          type: "PURCHASE",
          currency: USD_CURRENCY,
          orderId,
          description: `Payment of ${amountDecimal.toFixed(2)} USD from reserved funds for order ${orderId}`,
        },
      })

      return fresh
    }
    return existingTx ? run(existingTx) : this.prisma.$transaction(run)
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
