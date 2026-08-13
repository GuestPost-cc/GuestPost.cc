export const POST_PUBLICATION_PUBLISHER_ORDER_STATUSES = [
  "PUBLISHED",
  "VERIFIED",
  "DELIVERED",
  "COMPLETED",
] as const

const POST_PUBLICATION_STATUS_SET = new Set<string>(
  POST_PUBLICATION_PUBLISHER_ORDER_STATUSES,
)

export interface PublisherCompensationPolicyInput {
  fulfillmentChannel?: string | null
  websiteOwnershipType?: string | null
  effectiveOrderStatus?: string | null
  hasSettlement?: boolean
}

/**
 * Identifies refunds for which publisher work may already be payable.
 *
 * This predicate deliberately says only whether an explicit disposition is
 * required. The amount, publisher identity, responsibility, and ledger
 * evidence remain locked-domain decisions at the refund boundary.
 */
export function isPostPublicationPublisherOrder(
  input: PublisherCompensationPolicyInput,
): boolean {
  const channel =
    input.fulfillmentChannel ??
    (input.websiteOwnershipType === "PLATFORM" ? "PLATFORM" : "PUBLISHER")
  return (
    channel === "PUBLISHER" &&
    (Boolean(input.hasSettlement) ||
      POST_PUBLICATION_STATUS_SET.has(String(input.effectiveOrderStatus ?? "")))
  )
}
