type ExternalOrderActor = "CUSTOMER" | "PUBLISHER"

const PUBLIC_EVENT_TYPES = new Set([
  "ORDER_CREATED",
  "ITEM_ADDED",
  "ITEM_REMOVED",
  "PAYMENT_SUBMITTED",
  "ORDER_SUBMITTED",
  "PAYMENT_CAPTURED",
  "ORDER_ACCEPTED",
  "CONTENT_REQUESTED",
  "CONTENT_SUBMITTED",
  "CONTENT_MARKED_READY",
  "CONTENT_SUBMITTED_FOR_REVIEW",
  "CONTENT_APPROVED",
  "REVISION_REQUESTED",
  "PUBLICATION_MARKED",
  "VERIFIED_AUTO",
  "VERIFIED_MANUAL",
  "DELIVERY_CONFIRMED",
  "DISPUTE_OPENED",
  "DISPUTE_RESOLVED",
  "ORDER_CANCELLED",
  "REFUND_ISSUED",
  "SETTLEMENT_CREATED",
  "SETTLED",
  "REFUNDED",
  "VERIFICATION_ESCALATED",
  "AUTO_ACCEPTED",
  "REVIEW_REMINDER",
  "CANCELLATION_REQUESTED",
  "CANCELLATION_RESPONDED",
  "CANCELLATION_RESOLVED",
  "ORDER_DECLINED",
])

const FINANCIAL_EVENT_MESSAGES: Record<
  string,
  Record<ExternalOrderActor | "OPERATIONS", string>
> = {
  PAYMENT_SUBMITTED: {
    CUSTOMER: "Order payment submitted",
    PUBLISHER: "Order payment submitted",
    OPERATIONS: "Order payment submitted",
  },
  PAYMENT_CAPTURED: {
    CUSTOMER: "Order payment received",
    PUBLISHER: "Order payment received",
    OPERATIONS: "Order payment received",
  },
  SETTLEMENT_CREATED: {
    CUSTOMER: "Order settlement created",
    PUBLISHER: "Publisher settlement created",
    OPERATIONS: "Order settlement created",
  },
  SETTLED: {
    CUSTOMER: "Order settlement completed",
    PUBLISHER: "Publisher settlement completed",
    OPERATIONS: "Order settlement completed",
  },
  REFUND_ISSUED: {
    CUSTOMER: "Order refund processed",
    PUBLISHER: "Order refund processed",
    OPERATIONS: "Order refund processed",
  },
  REFUNDED: {
    CUSTOMER: "Order refund completed",
    PUBLISHER: "Order refund completed",
    OPERATIONS: "Order refund completed",
  },
}

const COMMON_PUBLIC_EVENT_KEYS = new Set([
  "action",
  "anchorFound",
  "deadline",
  "fromStatus",
  "hasContent",
  "httpStatus",
  "linkFound",
  "newStatus",
  "note",
  "notes",
  "publishedUrl",
  "reason",
  "reasonCode",
  "requesterType",
  "responseAction",
  "revisionNumber",
  "targetUrlMatched",
  "toStatus",
  "url",
  "verificationMethod",
  "verificationStatus",
  "version",
  "warrantyEndsAt",
])

const CUSTOMER_PUBLIC_EVENT_KEYS = new Set([
  ...COMMON_PUBLIC_EVENT_KEYS,
  "amount",
  "currency",
  "customerAmount",
  "refundAmount",
])

const PUBLISHER_PUBLIC_EVENT_KEYS = new Set([
  ...COMMON_PUBLIC_EVENT_KEYS,
  "currency",
  "debtApplied",
  "publisherAmount",
])

function projectEventMetadata(
  metadata: unknown,
  actor: ExternalOrderActor | "OPERATIONS",
) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null
  }

  const allowedKeys =
    actor === "CUSTOMER"
      ? CUSTOMER_PUBLIC_EVENT_KEYS
      : actor === "PUBLISHER"
        ? PUBLISHER_PUBLIC_EVENT_KEYS
        : COMMON_PUBLIC_EVENT_KEYS

  const sanitize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sanitize)
    if (!value || typeof value !== "object") return value
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => allowedKeys.has(key))
        .map(([key, nestedValue]) => [key, sanitize(nestedValue)]),
    )
  }

  return sanitize(metadata)
}

export function projectOrderEvent(
  event: any,
  actor: ExternalOrderActor | "OPERATIONS",
) {
  const financialMessage = FINANCIAL_EVENT_MESSAGES[event.eventType]?.[actor]
  return {
    id: event.id,
    eventType: event.eventType,
    message:
      financialMessage ??
      (PUBLIC_EVENT_TYPES.has(event.eventType)
        ? (event.message ?? null)
        : null),
    metadata: projectEventMetadata(event.metadata, actor),
    createdAt: event.createdAt,
  }
}

export function projectExternalOrder(
  order: any,
  actor: ExternalOrderActor,
  websiteUnlocked = actor === "PUBLISHER",
) {
  const {
    reports: _reports,
    settlements,
    events,
    website,
    items,
    ...publicOrder
  } = order
  const projectWebsite = (value: any) => {
    if (!value || actor === "PUBLISHER" || websiteUnlocked) return value
    const { url: _url, ...safeWebsite } = value
    return {
      ...safeWebsite,
      url: null,
      access: {
        unlocked: false,
        reason: "FIRST_DEPOSIT_REQUIRED",
      },
    }
  }
  return {
    ...publicOrder,
    website: projectWebsite(website),
    items: (items ?? []).map((item: any) => ({
      ...item,
      website: projectWebsite(item.website),
    })),
    events: (events ?? []).map((event: any) => projectOrderEvent(event, actor)),
    settlements:
      actor === "PUBLISHER"
        ? (settlements ?? []).map((settlement: any) => ({
            id: settlement.id,
            status: settlement.status,
            grossAmount: settlement.grossAmount,
            platformFee: settlement.platformFee,
            publisherAmount: settlement.publisherAmount,
            releasePolicy: settlement.releasePolicy,
            reviewEndsAt: settlement.reviewEndsAt,
            releasedAt: settlement.releasedAt,
            createdAt: settlement.createdAt,
            updatedAt: settlement.updatedAt,
          }))
        : [],
  }
}

export function projectOperationsOrder(order: any) {
  const {
    amount: _amount,
    currency: _currency,
    reports: _reports,
    settlements: _settlements,
    events,
    ...operationsOrder
  } = order
  return {
    ...operationsOrder,
    events: (events ?? []).map((event: any) =>
      projectOrderEvent(event, "OPERATIONS"),
    ),
  }
}
