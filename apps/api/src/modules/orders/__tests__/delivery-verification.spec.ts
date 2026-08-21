/**
 * Delivery verification — unit coverage for URL normalization, settlement
 * gating, separation of duties, and the delivery verification state machine
 * (success / target-mismatch / anchor-mismatch / transient-retry /
 * manual-review / idempotent / fraud detection).
 */
import {
  buildSettlementEligibilitySnapshot,
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
  runDeliveryVerification as runDeliveryVerificationCore,
  runSettlementHoldLinkSweep,
} from "@guestpost/shared/dist/delivery-verification-core"

function runDeliveryVerification(
  deps: any,
  deliveryVersionId: string,
  opts: {
    expectedVerificationVersion?: number
    actorUserId?: string
    isFinalAttempt?: boolean
  } = {},
) {
  return runDeliveryVerificationCore(deps, deliveryVersionId, {
    ...opts,
    expectedVerificationVersion: opts.expectedVerificationVersion ?? 0,
  })
}

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
      orderVersion?: number
      orderCurrency?: string
      orderPaymentStatus?: string
      activeDeliveryVersionId?: string | null
      activeDeliveryMatchesOrder?: boolean
      activeDeliveryIsCurrent?: boolean
      activeDeliveryVerificationStatus?: string | null
      activeDeliveryInterventionStatus?: string | null
      hasActiveDispute?: boolean
      hasActiveRevision?: boolean
      hasActiveCancellationRequest?: boolean
      fraudFlagCount?: number
    } = {},
  ): SettlementEligibilitySnapshot {
    return {
      orderStatus: "DELIVERED",
      orderVersion: 1,
      orderCurrency: "USD",
      orderPaymentStatus: "PAID",
      activeDeliveryVersionId: "v1",
      activeDeliveryMatchesOrder: true,
      activeDeliveryIsCurrent: true,
      activeDeliveryVerificationStatus: "VERIFIED",
      activeDeliveryInterventionStatus: "NONE",
      hasActiveDispute: false,
      hasActiveRevision: false,
      hasActiveCancellationRequest: false,
      fraudFlagCount: 0,
      ...over,
    }
  }

  it("eligible: delivered + verified active + no dispute/revision/fraud", () => {
    const r = evaluateSettlementEligibility(snapshotFor())
    expect(r).toEqual({ eligible: true, reasons: [], blockers: [] })
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
  it("preserves an explicit super-admin override", () => {
    const r = evaluateSettlementEligibility(
      snapshotFor({
        activeDeliveryVerificationStatus: "FAILED",
        activeDeliveryInterventionStatus: "OVERRIDDEN",
      }),
    )
    expect(r.eligible).toBe(true)
  })
  it("blocks non-USD and unpaid orders", () => {
    const r = evaluateSettlementEligibility(
      snapshotFor({ orderCurrency: "EUR", orderPaymentStatus: "REFUNDED" }),
    )
    expect(r.eligible).toBe(false)
    expect(r.reasons).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/currency.*USD/i),
        expect.stringMatching(/payment status.*PAID/i),
      ]),
    )
  })
  it("blocks an explicitly rejected delivery even when verification is VERIFIED", () => {
    const r = evaluateSettlementEligibility(
      snapshotFor({ activeDeliveryInterventionStatus: "REJECTED" }),
    )
    expect(r.eligible).toBe(false)
    expect(r.reasons.join()).toMatch(/explicitly rejected/i)
  })
  it("blocks an active-delivery pointer that crosses order ownership", () => {
    const r = evaluateSettlementEligibility(
      snapshotFor({ activeDeliveryMatchesOrder: false }),
    )
    expect(r.eligible).toBe(false)
    expect(r.reasons.join()).toMatch(/does not belong/i)
  })
  it("blocks a delivery that has been superseded despite a stale active pointer", () => {
    const r = evaluateSettlementEligibility(
      snapshotFor({ activeDeliveryIsCurrent: false }),
    )
    expect(r.eligible).toBe(false)
    expect(r.reasons.join()).toMatch(/superseded/i)
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
    expect(
      evaluateSettlementEligibility(
        snapshotFor({ hasActiveCancellationRequest: true }),
      ).eligible,
    ).toBe(false)
  })
})

describe("buildSettlementEligibilitySnapshot", () => {
  function dbWithCancellation(cancellation: unknown) {
    return {
      order: {
        findUnique: jest.fn().mockResolvedValue({
          id: "o1",
          status: "DELIVERED",
          version: 4,
          currency: "USD",
          paymentStatus: "PAID",
          activeDeliveryVersionId: "v1",
        }),
      },
      orderDeliveryVersion: {
        findUnique: jest.fn().mockResolvedValue({
          orderId: "o1",
          verificationStatus: "VERIFIED",
          interventionStatus: "NONE",
        }),
      },
      orderDispute: { findFirst: jest.fn().mockResolvedValue(null) },
      revision: { findFirst: jest.fn().mockResolvedValue(null) },
      orderCancellationRequest: {
        findFirst: jest.fn().mockResolvedValue(cancellation),
      },
      deliveryFraudHold: { count: jest.fn().mockResolvedValue(0) },
    }
  }

  it("uses a safe terminal allowlist so disputed and refund-approved cancellations block", async () => {
    const db = dbWithCancellation({ id: "c1" })
    const snapshot = await buildSettlementEligibilitySnapshot(db, "o1")

    expect(snapshot.hasActiveCancellationRequest).toBe(true)
    expect(db.orderDispute.findFirst).toHaveBeenCalledWith({
      where: {
        orderId: "o1",
        status: { notIn: ["RESOLVED_REJECTED", "RESOLVED_RESTORED"] },
      },
    })
    expect(db.orderCancellationRequest.findFirst).toHaveBeenCalledWith({
      where: {
        orderId: "o1",
        OR: [
          { status: { notIn: ["REJECTED", "WITHDRAWN", "APPROVED"] } },
          { status: "APPROVED", resolution: null },
          { status: "APPROVED", resolution: { not: "CONTINUE_ORDER" } },
        ],
      },
    })
  })

  it("does not block when every cancellation is in an explicitly safe terminal outcome", async () => {
    const db = dbWithCancellation(null)
    const snapshot = await buildSettlementEligibilitySnapshot(db, "o1")

    expect(snapshot.hasActiveCancellationRequest).toBe(false)
    expect(evaluateSettlementEligibility(snapshot).eligible).toBe(true)
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
    version: 0,
    activeDeliveryVersionId: "v1",
    websiteId: "w1",
    targetUrl: "https://client.com/product",
    anchorText: "best product",
    website: { url: "https://blog.com", publisherId: "pub1" },
  }

  beforeEach(() => {
    putObject = jest
      .fn()
      .mockImplementation(async (key: string) => ({ objectKey: key }))
    prisma = {
      orderDeliveryVersion: {
        findUnique: jest.fn().mockResolvedValue({ ...version }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest
          .fn()
          .mockImplementation(({ where }: any) =>
            Promise.resolve(where?.normalizedUrl ? 0 : 1),
          ),
      },
      order: {
        findUnique: jest.fn().mockResolvedValue({ ...order }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      deliverySnapshot: { create: jest.fn().mockResolvedValue({}) },
      deliveryVerificationEvidence: { create: jest.fn().mockResolvedValue({}) },
      deliveryFraudFlag: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({
            id: `flag-${data.type.toLowerCase()}`,
            ...data,
          }),
        ),
      },
      deliveryFraudFlagResolution: {
        create: jest.fn().mockResolvedValue({ id: "resolution-1" }),
      },
      deliveryFraudHold: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      orderEvent: { create: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      notification: {
        create: jest.fn().mockResolvedValue({}),
        upsert: jest.fn().mockResolvedValue({}),
      },
      communicationEvent: {
        upsert: jest.fn().mockImplementation(({ create }: any) =>
          Promise.resolve({
            id: "communication-1",
            ...create,
            payload: create.payload ?? null,
          }),
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      communicationDelivery: {
        count: jest.fn().mockResolvedValue(1),
        upsert: jest
          .fn()
          .mockResolvedValue({ id: "delivery-email-1", status: "PENDING" }),
      },
      user: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "staff1",
            email: "staff@example.com",
            emailVerified: true,
            banned: false,
            notificationPreferences: [],
            emailSuppressions: [],
          },
        ]),
      },
      publisherMembership: {
        findMany: jest.fn().mockResolvedValue([{ userId: "pub-user" }]),
      },
      membership: {
        findMany: jest.fn().mockResolvedValue([{ userId: "cust-owner" }]),
      },
      staffMembership: {
        findMany: jest.fn().mockResolvedValue([{ userId: "staff1" }]),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ id: "o1" }]),
      $transaction: jest
        .fn()
        .mockImplementation(async (callback: any) => callback(prisma)),
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
    expect(res.communicationEventIds).toEqual(["communication-1"])
    expect(prisma.communicationEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          type: "ORDER_VERIFIED",
          aggregateId: "v1",
        }),
      }),
    )
    expect(putObject).toHaveBeenCalledWith(
      expect.stringMatching(
        /^deliveries\/v1\/verification-0-[a-f0-9]{64}\.html$/,
      ),
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

  it("does not let attacker-controlled canonical metadata rewrite relative link navigation", async () => {
    const html = `<link rel="canonical" href="https://client.com"><a href="/product">best product</a>`

    const res = await runDeliveryVerification(
      { prisma, fetchUrl: fetcher(html), putObject },
      "v1",
    )

    expect(res.status).toBe("FAILED")
    expect(prisma.deliveryVerificationEvidence.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ targetUrlMatched: false }),
      }),
    )
  })

  it("resolves legitimate relative links against the final fetched page URL", async () => {
    const relativeTargetOrder = {
      ...order,
      targetUrl: "https://blog.com/product",
    }
    prisma.order.findUnique.mockResolvedValue(relativeTargetOrder)

    const res = await runDeliveryVerification(
      {
        prisma,
        fetchUrl: fetcher(`<a href="/product">best product</a>`),
        putObject,
      },
      "v1",
    )

    expect(res.status).toBe("VERIFIED")
  })

  it("flags URL_REUSED when normalized URL exists on another order", async () => {
    prisma.orderDeliveryVersion.findMany.mockResolvedValue([
      { id: "vX", orderId: "OTHER" },
    ])
    prisma.orderDeliveryVersion.count.mockImplementation(({ where }: any) =>
      Promise.resolve(where?.normalizedUrl ? 1 : 1),
    )
    const result = await runDeliveryVerification(
      { prisma, fetchUrl: fetcher(goodHtml), putObject },
      "v1",
    )
    expect(result.status).toBe("MANUAL_REVIEW")
    expect(prisma.deliveryFraudFlag.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "URL_REUSED" }),
      }),
    )
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
    expect(prisma.communicationEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          type: "STAFF_FRAUD_ALERT",
          aggregateId: "o1",
        }),
      }),
    )
  })

  it("honors a classified disposition when the exact fraud evidence recurs", async () => {
    prisma.orderDeliveryVersion.findMany.mockResolvedValue([
      { id: "vX", orderId: "OTHER" },
    ])
    prisma.orderDeliveryVersion.count.mockImplementation(({ where }: any) =>
      Promise.resolve(where?.normalizedUrl ? 1 : 1),
    )
    prisma.deliveryFraudFlag.findMany.mockResolvedValue([
      {
        id: "flag-resolved",
        type: "URL_REUSED",
        details: {
          otherOrderId: "OTHER",
          otherVersionId: "vX",
          reuseCount: 1,
        },
        resolution: {
          id: "resolution-resolved",
          kind: "STAFF_CLEARED",
          resolvedByUserId: "finance-1",
          resolvedByRole: "FINANCE",
          evidence: {
            adjudicatedDeliveryVersionId: "v1",
            fraudType: "URL_REUSED",
            disposition: "AUTHORIZED_REUSE",
            evidenceReference: "CASE-1024",
            roleAtTime: "FINANCE",
          },
        },
      },
    ])

    const result = await runDeliveryVerification(
      { prisma, fetchUrl: fetcher(goodHtml), putObject },
      "v1",
    )

    expect(result.status).toBe("VERIFIED")
    expect(prisma.deliveryFraudFlag.create).not.toHaveBeenCalled()
    expect(prisma.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "VERIFIED" }),
      }),
    )
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ORDER_DELIVERY_FRAUD_DISPOSITION_REUSED",
          metadata: expect.objectContaining({
            fraudFlagId: "flag-resolved",
            resolutionId: "resolution-resolved",
            disposition: "AUTHORIZED_REUSE",
          }),
        }),
      }),
    )
  })

  it("creates a new hold when reused-URL evidence changes after adjudication", async () => {
    prisma.orderDeliveryVersion.findMany.mockResolvedValue([
      { id: "vX", orderId: "OTHER" },
      { id: "vY", orderId: "ANOTHER" },
    ])
    prisma.orderDeliveryVersion.count.mockImplementation(({ where }: any) =>
      Promise.resolve(where?.normalizedUrl ? 2 : 0),
    )
    prisma.deliveryFraudFlag.findMany.mockResolvedValue([
      {
        id: "flag-resolved",
        type: "URL_REUSED",
        details: {
          otherOrderId: "OTHER",
          otherVersionId: "vX",
          reuseCount: 1,
        },
        resolution: {
          id: "resolution-resolved",
          kind: "STAFF_CLEARED",
          resolvedByUserId: "finance-1",
          resolvedByRole: "FINANCE",
          evidence: {
            adjudicatedDeliveryVersionId: "v1",
            fraudType: "URL_REUSED",
            disposition: "AUTHORIZED_REUSE",
            evidenceReference: "CASE-1024",
            roleAtTime: "FINANCE",
          },
        },
      },
    ])

    const result = await runDeliveryVerification(
      { prisma, fetchUrl: fetcher(goodHtml), putObject },
      "v1",
    )

    expect(result.status).toBe("MANUAL_REVIEW")
    expect(prisma.deliveryFraudFlag.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "URL_REUSED",
          details: expect.objectContaining({ reuseCount: 2 }),
        }),
      }),
    )
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
  })

  it("does not trust legacy unclassified fraud resolutions on retry", async () => {
    prisma.orderDeliveryVersion.findMany.mockResolvedValue([
      { id: "vX", orderId: "OTHER" },
    ])
    prisma.orderDeliveryVersion.count.mockImplementation(({ where }: any) =>
      Promise.resolve(where?.normalizedUrl ? 1 : 1),
    )
    prisma.deliveryFraudFlag.findMany.mockResolvedValue([
      {
        id: "flag-legacy",
        type: "URL_REUSED",
        details: {
          otherOrderId: "OTHER",
          otherVersionId: "vX",
          reuseCount: 1,
        },
        resolution: {
          id: "resolution-legacy",
          kind: "STAFF_CLEARED",
          resolvedByUserId: "operations-1",
          resolvedByRole: "OPERATIONS",
          evidence: {
            adjudicatedDeliveryVersionId: "v1",
            fraudType: "URL_REUSED",
            roleAtTime: "OPERATIONS",
          },
        },
      },
    ])

    const result = await runDeliveryVerification(
      { prisma, fetchUrl: fetcher(goodHtml), putObject },
      "v1",
    )

    expect(result.status).toBe("MANUAL_REVIEW")
    expect(prisma.deliveryFraudFlag.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "URL_REUSED" }),
      }),
    )
  })

  it("cannot auto-verify while an earlier unresolved order-level hold remains", async () => {
    prisma.deliveryFraudHold.findFirst.mockResolvedValue({
      fraudFlagId: "flag-existing",
    })

    const result = await runDeliveryVerification(
      { prisma, fetchUrl: fetcher(goodHtml), putObject },
      "v1",
    )

    expect(result).toEqual({
      status: "MANUAL_REVIEW",
      reason: "Delivery requires staff fraud review",
    })
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
    expect(prisma.orderDeliveryVersion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          verificationStatus: "MANUAL_REVIEW",
        }),
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

  it("treats an oversized/read-failed HTTP 200 body as transient without fraud evidence", async () => {
    const bodyFailure = jest.fn().mockResolvedValue({
      finalUrl: "https://blog.com/post",
      status: 200,
      headers: { "content-type": "text/html" },
      html: "",
      redirectChain: [],
      error: "BODY_TOO_LARGE: response exceeds 5 MB",
    } as FetchResult)

    await expect(
      runDeliveryVerification(
        { prisma, fetchUrl: bodyFailure, putObject },
        "v1",
      ),
    ).rejects.toThrow(/retrying/)

    expect(prisma.deliveryFraudFlag.create).not.toHaveBeenCalled()
    expect(prisma.deliveryVerificationEvidence.create).not.toHaveBeenCalled()
    expect(prisma.deliverySnapshot.create).not.toHaveBeenCalled()
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

  it("never adopts a newer verification generation from a stale signed job", async () => {
    prisma.orderDeliveryVersion.findUnique.mockResolvedValue({
      ...version,
      verificationVersion: 1,
    })
    const fetch = fetcher(goodHtml)

    await expect(
      runDeliveryVerification({ prisma, fetchUrl: fetch, putObject }, "v1", {
        expectedVerificationVersion: 0,
      }),
    ).resolves.toEqual({ skipped: "stale_generation" })

    expect(fetch).not.toHaveBeenCalled()
    expect(prisma.deliveryVerificationEvidence.create).not.toHaveBeenCalled()
    expect(prisma.orderDeliveryVersion.updateMany).not.toHaveBeenCalled()
  })

  it("does not persist fraud or mutate an order when the delivery is superseded during fetch", async () => {
    prisma.order.findUnique
      .mockResolvedValueOnce({ ...order })
      .mockResolvedValueOnce({
        ...order,
        activeDeliveryVersionId: "v2",
      })
    const html = `<a href="https://client.com/wrong">wrong anchor</a>`

    const res = await runDeliveryVerification(
      { prisma, fetchUrl: fetcher(html), putObject },
      "v1",
    )

    expect(res).toEqual({ skipped: "stale" })
    expect(prisma.deliverySnapshot.create).not.toHaveBeenCalled()
    expect(prisma.deliveryVerificationEvidence.create).not.toHaveBeenCalled()
    expect(prisma.deliveryFraudFlag.create).not.toHaveBeenCalled()
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
  })

  it("retries snapshot-storage failure without persisting verification evidence", async () => {
    putObject.mockRejectedValue(new Error("object store unavailable"))

    await expect(
      runDeliveryVerification(
        { prisma, fetchUrl: fetcher(goodHtml), putObject },
        "v1",
      ),
    ).rejects.toThrow(/snapshot storage failed.*retrying/i)

    expect(prisma.deliverySnapshot.create).not.toHaveBeenCalled()
    expect(prisma.deliveryVerificationEvidence.create).not.toHaveBeenCalled()
    expect(prisma.orderDeliveryVersion.updateMany).not.toHaveBeenCalled()
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
  })

  it("fails closed to manual review after snapshot-storage retries are exhausted", async () => {
    putObject.mockRejectedValue(new Error("object store unavailable"))

    await expect(
      runDeliveryVerification(
        { prisma, fetchUrl: fetcher(goodHtml), putObject },
        "v1",
        { isFinalAttempt: true },
      ),
    ).resolves.toMatchObject({ status: "MANUAL_REVIEW" })

    expect(prisma.orderDeliveryVersion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          verificationStatus: "MANUAL_REVIEW",
        }),
      }),
    )
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
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
    status: "VERIFIED",
    version: 1,
    activeDeliveryVersionId: "v1",
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
      deliveryFraudFlagResolution: {
        create: jest.fn().mockResolvedValue({ id: "resolution-1" }),
      },
      deliveryVerificationEvidence: {
        create: jest.fn().mockResolvedValue({ id: "evidence-1" }),
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
      $queryRaw: jest.fn().mockResolvedValue([{ id: "o1" }]),
      $transaction: jest
        .fn()
        .mockImplementation(async (callback: any) => callback(prisma)),
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
    expect(prisma.deliveryVerificationEvidence.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        linkFound: true,
        targetUrlMatched: true,
        anchorFound: true,
      }),
    })
  })

  it("monitors a manually approved delivery and revokes that approval when the link disappears", async () => {
    prisma.orderDeliveryVersion.findUnique.mockResolvedValue({
      ...version,
      verificationStatus: "FAILED",
      interventionStatus: "APPROVED",
    })

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
        data: expect.objectContaining({
          verificationStatus: "FAILED",
          interventionStatus: "REJECTED",
        }),
      }),
    )
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

  it("restores a removed link and appends resolution evidence for the hold", async () => {
    prisma.orderDeliveryVersion.findUnique.mockResolvedValue({
      ...version,
      verificationStatus: "FAILED",
    })
    prisma.deliveryFraudFlag.findFirst.mockResolvedValue({ id: "flag-1" })

    const r = await runDeliveryLinkRecheck(
      { prisma, fetchUrl: fetcher(goodHtml), putObject },
      "v1",
    )

    expect(r).toEqual({ restored: true })
    expect(prisma.deliveryFraudFlagResolution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fraudFlagId: "flag-1",
        orderId: "o1",
        deliveryVersionId: "v1",
        kind: "LINK_RESTORED",
        resolvedByUserId: null,
        resolvedByRole: null,
        evidenceId: "evidence-1",
      }),
    })
    expect(prisma.deliveryVerificationEvidence.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        deliveryVersionId: "v1",
        linkFound: true,
        targetUrlMatched: true,
        anchorFound: true,
      }),
    })
  })

  it("does not fail or flag a delivery superseded during a link recheck", async () => {
    prisma.order.findUnique
      .mockResolvedValueOnce({ ...order })
      .mockResolvedValueOnce({ ...order, activeDeliveryVersionId: "v2" })

    const r = await runDeliveryLinkRecheck(
      {
        prisma,
        fetchUrl: fetcher(`<p>article without the link</p>`),
        putObject,
      },
      "v1",
    )

    expect(r).toEqual({ skipped: "version_conflict" })
    expect(prisma.deliveryFraudFlag.create).not.toHaveBeenCalled()
    expect(prisma.orderDeliveryVersion.updateMany).not.toHaveBeenCalled()
  })
})

describe("runSettlementHoldLinkSweep", () => {
  it("scans every unreleased approval status with deterministic pagination", async () => {
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([
        {
          id: "settlement-1",
          createdAt: new Date("2026-08-01T00:00:00Z"),
          order: { activeDeliveryVersionId: null },
        },
        {
          id: "settlement-2",
          createdAt: new Date("2026-08-01T01:00:00Z"),
          order: { activeDeliveryVersionId: null },
        },
      ])
      .mockResolvedValueOnce([])
    const prisma = { settlement: { findMany } }

    await expect(
      runSettlementHoldLinkSweep({
        prisma,
        fetchUrl: jest.fn(),
        putObject: jest.fn(),
      }),
    ).resolves.toMatchObject({
      ok: true,
      scanned: 2,
      checked: 0,
      failed: 0,
    })

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: {
            in: [
              "PENDING",
              "UNDER_REVIEW",
              "CUSTOMER_APPROVED",
              "ADMIN_APPROVED",
            ],
          },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    )
  })
})
