/**
 * Verification hardening — trust score, token rotation, periodic health-check
 * (consecutive-failure revocation + enforcement), duplicate-domain protection,
 * and verification rate limiting.
 */

import {
  computeTrustScore,
  enforceRevocation,
  runWebsiteReverifySweep,
  runWebsiteVerify,
  trustBand,
} from "@guestpost/shared"
import { WebsitesService } from "../websites.service"

// ── Trust score ────────────────────────────────────────────────────────────
describe("computeTrustScore", () => {
  const base = {
    verificationStatus: "VERIFIED",
    verifiedAt: new Date(Date.now() - 365 * 86_400_000),
    now: new Date(),
    verificationCheckCount: 10,
    consecutiveFailures: 0,
    revocationCount: 0,
    listingCount: 3,
    completedOrderCount: 20,
    totalOrderCount: 22,
    disputeCount: 0,
    refundCount: 0,
    chargebackCount: 0,
  }
  it("scores a clean long-verified site High", () => {
    const r = computeTrustScore(base)
    expect(r.band).toBe("High")
    expect(r.score).toBeGreaterThanOrEqual(70)
  })
  it("scores REVOKED at 0 Low", () => {
    expect(
      computeTrustScore({ ...base, verificationStatus: "REVOKED" }),
    ).toEqual({ score: 0, band: "Low" })
  })
  it("penalizes disputes/refunds/chargebacks", () => {
    const bad = computeTrustScore({
      ...base,
      disputeCount: 8,
      refundCount: 6,
      chargebackCount: 2,
    })
    expect(bad.score).toBeLessThan(computeTrustScore(base).score)
  })
  it("keeps score within 0..100", () => {
    const r = computeTrustScore({
      ...base,
      disputeCount: 100,
      refundCount: 100,
      chargebackCount: 50,
    })
    expect(r.score).toBeGreaterThanOrEqual(0)
    expect(r.score).toBeLessThanOrEqual(100)
  })
  it("trustBand maps thresholds", () => {
    expect(trustBand(85)).toBe("High")
    expect(trustBand(50)).toBe("Medium")
    expect(trustBand(10)).toBe("Low")
    expect(trustBand(null)).toBe("Unknown")
  })
})

// ── Token rotation ─────────────────────────────────────────────────────────
describe("runWebsiteVerify token rotation", () => {
  it("on success: promotes proven token to activeVerifiedToken, rotates token, audits ROTATED", async () => {
    const prisma: any = {
      website: {
        findUnique: jest.fn().mockResolvedValue({
          id: "w1",
          url: "https://x.com",
          domain: "x.com",
          publisherId: "p1",
          verificationToken: "OLD",
          verificationStatus: "PENDING_VERIFICATION",
          verificationVersion: 0,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      publisher: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: "p1", organizationId: "o1" }),
      },
      publisherMembership: { findMany: jest.fn().mockResolvedValue([]) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      notification: { create: jest.fn().mockResolvedValue({}) },
    }
    const checkDns = jest
      .fn()
      .mockResolvedValue({ found: true, matchedHost: "x.com", reason: null })
    const res = await runWebsiteVerify({ prisma, checkDns }, "w1")
    expect(res.status).toBe("VERIFIED")
    const data = prisma.website.updateMany.mock.calls[0][0].data
    expect(data.activeVerifiedToken).toBe("OLD")
    expect(data.verificationToken).not.toBe("OLD")
    expect(data.consecutiveFailures).toBe(0)
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "WEBSITE_VERIFICATION_TOKEN_ROTATED",
        }),
      }),
    )
  })
})

// ── Periodic health check ──────────────────────────────────────────────────
describe("runWebsiteReverifySweep health check", () => {
  function prismaFor(site: any) {
    const updates: any[] = []
    return {
      _updates: updates,
      website: {
        findMany: jest.fn().mockResolvedValue([{ id: site.id }]),
        findUnique: jest.fn().mockResolvedValue(site),
        updateMany: jest.fn().mockImplementation((args: any) => {
          updates.push(args.data)
          return Promise.resolve({ count: 1 })
        }),
      },
      publisher: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: "p1", organizationId: "o1" }),
      },
      publisherMembership: {
        findMany: jest.fn().mockResolvedValue([{ userId: "u1" }]),
      },
      staffMembership: {
        findMany: jest.fn().mockResolvedValue([{ userId: "s1" }]),
      },
      marketplaceListing: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      notification: { create: jest.fn().mockResolvedValue({}) },
    }
  }
  const verified = {
    id: "w1",
    url: "https://x.com",
    domain: "x.com",
    publisherId: "p1",
    verificationStatus: "VERIFIED",
    activeVerifiedToken: "T",
    verificationVersion: 0,
    consecutiveFailures: 0,
  }

  it("refreshes + resets failures when record present", async () => {
    const prisma = prismaFor(verified)
    const res = await runWebsiteReverifySweep({
      prisma,
      checkDns: jest
        .fn()
        .mockResolvedValue({ found: true, matchedHost: "x.com", reason: null }),
    })
    expect(res.refreshed).toBe(1)
    expect(prisma._updates[0].consecutiveFailures).toBe(0)
  })

  it("1st failure warns, does not revoke", async () => {
    const prisma = prismaFor(verified)
    const res = await runWebsiteReverifySweep({
      prisma,
      checkDns: jest
        .fn()
        .mockResolvedValue({ found: false, matchedHost: null, reason: "gone" }),
    })
    expect(res.revoked).toBe(0)
    expect(res.warned).toBe(1)
    expect(prisma._updates[0].consecutiveFailures).toBe(1)
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "WEBSITE_VERIFICATION_HEALTH_WARNING",
        }),
      }),
    )
  })

  it("3rd consecutive failure REVOKES + enforces (hides listings)", async () => {
    const prisma = prismaFor({ ...verified, consecutiveFailures: 2 })
    const res = await runWebsiteReverifySweep({
      prisma,
      checkDns: jest
        .fn()
        .mockResolvedValue({ found: false, matchedHost: null, reason: "gone" }),
    })
    expect(res.revoked).toBe(1)
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "WEBSITE_VERIFICATION_REVOKED",
        }),
      }),
    )
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "WEBSITE_REVOKED_ENFORCEMENT",
        }),
      }),
    )
    expect(prisma.marketplaceListing.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "PAUSED" } }),
    )
  })

  it("transient resolver error never counts as a failure", async () => {
    const prisma = prismaFor(verified)
    const res = await runWebsiteReverifySweep({
      prisma,
      checkDns: jest.fn().mockRejectedValue(new Error("timeout")),
    })
    expect(res.revoked).toBe(0)
    expect(res.warned).toBe(0)
    expect(res.refreshed).toBe(0)
  })
})

// ── Revocation enforcement (direct) ────────────────────────────────────────
describe("enforceRevocation", () => {
  it("pauses active listings + audits + notifies", async () => {
    const prisma: any = {
      marketplaceListing: {
        updateMany: jest.fn().mockResolvedValue({ count: 3 }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      publisherMembership: {
        findMany: jest.fn().mockResolvedValue([{ userId: "u1" }]),
      },
      staffMembership: {
        findMany: jest.fn().mockResolvedValue([{ userId: "s1" }]),
      },
      notification: { create: jest.fn().mockResolvedValue({}) },
    }
    const hidden = await enforceRevocation(
      prisma,
      { id: "w1", domain: "x.com", publisherId: "p1" },
      "o1",
    )
    expect(hidden).toBe(3)
    expect(prisma.marketplaceListing.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "PAUSED" } }),
    )
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "WEBSITE_REVOKED_ENFORCEMENT",
        }),
      }),
    )
  })
})

// ── Duplicate domain + rate limiting (service) ─────────────────────────────
describe("WebsitesService hardening", () => {
  let svc: WebsitesService
  let prisma: any
  let audit: any
  let queue: any

  beforeEach(() => {
    audit = { log: jest.fn().mockResolvedValue(undefined) }
    queue = { addJob: jest.fn().mockResolvedValue({ id: "j" }) }
    prisma = {
      publisher: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: "p1", organizationId: "o1" }),
      },
      website: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      marketplaceListing: { create: jest.fn().mockResolvedValue({}) },
      marketplaceCategory: { findMany: jest.fn() },
      auditLog: { count: jest.fn().mockResolvedValue(0) },
    }
    svc = new WebsitesService(prisma as any, audit as any, queue as any)
  })

  it("blocks a cross-publisher duplicate domain with DOMAIN_ALREADY_REGISTERED + audits attempt", async () => {
    prisma.website.findFirst.mockResolvedValue({
      id: "existing",
      ownershipType: "PUBLISHER",
      publisherId: "OTHER",
    })
    await expect(
      svc.createWebsite("p1", "o1", { url: "https://www.example.com" } as any, {
        id: "u1",
      }),
    ).rejects.toMatchObject({ response: { code: "DOMAIN_ALREADY_REGISTERED" } })
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "WEBSITE_DUPLICATE_DOMAIN_ATTEMPT" }),
    )
    expect(prisma.website.create).not.toHaveBeenCalled()
  })

  it("creates the publisher website, listing metadata, and first service atomically", async () => {
    prisma.website.findFirst.mockResolvedValue(null)
    prisma.marketplaceCategory.findMany.mockResolvedValue([
      { id: "category-1", name: "Technology", slug: "technology" },
    ])
    const websiteCreate = jest.fn().mockResolvedValue({
      id: "website-1",
      url: "https://example.com",
    })
    const listingCreate = jest.fn().mockResolvedValue({ id: "listing-1" })
    prisma.$transaction = jest.fn((callback) =>
      callback({
        website: { create: websiteCreate },
        marketplaceListing: { create: listingCreate },
      }),
    )

    await svc.createWebsite(
      "p1",
      "o1",
      {
        url: "https://example.com",
        categoryIds: ["category-1"],
        language: "English",
        sportsGamingAllowed: false,
        pharmacyAllowed: false,
        cryptoAllowed: false,
        backlinkCount: 1,
        linkType: "DOFOLLOW",
        linkValidity: "PERMANENT",
        googleNews: false,
        markedSponsored: false,
        foreignLanguageAllowed: false,
        listingTitle: "Example technology placements",
        description: "A focused technology publication for software buyers.",
        initialService: {
          serviceType: "GUEST_POST",
          price: 175,
          currency: "USD",
          turnaroundDays: 7,
          revisionRounds: 2,
        },
      } as any,
      { id: "u1" },
    )

    expect(websiteCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ category: "Technology" }),
      }),
    )
    expect(listingCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: "Example technology placements",
          description: "A focused technology publication for software buyers.",
          categories: {
            create: [{ category: { connect: { id: "category-1" } } }],
          },
          ownerType: "PUBLISHER",
          services: {
            create: [
              expect.objectContaining({
                serviceType: "GUEST_POST",
                price: 175,
                availability: "AVAILABLE",
              }),
            ],
          },
        }),
      }),
    )
  })

  it("rate-limits verification within the cooldown window", async () => {
    prisma.website.findFirst.mockResolvedValue({
      id: "w1",
      domain: "x.com",
      publisherId: "p1",
      verificationToken: "T",
      verificationStatus: "PENDING_VERIFICATION",
      lastVerificationRequestAt: new Date(),
    })
    prisma.website.updateMany.mockResolvedValue({ count: 0 })
    await expect(
      svc.requestVerification("p1", "o1", "w1", { id: "u1" }),
    ).rejects.toMatchObject({ response: { code: "VERIFICATION_RATE_LIMITED" } })
    expect(queue.addJob).not.toHaveBeenCalled()
  })

  it("rate-limits when the hourly publisher cap is exceeded", async () => {
    prisma.website.findFirst.mockResolvedValue({
      id: "w1",
      domain: "x.com",
      publisherId: "p1",
      verificationToken: "T",
      verificationStatus: "PENDING_VERIFICATION",
      lastVerificationRequestAt: null,
    })
    prisma.website.updateMany.mockResolvedValue({ count: 1 })
    prisma.auditLog.count.mockResolvedValue(999)
    await expect(
      svc.requestVerification("p1", "o1", "w1", { id: "u1" }),
    ).rejects.toMatchObject({ response: { code: "VERIFICATION_RATE_LIMITED" } })
  })

  it("allows verification when within limits (enqueues + sets request timestamp)", async () => {
    prisma.website.findFirst.mockResolvedValue({
      id: "w1",
      domain: "x.com",
      publisherId: "p1",
      verificationToken: "T",
      verificationStatus: "PENDING_VERIFICATION",
      lastVerificationRequestAt: null,
    })
    prisma.website.updateMany.mockResolvedValue({ count: 1 })
    prisma.auditLog.count.mockResolvedValue(0)
    const r = await svc.requestVerification("p1", "o1", "w1", { id: "u1" })
    expect(r.instructions.value).toContain("guestpost-verification=T")
    expect(prisma.website.updateMany).toHaveBeenCalled()
    expect(queue.addJob).toHaveBeenCalled()
  })
})
