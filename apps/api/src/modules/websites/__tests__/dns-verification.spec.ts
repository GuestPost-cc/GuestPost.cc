/**
 * DNS TXT domain-ownership verification — full logic coverage.
 *
 * Covers: token format/entropy, candidate hostname derivation, the worker
 * state machine (verify success/fail/idempotent/version-conflict, periodic
 * sweep refresh/revoke/transient-skip), the publisher verify endpoint
 * (auth/cross-tenant/already-verified/enqueue), and the admin approval gate
 * (block unless VERIFIED, SUPER_ADMIN emergency override).
 */

import {
  candidateHostnames,
  generateVerificationToken,
  runWebsiteReverifySweep,
  runWebsiteVerify,
  VERIFICATION_TXT_PREFIX,
  verificationTxtValue,
} from "@guestpost/shared"
import { BadRequestException, NotFoundException } from "@nestjs/common"
import { AdminService } from "../../admin/admin.service"
import { WebsitesService } from "../websites.service"

// ── Token + format helpers ────────────────────────────────────────────────
describe("verification token helpers", () => {
  it("generates a URL-safe token with >=32 bytes entropy", () => {
    const t = generateVerificationToken()
    // base64url of 32 bytes -> 43 chars, no padding, URL-safe alphabet only
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(t.length).toBeGreaterThanOrEqual(43)
  })

  it("generates unique tokens", () => {
    const set = new Set(
      Array.from({ length: 1000 }, () => generateVerificationToken()),
    )
    expect(set.size).toBe(1000)
  })

  it("formats the TXT value with the guestpost-verification prefix", () => {
    expect(verificationTxtValue("abc")).toBe(`${VERIFICATION_TXT_PREFIX}=abc`)
    expect(verificationTxtValue("abc")).toBe("guestpost-verification=abc")
  })

  it("derives root + www candidates and strips an existing www", () => {
    expect(candidateHostnames("https://example.com/path?x=1")).toEqual([
      "example.com",
      "www.example.com",
    ])
    expect(candidateHostnames("https://www.example.com")).toEqual([
      "example.com",
      "www.example.com",
    ])
    expect(candidateHostnames("example.com")).toEqual([
      "example.com",
      "www.example.com",
    ])
  })

  it("returns no candidates for empty input", () => {
    expect(candidateHostnames("")).toEqual([])
  })
})

// ── Worker state machine: single verify ───────────────────────────────────
describe("runWebsiteVerify", () => {
  let prisma: any
  const baseWebsite = {
    id: "w1",
    url: "https://example.com",
    domain: "example.com",
    publisherId: "pub1",
    verificationToken: "tok",
    verificationStatus: "PENDING_VERIFICATION",
    verificationVersion: 0,
  }

  beforeEach(() => {
    prisma = {
      website: {
        findUnique: jest.fn().mockResolvedValue({ ...baseWebsite }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      publisher: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: "pub1", organizationId: "org1" }),
      },
      publisherMembership: {
        findMany: jest.fn().mockResolvedValue([{ userId: "u1" }]),
      },
      staffMembership: {
        findMany: jest.fn().mockResolvedValue([{ userId: "s1" }]),
      },
      notification: { create: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    }
  })

  it("sets VERIFIED + audits + notifies on a matching TXT record", async () => {
    const checkDns = jest.fn().mockResolvedValue({
      found: true,
      matchedHost: "example.com",
      reason: null,
    })
    const res = await runWebsiteVerify({ prisma, checkDns }, "w1", "actor1")

    expect(res).toEqual({ ok: true, status: "VERIFIED" })
    expect(prisma.website.updateMany).toHaveBeenCalledWith({
      where: { id: "w1", verificationVersion: 0 },
      data: expect.objectContaining({
        verificationStatus: "VERIFIED",
        verificationVersion: 1,
        verificationFailureReason: null,
      }),
    })
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "WEBSITE_VERIFIED",
          entityId: "w1",
        }),
      }),
    )
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "u1",
          type: "WEBSITE_VERIFIED",
        }),
      }),
    )
  })

  it("sets VERIFICATION_FAILED with the reason on no match", async () => {
    const checkDns = jest.fn().mockResolvedValue({
      found: false,
      matchedHost: null,
      reason: "No TXT record found",
    })
    const res = await runWebsiteVerify({ prisma, checkDns }, "w1")

    expect(res).toMatchObject({
      ok: false,
      status: "VERIFICATION_FAILED",
      reason: "No TXT record found",
    })
    expect(prisma.website.updateMany).toHaveBeenCalledWith({
      where: { id: "w1", verificationVersion: 0 },
      data: expect.objectContaining({
        verificationStatus: "VERIFICATION_FAILED",
        verificationFailureReason: "No TXT record found",
      }),
    })
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "WEBSITE_VERIFICATION_FAILED",
        }),
      }),
    )
  })

  it("is idempotent — already VERIFIED is a no-op (no DNS, no write)", async () => {
    prisma.website.findUnique.mockResolvedValue({
      ...baseWebsite,
      verificationStatus: "VERIFIED",
    })
    const checkDns = jest.fn()
    const res = await runWebsiteVerify({ prisma, checkDns }, "w1")

    expect(res).toEqual({ skipped: "already_verified" })
    expect(checkDns).not.toHaveBeenCalled()
    expect(prisma.website.updateMany).not.toHaveBeenCalled()
  })

  it("replaces a temporary override with real DNS evidence", async () => {
    prisma.website.findUnique.mockResolvedValue({
      ...baseWebsite,
      verificationStatus: "VERIFIED",
      verificationMethod: "SUPER_ADMIN_OVERRIDE",
      verificationOverrideExpiresAt: new Date("2026-08-01T00:00:00Z"),
      verificationOverrideReason: "Publisher onboarding evidence reviewed",
      verifiedByUserId: "admin1",
    })
    const res = await runWebsiteVerify(
      {
        prisma,
        checkDns: jest.fn().mockResolvedValue({
          found: true,
          matchedHost: "example.com",
          reason: null,
        }),
      },
      "w1",
    )

    expect(res).toEqual({ ok: true, status: "VERIFIED" })
    expect(prisma.website.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          verificationMethod: "DNS_TXT",
          verificationOverrideExpiresAt: null,
          verificationOverrideReason: null,
          verifiedByUserId: null,
        }),
      }),
    )
  })

  it("retains an unexpired override when voluntary TXT proof is not found", async () => {
    prisma.website.findUnique.mockResolvedValue({
      ...baseWebsite,
      verificationStatus: "VERIFIED",
      verificationMethod: "SUPER_ADMIN_OVERRIDE",
      verificationOverrideExpiresAt: new Date("2026-08-01T00:00:00Z"),
    })
    const res = await runWebsiteVerify(
      {
        prisma,
        now: () => new Date("2026-07-22T00:00:00Z"),
        checkDns: jest.fn().mockResolvedValue({
          found: false,
          matchedHost: null,
          reason: "No TXT record found",
        }),
      },
      "w1",
    )

    expect(res).toMatchObject({ ok: false, status: "VERIFIED" })
    expect(prisma.website.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({
          verificationStatus: "VERIFICATION_FAILED",
        }),
      }),
    )
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "WEBSITE_TXT_VERIFICATION_FAILED_OVERRIDE_RETAINED",
        }),
      }),
    )
  })

  it("skips on version conflict (a concurrent/replayed job already won)", async () => {
    prisma.website.updateMany.mockResolvedValue({ count: 0 })
    const checkDns = jest.fn().mockResolvedValue({
      found: true,
      matchedHost: "example.com",
      reason: null,
    })
    const res = await runWebsiteVerify({ prisma, checkDns }, "w1")

    expect(res).toEqual({ skipped: "version_conflict" })
    expect(prisma.auditLog.create).not.toHaveBeenCalled()
  })

  it("skips a missing website and a website with no token", async () => {
    const checkDns = jest.fn()
    prisma.website.findUnique.mockResolvedValueOnce(null)
    expect(await runWebsiteVerify({ prisma, checkDns }, "missing")).toEqual({
      skipped: "not_found",
    })

    prisma.website.findUnique.mockResolvedValueOnce({
      ...baseWebsite,
      verificationToken: null,
    })
    expect(await runWebsiteVerify({ prisma, checkDns }, "w1")).toEqual({
      skipped: "no_token",
    })
    expect(checkDns).not.toHaveBeenCalled()
  })
})

// ── Worker state machine: periodic sweep ──────────────────────────────────
describe("runWebsiteReverifySweep", () => {
  let prisma: any
  const verifiedSite = {
    id: "w1",
    url: "https://example.com",
    domain: "example.com",
    publisherId: "pub1",
    verificationToken: "tok",
    activeVerifiedToken: "tok",
    verificationStatus: "VERIFIED",
    verificationVersion: 3,
    consecutiveFailures: 0,
  }

  beforeEach(() => {
    prisma = {
      website: {
        findMany: jest.fn().mockResolvedValue([{ id: "w1" }]),
        findUnique: jest.fn().mockResolvedValue({ ...verifiedSite }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      publisher: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: "pub1", organizationId: "org1" }),
      },
      publisherMembership: {
        findMany: jest.fn().mockResolvedValue([{ userId: "u1" }]),
      },
      staffMembership: {
        findMany: jest.fn().mockResolvedValue([{ userId: "s1" }]),
      },
      marketplaceListing: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      notification: { create: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    }
  })

  it("refreshes + resets failure streak when the record still exists", async () => {
    const checkDns = jest.fn().mockResolvedValue({
      found: true,
      matchedHost: "example.com",
      reason: null,
    })
    const res = await runWebsiteReverifySweep({ prisma, checkDns })

    expect(res).toMatchObject({ ok: true, total: 1, revoked: 0, refreshed: 1 })
    expect(prisma.website.updateMany).toHaveBeenCalledWith({
      where: { id: "w1", verificationVersion: 3 },
      data: expect.objectContaining({
        lastVerificationCheckAt: expect.any(Date),
        consecutiveFailures: 0,
      }),
    })
    expect(prisma.auditLog.create).not.toHaveBeenCalled()
  })

  it("runs daily without rechecking DNS-backed sites before 30 days", async () => {
    prisma.website.findMany.mockResolvedValue([])
    await runWebsiteReverifySweep({
      prisma,
      checkDns: jest.fn(),
      now: () => new Date("2026-07-31T00:00:00Z"),
    })

    expect(prisma.website.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        OR: expect.arrayContaining([
          { verificationMethod: "SUPER_ADMIN_OVERRIDE" },
          expect.objectContaining({
            AND: expect.arrayContaining([
              expect.objectContaining({
                OR: expect.arrayContaining([
                  { lastVerificationCheckAt: null },
                  {
                    lastVerificationCheckAt: {
                      lte: new Date("2026-07-01T00:00:00Z"),
                    },
                  },
                ]),
              }),
            ]),
          }),
        ]),
      }),
      select: { id: true },
    })
  })

  it("REVOKES + enforces + notifies on the 3rd consecutive miss", async () => {
    // 2 prior failures -> this miss is the 3rd, which revokes.
    prisma.website.findUnique.mockResolvedValue({
      ...verifiedSite,
      consecutiveFailures: 2,
    })
    const checkDns = jest.fn().mockResolvedValue({
      found: false,
      matchedHost: null,
      reason: "No TXT record found",
    })
    const res = await runWebsiteReverifySweep({ prisma, checkDns })

    expect(res).toMatchObject({ ok: true, revoked: 1, refreshed: 0 })
    expect(prisma.website.updateMany).toHaveBeenCalledWith({
      where: {
        id: "w1",
        verificationVersion: 3,
        verificationStatus: "VERIFIED",
      },
      data: expect.objectContaining({ verificationStatus: "REVOKED" }),
    })
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "WEBSITE_VERIFICATION_REVOKED",
        }),
      }),
    )
    // Publisher owner + ops staff both notified
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "u1",
          type: "WEBSITE_VERIFICATION_REVOKED",
        }),
      }),
    )
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "s1",
          type: "WEBSITE_VERIFICATION_REVOKED",
        }),
      }),
    )
  })

  it("does NOT revoke on a transient resolver error", async () => {
    const checkDns = jest
      .fn()
      .mockRejectedValue(new Error("DNS lookup timed out"))
    const res = await runWebsiteReverifySweep({ prisma, checkDns })

    expect(res).toMatchObject({ revoked: 0, refreshed: 0 })
    expect(prisma.website.updateMany).not.toHaveBeenCalled()
  })

  it("does not query DNS while a temporary override is unexpired", async () => {
    prisma.website.findUnique.mockResolvedValue({
      ...verifiedSite,
      verificationMethod: "SUPER_ADMIN_OVERRIDE",
      verificationOverrideExpiresAt: new Date("2026-08-01T00:00:00Z"),
    })
    const checkDns = jest.fn()
    const result = await runWebsiteReverifySweep({
      prisma,
      checkDns,
      now: () => new Date("2026-07-22T00:00:00Z"),
    })

    expect(result).toMatchObject({ revoked: 0, refreshed: 0 })
    expect(checkDns).not.toHaveBeenCalled()
    expect(prisma.website.updateMany).not.toHaveBeenCalled()
  })

  it("revokes and hides listings when a temporary override expires", async () => {
    prisma.website.findUnique.mockResolvedValue({
      ...verifiedSite,
      verificationMethod: "SUPER_ADMIN_OVERRIDE",
      verificationOverrideExpiresAt: new Date("2026-07-21T00:00:00Z"),
      verifiedByUserId: "admin1",
    })
    const checkDns = jest.fn()
    const result = await runWebsiteReverifySweep({
      prisma,
      checkDns,
      now: () => new Date("2026-07-22T00:00:00Z"),
    })

    expect(result).toMatchObject({ revoked: 1, refreshed: 0 })
    expect(checkDns).not.toHaveBeenCalled()
    expect(prisma.website.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          verificationMethod: "SUPER_ADMIN_OVERRIDE",
        }),
        data: expect.objectContaining({ verificationStatus: "REVOKED" }),
      }),
    )
    expect(prisma.marketplaceListing.updateMany).toHaveBeenCalled()
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "WEBSITE_DOMAIN_VERIFICATION_OVERRIDE_EXPIRED",
        }),
      }),
    )
  })
})

// ── Publisher verify endpoint ─────────────────────────────────────────────
describe("WebsitesService.requestVerification", () => {
  let service: WebsitesService
  let prisma: any
  let audit: any
  let queue: any
  const user = { id: "u1" }

  beforeEach(() => {
    prisma = {
      publisher: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: "pub1", organizationId: "org1" }),
      },
      website: {
        findFirst: jest.fn().mockResolvedValue({
          id: "w1",
          domain: "example.com",
          publisherId: "pub1",
          verificationToken: "tok",
          verificationStatus: "PENDING_VERIFICATION",
          lastVerificationRequestAt: null,
        }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      auditLog: { count: jest.fn().mockResolvedValue(0) },
    }
    audit = { log: jest.fn().mockResolvedValue(undefined) }
    queue = { addJob: jest.fn().mockResolvedValue({ id: "job1" }) }
    service = new WebsitesService(prisma, audit, queue)
  })

  it("enqueues a signed verify job, audits REQUESTED, returns DNS instructions", async () => {
    prisma.website.updateMany.mockResolvedValue({ count: 1 })
    const res = await service.requestVerification("pub1", "org1", "w1", user)

    expect(queue.addJob).toHaveBeenCalledWith(
      "website-verification",
      "website-verify",
      { websiteId: "w1", actorUserId: "u1" },
      expect.objectContaining({ jobId: "website-verify-w1" }),
    )
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "WEBSITE_VERIFICATION_REQUESTED",
        entityId: "w1",
      }),
    )
    expect(res.instructions).toEqual(
      expect.objectContaining({
        type: "DNS_TXT",
        host: "@",
        value: "guestpost-verification=tok",
      }),
    )
  })

  it("mints a DNS token for legacy pending websites that do not have one", async () => {
    prisma.website.findFirst.mockResolvedValue({
      id: "w1",
      domain: "example.com",
      publisherId: "pub1",
      verificationToken: null,
      verificationStatus: "PENDING_VERIFICATION",
      lastVerificationRequestAt: null,
    })
    prisma.website.updateMany.mockResolvedValue({ count: 1 })

    const res = await service.requestVerification("pub1", "org1", "w1", user)
    const mintedToken =
      prisma.website.update.mock.calls[0][0].data.verificationToken

    expect(mintedToken).toEqual(expect.any(String))
    expect(prisma.website.update).toHaveBeenCalledWith({
      where: { id: "w1" },
      data: expect.objectContaining({
        verificationMethod: "DNS_TXT",
        verificationToken: mintedToken,
        verificationStatus: "PENDING_VERIFICATION",
        verificationFailureReason: null,
      }),
    })
    expect(res.instructions.value).toBe(`guestpost-verification=${mintedToken}`)
    expect(queue.addJob).toHaveBeenCalledWith(
      "website-verification",
      "website-verify",
      { websiteId: "w1", actorUserId: "u1" },
      expect.objectContaining({ jobId: "website-verify-w1" }),
    )
  })

  it("rejects when already VERIFIED (no enqueue)", async () => {
    prisma.website.findFirst.mockResolvedValue({
      id: "w1",
      domain: "example.com",
      publisherId: "pub1",
      verificationToken: "tok",
      verificationStatus: "VERIFIED",
    })
    await expect(
      service.requestVerification("pub1", "org1", "w1", user),
    ).rejects.toThrow(BadRequestException)
    expect(queue.addJob).not.toHaveBeenCalled()
  })

  it("allows real TXT verification to replace a temporary override", async () => {
    prisma.website.findFirst.mockResolvedValue({
      id: "w1",
      domain: "example.com",
      publisherId: "pub1",
      verificationToken: "tok",
      verificationStatus: "VERIFIED",
      verificationMethod: "SUPER_ADMIN_OVERRIDE",
    })
    prisma.website.updateMany.mockResolvedValue({ count: 1 })

    await expect(
      service.requestVerification("pub1", "org1", "w1", user),
    ).resolves.toMatchObject({
      verificationStatus: "VERIFIED",
      instructions: { value: "guestpost-verification=tok" },
    })
    expect(queue.addJob).toHaveBeenCalled()
  })

  it("blocks cross-tenant: publisher not in caller's organization", async () => {
    prisma.publisher.findUnique.mockResolvedValue({
      id: "pub1",
      organizationId: "OTHER_ORG",
    })
    await expect(
      service.requestVerification("pub1", "org1", "w1", user),
    ).rejects.toThrow(NotFoundException)
    expect(queue.addJob).not.toHaveBeenCalled()
  })

  it("blocks verifying another publisher's website (not found under this publisher)", async () => {
    prisma.website.findFirst.mockResolvedValue(null)
    await expect(
      service.requestVerification("pub1", "org1", "w1", user),
    ).rejects.toThrow(NotFoundException)
    expect(queue.addJob).not.toHaveBeenCalled()
  })
})

// ── Publisher submit endpoint ──────────────────────────────────────────────
describe("WebsitesService.submitForReview verification gate", () => {
  let service: WebsitesService
  let prisma: any
  let audit: any
  let queue: any
  const user = { id: "u1" }

  beforeEach(() => {
    prisma = {
      publisher: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: "pub1", organizationId: "org1" }),
      },
      website: {
        findFirst: jest.fn().mockResolvedValue({
          id: "w1",
          domain: "example.com",
          publisherId: "pub1",
          verificationStatus: "VERIFIED",
        }),
      },
      marketplaceListing: {
        findFirst: jest.fn().mockResolvedValue({
          id: "l1",
          categories: [{ categoryId: "category-1" }],
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
          description: "A complete buyer-facing marketplace description.",
          services: [{ id: "service-1" }],
        }),
        update: jest.fn().mockResolvedValue({ id: "l1" }),
      },
      websiteMetric: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { key: "AHREFS_ORGANIC_TRAFFIC" },
            { key: "MOZ_DOMAIN_AUTHORITY" },
          ]),
      },
    }
    audit = { log: jest.fn().mockResolvedValue(undefined) }
    queue = { addJob: jest.fn().mockResolvedValue({ id: "job1" }) }
    service = new WebsitesService(prisma, audit, queue)
  })

  it("blocks submission until DNS ownership is verified", async () => {
    prisma.website.findFirst.mockResolvedValue({
      id: "w1",
      domain: "example.com",
      publisherId: "pub1",
      verificationStatus: "PENDING_VERIFICATION",
    })

    await expect(
      service.submitForReview("pub1", "org1", "w1", user),
    ).rejects.toMatchObject({ response: { code: "WEBSITE_NOT_VERIFIED" } })
    expect(prisma.marketplaceListing.update).not.toHaveBeenCalled()
  })

  it("submits a draft listing after DNS ownership is verified", async () => {
    await expect(
      service.submitForReview("pub1", "org1", "w1", user),
    ).resolves.toEqual({ success: true })
    expect(prisma.marketplaceListing.update).toHaveBeenCalledWith({
      where: { id: "l1" },
      data: { status: "PENDING_REVIEW" },
    })
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "WEBSITE_SUBMITTED_FOR_REVIEW" }),
    )
  })

  it("blocks submission when required manual metrics are missing", async () => {
    prisma.websiteMetric.findMany.mockResolvedValue([
      { key: "AHREFS_ORGANIC_TRAFFIC" },
    ])

    await expect(
      service.submitForReview("pub1", "org1", "w1", user),
    ).rejects.toMatchObject({ response: { code: "MANUAL_METRICS_REQUIRED" } })
    expect(prisma.marketplaceListing.update).not.toHaveBeenCalled()
  })
})

// ── Admin approval gate ───────────────────────────────────────────────────
describe("AdminService.updateListingStatus verification gate", () => {
  let admin: AdminService
  let prisma: any
  let audit: any
  let queue: any

  function makeListing(websiteStatus: string | null) {
    return {
      id: "l1",
      status: "PENDING_REVIEW",
      title: "Listing",
      organizationId: "org1",
      publisherId: "pub1",
      publisher: { email: "p@test" },
      services: [{ id: "service-1" }],
      categories: [{ categoryId: "category-1" }],
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
      website: websiteStatus
        ? { verificationStatus: websiteStatus, domain: "example.com" }
        : null,
    }
  }

  beforeEach(() => {
    prisma = {
      marketplaceListing: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({ id: "l1", status: "APPROVED" }),
      },
    }
    audit = { log: jest.fn().mockResolvedValue(undefined) }
    queue = {
      pushNotification: jest.fn().mockResolvedValue({}),
      sendEmail: jest.fn().mockResolvedValue({}),
    }
    admin = new AdminService(prisma, audit, queue as any)
  })

  it("blocks APPROVED with WEBSITE_NOT_VERIFIED when the website is not VERIFIED", async () => {
    prisma.marketplaceListing.findUnique.mockResolvedValue(
      makeListing("PENDING_VERIFICATION"),
    )
    await expect(
      admin.updateListingStatus("l1", "APPROVED", {
        id: "admin1",
        role: "OPERATIONS",
      }),
    ).rejects.toMatchObject({ response: { code: "WEBSITE_NOT_VERIFIED" } })
    expect(prisma.marketplaceListing.update).not.toHaveBeenCalled()
  })

  it("allows APPROVED when the website is VERIFIED", async () => {
    prisma.marketplaceListing.findUnique.mockResolvedValue(
      makeListing("VERIFIED"),
    )
    const res = await admin.updateListingStatus("l1", "APPROVED", {
      id: "admin1",
      role: "OPERATIONS",
    })
    expect(res.status).toBe("APPROVED")
    expect(prisma.marketplaceListing.update).toHaveBeenCalled()
  })

  it("allows APPROVED for a platform listing with no website", async () => {
    prisma.marketplaceListing.findUnique.mockResolvedValue(makeListing(null))
    const res = await admin.updateListingStatus("l1", "APPROVED", {
      id: "admin1",
      role: "OPERATIONS",
    })
    expect(res.status).toBe("APPROVED")
  })

  it("blocks approval when the listing has no available services", async () => {
    prisma.marketplaceListing.findUnique.mockResolvedValue({
      ...makeListing(null),
      services: [],
    })
    await expect(
      admin.updateListingStatus("l1", "APPROVED", {
        id: "admin1",
        staffRole: "OPERATIONS",
      }),
    ).rejects.toMatchObject({ response: { code: "NO_AVAILABLE_SERVICES" } })
    expect(prisma.marketplaceListing.update).not.toHaveBeenCalled()
  })

  it("refuses force override from a non-SUPER_ADMIN", async () => {
    prisma.marketplaceListing.findUnique.mockResolvedValue(
      makeListing("VERIFICATION_FAILED"),
    )
    await expect(
      admin.updateListingStatus(
        "l1",
        "APPROVED",
        { id: "admin1", staffRole: "OPERATIONS" },
        true,
      ),
    ).rejects.toMatchObject({ response: { code: "WEBSITE_NOT_VERIFIED" } })
    expect(prisma.marketplaceListing.update).not.toHaveBeenCalled()
  })

  it("allows SUPER_ADMIN emergency force override and audits it", async () => {
    prisma.marketplaceListing.findUnique.mockResolvedValue(
      makeListing("VERIFICATION_FAILED"),
    )
    const res = await admin.updateListingStatus(
      "l1",
      "APPROVED",
      { id: "super1", staffRole: "SUPER_ADMIN" },
      true,
    )
    expect(res.status).toBe("APPROVED")
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "WEBSITE_VERIFICATION_OVERRIDE",
        entityId: "l1",
      }),
    )
  })
})
