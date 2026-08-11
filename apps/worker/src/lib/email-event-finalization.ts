/**
 * Terminalize one email delivery while holding the parent communication-event
 * row lock. The event lock is deliberately acquired before the delivery write:
 * concurrent final deliveries for the same event are therefore serialized and
 * the last transaction observes every previously committed terminal state.
 */
export async function runEmailDeliveryTerminalTransaction<T>(
  db: any,
  eventId: string,
  operation: (tx: any) => Promise<{ terminalized: boolean; result: T }>,
): Promise<T> {
  return db.$transaction(async (tx: any) => {
    const eventRows = await tx.$queryRaw`
      SELECT "id"
      FROM "CommunicationEvent"
      WHERE "id" = ${eventId}
      FOR UPDATE
    `
    if (!Array.isArray(eventRows) || eventRows.length !== 1) {
      throw new Error(
        "Communication event was not found while terminalizing email",
      )
    }

    const transition = await operation(tx)
    if (!transition.terminalized) return transition.result

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
        data: { status: "PROCESSED", processedAt: new Date(), lockedAt: null },
      })
    } else {
      // Repair a stale terminal parent left by an older writer while another
      // delivery (including DELIVERY_UNCERTAIN) still requires attention.
      await tx.communicationEvent.updateMany({
        where: { id: eventId, status: "PROCESSED" },
        data: { status: "PENDING", processedAt: null },
      })
    }
    return transition.result
  })
}
