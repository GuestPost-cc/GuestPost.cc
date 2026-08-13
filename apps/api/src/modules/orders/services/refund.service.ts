import {
  financialDocumentSnapshotSchema,
  formatFinancialDocumentNumber,
  isPostPublicationPublisherOrder,
  isSupportedMoneyCurrency,
  normalizeFinancialMoney,
  notificationDedupKey,
  orderEventMetadata,
  REFUNDABLE_ORDER_STATUSES,
  runLockedOrderSerializableTransaction,
  USD_CURRENCY,
} from "@guestpost/shared"
import {
  FinalRefundResponsibility,
  OrderRefundConflictError,
  refundUnacceptedPaidOrderInTransaction,
} from "@guestpost/shared/dist/order-refund-core"
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/client"
import { assertApiFinanceOperationAllowed } from "../../../common/finance-runtime-mode"
import { notificationThreshold } from "../../../common/notification-config"
import { PrismaService } from "../../../common/prisma.service"
import { checkPublisherBalanceInvariant } from "../../../common/publisher-balance-invariants"
import { lockPublisherBalanceForUpdate } from "../../../common/publisher-balance-lock"
import { AuditService } from "../../audit/audit.service"
import { CommunicationsService } from "../../communications/communications.service"
import { QueueService } from "../../queues/queue.service"

export interface RefundOptions {
  responsibility: FinalRefundResponsibility
  publisherCompensation?: PublisherCompensationDecision
}

export interface PublisherCompensationDecision {
  amount?: number
  reason?: string
  // A DISPUTED order temporarily hides the fulfillment milestone that decides
  // whether publisher work has already been performed. Callers resolving a
  // dispute pass its immutable previousStatus through this field.
  effectiveOrderStatus?: string
}

export interface RefundTransactionResult {
  order: any
  refundTransactionId: string
}

const FINAL_REFUND_RESPONSIBILITIES = new Set<FinalRefundResponsibility>([
  "CUSTOMER",
  "PUBLISHER",
  "PLATFORM",
  "SHARED",
  "SYSTEM",
])

interface ResolvedPublisherCompensation {
  publisherId: string
  amount: Decimal
  reason: string
  effectiveOrderStatus: string
  responsibility: FinalRefundResponsibility
}

/**
 * Single refund path for captured payments. Every approved refund flow
 * (cancellation, dispute resolution, emergency force-cancel) goes through here so
 * behavior never diverges: duplicate check, settlement cancellation (with
 * publisher clawback when already released), wallet credit, order state,
 * transaction record, audit.
 */
@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
    @Optional() private readonly communications?: CommunicationsService,
  ) {}

  private assertCanonicalUsd(
    currency: unknown,
    entity: "order" | "wallet" | "publisher balance",
  ) {
    if (!isSupportedMoneyCurrency(currency)) {
      throw new ConflictException({
        code:
          entity === "order"
            ? "ORDER_CURRENCY_UNSUPPORTED"
            : entity === "wallet"
              ? "WALLET_CURRENCY_MISMATCH"
              : "PUBLISHER_BALANCE_CURRENCY_INVALID",
        message:
          entity === "order"
            ? "Order cannot be refunded outside the supported USD currency"
            : entity === "wallet"
              ? "Refund wallet is not a canonical USD wallet"
              : "Publisher balance is not denominated in canonical USD",
      })
    }
  }

  private resolvePublisherCompensation(
    order: any,
    activeSettlement: any | null,
    responsibility: FinalRefundResponsibility,
    input?: PublisherCompensationDecision,
  ): ResolvedPublisherCompensation | null {
    const effectiveOrderStatus = input?.effectiveOrderStatus ?? order.status
    const postPublication = isPostPublicationPublisherOrder({
      fulfillmentChannel: order.fulfillmentChannel,
      websiteOwnershipType: order.website?.ownershipType,
      effectiveOrderStatus,
      hasSettlement: Boolean(activeSettlement),
    })

    if (!postPublication) {
      if (input?.amount != null && new Decimal(input.amount).greaterThan(0)) {
        throw new BadRequestException({
          code: "PUBLISHER_COMPENSATION_NOT_APPLICABLE",
          message:
            "Publisher compensation is only valid for post-publication publisher orders",
        })
      }
      return null
    }

    const publisherId =
      activeSettlement?.publisherId ?? order.website?.publisherId ?? null
    if (!publisherId) {
      throw new ConflictException({
        code: "PUBLISHER_COMPENSATION_PUBLISHER_MISSING",
        message:
          "Post-publication refund has no authoritative publisher identity",
      })
    }

    // Publisher-attributed failure explicitly means no platform-funded
    // compensation. Persist that NONE decision instead of inferring it from a
    // missing settlement or a skipped branch.
    if (responsibility === "PUBLISHER") {
      if (input?.amount != null && !new Decimal(input.amount).isZero()) {
        throw new BadRequestException({
          code: "PUBLISHER_COMPENSATION_RESPONSIBILITY_CONFLICT",
          message:
            "A publisher-attributed refund cannot also credit publisher compensation",
        })
      }
      return {
        publisherId,
        amount: new Decimal(0),
        reason:
          input?.reason?.trim() ||
          "Publisher-attributed refund; publisher compensation is not payable.",
        effectiveOrderStatus,
        responsibility,
      }
    }

    const compensationReason = input?.reason?.trim()
    if (input?.amount == null || !compensationReason) {
      throw new ConflictException({
        code: "PUBLISHER_COMPENSATION_DECISION_REQUIRED",
        message:
          "Post-publication refund requires an explicit publisher compensation amount and reason",
      })
    }
    if (compensationReason.length < 20 || compensationReason.length > 2000) {
      throw new BadRequestException({
        code: "PUBLISHER_COMPENSATION_REASON_INVALID",
        message:
          "Publisher compensation reason must be between 20 and 2000 characters",
      })
    }

    const amount = new Decimal(input.amount)
    if (
      !amount.isFinite() ||
      amount.isNegative() ||
      !amount.mul(100).isInteger()
    ) {
      throw new BadRequestException({
        code: "PUBLISHER_COMPENSATION_AMOUNT_INVALID",
        message:
          "Publisher compensation must be a non-negative USD amount with at most two decimal places",
      })
    }
    const maximum = activeSettlement
      ? new Decimal(activeSettlement.publisherAmount)
      : new Decimal(order.amount ?? 0)
    if (amount.greaterThan(maximum)) {
      throw new BadRequestException({
        code: "PUBLISHER_COMPENSATION_AMOUNT_EXCEEDS_CONTRACT",
        message:
          "Publisher compensation cannot exceed the authoritative publisher amount or order gross amount",
      })
    }

    return {
      publisherId,
      amount,
      reason: compensationReason,
      effectiveOrderStatus,
      responsibility,
    }
  }

  private async recordPublisherCompensation(
    tx: any,
    order: any,
    refundTransactionId: string,
    actorUserId: string,
    plan: ResolvedPublisherCompensation,
  ) {
    const reference = `publisher-compensation:${order.id}`
    const debtReference = `publisher-compensation-debt:${order.id}`
    let compensationTransactionId: string | null = null
    let debtRepaymentTransactionId: string | null = null
    let debtApplied = new Decimal(0)

    if (plan.amount.greaterThan(0)) {
      const balance = await lockPublisherBalanceForUpdate(tx, plan.publisherId)
      if (balance)
        this.assertCanonicalUsd(balance.currency, "publisher balance")
      const debt = new Decimal(balance?.debtBalance ?? 0)
      debtApplied = Decimal.min(debt, plan.amount)
      const withdrawableCredit = plan.amount.minus(debtApplied)

      if (balance) {
        const updated = await tx.publisherBalance.updateMany({
          where: {
            publisherId: plan.publisherId,
            version: balance.version,
          },
          data: {
            currency: USD_CURRENCY,
            withdrawableBalance: { increment: withdrawableCredit },
            debtBalance: { decrement: debtApplied },
            lifetimeEarnings: { increment: plan.amount },
            version: { increment: 1 },
          },
        })
        if (updated.count !== 1) {
          throw new ConflictException(
            "Publisher balance changed while compensation was recorded. Retry.",
          )
        }
        checkPublisherBalanceInvariant(
          {
            ...balance,
            withdrawableBalance: new Decimal(balance.withdrawableBalance).plus(
              withdrawableCredit,
            ),
            debtBalance: debt.minus(debtApplied),
            lifetimeEarnings: new Decimal(balance.lifetimeEarnings).plus(
              plan.amount,
            ),
          },
          this.logger,
          "recordPublisherCompensation",
        )
      } else {
        await tx.publisherBalance.create({
          data: {
            publisherId: plan.publisherId,
            currency: USD_CURRENCY,
            withdrawableBalance: plan.amount,
            lifetimeEarnings: plan.amount,
          },
        })
      }

      const compensationTransaction = await tx.transaction.create({
        data: {
          amount: plan.amount,
          type: "PUBLISHER_COMPENSATION",
          currency: USD_CURRENCY,
          orderId: order.id,
          publisherId: plan.publisherId,
          reference,
          description: `Publisher compensation of ${plan.amount.toFixed(2)} USD for refunded order ${order.id}`,
        },
      })
      compensationTransactionId = compensationTransaction.id

      if (debtApplied.greaterThan(0)) {
        const debtTransaction = await tx.transaction.create({
          data: {
            amount: debtApplied.negated(),
            type: "DEBT_REPAYMENT",
            currency: USD_CURRENCY,
            orderId: order.id,
            publisherId: plan.publisherId,
            reference: debtReference,
            description: `Debt repayment of ${debtApplied.toFixed(2)} USD netted from publisher compensation`,
          },
        })
        debtRepaymentTransactionId = debtTransaction.id
      }
    }

    const compensation = await tx.publisherCompensation.create({
      data: {
        orderId: order.id,
        publisherId: plan.publisherId,
        refundTransactionId,
        compensationTransactionId,
        debtRepaymentTransactionId,
        disposition: plan.amount.isZero() ? "NONE" : "EXACT_AMOUNT",
        amount: plan.amount,
        currency: USD_CURRENCY,
        responsibility: plan.responsibility,
        reason: plan.reason,
        effectiveOrderStatus: plan.effectiveOrderStatus,
        decidedByUserId: actorUserId,
      },
    })

    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        eventType: "PUBLISHER_COMPENSATION_RECORDED",
        actorId: actorUserId,
        message: plan.amount.isZero()
          ? "Publisher compensation explicitly resolved as none"
          : `Publisher compensation recorded: ${plan.amount.toFixed(2)} USD`,
        metadata: {
          publisherCompensationId: compensation.id,
          refundTransactionId,
          publisherId: plan.publisherId,
          amount: plan.amount.toFixed(2),
          currency: USD_CURRENCY,
          responsibility: plan.responsibility,
          effectiveOrderStatus: plan.effectiveOrderStatus,
          compensationTransactionId,
          debtRepaymentTransactionId,
          debtApplied: debtApplied.toFixed(2),
        },
      },
    })
    return compensation
  }

  private async assertExistingRefundEvidence(
    tx: any,
    order: any,
    refund: any,
    expectedReference: string,
  ): Promise<FinalRefundResponsibility> {
    const responsibility = order.refundResponsibility
    const amount = new Decimal(order.amount ?? 0)
    const wallet = await tx.wallet.findUnique({
      where: { organizationId: order.organizationId },
    })
    const refundEvent = await tx.orderEvent.findFirst({
      where: {
        orderId: order.id,
        eventType: "REFUND_ISSUED",
        metadata: { path: ["refundTransactionId"], equals: refund.id },
      },
      select: { id: true },
    })
    let hasRefundEventEvidence = Boolean(refundEvent)
    if (!hasRefundEventEvidence && tx.orderEvent.findMany) {
      // The origin/main post-acceptance writer predates the ledger-ID field on
      // OrderEvent. Grandfather only its exact historical shape: one event
      // whose reason joins the immutable REFUND description and whose
      // responsibility matches the terminal Order. New writers must always
      // use the direct refundTransactionId binding above.
      const candidates = await tx.orderEvent.findMany({
        where: { orderId: order.id, eventType: "REFUND_ISSUED" },
        select: { id: true, actorId: true, message: true, metadata: true },
      })
      const legacyMatches = candidates.filter((candidate: any) => {
        const metadata =
          candidate.metadata &&
          typeof candidate.metadata === "object" &&
          !Array.isArray(candidate.metadata)
            ? (candidate.metadata as Record<string, unknown>)
            : null
        const reason =
          typeof metadata?.reason === "string" ? metadata.reason : null
        const settlementCancelled = metadata?.settlementCancelled
        return (
          Object.keys(metadata ?? {})
            .sort()
            .join(",") ===
            "reason,refundedBy,responsibility,settlementCancelled" &&
          reason !== null &&
          metadata?.responsibility === responsibility &&
          typeof metadata?.refundedBy === "string" &&
          (candidate.actorId === null ||
            candidate.actorId === metadata?.refundedBy) &&
          (settlementCancelled === null ||
            typeof settlementCancelled === "string") &&
          candidate.message === `Order refunded: ${reason}` &&
          refund.description === `Refund for order ${order.id}: ${reason}`
        )
      })
      hasRefundEventEvidence = legacyMatches.length === 1
    }
    if (
      order.status !== "REFUNDED" ||
      order.paymentStatus !== "REFUNDED" ||
      !FINAL_REFUND_RESPONSIBILITIES.has(responsibility) ||
      refund.type !== "REFUND" ||
      refund.orderId !== order.id ||
      refund.reference !== expectedReference ||
      refund.currency !== order.currency ||
      !new Decimal(refund.amount ?? 0).equals(amount) ||
      !wallet ||
      refund.walletId !== wallet.id ||
      wallet.currency !== order.currency ||
      !hasRefundEventEvidence
    ) {
      throw new ConflictException(
        "Refund transaction does not match completed order evidence",
      )
    }
    this.assertCanonicalUsd(order.currency, "order")
    this.assertCanonicalUsd(wallet.currency, "wallet")
    return responsibility
  }

  /**
   * An idempotency key identifies one immutable refund command, not merely any
   * refund for the same order. Replays therefore have to match the original
   * attribution, explanation, and publisher-pay disposition exactly. Without
   * this check a caller could receive a successful response for materially
   * different instructions that were never applied.
   */
  private async assertExactRefundReplayIntent(
    tx: any,
    order: any,
    refund: any,
    input: {
      reason: string
      responsibility: FinalRefundResponsibility
      publisherCompensation?: PublisherCompensationDecision
    },
  ): Promise<void> {
    const mismatch = () =>
      new ConflictException({
        code: "REFUND_IDEMPOTENCY_INTENT_MISMATCH",
        message:
          "Idempotency key was already used with different refund instructions",
      })

    if (
      order.refundResponsibility !== input.responsibility ||
      refund.description !== `Refund for order ${order.id}: ${input.reason}`
    ) {
      throw mismatch()
    }

    const persisted = await tx.publisherCompensation.findUnique({
      where: { refundTransactionId: refund.id },
    })
    if (!persisted) {
      // Historical refunds predate explicit publisher-compensation evidence.
      // They may be replayed only when the caller is not trying to introduce a
      // new disposition after the financial command has already committed.
      if (
        input.publisherCompensation?.amount != null ||
        input.publisherCompensation?.reason != null ||
        input.publisherCompensation?.effectiveOrderStatus != null
      ) {
        throw mismatch()
      }
      return
    }

    const amount = new Decimal(persisted.amount ?? 0)
    const supplied = input.publisherCompensation
    if (
      persisted.orderId !== order.id ||
      persisted.refundTransactionId !== refund.id ||
      persisted.responsibility !== input.responsibility ||
      persisted.currency !== USD_CURRENCY ||
      amount.isZero() !== (persisted.disposition === "NONE") ||
      !amount.isZero() !== (persisted.disposition === "EXACT_AMOUNT")
    ) {
      throw new ConflictException(
        "Publisher compensation does not match completed refund evidence",
      )
    }

    if (input.responsibility !== "PUBLISHER" && !supplied) {
      throw mismatch()
    }
    if (
      supplied?.amount != null &&
      !new Decimal(supplied.amount).equals(amount)
    ) {
      throw mismatch()
    }
    if (
      supplied?.reason != null &&
      supplied.reason.trim() !== persisted.reason
    ) {
      throw mismatch()
    }
    if (
      supplied?.effectiveOrderStatus != null &&
      supplied.effectiveOrderStatus !== persisted.effectiveOrderStatus
    ) {
      throw mismatch()
    }
  }

  private async assertLegacyRefundDocument(
    tx: any,
    order: any,
    financialDocumentId: string,
  ): Promise<void> {
    const document = await tx.financialDocument.findUnique({
      where: { id: financialDocumentId },
      include: {
        relatedDocument: {
          select: {
            id: true,
            kind: true,
            aggregateType: true,
            aggregateId: true,
            organizationId: true,
            currency: true,
            total: true,
            numberPrefix: true,
            sequenceNumber: true,
            issuedAt: true,
          },
        },
      },
    })
    const amount = normalizeFinancialMoney(order.amount)
    if (
      document?.kind !== "CREDIT_NOTE" ||
      document.aggregateType !== "Order" ||
      document.aggregateId !== order.id ||
      document.organizationId !== order.organizationId ||
      document.currency !== String(order.currency).toUpperCase() ||
      normalizeFinancialMoney(document.subtotal) !== amount ||
      normalizeFinancialMoney(document.taxAmount) !== "0.00" ||
      normalizeFinancialMoney(document.total) !== amount ||
      document.dedupKey !== `financial-document:order:${order.id}:refunded`
    ) {
      throw new ConflictException(
        "Legacy refund credit note does not match completed order evidence",
      )
    }

    const snapshot = financialDocumentSnapshotSchema.safeParse(
      document.snapshot,
    )
    const related = document.relatedDocument
    const relatedDocumentValid = related
      ? related.id === document.relatedDocumentId &&
        related.kind === "PAID_INVOICE" &&
        related.aggregateType === "Order" &&
        related.aggregateId === order.id &&
        related.organizationId === order.organizationId &&
        related.currency === String(order.currency).toUpperCase() &&
        normalizeFinancialMoney(related.total) === amount &&
        snapshot.success &&
        snapshot.data.relatedDocumentNumber ===
          formatFinancialDocumentNumber(related)
      : document.relatedDocumentId === null &&
        snapshot.success &&
        snapshot.data.relatedDocumentNumber === null
    const serviceName = String(order.type)
      .toLowerCase()
      .split("_")
      .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
      .join(" ")
    if (
      !snapshot.success ||
      !relatedDocumentValid ||
      snapshot.data.lineItems.length !== 1 ||
      snapshot.data.lineItems[0]?.description !==
        `Refund - ${serviceName} service` ||
      snapshot.data.lineItems[0]?.quantity !== 1 ||
      normalizeFinancialMoney(snapshot.data.lineItems[0]?.unitAmount) !==
        amount ||
      normalizeFinancialMoney(snapshot.data.lineItems[0]?.lineTotal) !==
        amount ||
      snapshot.data.payment.status !== "REFUNDED" ||
      snapshot.data.payment.method !== "GuestPost.cc wallet" ||
      snapshot.data.payment.reference !== `Order ${order.id}` ||
      snapshot.data.tax.label !== "Tax" ||
      snapshot.data.tax.treatment !== "NOT_SEPARATELY_CHARGED" ||
      snapshot.data.tax.note !==
        "No tax was separately charged on this document." ||
      snapshot.data.notes.length !== 0
    ) {
      throw new ConflictException(
        "Legacy refund credit-note snapshot does not match completed order evidence",
      )
    }
  }

  /**
   * Origin/main credit notes used `Order <id>` as their immutable payment
   * reference and omitted refundTransactionId from the event payload. They
   * cannot be rewritten. An exact replay may repair missing projections only
   * after every ledger, tenant, event, audience, and snapshot field proves the
   * historical row is that known shape.
   */
  private async repairValidatedLegacyRefundCommunication(
    tx: any,
    input: {
      order: any
      actorUserId: string
      responsibility: FinalRefundResponsibility
      refundTransactionId: string
      recipientUserIds: string[]
    },
  ): Promise<boolean> {
    if (!this.communications || !tx.communicationEvent?.findUnique) return false
    const dedupKey = `order:${input.order.id}:refunded`
    const existing = await tx.communicationEvent.findUnique({
      where: { dedupKey },
    })
    if (!existing) return false
    const locked = await tx.$queryRaw`
      SELECT "id"
      FROM "CommunicationEvent"
      WHERE "dedupKey" = ${dedupKey}
      FOR UPDATE
    `
    if (
      !Array.isArray(locked) ||
      locked.length !== 1 ||
      locked[0]?.id !== existing.id
    ) {
      throw new ConflictException(
        "Legacy refund communication evidence is ambiguous",
      )
    }
    const event = await tx.communicationEvent.findUnique({
      where: { dedupKey },
    })
    const payload =
      event?.payload &&
      typeof event.payload === "object" &&
      !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : null
    if (Object.hasOwn(payload ?? {}, "refundTransactionId")) return false
    const sourceOrder = await tx.order.findUnique({
      where: { id: input.order.id },
      select: {
        id: true,
        customerId: true,
        organizationId: true,
        type: true,
        amount: true,
        currency: true,
        organization: {
          select: { id: true },
        },
      },
    })
    const financialDocumentId =
      typeof payload?.financialDocumentId === "string"
        ? payload.financialDocumentId
        : null
    const amount = new Decimal(input.order.amount ?? 0)
    if (
      !event ||
      !sourceOrder ||
      sourceOrder.id !== input.order.id ||
      sourceOrder.organizationId !== input.order.organizationId ||
      sourceOrder.organization?.id !== input.order.organizationId ||
      typeof sourceOrder.customerId !== "string" ||
      !input.recipientUserIds.includes(sourceOrder.customerId) ||
      normalizeFinancialMoney(sourceOrder.amount) !==
        normalizeFinancialMoney(input.order.amount) ||
      String(sourceOrder.currency).toUpperCase() !==
        String(input.order.currency).toUpperCase() ||
      event.id !== existing.id ||
      event.type !== "ORDER_REFUNDED" ||
      event.category !== "BILLING" ||
      event.severity !== "WARNING" ||
      event.aggregateType !== "Order" ||
      event.aggregateId !== input.order.id ||
      event.organizationId !== input.order.organizationId ||
      event.title !== "Order refund completed" ||
      event.message !==
        `${amount.toFixed(2)} ${input.order.currency} was returned to your wallet for order ${input.order.id}.` ||
      event.actionPath !== `/dashboard/orders/${input.order.id}` ||
      event.dedupKey !== dedupKey ||
      Object.keys(payload ?? {})
        .sort()
        .join(",") !== "amount,currency,financialDocumentId,responsibility" ||
      normalizeFinancialMoney(payload?.amount) !==
        normalizeFinancialMoney(input.order.amount) ||
      String(payload?.currency ?? "").toUpperCase() !==
        String(input.order.currency).toUpperCase() ||
      payload?.responsibility !== input.responsibility ||
      !financialDocumentId
    ) {
      throw new ConflictException(
        "Legacy refund communication does not match completed order evidence",
      )
    }

    await this.assertLegacyRefundDocument(
      tx,
      { ...sourceOrder, organizationId: sourceOrder.organizationId },
      financialDocumentId,
    )
    const authorized = new Set(input.recipientUserIds)
    const [deliveries, notifications] = await Promise.all([
      tx.communicationDelivery.findMany({
        where: { eventId: event.id },
        select: { userId: true },
      }),
      tx.notification.findMany({
        where: { eventId: event.id },
        select: { userId: true },
      }),
    ])
    if (
      [...deliveries, ...notifications].some(
        (projection: { userId: string | null }) =>
          !projection.userId || !authorized.has(projection.userId),
      )
    ) {
      throw new ConflictException(
        "Legacy refund communication audience does not match the customer account",
      )
    }

    await this.communications.repairValidatedLegacyEvent(
      event,
      input.recipientUserIds,
      input.actorUserId,
      tx,
    )
    return true
  }

  async refundOrder(
    orderId: string,
    reason: string,
    userId: string,
    idempotencyKey: string | undefined,
    options: RefundOptions,
  ) {
    if (!options) {
      throw new BadRequestException(
        "A final refund responsibility attribution is required",
      )
    }
    if (idempotencyKey) {
      const existing = await this.prisma.transaction.findFirst({
        where: { reference: idempotencyKey },
      })
      if (existing && existing.orderId !== orderId) {
        throw new ConflictException("Idempotency key belongs to another order")
      }
      if (existing && existing.type !== "REFUND") {
        throw new ConflictException(
          "Idempotency key belongs to a different transaction type",
        )
      }
      if (existing) {
        const replayedOrder = await runLockedOrderSerializableTransaction(
          this.prisma,
          orderId,
          async (tx: any) => {
            const lockedRefund = await tx.transaction.findFirst({
              where: { reference: idempotencyKey },
            })
            if (
              !lockedRefund ||
              lockedRefund.orderId !== orderId ||
              lockedRefund.type !== "REFUND"
            ) {
              throw new ConflictException(
                "Idempotent refund evidence changed before replay",
              )
            }
            const refundedOrder = await tx.order.findUniqueOrThrow({
              where: { id: orderId },
            })
            const responsibility = await this.assertExistingRefundEvidence(
              tx,
              refundedOrder,
              lockedRefund,
              idempotencyKey,
            )
            await this.assertExactRefundReplayIntent(
              tx,
              refundedOrder,
              lockedRefund,
              {
                reason,
                responsibility: options.responsibility,
                publisherCompensation: options.publisherCompensation,
              },
            )
            await this.recordRefundCommunications(tx, {
              order: refundedOrder,
              actorUserId: userId,
              responsibility,
              refundTransactionId: lockedRefund.id,
            })
            return refundedOrder
          },
        )
        this.dispatchOrderRefundCommunicationsBestEffort(orderId)
        return replayedOrder
      }
    }
    assertApiFinanceOperationAllowed("new_liability")

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        website: { select: { ownershipType: true, publisherId: true } },
        dispute: { select: { previousStatus: true } },
      },
    })
    if (!order) throw new NotFoundException("Order not found")
    this.assertCanonicalUsd(order.currency, "order")

    if (
      !(REFUNDABLE_ORDER_STATUSES as readonly string[]).includes(order.status)
    ) {
      throw new BadRequestException(
        `Order cannot be refunded in ${order.status} status`,
      )
    }
    if (order.paymentStatus !== "PAID") {
      throw new BadRequestException("Only paid orders can be refunded")
    }

    const responsibility = options.responsibility
    const result = await runLockedOrderSerializableTransaction(
      this.prisma,
      orderId,
      async (tx: any) => {
        // Re-read after acquiring the parent row lock. A request that waited
        // behind a concurrent refund must observe the committed REFUND row and
        // take the exact-evidence replay path instead of attempting a second
        // transaction with the same unique reference.
        const lockedOrder = await tx.order.findUnique({
          where: { id: orderId },
          include: {
            website: { select: { ownershipType: true, publisherId: true } },
            dispute: { select: { previousStatus: true } },
          },
        })
        if (!lockedOrder) throw new NotFoundException("Order not found")
        return this.refundOrderInTransaction(
          tx,
          lockedOrder,
          reason,
          userId,
          idempotencyKey,
          responsibility,
          options.publisherCompensation
            ? {
                ...options.publisherCompensation,
                effectiveOrderStatus:
                  options.publisherCompensation.effectiveOrderStatus ??
                  lockedOrder.dispute?.previousStatus ??
                  lockedOrder.status,
              }
            : undefined,
        )
      },
    )
    this.dispatchOrderRefundCommunicationsBestEffort(orderId)

    // Refunds only affect publisher trust when the case attributes the failure
    // to the publisher. Customer changes of mind and platform failures must not
    // silently punish a publisher.
    if (responsibility === "PUBLISHER") {
      await this.queue.enqueueTrustRecompute(
        order.website?.publisherId,
        "REFUND_ISSUED",
        `publisher-attributed refund on order ${orderId}`,
      )
    }

    return result.order
  }

  /**
   * Resolves only committed refund-related event IDs after the authoritative
   * domain transaction completes, then wakes their email deliveries. This is
   * safe across serializable retries because no ID captured by a rolled-back
   * attempt escapes the transaction; the database sweep remains the fallback.
   */
  dispatchOrderRefundCommunicationsBestEffort(orderId: string): void {
    if (!this.communications) return
    void this.prisma.communicationEvent
      .findMany({
        where: {
          aggregateType: "Order",
          aggregateId: orderId,
          type: {
            in: [
              "ORDER_REFUNDED",
              "STAFF_HIGH_VALUE_REFUND",
              "PUBLISHER_DEBT_CREATED",
              "STAFF_PUBLISHER_DEBT_CREATED",
            ],
          },
        },
        select: { id: true },
      })
      .then((events) => {
        this.communications?.dispatchManyBestEffort(
          events.map((event) => event.id),
        )
      })
      .catch((error) => {
        this.logger.warn(
          `Refund communications for order ${orderId} remain pending for catch-up: ${error}`,
        )
      })
  }

  /**
   * Transaction-aware refund primitive used by dispute/cancellation workflows.
   * The caller owns the transaction and can resolve its case record in the same
   * commit as the wallet, settlement, assignment, order, event, and audit writes.
   */
  async refundOrderInTransaction(
    tx: any,
    order: any,
    reason: string,
    userId: string,
    idempotencyKey: string | undefined,
    responsibility: FinalRefundResponsibility,
    publisherCompensation?: PublisherCompensationDecision,
  ): Promise<RefundTransactionResult> {
    this.assertCanonicalUsd(order.currency, "order")
    // Duplicate guard
    if (idempotencyKey) {
      const existing = await tx.transaction.findFirst({
        where: { reference: idempotencyKey },
      })
      if (existing) {
        if (existing.orderId !== order.id) {
          throw new ConflictException(
            "Idempotency key belongs to another order",
          )
        }
        if (existing.type !== "REFUND") {
          throw new ConflictException(
            "Idempotency key belongs to a different transaction type",
          )
        }
        const refundedOrder = await tx.order.findUniqueOrThrow({
          where: { id: order.id },
        })
        const persistedResponsibility = await this.assertExistingRefundEvidence(
          tx,
          refundedOrder,
          existing,
          idempotencyKey,
        )
        await this.assertExactRefundReplayIntent(tx, refundedOrder, existing, {
          reason,
          responsibility,
          publisherCompensation,
        })
        await this.recordRefundCommunications(tx, {
          order: refundedOrder,
          actorUserId: userId,
          responsibility: persistedResponsibility,
          refundTransactionId: existing.id,
        })
        return {
          order: refundedOrder,
          refundTransactionId: existing.id,
        }
      }
    }
    const existingRefund = await tx.transaction.findFirst({
      where: { orderId: order.id, type: "REFUND" },
    })
    if (existingRefund) {
      throw new BadRequestException("Order already refunded")
    }
    assertApiFinanceOperationAllowed("new_liability")

    if (
      !(REFUNDABLE_ORDER_STATUSES as readonly string[]).includes(order.status)
    ) {
      throw new BadRequestException(
        `Order cannot be refunded in ${order.status} status`,
      )
    }
    if (order.paymentStatus !== "PAID") {
      throw new BadRequestException("Only paid orders can be refunded")
    }

    if (["PAID", "SUBMITTED"].includes(order.status)) {
      try {
        const result = await refundUnacceptedPaidOrderInTransaction(
          tx,
          order,
          {
            reference: idempotencyKey ?? `refund-${order.id}`,
            reason,
            responsibility,
            actorUserId: userId,
            auditAction: "ORDER_REFUNDED",
            auditMetadata: {
              reason,
              ...orderEventMetadata(order),
            },
          },
          (data, auditTx) => this.audit.log(data, auditTx),
        )
        await this.recordRefundCommunications(tx, {
          order: result.order,
          actorUserId: userId,
          responsibility,
          refundTransactionId: result.refundTransactionId,
        })
        return result
      } catch (error) {
        if (error instanceof OrderRefundConflictError) {
          throw new ConflictException(error.message)
        }
        throw error
      }
    }

    // Channel snapshot is authoritative — but legacy orders predate the
    // snapshot, so fall back to website.ownershipType for them.
    const channel =
      order.fulfillmentChannel ??
      (order.website?.ownershipType === "PLATFORM" ? "PLATFORM" : "PUBLISHER")
    const isPlatformOrder = channel === "PLATFORM"
    let cancelledSettlementId: string | null = null
    let publisherCompensationPlan: ResolvedPublisherCompensation | null = null

    if (isPlatformOrder) {
      // Platform order: reverse PlatformRevenue. The row is never deleted —
      // financial records survive; revenue queries filter reversedAt: null.
      await tx.platformRevenue.updateMany({
        where: { orderId: order.id, reversedAt: null },
        data: { reversedAt: new Date() },
      })
    } else {
      // Publisher order: cancel settlement + clawback if released
      const activeSettlement = await tx.settlement.findFirst({
        where: { orderId: order.id, status: { not: "CANCELLED" } },
      })
      publisherCompensationPlan = this.resolvePublisherCompensation(
        order,
        activeSettlement,
        responsibility,
        publisherCompensation,
      )
      if (activeSettlement && activeSettlement.status !== "RELEASED") {
        const cancelled = await tx.settlement.updateMany({
          where: {
            id: activeSettlement.id,
            version: activeSettlement.version,
          },
          data: { status: "CANCELLED", version: { increment: 1 } },
        })
        if (cancelled.count === 0) {
          throw new ConflictException(
            "Settlement was modified by another request. Retry.",
          )
        }
      }

      // Clawback: settlement already released. The publisher may have
      // withdrawn already — claw back only what is withdrawable and record
      // the remainder as debt, netted against future settlement releases.
      // (A blind decrement would hit the >= 0 CHECK constraint and make the
      // customer's refund impossible.)
      if (activeSettlement && activeSettlement.status === "RELEASED") {
        const balance = await lockPublisherBalanceForUpdate(
          tx,
          activeSettlement.publisherId,
        )
        const owed = new Decimal(activeSettlement.publisherAmount)
        if (balance) {
          this.assertCanonicalUsd(balance.currency, "publisher balance")
          const withdrawable = new Decimal(balance.withdrawableBalance)
          const clawedNow = Decimal.min(withdrawable, owed)
          const newDebt = owed.minus(clawedNow)

          const updated = await tx.publisherBalance.updateMany({
            where: {
              publisherId: activeSettlement.publisherId,
              version: balance.version,
            },
            data: {
              withdrawableBalance: { decrement: clawedNow },
              debtBalance: { increment: newDebt },
              lifetimeEarnings: { decrement: owed },
              version: { increment: 1 },
            },
          })
          if (updated.count === 0) {
            throw new ConflictException(
              "Publisher balance was modified by another request",
            )
          }

          checkPublisherBalanceInvariant(
            {
              ...balance,
              withdrawableBalance: new Decimal(
                balance.withdrawableBalance,
              ).minus(clawedNow),
              debtBalance: new Decimal(balance.debtBalance ?? 0).plus(newDebt),
              lifetimeEarnings: new Decimal(
                balance.lifetimeEarnings ?? 0,
              ).minus(owed),
            },
            this.logger,
            "refundOrder/clawback",
          )

          if (clawedNow.greaterThan(0)) {
            await tx.transaction.create({
              data: {
                amount: clawedNow.negated(),
                type: "SETTLEMENT_CLAWBACK",
                currency: USD_CURRENCY,
                orderId: order.id,
                publisherId: activeSettlement.publisherId,
                settlementId: activeSettlement.id,
                reference: `clawback-${order.id}`,
                description:
                  `Clawback of ${clawedNow.toFixed(2)} for refunded order ${order.id}` +
                  (newDebt.greaterThan(0)
                    ? ` (${newDebt.toFixed(2)} recorded as debt)`
                    : ""),
              },
            })
          }
          if (newDebt.greaterThan(0)) {
            await this.createPublisherDebtNotifications(tx, {
              publisherId: activeSettlement.publisherId,
              orderId: order.id,
              amount: newDebt,
              currency: USD_CURRENCY,
            })
          }
        } else {
          // No balance row at all — full amount becomes debt
          await tx.publisherBalance.create({
            data: {
              publisherId: activeSettlement.publisherId,
              currency: USD_CURRENCY,
              debtBalance: owed,
            },
          })
          await this.createPublisherDebtNotifications(tx, {
            publisherId: activeSettlement.publisherId,
            orderId: order.id,
            amount: owed,
            currency: USD_CURRENCY,
          })
        }

        const cancelledReleased = await tx.settlement.updateMany({
          where: {
            id: activeSettlement.id,
            status: "RELEASED",
            version: activeSettlement.version,
          },
          data: { status: "CANCELLED", version: { increment: 1 } },
        })
        if (cancelledReleased.count === 0) {
          throw new ConflictException(
            "Settlement was modified by another request. Retry.",
          )
        }
      }
      cancelledSettlementId = activeSettlement?.id ?? null
    }

    // A terminal refund must make the order disappear from every active Ops
    // queue in the same commit. This also cleans legacy DRAFT assignments.
    await tx.fulfillmentAssignment.updateMany({
      where: {
        orderId: order.id,
        status: { in: ["ASSIGNED", "IN_PROGRESS"] },
      },
      data: { status: "CANCELLED", version: { increment: 1 } },
    })

    // Refund captured payment to wallet. Refundable statuses are post-capture,
    // so the order's reservation was already consumed — reservedBalance must not
    // be touched (any reserved funds belong to other orders).
    const wallet = await tx.wallet.findUnique({
      where: { organizationId: order.organizationId },
    })
    const amount = order.amount ? new Decimal(order.amount) : new Decimal(0)
    if (!wallet && amount.greaterThan(0)) {
      throw new ConflictException(
        "Paid order has no organization wallet; refund requires reconciliation",
      )
    }
    if (wallet && amount.greaterThan(0)) {
      this.assertCanonicalUsd(wallet.currency, "wallet")
      const refunded = await tx.wallet.updateMany({
        where: { id: wallet.id, version: wallet.version },
        data: {
          availableBalance: { increment: amount },
          version: { increment: 1 },
        },
      })
      if (refunded.count === 0) {
        throw new ConflictException(
          "Wallet was modified by another request. Retry.",
        )
      }
    }

    const refundedOrder = await tx.order.updateMany({
      where: { id: order.id, version: order.version },
      data: {
        status: "REFUNDED",
        paymentStatus: "REFUNDED",
        refundResponsibility: responsibility,
        version: { increment: 1 },
      },
    })
    if (refundedOrder.count === 0) {
      throw new ConflictException(
        "Order was modified by another request. Retry.",
      )
    }
    const updated = await tx.order.findUniqueOrThrow({
      where: { id: order.id },
    })

    const refundTransaction = await tx.transaction.create({
      data: {
        amount,
        type: "REFUND",
        currency: USD_CURRENCY,
        orderId: order.id,
        walletId: wallet?.id ?? null,
        reference: idempotencyKey ?? `refund-${order.id}`,
        description: `Refund for order ${order.id}: ${reason}`,
      },
    })
    const publisherCompensationRecord = publisherCompensationPlan
      ? await this.recordPublisherCompensation(
          tx,
          order,
          refundTransaction.id,
          userId,
          publisherCompensationPlan,
        )
      : null

    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        eventType: "REFUND_ISSUED",
        actorId: userId,
        message: `Order refunded: ${reason}`,
        metadata: {
          reason,
          refundedBy: userId,
          responsibility,
          settlementCancelled: cancelledSettlementId,
          refundTransactionId: refundTransaction.id,
          publisherCompensationId: publisherCompensationRecord?.id ?? null,
        },
      },
    })

    await this.audit.log(
      {
        action: "ORDER_REFUNDED",
        entityType: "Order",
        entityId: order.id,
        // Phase 6 standardized metadata — orderEventMetadata supplies the
        // snapshot trio so historical refund replays don't have to chase
        // a possibly-edited live listing.
        metadata: {
          fromStatus: order.status,
          reason,
          responsibility,
          refundTransactionId: refundTransaction.id,
          publisherCompensationId: publisherCompensationRecord?.id ?? null,
          ...orderEventMetadata(order),
        },
        userId,
        organizationId: order.organizationId,
      },
      tx,
    )

    await this.recordRefundCommunications(tx, {
      order: updated,
      actorUserId: userId,
      responsibility,
      refundTransactionId: refundTransaction.id,
    })

    return {
      order: updated,
      refundTransactionId: refundTransaction.id,
    }
  }

  /**
   * Records the customer credit-note event and any high-value staff alert in
   * the same transaction as the refund. The stable deduplication keys also let
   * an exact idempotent replay repair communications omitted by older writers
   * without issuing a second refund or financial document.
   */
  private async recordRefundCommunications(
    tx: any,
    input: {
      order: any
      actorUserId: string
      responsibility: FinalRefundResponsibility
      refundTransactionId: string
    },
  ): Promise<void> {
    if (!this.communications) return
    const amount = new Decimal(input.order.amount ?? 0)
    const recipients = await this.communications.customerOrderRecipients(
      input.order.id,
      tx,
    )
    const repairedLegacy = await this.repairValidatedLegacyRefundCommunication(
      tx,
      {
        ...input,
        recipientUserIds: recipients,
      },
    )
    if (!repairedLegacy) {
      await this.communications.record(
        {
          type: "ORDER_REFUNDED",
          aggregateType: "Order",
          aggregateId: input.order.id,
          organizationId: input.order.organizationId,
          title: "Order refund completed",
          message: `${amount.toFixed(2)} ${input.order.currency} was returned to your wallet for order ${input.order.id}.`,
          actionPath: `/dashboard/orders/${input.order.id}`,
          payload: {
            amount: amount.toString(),
            currency: input.order.currency,
            responsibility: input.responsibility,
            refundTransactionId: input.refundTransactionId,
          },
          dedupKey: `order:${input.order.id}:refunded`,
          recipientUserIds: recipients,
          actorUserId: input.actorUserId,
        },
        tx,
      )
    }
    if (
      !amount.greaterThan(
        notificationThreshold("ADMIN_REFUND_NOTIFICATION_THRESHOLD", 100),
      )
    ) {
      return
    }
    const staffRecipients = await this.communications.staffRecipients(
      ["SUPER_ADMIN", "FINANCE"],
      tx,
    )
    await this.communications.record(
      {
        type: "STAFF_HIGH_VALUE_REFUND",
        aggregateType: "Order",
        aggregateId: input.order.id,
        organizationId: input.order.organizationId,
        title: "High-value refund completed",
        message: `${amount.toFixed(2)} ${input.order.currency} was refunded for order ${input.order.id}.`,
        actionPath: `/dashboard/orders/${input.order.id}`,
        payload: {
          amount: amount.toString(),
          currency: input.order.currency,
          responsibility: input.responsibility,
        },
        dedupKey: `staff:order:${input.order.id}:refund:${input.refundTransactionId}`,
        recipientUserIds: staffRecipients,
        actorUserId: input.actorUserId,
      },
      tx,
    )
  }

  private async createPublisherDebtNotifications(
    tx: any,
    args: {
      publisherId: string
      orderId: string
      amount: Decimal
      currency: string
    },
  ) {
    const publisher = await tx.publisher.findUnique({
      where: { id: args.publisherId },
      select: {
        organizationId: true,
        publisherMemberships: { select: { userId: true } },
      },
    })
    if (!publisher) {
      throw new ConflictException(
        "Publisher account is missing for settlement clawback",
      )
    }

    for (const membership of publisher.publisherMemberships) {
      const dedupKey = notificationDedupKey.publisherDebt(
        args.orderId,
        membership.userId,
      )
      await tx.notification.upsert({
        where: {
          userId_dedupKey: { userId: membership.userId, dedupKey },
        },
        create: {
          userId: membership.userId,
          organizationId: publisher.organizationId,
          type: "PUBLISHER_DEBT_CREATED",
          message: `${args.amount.toFixed(2)} ${args.currency} was recorded as outstanding debt after the refund for order ${args.orderId}. Future settlement earnings will repay this debt before funds become withdrawable.`,
          dedupKey,
        },
        update: {},
      })
    }

    if (this.communications) {
      await this.communications.record(
        {
          type: "PUBLISHER_DEBT_CREATED",
          aggregateType: "Order",
          aggregateId: args.orderId,
          organizationId: publisher.organizationId,
          title: "Outstanding publisher debt recorded",
          message: `${args.amount.toFixed(2)} ${args.currency} was recorded as outstanding debt after the refund for order ${args.orderId}. Future settlement earnings will repay this debt before funds become withdrawable.`,
          actionPath: "/dashboard/earnings",
          dedupKey: `publisher-debt:${args.orderId}`,
          recipientUserIds: publisher.publisherMemberships.map(
            (membership: { userId: string }) => membership.userId,
          ),
        },
        tx,
      )
      const staffRecipients = await this.communications.staffRecipients(
        ["SUPER_ADMIN", "FINANCE"],
        tx,
      )
      await this.communications.record(
        {
          type: "STAFF_PUBLISHER_DEBT_CREATED",
          aggregateType: "Order",
          aggregateId: args.orderId,
          organizationId: publisher.organizationId,
          title: "Publisher debt requires monitoring",
          message: `${args.amount.toFixed(2)} ${args.currency} of publisher debt was created for order ${args.orderId}.`,
          actionPath: `/dashboard/orders/${args.orderId}`,
          payload: {
            amount: args.amount.toString(),
            currency: args.currency,
            publisherId: args.publisherId,
          },
          dedupKey: `staff:publisher-debt:${args.orderId}`,
          recipientUserIds: staffRecipients,
        },
        tx,
      )
    }
  }
}
