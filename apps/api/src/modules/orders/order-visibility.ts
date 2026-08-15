import { buildOrderStakeholderTimeline } from "./order-stakeholder-timeline"

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
  "SETTLEMENT_CUSTOMER_APPROVED",
  "SETTLEMENT_RETURNED_TO_REVIEW",
  "SETTLEMENT_RELEASED",
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
  SETTLEMENT_CUSTOMER_APPROVED: {
    CUSTOMER: "Order settlement customer-approved",
    PUBLISHER: "Publisher settlement customer-approved",
    OPERATIONS: "Order settlement customer-approved",
  },
  SETTLEMENT_RETURNED_TO_REVIEW: {
    CUSTOMER: "Order settlement returned to review",
    PUBLISHER: "Publisher settlement returned to review",
    OPERATIONS: "Order settlement returned to review",
  },
  SETTLEMENT_RELEASED: {
    CUSTOMER: "Order settlement funds released",
    PUBLISHER: "Publisher settlement funds released",
    OPERATIONS: "Order settlement funds released",
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

const PUBLIC_EVENT_MESSAGES: Record<string, string> = {
  ORDER_CREATED: "Order created",
  ITEM_ADDED: "Order item added",
  ITEM_REMOVED: "Order item removed",
  PAYMENT_SUBMITTED: "Order payment submitted",
  ORDER_SUBMITTED: "Order submitted",
  PAYMENT_CAPTURED: "Order payment received",
  ORDER_ACCEPTED: "Order accepted",
  CONTENT_REQUESTED: "Content requested",
  CONTENT_SUBMITTED: "Content submitted",
  CONTENT_MARKED_READY: "Content marked ready",
  CONTENT_SUBMITTED_FOR_REVIEW: "Content submitted for review",
  CONTENT_APPROVED: "Content approved",
  REVISION_REQUESTED: "Content revision requested",
  PUBLICATION_MARKED: "Publication recorded",
  VERIFIED_AUTO: "Delivery automatically verified",
  VERIFIED_MANUAL: "Delivery manually verified",
  DELIVERY_CONFIRMED: "Delivery confirmed",
  DISPUTE_OPENED: "Order dispute opened",
  DISPUTE_RESOLVED: "Order dispute resolved",
  ORDER_CANCELLED: "Order cancelled",
  REFUND_ISSUED: "Order refund processed",
  SETTLEMENT_CREATED: "Order settlement created",
  SETTLEMENT_CUSTOMER_APPROVED: "Order settlement customer-approved",
  SETTLEMENT_RETURNED_TO_REVIEW: "Order settlement returned to review",
  SETTLEMENT_RELEASED: "Order settlement funds released",
  REFUNDED: "Order refund completed",
  VERIFICATION_ESCALATED: "Delivery verification requires staff review",
  AUTO_ACCEPTED: "Delivery automatically accepted",
  REVIEW_REMINDER: "Order review reminder",
  CANCELLATION_REQUESTED: "Cancellation requested",
  CANCELLATION_RESPONDED: "Cancellation request updated",
  CANCELLATION_RESOLVED: "Cancellation review completed",
  ORDER_DECLINED: "Order declined",
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
  "publishedUrl",
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

// Event metadata is an external API contract, not a generic JSON redaction
// exercise. A key must be allowed for both the viewer and this exact event
// type. Free-form staff fields such as reason/notes are intentionally absent.
const PUBLIC_EVENT_METADATA_KEYS: Record<string, ReadonlySet<string>> = {
  ORDER_CREATED: new Set(["version"]),
  ITEM_ADDED: new Set(["action", "version"]),
  ITEM_REMOVED: new Set(["action", "version"]),
  PAYMENT_SUBMITTED: new Set(["amount", "currency"]),
  PAYMENT_CAPTURED: new Set(["amount", "currency"]),
  ORDER_SUBMITTED: new Set(["fromStatus", "toStatus", "version"]),
  ORDER_ACCEPTED: new Set(["fromStatus", "toStatus", "version"]),
  CONTENT_REQUESTED: new Set(["deadline", "version"]),
  CONTENT_SUBMITTED: new Set(["hasContent", "version"]),
  CONTENT_MARKED_READY: new Set(["hasContent", "version"]),
  CONTENT_SUBMITTED_FOR_REVIEW: new Set(["hasContent", "version"]),
  CONTENT_APPROVED: new Set(["version"]),
  REVISION_REQUESTED: new Set(["revisionNumber", "version"]),
  PUBLICATION_MARKED: new Set([
    "publishedUrl",
    "url",
    "version",
    "warrantyEndsAt",
  ]),
  VERIFIED_AUTO: new Set([
    "anchorFound",
    "httpStatus",
    "linkFound",
    "targetUrlMatched",
    "verificationMethod",
    "verificationStatus",
    "version",
  ]),
  VERIFIED_MANUAL: new Set([
    "verificationMethod",
    "verificationStatus",
    "version",
  ]),
  DELIVERY_CONFIRMED: new Set([
    "verificationMethod",
    "verificationStatus",
    "version",
  ]),
  DISPUTE_OPENED: new Set(["fromStatus", "toStatus", "version"]),
  DISPUTE_RESOLVED: new Set(["fromStatus", "toStatus", "version"]),
  ORDER_CANCELLED: new Set(["fromStatus", "reasonCode", "toStatus", "version"]),
  REFUND_ISSUED: new Set([
    "amount",
    "currency",
    "customerAmount",
    "refundAmount",
  ]),
  SETTLEMENT_CREATED: new Set([
    "amount",
    "currency",
    "customerAmount",
    "publisherAmount",
  ]),
  SETTLEMENT_CUSTOMER_APPROVED: new Set(["version"]),
  SETTLEMENT_RETURNED_TO_REVIEW: new Set(["version"]),
  SETTLEMENT_RELEASED: new Set(["currency", "publisherAmount", "version"]),
  REFUNDED: new Set(["amount", "currency", "customerAmount", "refundAmount"]),
  VERIFICATION_ESCALATED: new Set([
    "reasonCode",
    "verificationStatus",
    "version",
  ]),
  AUTO_ACCEPTED: new Set(["verificationMethod", "version"]),
  REVIEW_REMINDER: new Set(["deadline"]),
  CANCELLATION_REQUESTED: new Set(["reasonCode", "requesterType", "version"]),
  CANCELLATION_RESPONDED: new Set(["newStatus", "responseAction", "version"]),
  CANCELLATION_RESOLVED: new Set(["newStatus", "reasonCode", "version"]),
  ORDER_DECLINED: new Set(["fromStatus", "reasonCode", "toStatus", "version"]),
}

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
  eventType: string,
) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null
  }

  const audienceKeys =
    actor === "CUSTOMER"
      ? CUSTOMER_PUBLIC_EVENT_KEYS
      : actor === "PUBLISHER"
        ? PUBLISHER_PUBLIC_EVENT_KEYS
        : COMMON_PUBLIC_EVENT_KEYS
  const eventKeys = PUBLIC_EVENT_METADATA_KEYS[eventType]
  if (!eventKeys) return null
  const allowedKeys = new Set(
    [...eventKeys].filter((key) => audienceKeys.has(key)),
  )

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
    // Never return a writer-supplied message to external actors. Several
    // domain writers legitimately embed internal notes, provider errors, or
    // support references in their event message. Public copy is a closed,
    // event-specific server contract; unknown types fail closed to null.
    message: financialMessage ?? PUBLIC_EVENT_MESSAGES[event.eventType] ?? null,
    metadata: projectEventMetadata(event.metadata, actor, event.eventType),
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
  "status",
  "responsibility",
  "responseDeadlineAt",
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
  const projected = pickOwnDefined(value, EXTERNAL_CANCELLATION_REQUEST_KEYS)
  // Customer/publisher-authored request context may be shown back to the
  // order participants. Staff-authored notes and every response note are
  // internal evidence, not public copy; status/timeline projections carry the
  // safe stakeholder decision instead.
  if (
    (value.requesterType === "CUSTOMER" ||
      value.requesterType === "PUBLISHER") &&
    Object.hasOwn(value, "note")
  ) {
    projected.note = value.note
  }
  return projected
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
    // Filtering is mandatory. Redacting only message/metadata still leaks the
    // existence and timing of internal event types to external participants.
    events: Array.isArray(order.events)
      ? order.events
          .filter((event: any) => PUBLIC_EVENT_TYPES.has(event.eventType))
          .map((event: any) => projectOrderEvent(event, actor))
      : [],
    ...(Object.hasOwn(order, "fraudFlags") && {
      stakeholderTimeline: buildOrderStakeholderTimeline(order, actor),
    }),
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
