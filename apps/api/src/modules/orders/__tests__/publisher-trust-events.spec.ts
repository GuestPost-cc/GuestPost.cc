/**
 * Event-driven publisher trust: core recompute (tier up/down + audit + ops
 * notify), debounce/dedup job options, and the worker cores emitting trust
 * events on link removal/restoration.
 */

import {
  type FetchResult,
  runDeliveryLinkRecheck,
} from "@guestpost/shared/dist/delivery-verification-core"
import {
  recomputePublisherTrustCore,
  TRUST_RECOMPUTE_DEBOUNCE_MS,
  trustRecomputeJobOptions,
} from "@guestpost/shared/dist/publisher-trust-core"

function trustPrisma(
  over: {
    oldTier?: string
    oldScore?: number | null
    rating?: number
    reviewCount?: number
    completed?: number
    total?: number
    disputes?: number
    refunds?: number
    linkRemovals?: number
    revocations?: number
  } = {},
) {
  const audits: any[] = []
  const notifs: any[] = []
  return {
    _audits: audits,
    _notifs: notifs,
    publisher: {
      findUnique: jest.fn().mockResolvedValue({
        id: "pub1",
        name: "Pub",
        tier: over.oldTier ?? "NEW",
        profile: { trustScore: over.oldScore ?? null },
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    orderReview: {
      aggregate: jest.fn().mockResolvedValue({
        _avg: { rating: over.rating ?? 5 },
        _count: { _all: over.reviewCount ?? 5 },
      }),
    },
    order: {
      count: jest.fn().mockImplementation(({ where }: any) => {
        if (where.status?.in) return Promise.resolve(over.completed ?? 6)
        if (where.status === "REFUNDED")
          return Promise.resolve(over.refunds ?? 0)
        return Promise.resolve(over.total ?? 6)
      }),
    },
    orderDispute: { count: jest.fn().mockResolvedValue(over.disputes ?? 0) },
    deliveryFraudFlag: {
      count: jest.fn().mockResolvedValue(over.linkRemovals ?? 0),
    },
    website: { count: jest.fn().mockResolvedValue(over.revocations ?? 0) },
    publisherProfile: { upsert: jest.fn().mockResolvedValue({}) },
    staffMembership: {
      findMany: jest.fn().mockResolvedValue([{ userId: "s1" }]),
    },
    notification: {
      create: jest.fn().mockImplementation((a: any) => {
        notifs.push(a.data)
        return Promise.resolve({})
      }),
    },
    auditLog: {
      create: jest.fn().mockImplementation((a: any) => {
        audits.push(a.data)
        return Promise.resolve({})
      }),
    },
  }
}

describe("trustRecomputeJobOptions (dedup/debounce)", () => {
  it("uses a per-publisher jobId + debounce delay so bursts collapse", () => {
    const o = trustRecomputeJobOptions("pub1")
    expect(o.jobId).toBe("trust-recompute-pub1")
    expect(o.delay).toBe(TRUST_RECOMPUTE_DEBOUNCE_MS)
    // Two events for the same publisher map to the same jobId -> one job.
    expect(trustRecomputeJobOptions("pub1").jobId).toBe(o.jobId)
  })
})

describe("recomputePublisherTrustCore", () => {
  it("upgrades tier on strong record + audits RECOMPUTED & TIER_CHANGED + notifies ops", async () => {
    const prisma = trustPrisma({
      oldTier: "NEW",
      oldScore: 30,
      rating: 5,
      reviewCount: 5,
      completed: 8,
      total: 8,
    })
    const r = await recomputePublisherTrustCore(prisma as any, "pub1", {
      sourceEvent: "ORDER_REVIEW_CREATED",
    })
    expect(r?.newTier).toBe("VERIFIED")
    expect(r?.changed).toBe(true)
    expect(prisma.publisher.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { tier: "VERIFIED" } }),
    )
    expect(prisma._audits.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        "PUBLISHER_TRUST_RECOMPUTED",
        "PUBLISHER_TIER_CHANGED",
      ]),
    )
    expect(
      prisma._notifs.some((n) => n.type === "PUBLISHER_TIER_CHANGED"),
    ).toBe(true)
  })

  it("downgrades when a delivered link was removed (VERIFIED requires 0 removals)", async () => {
    const prisma = trustPrisma({
      oldTier: "VERIFIED",
      oldScore: 85,
      rating: 5,
      reviewCount: 5,
      completed: 8,
      total: 8,
      linkRemovals: 1,
    })
    const r = await recomputePublisherTrustCore(prisma as any, "pub1", {
      sourceEvent: "LINK_REMOVED",
    })
    expect(r?.oldTier).toBe("VERIFIED")
    expect(r?.newTier).not.toBe("VERIFIED")
    expect(r?.changed).toBe(true)
    expect(
      prisma._audits.some(
        (a) =>
          a.action === "PUBLISHER_TIER_CHANGED" &&
          a.metadata.direction === "downgraded",
      ),
    ).toBe(true)
  })

  it("no tier change -> no TIER_CHANGED audit, no ops notify", async () => {
    const prisma = trustPrisma({
      oldTier: "TRUSTED",
      oldScore: 60,
      rating: 4,
      reviewCount: 3,
      completed: 3,
      total: 4,
    })
    const r = await recomputePublisherTrustCore(prisma as any, "pub1", {
      sourceEvent: "DISPUTE_RESOLVED",
    })
    expect(r?.newTier).toBe("TRUSTED")
    expect(r?.changed).toBe(false)
    expect(
      prisma._audits.some((a) => a.action === "PUBLISHER_TIER_CHANGED"),
    ).toBe(false)
    expect(prisma._notifs.length).toBe(0)
  })

  it("excludes RESOLVED_REJECTED and RESOLVED_RESTORED disputes from count", async () => {
    const prisma = trustPrisma({ disputes: 0 })
    const r = await recomputePublisherTrustCore(prisma as any, "pub1", {
      sourceEvent: "DISPUTE_RESOLVED",
    })
    const callArgs = prisma.orderDispute.count.mock.calls[0][0]
    expect(callArgs.where.status).toEqual({
      notIn: ["RESOLVED_REJECTED", "RESOLVED_RESTORED"],
    })
  })

  it("returns null for an unknown publisher", async () => {
    const prisma = trustPrisma()
    prisma.publisher.findUnique.mockResolvedValue(null)
    expect(
      await recomputePublisherTrustCore(prisma as any, "missing", {
        sourceEvent: "MANUAL",
      }),
    ).toBeNull()
  })
})

describe("runDeliveryLinkRecheck emits trust events", () => {
  const putObject = jest.fn().mockResolvedValue({ objectKey: "k" })
  const order = {
    id: "o1",
    organizationId: "org1",
    customerId: "c1",
    websiteId: "w1",
    targetUrl: "https://client.com/p",
    anchorText: "anchor",
    website: { url: "https://blog.com", publisherId: "pub1" },
  }
  function prismaFor(status: string, hasFlag = false) {
    return {
      orderDeliveryVersion: {
        findUnique: jest.fn().mockResolvedValue({
          id: "v1",
          orderId: "o1",
          publishedUrl: "https://blog.com/post",
          verificationStatus: status,
          verificationVersion: 1,
          supersededByVersion: null,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      order: { findUnique: jest.fn().mockResolvedValue(order) },
      deliveryFraudFlag: {
        findFirst: jest.fn().mockResolvedValue(hasFlag ? { id: "f1" } : null),
        create: jest.fn().mockResolvedValue({}),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      notification: { create: jest.fn().mockResolvedValue({}) },
      publisherMembership: { findMany: jest.fn().mockResolvedValue([]) },
      staffMembership: {
        findMany: jest.fn().mockResolvedValue([{ userId: "s1" }]),
      },
    }
  }
  const fetcher = (html: string) =>
    jest.fn().mockResolvedValue({
      finalUrl: "https://blog.com/post",
      status: 200,
      headers: {},
      html,
      redirectChain: [],
    } as FetchResult)
  const withLink = `<a href="https://client.com/p">anchor</a>`
  const withoutLink = `<p>no link</p>`

  it("LINK_REMOVED -> onTrustEvent fired", async () => {
    const onTrustEvent = jest.fn()
    const r = await runDeliveryLinkRecheck(
      {
        prisma: prismaFor("VERIFIED") as any,
        fetchUrl: fetcher(withoutLink),
        putObject,
        onTrustEvent,
      },
      "v1",
    )
    expect(r.removed).toBe(true)
    expect(onTrustEvent).toHaveBeenCalledWith(
      "pub1",
      "LINK_REMOVED",
      expect.any(String),
    )
  })

  it("LINK_RESTORED -> onTrustEvent fired when a flagged link is back", async () => {
    const onTrustEvent = jest.fn()
    const r = await runDeliveryLinkRecheck(
      {
        prisma: prismaFor("FAILED", true) as any,
        fetchUrl: fetcher(withLink),
        putObject,
        onTrustEvent,
      },
      "v1",
    )
    expect(r.restored).toBe(true)
    expect(onTrustEvent).toHaveBeenCalledWith(
      "pub1",
      "LINK_RESTORED",
      expect.any(String),
    )
  })
})
