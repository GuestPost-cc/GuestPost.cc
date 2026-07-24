/**
 * Delivery verification — unit coverage for URL normalization, settlement
 * gating, separation of duties, and the delivery verification state machine
 * (success / target-mismatch / anchor-mismatch / transient-retry /
 * manual-review / idempotent / fraud detection).
 */
import {
  checkSeparationOfDuties,
  evaluateSettlementEligibility,
  normalizeUrl,
  type SettlementEligibilitySnapshot,
  sameDomain,
  urlsMatch,
} from "@guestpost/shared"
import {
  type FetchResult,
  runDeliveryLinkRecheck,
  runDeliveryVerification,
} from "@guestpost/shared/dist/delivery-verification-core"

// ── URL normalization ──────────────────────────────────────────────────────
describe("normalizeUrl / urlsMatch", () => {
  it("lowercases protocol + host, drops default port, trailing slash, fragment", () => {
    expect(normalizeUrl("HTTPS://Example.COM:443/Path/#frag")).toBe(
      "https://example.com/Path",
    )
    expect(normalizeUrl("http://example.com:80/")).toBe("http://example.com")
  })
  it("sorts query params for stable comparison", () => {
    expect(normalizeUrl("https://x.com/p?b=2&a=1")).toBe(
      normalizeUrl("https://x.com/p?a=1&b=2"),
    )
  })
  it("matches exact normalized URLs only", () => {
    expect(
      urlsMatch("https://client.com/product", "https://client.com/product/"),
    ).toBe(true)
    expect(urlsMatch("https://client.com/product", "https://client.com")).toBe(
      false,
    )
  })
  it("sameDomain ignores www", () => {
    expect(sameDomain("https://www.x.com/a", "https://x.com/b")).toBe(true)
    expect(sameDomain("https://x.com", "https://y.com")).toBe(false)
  })
})

// ── Settlement gating ──────────────────────────────────────────────────────
describe("evaluateSettlementEligibility", () => {
  function snapshotFor(
    over: {
      orderStatus?: string
      activeDeliveryVersionId?: string | null
      activeDeliveryVerificationStatus?: string | null
      activeDeliveryInterventionStatus?: string | null
      hasActiveDispute?: boolean
      hasActiveRevision?: boolean
      fraudFlagCount?: number
    } = {},
  ): SettlementEligibilitySnapshot {
    return {
      orderStatus: "DELIVERED",
      activeDeliveryVersionId: "v1",
      activeDeliveryVerificationStatus: "VERIFIED",
      activeDeliveryInterventionStatus: "NONE",
      hasActiveDispute: false,
      hasActiveRevision: false,
      fraudFlagCount: 0,
      ...over,
    }
  }

  it("eligible: delivered + verified active + no dispute/revision/fraud", () => {
    const r = evaluateSettlementEligibility(snapshotFor())
    expect(r).toEqual({ eligible: true, reasons: [] })
  })
  it("blocks when order not DELIVERED", () => {
    const r = evaluateSettlementEligibility(
      snapshotFor({ orderStatus: "PUBLISHED" }),
    )
    expect(r.eligible).toBe(false)
    expect(r.reasons.join()).toMatch(/DELIVERED/)
  })
  it("blocks when active delivery not verified nor manually approved", () => {
    const r = evaluateSettlementEligibility(
      snapshotFor({
        activeDeliveryVerificationStatus: "FAILED",
        activeDeliveryInterventionStatus: "NONE",
      }),
    )
    expect(r.eligible).toBe(false)
  })
  it("allows manual-approved delivery even if auto FAILED", () => {
    const r = evaluateSettlementEligibility(
      snapshotFor({
        activeDeliveryVerificationStatus: "FAILED",
        activeDeliveryInterventionStatus: "APPROVED",
      }),
    )
    expect(r.eligible).toBe(true)
  })
  it("blocks on open dispute, active revision, fraud flags", () => {
    expect(
      evaluateSettlementEligibility(snapshotFor({ hasActiveDispute: true }))
        .eligible,
    ).toBe(false)
    expect(
      evaluateSettlementEligibility(snapshotFor({ hasActiveRevision: true }))
        .eligible,
    ).toBe(false)
    expect(
      evaluateSettlementEligibility(snapshotFor({ fraudFlagCount: 2 }))
        .eligible,
    ).toBe(false)
  })
})

describe("checkSeparationOfDuties", () => {
  it("blocks platform fulfiller from releasing own settlement", () => {
    expect(
      checkSeparationOfDuties({
        ownershipType: "PLATFORM",
        fulfilledByUserId: "u1",
        releasedByUserId: "u1",
      }),
    ).toMatch(/Separation of duties/)
  })
  it("allows different users on platform inventory", () => {
    expect(
      checkSeparationOfDuties({
        ownershipType: "PLATFORM",
        fulfilledByUserId: "u1",
        releasedByUserId: "u2",
      }),
    ).toBeNull()
  })
  it("does not apply to publisher inventory", () => {
    expect(
      checkSeparationOfDuties({
        ownershipType: "PUBLISHER",
        fulfilledByUserId: "u1",
        releasedByUserId: "u1",
      }),
    ).toBeNull()
  })
})

// ── Delivery verification state machine ────────────────────────────────────
describe("runDeliveryVerification", () => {
  let prisma: any
  let putObject: jest.Mock

  const version = {
    id: "v1",
    orderId: "o1",
    publishedUrl: "https://blog.com/post",
    normalizedUrl: "https://blog.com/post",
    submittedByUserId: "pub-user",
    verificationStatus: "PENDING",
    verificationVersion: 0,
    supersededByVersion: null,
  }
  const order = {
    id: "o1",
    organizationId: "org1",
    customerId: "cust1",
    status: "PUBLISHED",
    websiteId: "w1",
    targetUrl: "https://client.com/product",
    anchorText: "best product",
    website: { url: "https://blog.com", publisherId: "pub1" },
  }

  beforeEach(() => {
    putObject = jest.fn().mockResolvedValue({ objectKey: "k" })
    prisma = {
      orderDeliveryVersion: {
        findUnique: jest.fn().mockResolvedValue({ ...version }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(1),
      },
      order: {
        findUnique: jest.fn().mockResolvedValue({ ...order }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      deliverySnapshot: { create: jest.fn().mockResolvedValue({}) },
      deliveryVerificationEvidence: { create: jest.fn().mockResolvedValue({}) },
      deliveryFraudFlag: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
      orderEvent: { create: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      notification: { create: jest.fn().mockResolvedValue({}) },
      publisherMembership: {
        findMany: jest.fn().mockResolvedValue([{ userId: "pub-user" }]),
      },
      staffMembership: {
        findMany: jest.fn().mockResolvedValue([{ userId: "staff1" }]),
      },
    }
  })

  function fetcher(html: string, status = 200): jest.Mock {
    return jest.fn().mockResolvedValue({
      finalUrl: `${order.website.url}/post`,
      status,
      headers: { "content-type": "text/html" },
      html,
      redirectChain: [],
    } as FetchResult)
  }

  const goodHtml = `<html><head><title>Great Post</title><link rel="canonical" href="https://blog.com/post"></head>
    <body><a href="https://client.com/product">best product</a></body></html>`

  it("VERIFIES when link + target + anchor all match, stores evidence + snapshot", async () => {
    const res = await runDeliveryVerification(
      { prisma, fetchUrl: fetcher(goodHtml), putObject },
      "v1",
    )
    expect(res.status).toBe("VERIFIED")
    expect(putObject).toHaveBeenCalledWith(
      expect.stringContaining("deliveries/v1/"),
      expect.any(String),
      expect.stringContaining("text/html"),
    )
    expect(prisma.deliveryVerificationEvidence.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          targetUrlMatched: true,
          anchorFound: true,
          linkFound: true,
        }),
      }),
    )
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ORDER_DELIVERY_AUTO_VERIFIED",
        }),
      }),
    )
  })

  it("throws a version conflict so the queue retries instead of silently completing", async () => {
    prisma.order.updateMany.mockResolvedValue({ count: 0 })

    await expect(
      runDeliveryVerification(
        { prisma, fetchUrl: fetcher(goodHtml), putObject },
        "v1",
      ),
    ).rejects.toMatchObject({
      name: "DeliveryVerificationVersionConflict",
      message: "order verification version conflict",
    })
  })

  it("FAILS on target URL mismatch and flags TARGET_MISMATCH", async () => {
    const html = `<a href="https://client.com/wrong">best product</a>`
    const res = await runDeliveryVerification(
      { prisma, fetchUrl: fetcher(html), putObject },
      "v1",
    )
    expect(res.status).toBe("FAILED")
    expect(prisma.deliveryFraudFlag.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "TARGET_MISMATCH" }),
      }),
    )
  })

  it("FAILS on anchor mismatch", async () => {
    const html = `<a href="https://client.com/product">wrong anchor</a>`
    const res = await runDeliveryVerification(
      { prisma, fetchUrl: fetcher(html), putObject },
      "v1",
    )
    expect(res.status).toBe("FAILED")
  })

  it("flags URL_REUSED when normalized URL exists on another order", async () => {
    prisma.orderDeliveryVersion.findFirst.mockResolvedValue({
      id: "vX",
      orderId: "OTHER",
    })
    await runDeliveryVerification(
      { prisma, fetchUrl: fetcher(goodHtml), putObject },
      "v1",
    )
    expect(prisma.deliveryFraudFlag.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "URL_REUSED" }),
      }),
    )
  })

  it("throws to retry on transient HTTP 503 when not final attempt", async () => {
    await expect(
      runDeliveryVerification(
        { prisma, fetchUrl: fetcher("", 503), putObject },
        "v1",
        { isFinalAttempt: false },
      ),
    ).rejects.toThrow(/retrying/)
  })

  it("routes to MANUAL_REVIEW on final failed attempt", async () => {
    const res = await runDeliveryVerification(
      { prisma, fetchUrl: fetcher("", 503), putObject },
      "v1",
      { isFinalAttempt: true },
    )
    expect(res.status).toBe("MANUAL_REVIEW")
    expect(prisma.orderDeliveryVersion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ verificationStatus: "MANUAL_REVIEW" }),
      }),
    )
  })

  it("is idempotent — already VERIFIED is skipped (no fetch)", async () => {
    prisma.orderDeliveryVersion.findUnique.mockResolvedValue({
      ...version,
      verificationStatus: "VERIFIED",
    })
    const f = fetcher(goodHtml)
    const res = await runDeliveryVerification(
      { prisma, fetchUrl: f, putObject },
      "v1",
    )
    expect(res).toEqual({ skipped: "already_verified" })
    expect(f).not.toHaveBeenCalled()
  })

  it("skips superseded versions", async () => {
    prisma.orderDeliveryVersion.findUnique.mockResolvedValue({
      ...version,
      supersededByVersion: 2,
    })
    const res = await runDeliveryVerification(
      { prisma, fetchUrl: fetcher(goodHtml), putObject },
      "v1",
    )
    expect(res).toEqual({ skipped: "superseded" })
  })
})

// ── Settlement-hold link monitoring ────────────────────────────────────────
describe("runDeliveryLinkRecheck", () => {
  let prisma: any
  const putObject = jest.fn().mockResolvedValue({ objectKey: "k" })
  const version = {
    id: "v1",
    orderId: "o1",
    publishedUrl: "https://blog.com/post",
    normalizedUrl: "https://blog.com/post",
    verificationStatus: "VERIFIED",
    verificationVersion: 1,
    supersededByVersion: null,
  }
  const order = {
    id: "o1",
    organizationId: "org1",
    customerId: "cust1",
    websiteId: "w1",
    targetUrl: "https://client.com/product",
    anchorText: "best product",
    website: { url: "https://blog.com", publisherId: "pub1" },
  }
  const goodHtml = `<a href="https://client.com/product">best product</a>`

  beforeEach(() => {
    prisma = {
      orderDeliveryVersion: {
        findUnique: jest.fn().mockResolvedValue({ ...version }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      order: { findUnique: jest.fn().mockResolvedValue({ ...order }) },
      deliveryFraudFlag: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
      orderEvent: { create: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      notification: { create: jest.fn().mockResolvedValue({}) },
      publisherMembership: {
        findMany: jest.fn().mockResolvedValue([{ userId: "pub-user" }]),
      },
      staffMembership: {
        findMany: jest.fn().mockResolvedValue([{ userId: "s1" }]),
      },
    }
  })
  const fetcher = (html: string, status = 200) =>
    jest.fn().mockResolvedValue({
      finalUrl: "https://blog.com/post",
      status,
      headers: {},
      html,
      redirectChain: [],
    } as FetchResult)

  it("link still present -> ok, no flag", async () => {
    const r = await runDeliveryLinkRecheck(
      { prisma, fetchUrl: fetcher(goodHtml), putObject },
      "v1",
    )
    expect(r).toEqual({ ok: true })
    expect(prisma.deliveryFraudFlag.create).not.toHaveBeenCalled()
  })

  it("link removed -> FAILED + LINK_REMOVED flag + audit + notify", async () => {
    const r = await runDeliveryLinkRecheck(
      {
        prisma,
        fetchUrl: fetcher(`<p>article without the link</p>`),
        putObject,
      },
      "v1",
    )
    expect(r).toEqual({ removed: true })
    expect(prisma.orderDeliveryVersion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ verificationStatus: "FAILED" }),
      }),
    )
    expect(prisma.deliveryFraudFlag.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "LINK_REMOVED" }),
      }),
    )
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ORDER_DELIVERY_LINK_REMOVED",
        }),
      }),
    )
  })

  it("transient outage -> skipped, never penalizes", async () => {
    const r = await runDeliveryLinkRecheck(
      { prisma, fetchUrl: fetcher("", 503), putObject },
      "v1",
    )
    expect(r).toEqual({ skipped: "transient" })
    expect(prisma.deliveryFraudFlag.create).not.toHaveBeenCalled()
  })

  it("non-verified delivery -> skipped", async () => {
    prisma.orderDeliveryVersion.findUnique.mockResolvedValue({
      ...version,
      verificationStatus: "FAILED",
    })
    const r = await runDeliveryLinkRecheck(
      { prisma, fetchUrl: fetcher(goodHtml), putObject },
      "v1",
    )
    expect(r).toEqual({ skipped: "not_verified" })
  })
})
