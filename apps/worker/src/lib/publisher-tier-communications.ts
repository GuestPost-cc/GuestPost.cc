import { recordCommunicationOutbox } from "@guestpost/shared"
import type { TrustRecomputeResult } from "@guestpost/shared/dist/publisher-trust-core"

export async function recordPublisherTierCommunications(
  tx: any,
  result: TrustRecomputeResult | null,
): Promise<string[]> {
  if (!result?.changed) return []
  if (!result.transitionId) {
    throw new Error("Publisher tier transition is missing durable identity")
  }

  const [publisher, publisherMemberships, staffMemberships] = await Promise.all(
    [
      tx.publisher.findUnique({
        where: { id: result.publisherId },
        select: { name: true, organizationId: true },
      }),
      tx.publisherMembership.findMany({
        where: { publisherId: result.publisherId },
        select: { userId: true },
      }),
      tx.staffMembership.findMany({
        where: {
          role: { in: ["SUPER_ADMIN", "OPERATIONS"] },
          user: { banned: false },
        },
        select: { userId: true },
      }),
    ],
  )
  if (!publisher) return []

  const publisherEvent = await recordCommunicationOutbox(tx, {
    type: "PUBLISHER_TIER_CHANGED",
    aggregateType: "Publisher",
    aggregateId: result.publisherId,
    organizationId: publisher.organizationId,
    title: "Publisher tier changed",
    message: `Your publisher tier changed from ${result.oldTier ?? "NEW"} to ${result.newTier}.`,
    actionPath: "/dashboard/settings",
    payload: {
      from: result.oldTier,
      to: result.newTier,
      trustScore: result.newScore,
      transitionId: result.transitionId,
    },
    dedupKey: `publisher:${result.publisherId}:tier-change:${result.transitionId}`,
    recipientUserIds: publisherMemberships.map(
      (item: { userId: string }) => item.userId,
    ),
  })
  const staffEvent = await recordCommunicationOutbox(tx, {
    type: "STAFF_PUBLISHER_TIER_CHANGED",
    aggregateType: "Publisher",
    aggregateId: result.publisherId,
    organizationId: publisher.organizationId,
    title: "Publisher tier changed",
    message: `Publisher ${publisher.name ?? result.publisherId} changed from ${result.oldTier ?? "NEW"} to ${result.newTier}.`,
    actionPath: "/dashboard/publishers",
    payload: {
      from: result.oldTier,
      to: result.newTier,
      trustScore: result.newScore,
      transitionId: result.transitionId,
    },
    dedupKey: `staff:publisher:${result.publisherId}:tier-change:${result.transitionId}`,
    recipientUserIds: staffMemberships.map(
      (item: { userId: string }) => item.userId,
    ),
  })
  return [publisherEvent.eventId, staffEvent.eventId]
}
