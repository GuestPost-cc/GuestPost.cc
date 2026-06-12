/**
 * DNS TXT domain-ownership verification — full logic coverage.
 *
 * Covers: token format/entropy, candidate hostname derivation, the worker
 * state machine (verify success/fail/idempotent/version-conflict, periodic
 * sweep refresh/revoke/transient-skip), the publisher verify endpoint
 * (auth/cross-tenant/already-verified/enqueue), and the admin approval gate
 * (block unless VERIFIED, SUPER_ADMIN emergency override).
 */
import { BadRequestException, NotFoundException } from "@nestjs/common"
import {
  generateVerificationToken,
  verificationTxtValue,
  candidateHostnames,
  VERIFICATION_TXT_PREFIX,
  runWebsiteVerify,
  runWebsiteReverifySweep,
} from "@guestpost/shared"
import { WebsitesService } from "../websites.service"
import { AdminService } from "../../admin/admin.service"

// ── Token + format helpers ────────────────────────────────────────────────
describe("verification token helpers", () => {
  it("generates a URL-safe token with >=32 bytes entropy", () => {
    const t = generateVerificationToken()
    // base64url of 32 bytes -> 43 chars, no padding, URL-safe alphabet only
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(t.length).toBeGreaterThanOrEqual(43)
  })

  it("generates unique tokens", () => {
    const set = new Set(Array.from({ length: 1000 }, () => generateVerificationToken()))
    expect(set.size).toBe(1000)
  })

  it("formats the TXT value with the guestpost-verification prefix", () => {
    expect(verificationTxtValue("abc")).toBe(`${VERIFICATION_TXT_PREFIX}=abc`)
    expect(verificationTxtValue("abc")).toBe("guestpost-verification=abc")
  })

  it("derives root + www candidates and strips an existing www", () => {
    expect(candidateHostnames("https://example.com/path?x=1")).toEqual(["example.com", "www.example.com"])
    expect(candidateHostnames("https://www.example.com")).toEqual(["example.com", "www.example.com"])
    expect(candidateHostnames("example.com")).toEqual(["example.com", "www.example.com"])
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
      publisher: { findUnique: jest.fn().mockResolvedValue({ id: "pub1", organizationId: "org1" }) },
      publisherMembership: { findMany: jest.fn().mockResolvedValue([{ userId: "u1" }]) },
      staffMembership: { findMany: jest.fn().mockResolvedValue([{ userId: "s1" }]) },
      notification: { create: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    }
  })

  it("sets VERIFIED + audits + notifies on a matching TXT record", async () => {
    const checkDns = jest.fn().mockResolvedValue({ found: true, matchedHost: "example.com", reason: null })
    const res = await runWebsiteVerify({ prisma, checkDns }, "w1", "actor1")

    expect(res).toEqual({ ok: true, status: "VERIFIED" })
    expect(prisma.website.updateMany).toHaveBeenCalledWith({
      where: { id: "w1", verificationVersion: 0 },
      data: expect.objectContaining({ verificationStatus: "VERIFIED", verificationVersion: 1, verificationFailureReason: null }),
    })
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "WEBSITE_VERIFIED", entityId: "w1" }) }),
    )
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: "u1", type: "WEBSITE_VERIFIED" }) }),
    )
  })

  it("sets VERIFICATION_FAILED with the reason on no match", async () => {
    const checkDns = jest.fn().mockResolvedValue({ found: false, matchedHost: null, reason: "No TXT record found" })
    const res = await runWebsiteVerify({ prisma, checkDns }, "w1")

    expect(res).toMatchObject({ ok: false, status: "VERIFICATION_FAILED", reason: "No TXT record found" })
    expect(prisma.website.updateMany).toHaveBeenCalledWith({
      where: { id: "w1", verificationVersion: 0 },
      data: expect.objectContaining({ verificationStatus: "VERIFICATION_FAILED", verificationFailureReason: "No TXT record found" }),
    })
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "WEBSITE_VERIFICATION_FAILED" }) }),
    )
  })

  it("is idempotent — already VERIFIED is a no-op (no DNS, no write)", async () => {
    prisma.website.findUnique.mockResolvedValue({ ...baseWebsite, verificationStatus: "VERIFIED" })
    const checkDns = jest.fn()
    const res = await runWebsiteVerify({ prisma, checkDns }, "w1")

    expect(res).toEqual({ skipped: "already_verified" })
    expect(checkDns).not.toHaveBeenCalled()
    expect(prisma.website.updateMany).not.toHaveBeenCalled()
  })

  it("skips on version conflict (a concurrent/replayed job already won)", async () => {
    prisma.website.updateMany.mockResolvedValue({ count: 0 })
    const checkDns = jest.fn().mockResolvedValue({ found: true, matchedHost: "example.com", reason: null })
    const res = await runWebsiteVerify({ prisma, checkDns }, "w1")

    expect(res).toEqual({ skipped: "version_conflict" })
    expect(prisma.auditLog.create).not.toHaveBeenCalled()
  })

  it("skips a missing website and a website with no token", async () => {
    const checkDns = jest.fn()
    prisma.website.findUnique.mockResolvedValueOnce(null)
    expect(await runWebsiteVerify({ prisma, checkDns }, "missing")).toEqual({ skipped: "not_found" })

    prisma.website.findUnique.mockResolvedValueOnce({ ...baseWebsite, verificationToken: null })
    expect(await runWebsiteVerify({ prisma, checkDns }, "w1")).toEqual({ skipped: "no_token" })
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
    verificationStatus: "VERIFIED",
    verificationVersion: 3,
  }

  beforeEach(() => {
    prisma = {
      website: {
        findMany: jest.fn().mockResolvedValue([{ id: "w1" }]),
        findUnique: jest.fn().mockResolvedValue({ ...verifiedSite }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      publisher: { findUnique: jest.fn().mockResolvedValue({ id: "pub1", organizationId: "org1" }) },
      publisherMembership: { findMany: jest.fn().mockResolvedValue([{ userId: "u1" }]) },
      staffMembership: { findMany: jest.fn().mockResolvedValue([{ userId: "s1" }]) },
      notification: { create: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    }
  })

  it("refreshes lastVerificationCheckAt when the record still exists", async () => {
    const checkDns = jest.fn().mockResolvedValue({ found: true, matchedHost: "example.com", reason: null })
    const res = await runWebsiteReverifySweep({ prisma, checkDns })

    expect(res).toMatchObject({ ok: true, total: 1, revoked: 0, refreshed: 1 })
    expect(prisma.website.updateMany).toHaveBeenCalledWith({
      where: { id: "w1", verificationVersion: 3 },
      data: { lastVerificationCheckAt: expect.any(Date) },
    })
    expect(prisma.auditLog.create).not.toHaveBeenCalled()
  })

  it("REVOKES + audits + notifies publisher & ops when the record is gone", async () => {
    const checkDns = jest.fn().mockResolvedValue({ found: false, matchedHost: null, reason: "No TXT record found" })
    const res = await runWebsiteReverifySweep({ prisma, checkDns })

    expect(res).toMatchObject({ ok: true, revoked: 1, refreshed: 0 })
    expect(prisma.website.updateMany).toHaveBeenCalledWith({
      where: { id: "w1", verificationVersion: 3, verificationStatus: "VERIFIED" },
      data: expect.objectContaining({ verificationStatus: "REVOKED" }),
    })
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "WEBSITE_VERIFICATION_REVOKED" }) }),
    )
    // Publisher owner + ops staff both notified
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: "u1", type: "WEBSITE_VERIFICATION_REVOKED" }) }),
    )
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: "s1", type: "WEBSITE_VERIFICATION_REVOKED" }) }),
    )
  })

  it("does NOT revoke on a transient resolver error", async () => {
    const checkDns = jest.fn().mockRejectedValue(new Error("DNS lookup timed out"))
    const res = await runWebsiteReverifySweep({ prisma, checkDns })

    expect(res).toMatchObject({ revoked: 0, refreshed: 0 })
    expect(prisma.website.updateMany).not.toHaveBeenCalled()
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
      publisher: { findUnique: jest.fn().mockResolvedValue({ id: "pub1", organizationId: "org1" }) },
      website: {
        findFirst: jest.fn().mockResolvedValue({
          id: "w1",
          domain: "example.com",
          publisherId: "pub1",
          verificationToken: "tok",
          verificationStatus: "PENDING_VERIFICATION",
        }),
      },
    }
    audit = { log: jest.fn().mockResolvedValue(undefined) }
    queue = { addJob: jest.fn().mockResolvedValue({ id: "job1" }) }
    service = new WebsitesService(prisma, audit, queue)
  })

  it("enqueues a signed verify job, audits REQUESTED, returns DNS instructions", async () => {
    const res = await service.requestVerification("pub1", "org1", "w1", user)

    expect(queue.addJob).toHaveBeenCalledWith(
      "website-verification",
      "website-verify",
      { websiteId: "w1", actorUserId: "u1" },
      expect.objectContaining({ jobId: "website-verify-w1" }),
    )
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "WEBSITE_VERIFICATION_REQUESTED", entityId: "w1" }),
    )
    expect(res.instructions).toEqual(
      expect.objectContaining({ type: "DNS_TXT", host: "@", value: "guestpost-verification=tok" }),
    )
  })

  it("rejects when already VERIFIED (no enqueue)", async () => {
    prisma.website.findFirst.mockResolvedValue({
      id: "w1", domain: "example.com", publisherId: "pub1", verificationToken: "tok", verificationStatus: "VERIFIED",
    })
    await expect(service.requestVerification("pub1", "org1", "w1", user)).rejects.toThrow(BadRequestException)
    expect(queue.addJob).not.toHaveBeenCalled()
  })

  it("blocks cross-tenant: publisher not in caller's organization", async () => {
    prisma.publisher.findUnique.mockResolvedValue({ id: "pub1", organizationId: "OTHER_ORG" })
    await expect(service.requestVerification("pub1", "org1", "w1", user)).rejects.toThrow(NotFoundException)
    expect(queue.addJob).not.toHaveBeenCalled()
  })

  it("blocks verifying another publisher's website (not found under this publisher)", async () => {
    prisma.website.findFirst.mockResolvedValue(null)
    await expect(service.requestVerification("pub1", "org1", "w1", user)).rejects.toThrow(NotFoundException)
    expect(queue.addJob).not.toHaveBeenCalled()
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
      website: websiteStatus ? { verificationStatus: websiteStatus, domain: "example.com" } : null,
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
    queue = { pushNotification: jest.fn().mockResolvedValue({}), sendEmail: jest.fn().mockResolvedValue({}) }
    const refund = {} as any
    admin = new AdminService(prisma, audit, queue as any, refund)
  })

  it("blocks APPROVED with WEBSITE_NOT_VERIFIED when the website is not VERIFIED", async () => {
    prisma.marketplaceListing.findUnique.mockResolvedValue(makeListing("PENDING_VERIFICATION"))
    await expect(
      admin.updateListingStatus("l1", "APPROVED", { id: "admin1", role: "OPERATIONS" }),
    ).rejects.toMatchObject({ response: { code: "WEBSITE_NOT_VERIFIED" } })
    expect(prisma.marketplaceListing.update).not.toHaveBeenCalled()
  })

  it("allows APPROVED when the website is VERIFIED", async () => {
    prisma.marketplaceListing.findUnique.mockResolvedValue(makeListing("VERIFIED"))
    const res = await admin.updateListingStatus("l1", "APPROVED", { id: "admin1", role: "OPERATIONS" })
    expect(res.status).toBe("APPROVED")
    expect(prisma.marketplaceListing.update).toHaveBeenCalled()
  })

  it("allows APPROVED for a platform listing with no website", async () => {
    prisma.marketplaceListing.findUnique.mockResolvedValue(makeListing(null))
    const res = await admin.updateListingStatus("l1", "APPROVED", { id: "admin1", role: "OPERATIONS" })
    expect(res.status).toBe("APPROVED")
  })

  it("refuses force override from a non-SUPER_ADMIN", async () => {
    prisma.marketplaceListing.findUnique.mockResolvedValue(makeListing("VERIFICATION_FAILED"))
    await expect(
      admin.updateListingStatus("l1", "APPROVED", { id: "admin1", role: "OPERATIONS" }, true),
    ).rejects.toMatchObject({ response: { code: "WEBSITE_NOT_VERIFIED" } })
    expect(prisma.marketplaceListing.update).not.toHaveBeenCalled()
  })

  it("allows SUPER_ADMIN emergency force override and audits it", async () => {
    prisma.marketplaceListing.findUnique.mockResolvedValue(makeListing("VERIFICATION_FAILED"))
    const res = await admin.updateListingStatus("l1", "APPROVED", { id: "super1", role: "SUPER_ADMIN" }, true)
    expect(res.status).toBe("APPROVED")
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "WEBSITE_VERIFICATION_OVERRIDE", entityId: "l1" }),
    )
  })
})
