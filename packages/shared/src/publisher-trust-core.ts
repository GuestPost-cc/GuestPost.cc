// Event-driven publisher trust recomputation — pure-ish core (DI prisma, no
// node deps) so both the API (manual/sync path) and the worker (queued path)
// share one implementation. Gathers the publisher's full track record, scores
// it via computePublisherTrust, persists score + tier, and emits audit +
// ops-notification when the tier changes.
import { createLogger } from "./observability/structured-logger"
import { computePublisherTrust } from "./trust-score"

const trustLogger = createLogger("shared.trust")

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
  // The durable audit row is the unique identity of this committed tier
  // transition. from/to alone is not unique when a publisher cycles tiers.
  transitionId: string | null
  durationMs: number
}

/**
 * All manual and computed publisher-tier writers take this row lock before
 * reading the current tier. Keeping one lock protocol prevents a delayed
 * recompute from overwriting a newer manual decision with stale evidence.
 */
export async function lockPublisherTierMutation(
  prisma: any,
  publisherId: string,
): Promise<boolean> {
  const rows = (await prisma.$queryRaw`
    SELECT "id"
    FROM "Publisher"
    WHERE "id" = ${publisherId}
    FOR UPDATE
  `) as Array<{ id: string }>
  return rows.length === 1
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
  if (!(await lockPublisherTierMutation(prisma, publisherId))) return null
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
      where: {
        website: { publisherId },
        status: "REFUNDED",
        refundResponsibility: "PUBLISHER",
      },
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
  let transitionId: string | null = null
  if (changed) {
    // A tier-change communication must never commit when the authoritative
    // tier mutation failed. Production callers wrap this core and their
    // outbox records in one transaction, so propagate the write failure and
    // let the transaction roll back every derived profile/audit/outbox write.
    await prisma.publisher.update({
      where: { id: publisherId },
      data: { tier },
    })
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
    const transitionAudit = await prisma.auditLog.create({
      data: {
        action: "PUBLISHER_TIER_CHANGED",
        entityType: "Publisher",
        entityId: publisherId,
        metadata: { ...meta, direction },
        userId: opts.actorUserId ?? null,
        organizationId: null,
      },
      select: { id: true },
    })
    transitionId = transitionAudit.id
    // Compatibility for lightweight callers that do not expose the durable
    // communication outbox. Production API/worker paths record the typed
    // publisher + staff deliveries after this core returns.
    if (!prisma.communicationEvent) {
      await notifyOps(
        prisma,
        "PUBLISHER_TIER_CHANGED",
        `Publisher ${publisher.name ?? publisherId} ${direction}: ${oldTier} → ${tier} (trust ${oldScore ?? "?"} → ${score}, via ${opts.sourceEvent})`,
      )
    }
  }

  trustLogger.info("recompute", {
    publisherId,
    sourceEvent: opts.sourceEvent,
    score: { from: oldScore, to: score },
    tier: { from: oldTier, to: tier },
    changed,
    transitionId,
    durationMs,
  })

  return {
    publisherId,
    oldScore,
    newScore: score,
    oldTier,
    newTier: tier,
    changed,
    transitionId,
    durationMs,
  }
}

function scoreTierRank(tier: string): number {
  return tier === "VERIFIED" ? 3 : tier === "TRUSTED" ? 2 : 1
}
