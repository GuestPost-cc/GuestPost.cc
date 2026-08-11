import {
  ACTIVE_CANCELLATION_REQUEST_STATUSES,
  type CommunicationEventInput,
  financialDocumentSnapshotSchema,
  formatFinancialDocumentNumber,
  normalizeFinancialMoney,
  recordCommunicationOutbox,
  repairCommunicationOutboxProjections,
} from "@guestpost/shared"
import {
  type FinalRefundResponsibility,
  refundUnacceptedPaidOrderInTransaction,
} from "@guestpost/shared/dist/order-refund-core"

const LEGACY_REFUND_TITLE = "Order refund completed"
const REFUND_AUDIENCE_SUPPRESSION_REASON =
  "Recipient removed from financial event audience"

function moneyCents(value: unknown): bigint {
  const normalized = normalizeFinancialMoney(value)
  const [whole, fraction] = normalized.split(".") as [string, string]
  return BigInt(whole) * 100n + BigInt(fraction)
}

function financialPayloadAmount(value: unknown): string {
  return normalizeFinancialMoney(value)
}

const FINAL_REFUND_RESPONSIBILITIES = new Set<FinalRefundResponsibility>([
  "CUSTOMER",
  "PUBLISHER",
  "PLATFORM",
  "SHARED",
  "SYSTEM",
])

type RecordOutbox = (
  tx: any,
  input: CommunicationEventInput,
) => Promise<{ eventId: string; deliveryIds: string[] }>

export class AcceptanceTimeoutRefundEvidenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AcceptanceTimeoutRefundEvidenceError"
  }
}

function timeoutResponsibility(order: any): FinalRefundResponsibility {
  return (order.fulfillmentChannel ??
    (order.website?.ownershipType === "PLATFORM"
      ? "PLATFORM"
      : "PUBLISHER")) === "PLATFORM"
    ? "PLATFORM"
    : "PUBLISHER"
}

function assertExistingRefundEvidence(
  order: any,
  transaction: any,
  responsibility: FinalRefundResponsibility,
  refundEvent: any,
): void {
  const eventMetadata =
    refundEvent?.metadata &&
    typeof refundEvent.metadata === "object" &&
    !Array.isArray(refundEvent.metadata)
      ? (refundEvent.metadata as Record<string, unknown>)
      : null
  if (
    transaction.type !== "REFUND" ||
    transaction.orderId !== order.id ||
    transaction.reference !== `acceptance-timeout:${order.id}` ||
    transaction.currency !== order.currency ||
    normalizeFinancialMoney(transaction.amount) !==
      normalizeFinancialMoney(order.amount) ||
    !transaction.walletId ||
    transaction.wallet?.organizationId !== order.organizationId ||
    transaction.wallet?.currency !== order.currency ||
    refundEvent?.orderId !== order.id ||
    refundEvent?.eventType !== "REFUND_ISSUED" ||
    eventMetadata?.refundTransactionId !== transaction.id
  ) {
    throw new AcceptanceTimeoutRefundEvidenceError(
      "Acceptance-timeout refund ledger evidence does not match the order",
    )
  }
  if (
    order.status !== "REFUNDED" ||
    order.paymentStatus !== "REFUNDED" ||
    !FINAL_REFUND_RESPONSIBILITIES.has(order.refundResponsibility) ||
    order.refundResponsibility !== responsibility
  ) {
    throw new AcceptanceTimeoutRefundEvidenceError(
      "Acceptance-timeout refund ledger evidence does not match terminal order state",
    )
  }
}

function legacyRefundMessage(order: any): string {
  return `${normalizeFinancialMoney(order.amount)} ${order.currency} was returned to the customer wallet because order ${order.id} was not accepted in time.`
}

function expectedLegacyLineDescription(order: any): string {
  const serviceName = String(order.type)
    .toLowerCase()
    .split("_")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ")
  return `Refund - ${serviceName} service`
}

async function loadLockedCommunicationEvent(
  tx: any,
  dedupKey: string,
): Promise<any> {
  if (!tx.communicationEvent?.findUnique || !tx.$queryRaw) return null
  const rows = await tx.$queryRaw`
    SELECT "id"
    FROM "CommunicationEvent"
    WHERE "dedupKey" = ${dedupKey}
    FOR UPDATE
  `
  if (!Array.isArray(rows) || rows.length === 0) return null
  if (rows.length !== 1) {
    throw new AcceptanceTimeoutRefundEvidenceError(
      "Acceptance-timeout refund event identity is ambiguous",
    )
  }
  return tx.communicationEvent.findUnique({ where: { dedupKey } })
}

async function loadLockedRefundEvent(tx: any, orderId: string): Promise<any> {
  return loadLockedCommunicationEvent(tx, `order:${orderId}:refunded`)
}

function assertLegacyRefundEventIdentity(event: any, order: any): string {
  const payload =
    event?.payload &&
    typeof event.payload === "object" &&
    !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : null
  const financialDocumentId =
    typeof payload?.financialDocumentId === "string"
      ? payload.financialDocumentId
      : null
  if (
    event?.type !== "ORDER_REFUNDED" ||
    event.category !== "BILLING" ||
    event.severity !== "WARNING" ||
    event.aggregateType !== "Order" ||
    event.aggregateId !== order.id ||
    event.organizationId !== order.organizationId ||
    event.title !== LEGACY_REFUND_TITLE ||
    event.message !== legacyRefundMessage(order) ||
    event.actionPath !== `/dashboard/orders/${order.id}` ||
    Object.keys(payload ?? {})
      .sort()
      .join(",") !== "amount,currency,financialDocumentId" ||
    normalizeFinancialMoney(payload?.amount) !==
      normalizeFinancialMoney(order.amount) ||
    String(payload?.currency ?? "").toUpperCase() !==
      String(order.currency).toUpperCase() ||
    !financialDocumentId
  ) {
    throw new AcceptanceTimeoutRefundEvidenceError(
      "Legacy acceptance-timeout refund event does not match the order",
    )
  }
  return financialDocumentId
}

function isExactLegacyNumericHighValueEvent(event: any, order: any): boolean {
  const payload =
    event?.payload &&
    typeof event.payload === "object" &&
    !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : null
  if (typeof payload?.amount !== "number") return false
  if (
    event.type !== "STAFF_HIGH_VALUE_REFUND" ||
    event.category !== "STAFF_ALERTS" ||
    event.severity !== "WARNING" ||
    event.aggregateType !== "Order" ||
    event.aggregateId !== order.id ||
    event.organizationId !== order.organizationId ||
    event.title !== "High-value automatic refund" ||
    event.message !==
      `${normalizeFinancialMoney(order.amount)} ${order.currency} was refunded for unaccepted order ${order.id}.` ||
    event.actionPath !== `/dashboard/orders/${order.id}` ||
    Object.keys(payload).sort().join(",") !== "amount,currency" ||
    normalizeFinancialMoney(payload.amount) !==
      normalizeFinancialMoney(order.amount) ||
    String(payload.currency ?? "").toUpperCase() !==
      String(order.currency).toUpperCase()
  ) {
    throw new AcceptanceTimeoutRefundEvidenceError(
      "Legacy high-value refund event does not match the order",
    )
  }
  return true
}

async function assertLegacyFinancialDocument(
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
    throw new AcceptanceTimeoutRefundEvidenceError(
      "Legacy acceptance-timeout credit note does not match the order",
    )
  }
  const snapshot = financialDocumentSnapshotSchema.safeParse(document.snapshot)
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
  if (
    !snapshot.success ||
    !relatedDocumentValid ||
    snapshot.data.lineItems.length !== 1 ||
    snapshot.data.lineItems[0]?.description !==
      expectedLegacyLineDescription(order) ||
    snapshot.data.lineItems[0]?.quantity !== 1 ||
    normalizeFinancialMoney(snapshot.data.lineItems[0]?.unitAmount) !==
      amount ||
    normalizeFinancialMoney(snapshot.data.lineItems[0]?.lineTotal) !== amount ||
    snapshot.data.payment.status !== "REFUNDED" ||
    snapshot.data.payment.method !== "GuestPost.cc wallet" ||
    snapshot.data.payment.reference !== `Order ${order.id}` ||
    snapshot.data.tax.treatment !== "NOT_SEPARATELY_CHARGED"
  ) {
    throw new AcceptanceTimeoutRefundEvidenceError(
      "Legacy acceptance-timeout credit-note snapshot is invalid",
    )
  }
  // The parsed recipient is immutable issuance evidence. A mutable current
  // BillingProfile (or organization name) is not proof of what was correct at
  // the historical issue time, so recovery must never compare the two.
}

async function customerRecipients(tx: any, order: any): Promise<string[]> {
  const owners = await tx.membership.findMany({
    where: {
      organizationId: order.organizationId,
      status: "ACTIVE",
      role: "OWNER",
    },
    select: { userId: true },
  })
  return [
    ...new Set<string>([
      order.customerId,
      ...owners.map((owner: { userId: string }) => owner.userId),
    ]),
  ]
}

async function publisherAudience(
  tx: any,
  publisherId: string | null | undefined,
): Promise<{ organizationId: string | null; userIds: string[] }> {
  if (!publisherId) return { organizationId: null, userIds: [] }
  const publisher = await tx.publisher.findUnique({
    where: { id: publisherId },
    select: {
      organizationId: true,
      publisherMemberships: { select: { userId: true } },
    },
  })
  if (!publisher) return { organizationId: null, userIds: [] }
  return {
    organizationId: publisher.organizationId ?? null,
    userIds: publisher.publisherMemberships.map(
      (membership: { userId: string }) => membership.userId,
    ),
  }
}

async function reconcileRefundEventStatus(
  tx: any,
  eventId: string,
): Promise<void> {
  const outstanding = await tx.communicationDelivery.count({
    where: {
      eventId,
      status: {
        in: ["PENDING", "PROCESSING", "FAILED", "DELIVERY_UNCERTAIN"],
      },
    },
  })
  if (outstanding === 0) {
    await tx.communicationEvent.updateMany({
      where: { id: eventId, status: { not: "PROCESSED" } },
      data: {
        status: "PROCESSED",
        processedAt: new Date(),
        lockedAt: null,
      },
    })
    return
  }
  await tx.communicationEvent.updateMany({
    where: { id: eventId, status: "PROCESSED" },
    data: { status: "PENDING", processedAt: null },
  })
}

async function suppressUnauthorizedRefundAudience(
  tx: any,
  eventId: string,
  authorizedUserIds: string[],
): Promise<number> {
  const unauthorizedUser = {
    OR: [{ userId: null }, { userId: { notIn: authorizedUserIds } }],
  }
  const terminalUnauthorized = tx.communicationDelivery.count
    ? await tx.communicationDelivery.count({
        where: {
          eventId,
          channel: "EMAIL",
          AND: [
            unauthorizedUser,
            {
              OR: [
                {
                  status: {
                    in: ["SENT", "DELIVERY_UNCERTAIN", "BOUNCED", "COMPLAINED"],
                  },
                },
                { dispatchStartedAt: { not: null } },
              ],
            },
          ],
        },
      })
    : 0
  await tx.communicationDelivery.updateMany({
    where: {
      eventId,
      ...unauthorizedUser,
      status: { in: ["PENDING", "FAILED", "PROCESSING"] },
      dispatchStartedAt: null,
    },
    data: {
      status: "SUPPRESSED",
      lockedAt: null,
      failedAt: new Date(),
      lastError: REFUND_AUDIENCE_SUPPRESSION_REASON,
    },
  })
  await tx.notification.deleteMany({
    where: { eventId, ...unauthorizedUser },
  })
  return terminalUnauthorized
}

async function repairLegacyRefundProjections(
  tx: any,
  event: any,
  recipientUserIds: string[],
): Promise<{ deliveryIds: string[]; terminalUnauthorized: number }> {
  const terminalUnauthorized = await suppressUnauthorizedRefundAudience(
    tx,
    event.id,
    recipientUserIds,
  )
  const repaired = await repairCommunicationOutboxProjections(
    tx,
    event,
    recipientUserIds,
  )
  return { deliveryIds: repaired.deliveryIds, terminalUnauthorized }
}

async function recordTimeoutCommunications(
  tx: any,
  input: {
    order: any
    acceptanceHours: number
    responsibility: FinalRefundResponsibility
    refundTransactionId: string
    highValueThreshold: number
  },
  recordOutbox: RecordOutbox,
): Promise<{
  communicationEventIds: string[]
  legacyUnauthorizedTerminalDeliveryCount: number
}> {
  const amountText = normalizeFinancialMoney(input.order.amount)
  const customerUserIds = await customerRecipients(tx, input.order)
  const communicationEventIds: string[] = []
  let legacyUnauthorizedTerminalDeliveryCount = 0
  const refundInput: CommunicationEventInput = {
    type: "ORDER_REFUNDED",
    aggregateType: "Order",
    aggregateId: input.order.id,
    organizationId: input.order.organizationId,
    title: "Order refund completed",
    message: `${amountText} ${input.order.currency} was returned to the customer wallet because order ${input.order.id} was not accepted in time.`,
    actionPath: `/dashboard/orders/${input.order.id}`,
    payload: {
      amount: financialPayloadAmount(input.order.amount),
      currency: input.order.currency,
      responsibility: input.responsibility,
      refundTransactionId: input.refundTransactionId,
    },
    dedupKey: `order:${input.order.id}:refunded`,
    recipientUserIds: customerUserIds,
  }
  const existingRefundEvent = await loadLockedRefundEvent(tx, input.order.id)
  const existingPayload =
    existingRefundEvent?.payload &&
    typeof existingRefundEvent.payload === "object" &&
    !Array.isArray(existingRefundEvent.payload)
      ? (existingRefundEvent.payload as Record<string, unknown>)
      : null
  const explicitLegacyEvent =
    existingRefundEvent &&
    !Object.hasOwn(existingPayload ?? {}, "refundTransactionId")
  if (explicitLegacyEvent) {
    // Origin/main issued this immutable credit note with `Order <id>` as the
    // payment reference and a combined customer+publisher audience. Validate
    // that exact historical shape before repairing only its derived audience;
    // never replace or silently reinterpret the accounting artifact.
    const financialDocumentId = assertLegacyRefundEventIdentity(
      existingRefundEvent,
      input.order,
    )
    await assertLegacyFinancialDocument(tx, input.order, financialDocumentId)
    const repaired = await repairLegacyRefundProjections(
      tx,
      existingRefundEvent,
      customerUserIds,
    )
    communicationEventIds.push(existingRefundEvent.id)
    legacyUnauthorizedTerminalDeliveryCount += repaired.terminalUnauthorized
  } else {
    const refundEvent = await recordOutbox(tx, refundInput)
    communicationEventIds.push(refundEvent.eventId)
    // Any canonical replay can still encounter derived rows created by the
    // historical combined-audience writer. Strip them only after the generic
    // outbox has proved this dedup winner is the exact same event.
    legacyUnauthorizedTerminalDeliveryCount +=
      await suppressUnauthorizedRefundAudience(
        tx,
        refundEvent.eventId,
        customerUserIds,
      )
    // recordOutbox reconciles before the historical unauthorized projections
    // are suppressed. Reconcile again while the event lock is still held so a
    // now-empty event cannot remain permanently PENDING.
    await reconcileRefundEventStatus(tx, refundEvent.eventId)
  }

  const publisher = await publisherAudience(
    tx,
    input.order.website?.publisherId,
  )
  if (publisher.userIds.length > 0) {
    const publisherEvent = await recordOutbox(tx, {
      type: "ORDER_CANCELLED",
      aggregateType: "Order",
      aggregateId: input.order.id,
      organizationId: publisher.organizationId,
      title: "Order cancelled after acceptance timeout",
      message: `Order ${input.order.id} was cancelled because it was not accepted within ${input.acceptanceHours} hours.`,
      actionPath: `/dashboard/orders/${input.order.id}`,
      payload: {
        reason: "ACCEPTANCE_TIMEOUT",
        responsibility: input.responsibility,
      },
      dedupKey: `publisher:order:${input.order.id}:acceptance-timeout-cancelled`,
      recipientUserIds: publisher.userIds,
    })
    communicationEventIds.push(publisherEvent.eventId)
  }

  if (moneyCents(input.order.amount) > moneyCents(input.highValueThreshold)) {
    const highValueDedupKey = `staff:order:${input.order.id}:high-value-refund`
    const existingHighValueEvent = await loadLockedCommunicationEvent(
      tx,
      highValueDedupKey,
    )
    if (
      existingHighValueEvent &&
      isExactLegacyNumericHighValueEvent(existingHighValueEvent, input.order)
    ) {
      // Pre-hardening events stored a JavaScript number. Keep that immutable
      // historical row, but never create another numeric payload.
      communicationEventIds.push(existingHighValueEvent.id)
      return {
        communicationEventIds,
        legacyUnauthorizedTerminalDeliveryCount,
      }
    }
    const staff = await tx.staffMembership.findMany({
      where: {
        role: { in: ["SUPER_ADMIN", "FINANCE"] },
        user: { banned: false },
      },
      select: { userId: true },
    })
    const staffEvent = await recordOutbox(tx, {
      type: "STAFF_HIGH_VALUE_REFUND",
      aggregateType: "Order",
      aggregateId: input.order.id,
      organizationId: input.order.organizationId,
      title: "High-value automatic refund",
      message: `${amountText} ${input.order.currency} was refunded for unaccepted order ${input.order.id}.`,
      actionPath: `/dashboard/orders/${input.order.id}`,
      payload: {
        amount: financialPayloadAmount(input.order.amount),
        currency: input.order.currency,
      },
      dedupKey: highValueDedupKey,
      recipientUserIds: staff.map(
        (membership: { userId: string }) => membership.userId,
      ),
    })
    communicationEventIds.push(staffEvent.eventId)
  }
  return {
    communicationEventIds,
    legacyUnauthorizedTerminalDeliveryCount,
  }
}

/**
 * Process one candidate after its canonical Order row has been locked by the
 * caller. A prior exact refund is a repair replay: validate its ledger binding
 * and recreate any missing outbox projections in this same transaction.
 */
export async function processAcceptanceTimeoutOrderInTransaction(
  tx: any,
  input: {
    orderId: string
    acceptanceHours: number
    highValueThreshold: number
  },
  recordOutbox: RecordOutbox = recordCommunicationOutbox,
): Promise<{
  didRefund: boolean
  communicationEventIds: string[]
  publisherId: string | null
  responsibility: FinalRefundResponsibility | null
  refundTransactionId: string | null
  legacyUnauthorizedTerminalDeliveryCount: number
  skipped?: "ORDER_MISSING" | "NOT_ELIGIBLE" | "CANCELLATION_ACTIVE"
}> {
  const order = await tx.order.findUnique({
    where: { id: input.orderId },
    include: {
      website: { select: { ownershipType: true, publisherId: true } },
      organization: {
        select: { id: true, name: true, billingProfile: true },
      },
    },
  })
  if (!order) {
    return {
      didRefund: false,
      communicationEventIds: [],
      publisherId: null,
      responsibility: null,
      refundTransactionId: null,
      legacyUnauthorizedTerminalDeliveryCount: 0,
      skipped: "ORDER_MISSING",
    }
  }
  const responsibility = timeoutResponsibility(order)
  const reference = `acceptance-timeout:${order.id}`
  const existing = await tx.transaction.findUnique({
    where: { reference },
    include: {
      wallet: { select: { organizationId: true, currency: true } },
    },
  })

  let didRefund = false
  let refundTransactionId: string
  let refundedOrder = order
  if (existing) {
    const refundEvent = await tx.orderEvent.findFirst({
      where: {
        orderId: order.id,
        eventType: "REFUND_ISSUED",
        metadata: { path: ["refundTransactionId"], equals: existing.id },
      },
      select: {
        orderId: true,
        eventType: true,
        metadata: true,
      },
    })
    assertExistingRefundEvidence(order, existing, responsibility, refundEvent)
    refundTransactionId = existing.id
  } else {
    if (order.status !== "SUBMITTED" || order.paymentStatus !== "PAID") {
      return {
        didRefund: false,
        communicationEventIds: [],
        publisherId: order.website?.publisherId ?? null,
        responsibility,
        refundTransactionId: null,
        legacyUnauthorizedTerminalDeliveryCount: 0,
        skipped: "NOT_ELIGIBLE",
      }
    }
    const activeCancellation = await tx.orderCancellationRequest.findFirst({
      where: {
        orderId: order.id,
        status: { in: [...ACTIVE_CANCELLATION_REQUEST_STATUSES] },
      },
      select: { id: true },
    })
    if (activeCancellation) {
      return {
        didRefund: false,
        communicationEventIds: [],
        publisherId: order.website?.publisherId ?? null,
        responsibility,
        refundTransactionId: null,
        legacyUnauthorizedTerminalDeliveryCount: 0,
        skipped: "CANCELLATION_ACTIVE",
      }
    }
    const refund = await refundUnacceptedPaidOrderInTransaction(
      tx,
      order,
      {
        reference,
        reason: `Order not accepted within ${input.acceptanceHours} hours`,
        responsibility,
        actorUserId: null,
        auditAction: "ORDER_ACCEPTANCE_TIMEOUT_REFUND",
        auditMetadata: {
          automatic: true,
          acceptanceHours: input.acceptanceHours,
        },
      },
      (data, auditTx) => auditTx.auditLog.create({ data }),
    )
    didRefund = true
    refundedOrder = { ...order, ...refund.order }
    refundTransactionId = refund.refundTransactionId
  }

  const communications = await recordTimeoutCommunications(
    tx,
    {
      order: refundedOrder,
      acceptanceHours: input.acceptanceHours,
      responsibility,
      refundTransactionId,
      highValueThreshold: input.highValueThreshold,
    },
    recordOutbox,
  )
  return {
    didRefund,
    communicationEventIds: communications.communicationEventIds,
    publisherId: order.website?.publisherId ?? null,
    responsibility,
    refundTransactionId,
    legacyUnauthorizedTerminalDeliveryCount:
      communications.legacyUnauthorizedTerminalDeliveryCount,
  }
}
