// Standardized audit-event metadata for any Order-scoped action. Every
// settlement / refund / dispute / delivery / fulfillment write that records
// `audit.log({ entityType: "Order" | "Settlement" | … })` SHOULD spread the
// output of this helper into its `metadata` so the audit log carries the
// Phase 6 snapshot trio uniformly — listingId, listingServiceId, serviceType,
// fulfillmentChannel, ownerType, websiteId, amount.
//
// Why a helper rather than the raw order: any of these fields can be NULL
// on legacy orders, and the helper coerces consistently (e.g. amount goes
// to string so Decimal serialization is stable across runtimes).

export interface OrderLike {
  listingId?: string | null
  listingServiceId?: string | null
  type?: string | null
  fulfillmentChannel?: string | null
  websiteId?: string | null
  amount?: { toString(): string } | string | number | null
}

export interface OrderEventMetadata {
  listingId: string | null
  listingServiceId: string | null
  serviceType: string | null
  fulfillmentChannel: string | null
  ownerType: string | null
  websiteId: string | null
  amount: string | null
}

export function orderEventMetadata(order: OrderLike): OrderEventMetadata {
  const channel = order.fulfillmentChannel ?? null
  const ownerType =
    channel === "PLATFORM"
      ? "PLATFORM"
      : channel === "PUBLISHER"
        ? "PUBLISHER"
        : null
  const amount =
    order.amount == null
      ? null
      : typeof order.amount === "string" || typeof order.amount === "number"
        ? String(order.amount)
        : order.amount.toString()
  return {
    listingId: order.listingId ?? null,
    listingServiceId: order.listingServiceId ?? null,
    serviceType: order.type ?? null,
    fulfillmentChannel: channel,
    ownerType,
    websiteId: order.websiteId ?? null,
    amount,
  }
}
