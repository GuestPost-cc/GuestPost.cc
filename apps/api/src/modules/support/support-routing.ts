import type { Prisma } from "@guestpost/database"

/**
 * The only ticket shapes that Operations may treat as Platform support.
 *
 * New rows carry an explicit PLATFORM snapshot and no publisher owner. Older
 * general tickets predate that snapshot and are safe to grandfather only when
 * they have neither an order nor a publisher owner. Every ambiguous or
 * contradictory shape fails closed.
 */
export interface PlatformSupportRoutingFacts {
  orderId: string | null
  fulfillmentChannel: "PLATFORM" | "PUBLISHER" | null
  assignedPublisherId: string | null
}

export function isOperationsPlatformSupportTicket(
  ticket: PlatformSupportRoutingFacts,
): boolean {
  if (ticket.assignedPublisherId !== null) return false
  if (ticket.fulfillmentChannel === "PLATFORM") return true
  return ticket.fulfillmentChannel === null && ticket.orderId === null
}

/** Prisma equivalent of {@link isOperationsPlatformSupportTicket}. */
export function operationsPlatformSupportWhere(): Prisma.TicketWhereInput {
  return {
    assignedPublisherId: null,
    OR: [
      { fulfillmentChannel: "PLATFORM" },
      { fulfillmentChannel: null, orderId: null },
    ],
  }
}
