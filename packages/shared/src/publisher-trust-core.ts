// Event-driven publisher trust recomputation — pure-ish core (DI prisma, no
// node deps) so both the API (manual/sync path) and the worker (queued path)
// share one implementation. Gathers the publisher's full track record, scores
// it via computePublisherTrust, persists score + tier, and emits audit +
// ops-notification when the tier changes.
import { computePublisherTrust } from "./trust-score"

// Debounce window: rapid trust-affecting events for one publisher collapse into
// a single recompute. Enqueue with this jobId + delay; BullMQ drops duplicate
// jobIds while one is pending.
export const TRUST_RECOMPUTE_DEBOUNCE_MS =
  Number(process.env.TRUST_RECOMPUTE_DEBOUNCE_MS) || 5000

export function trustRecomputeJobOptions(publisherId: string) {
  return {
    jobId: `trust-recompute-${publisherId}`,
    delay: TRUST_RECOMPUTE_DEBOUNCE_MS,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
  }
}

export interface TrustRecomputeResult {
  publisherId: string
  oldScore: number | null
  newScore: number
  oldTier: string | null
  newTier: string
  changed: boolean
  durationMs: number
}

async function notifyOps(prisma: any, type: string, message: string) {
  const staff = await prisma.staffMembership.findMany({
    select: { userId: true },
  })
  for (const s of staff) {
    await prisma.notification
      .create({
        data: { userId: s.userId, organizationId: null, type, message },
      })
      .catch(() => undefined)
  }
}

export async function recomputePublisherTrustCore(
  prisma: any,
  publisherId: string,
  opts: {
    sourceEvent: string
    reason?: string
    actorUserId?: string | null
  } = { sourceEvent: "MANUAL" },
): Promise<TrustRecomputeResult | null> {
  const startedAt = Date.now()
  const publisher = await prisma.publisher.findUnique({
    where: { id: publisherId },
    include: { profile: { select: { trustScore: true } } },
  })
  if (!publisher) return null

  const oldScore: number | null = publisher.profile?.trustScore ?? null
  const oldTier: string = publisher.tier

  const [
    reviewAgg,
    totalOrders,
    completedOrders,
    disputeCount,
    refundCount,
    linkRemovals,
    websiteRevocations,
  ] = await Promise.all([
    prisma.orderReview.aggregate({
      where: { publisherId },
      _avg: { rating: true },
      _count: { _all: true },
    }),
    prisma.order.count({ where: { website: { publisherId } } }),
    prisma.order.count({
      where: {
        website: { publisherId },
        status: { in: ["DELIVERED", "SETTLED", "COMPLETED"] },
      },
    }),
    prisma.orderDispute.count({
      where: {
        order: { website: { publisherId } },
        status: { notIn: ["RESOLVED_REJECTED", "RESOLVED_RESTORED"] },
      },
    }),
    prisma.order.count({
      where: { website: { publisherId }, status: "REFUNDED" },
    }),
    prisma.deliveryFraudFlag.count({
      where: { type: "LINK_REMOVED", order: { website: { publisherId } } },
    }),
    prisma.website.count({
      where: { publisherId, verificationStatus: "REVOKED" },
    }),
  ])

  const avgRating = reviewAgg._avg.rating ?? null
  const reviewCount = reviewAgg._count._all
  const { score, band, tier } = computePublisherTrust({
    avgRating,
    reviewCount,
    completedOrders,
    totalOrders,
    disputeCount,
    refundCount,
    linkRemovals,
    websiteRevocations,
  })
  const completionRate = totalOrders > 0 ? completedOrders / totalOrders : null

  await prisma.publisherProfile.upsert({
    where: { publisherId },
    create: {
      publisherId,
      rating: avgRating,
      totalReviews: reviewCount,
      trustScore: score,
      completionRate,
    },
    update: {
      rating: avgRating,
      totalReviews: reviewCount,
      trustScore: score,
      completionRate,
    },
  })
  const changed = tier !== oldTier
  if (changed) {
    await prisma.publisher
      .update({ where: { id: publisherId }, data: { tier } })
      .catch(() => undefined)
  }

  const durationMs = Date.now() - startedAt
  const meta = {
    publisherId,
    oldTrustScore: oldScore,
    newTrustScore: score,
    oldTier,
    newTier: tier,
    band,
    triggerReason: opts.reason ?? null,
    sourceEvent: opts.sourceEvent,
    durationMs,
  }

  await prisma.auditLog.create({
    data: {
      action: "PUBLISHER_TRUST_RECOMPUTED",
      entityType: "Publisher",
      entityId: publisherId,
      metadata: meta,
      userId: opts.actorUserId ?? null,
      organizationId: null,
    },
  })

  if (changed) {
    const direction =
      scoreTierRank(tier) > scoreTierRank(oldTier) ? "upgraded" : "downgraded"
    await prisma.auditLog.create({
      data: {
        action: "PUBLISHER_TIER_CHANGED",
        entityType: "Publisher",
        entityId: publisherId,
        metadata: { ...meta, direction },
        userId: opts.actorUserId ?? null,
        organizationId: null,
      },
    })
    await notifyOps(
      prisma,
      "PUBLISHER_TIER_CHANGED",
      `Publisher ${publisher.name ?? publisherId} ${direction}: ${oldTier} → ${tier} (trust ${oldScore ?? "?"} → ${score}, via ${opts.sourceEvent})`,
    )
  }

  // Observability — single structured line carries the "metrics" fields.
  console.log(
    `[TRUST] recompute publisher=${publisherId} source=${opts.sourceEvent} score=${oldScore}->${score} tier=${oldTier}->${tier} changed=${changed} durationMs=${durationMs}`,
  )

  return {
    publisherId,
    oldScore,
    newScore: score,
    oldTier,
    newTier: tier,
    changed,
    durationMs,
  }
}

function scoreTierRank(tier: string): number {
  return tier === "VERIFIED" ? 3 : tier === "TRUSTED" ? 2 : 1
}
