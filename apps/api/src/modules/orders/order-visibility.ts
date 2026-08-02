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

function pickOwnDefined(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const projected: Record<string, unknown> = {}
  for (const key of keys) {
    if (Object.hasOwn(value, key) && value[key] !== undefined) {
      projected[key] = value[key]
    }
  }
  return projected
}

const EXTERNAL_ORDER_SCALAR_KEYS = [
  "id",
  "customerId",
  "version",
  "type",
  "status",
  "amount",
  "currency",
  "paymentStatus",
  "title",
  "instructions",
  "targetUrl",
  "anchorText",
  "publishedUrl",
  "campaignId",
  "autoAcceptAt",
  "verifyMethod",
  "deliveryAcceptedMethod",
  "turnaroundDays",
  "submittedAt",
  "acceptedAt",
  "fulfillmentDueAt",
  "warrantyEndsAt",
  "briefData",
  "fulfillmentChannel",
  "createdAt",
  "updatedAt",
] as const

const EXTERNAL_ORDER_ITEM_KEYS = [
  "id",
  "websiteId",
  "targetUrl",
  "anchorText",
  "price",
  "status",
] as const

const EXTERNAL_PUBLICATION_KEYS = [
  "id",
  "publishedUrl",
  "targetUrl",
  "anchorText",
  "screenshotUrl",
  "publicationDate",
  "verificationStatus",
] as const

const EXTERNAL_ARTICLE_VERSION_KEYS = [
  "id",
  "version",
  "source",
  "purpose",
  "title",
  "body",
  "format",
  "checksum",
  "wordCount",
  "supersedesId",
  "createdAt",
] as const

const EXTERNAL_REVISION_KEYS = [
  "id",
  "notes",
  "files",
  "status",
  "createdAt",
] as const

const EXTERNAL_DISPUTE_KEYS = [
  "id",
  "reason",
  "status",
  "resolvedAt",
  "resolution",
  "createdAt",
  "updatedAt",
] as const

const EXTERNAL_CANCELLATION_REQUEST_KEYS = [
  "id",
  "orderId",
  "requesterType",
  "reasonCode",
  "note",
  "status",
  "responsibility",
  "responseDeadlineAt",
  "responseNote",
  "createdAt",
] as const

function projectExternalWebsite(value: any, websiteUnlocked: boolean) {
  if (value == null) return value
  const projected = pickOwnDefined(value, ["id", "name"])
  if (websiteUnlocked) {
    if (Object.hasOwn(value, "url")) projected.url = value.url
    return projected
  }
  return {
    ...projected,
    url: null,
    access: {
      unlocked: false,
      reason: "FIRST_DEPOSIT_REQUIRED",
    },
  }
}

function projectExternalPublication(value: any) {
  return pickOwnDefined(value, EXTERNAL_PUBLICATION_KEYS)
}

function projectExternalOrderItem(value: any, websiteUnlocked: boolean) {
  const projected = pickOwnDefined(value, EXTERNAL_ORDER_ITEM_KEYS)
  projected.website = projectExternalWebsite(value.website, websiteUnlocked)
  if (Object.hasOwn(value, "publications")) {
    projected.publications = Array.isArray(value.publications)
      ? value.publications.map(projectExternalPublication)
      : []
  }
  return projected
}

export function projectExternalCancellationRequest(value: any) {
  if (value == null) return value
  return pickOwnDefined(value, EXTERNAL_CANCELLATION_REQUEST_KEYS)
}

export function projectExternalOrderDispute(value: any) {
  if (value == null) return value
  return pickOwnDefined(value, EXTERNAL_DISPUTE_KEYS)
}

export function projectExternalOrderReview(value: any) {
  if (value == null) return value
  return pickOwnDefined(value, [
    "id",
    "rating",
    "comment",
    "createdAt",
    "updatedAt",
  ])
}

export function projectExternalOrder(
  order: any,
  actor: ExternalOrderActor,
  websiteUnlocked = actor === "PUBLISHER",
): any {
  const canViewWebsite = actor === "PUBLISHER" || websiteUnlocked
  const projected = pickOwnDefined(order, EXTERNAL_ORDER_SCALAR_KEYS)

  if (Object.hasOwn(order, "campaign")) {
    projected.campaign =
      order.campaign == null
        ? order.campaign
        : pickOwnDefined(order.campaign, ["id", "name"])
  }
  if (Object.hasOwn(order, "contentOrder")) {
    projected.contentOrder =
      order.contentOrder == null
        ? order.contentOrder
        : pickOwnDefined(order.contentOrder, [
            "id",
            "title",
            "brief",
            "deliverable",
            "status",
          ])
  }
  if (Object.hasOwn(order, "articleVersions")) {
    projected.articleVersions = Array.isArray(order.articleVersions)
      ? order.articleVersions.map((article: any) =>
          pickOwnDefined(article, EXTERNAL_ARTICLE_VERSION_KEYS),
        )
      : []
  }
  if (Object.hasOwn(order, "revisions")) {
    projected.revisions = Array.isArray(order.revisions)
      ? order.revisions.map((revision: any) =>
          pickOwnDefined(revision, EXTERNAL_REVISION_KEYS),
        )
      : []
  }
  if (Object.hasOwn(order, "dispute")) {
    projected.dispute = projectExternalOrderDispute(order.dispute)
  }
  if (Object.hasOwn(order, "cancellationRequests")) {
    projected.cancellationRequests = Array.isArray(order.cancellationRequests)
      ? order.cancellationRequests.map(projectExternalCancellationRequest)
      : []
  }

  return {
    ...projected,
    website: projectExternalWebsite(order.website, canViewWebsite),
    items: Array.isArray(order.items)
      ? order.items.map((item: any) =>
          projectExternalOrderItem(item, canViewWebsite),
        )
      : [],
    events: Array.isArray(order.events)
      ? order.events.map((event: any) => projectOrderEvent(event, actor))
      : [],
    settlements:
      actor === "PUBLISHER"
        ? (Array.isArray(order.settlements) ? order.settlements : []).map(
            (settlement: any) => ({
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
            }),
          )
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
