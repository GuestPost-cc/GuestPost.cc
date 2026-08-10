import { prisma } from "@guestpost/database"
import { recordCommunicationOutbox } from "@guestpost/shared"
import type { TrustRecomputeResult } from "@guestpost/shared/dist/publisher-trust-core"

export async function recordPublisherTierCommunications(
  result: TrustRecomputeResult | null,
) {
  if (!result?.changed) return

  await prisma.$transaction(async (tx) => {
    const [publisher, publisherMemberships, staffMemberships, audit] =
      await Promise.all([
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
        tx.auditLog.findFirst({
          where: {
            action: "PUBLISHER_TIER_CHANGED",
            entityType: "Publisher",
            entityId: result.publisherId,
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { id: true },
        }),
      ])
    if (!publisher) return
    const transitionId = audit?.id ?? `${result.oldTier}-${result.newTier}`

    await recordCommunicationOutbox(tx, {
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
      },
      dedupKey: `publisher:${result.publisherId}:tier-change:${transitionId}`,
      recipientUserIds: publisherMemberships.map((item) => item.userId),
    })
    await recordCommunicationOutbox(tx, {
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
      },
      dedupKey: `staff:publisher:${result.publisherId}:tier-change:${transitionId}`,
      recipientUserIds: staffMemberships.map((item) => item.userId),
    })
  })
}
