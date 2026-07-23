import { BadRequestException } from "@nestjs/common"
import { WebsiteVerificationService } from "../website-verification.service"

describe("WebsiteVerificationService.forceVerifyWebsites", () => {
  let prisma: any
  let audit: any
  let service: WebsiteVerificationService
  let tx: any

  beforeEach(() => {
    tx = { website: { update: jest.fn().mockResolvedValue({}) } }
    prisma = {
      website: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "website-1",
            domain: "example.com",
            canonicalDomain: "example.com",
            publisherId: "publisher-1",
            verificationStatus: "PENDING_VERIFICATION",
            importBatchId: "batch-1",
            publisher: { id: "publisher-1", organizationId: "org-1" },
          },
        ]),
      },
      $transaction: jest.fn(async (callback) => callback(tx)),
    }
    audit = { log: jest.fn().mockResolvedValue(undefined) }
    service = new WebsiteVerificationService(prisma, audit, {} as any)
  })

  it("enforces Super Admin again inside the service", async () => {
    await expect(
      service.forceVerifyWebsites(
        {
          websiteIds: ["website-1"],
          reason: "Publisher onboarding evidence reviewed",
          expiresInDays: 30,
        },
        { id: "staff-1", staffRole: "OPERATIONS" },
      ),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(prisma.website.findMany).not.toHaveBeenCalled()
  })

  it("fails the whole request if any requested website is out of scope", async () => {
    await expect(
      service.forceVerifyWebsites(
        {
          websiteIds: ["website-1", "website-outside-scope"],
          reason: "Publisher onboarding evidence reviewed",
          expiresInDays: 30,
        },
        { id: "admin-1", staffRole: "SUPER_ADMIN" },
      ),
    ).rejects.toThrow("unavailable for forced verification")
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it("writes explicit expiring provenance and an atomic audit record", async () => {
    const result = await service.forceVerifyWebsites(
      {
        websiteIds: ["website-1"],
        reason: "  Publisher onboarding evidence reviewed  ",
        expiresInDays: 30,
      },
      { id: "admin-1", staffRole: "SUPER_ADMIN" },
    )

    expect(result.verified).toBe(1)
    expect(tx.website.update).toHaveBeenCalledWith({
      where: { id: "website-1" },
      data: expect.objectContaining({
        verificationStatus: "VERIFIED",
        verificationMethod: "SUPER_ADMIN_OVERRIDE",
        verificationOverrideExpiresAt: expect.any(Date),
        verificationOverrideReason: "Publisher onboarding evidence reviewed",
        verifiedByUserId: "admin-1",
        activeVerifiedToken: null,
      }),
    })
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "WEBSITE_DOMAIN_VERIFICATION_OVERRIDE",
        entityType: "Website",
        entityId: "website-1",
        userId: "admin-1",
        metadata: expect.objectContaining({
          importBatchId: "batch-1",
          reason: "Publisher onboarding evidence reviewed",
        }),
      }),
      tx,
    )
  })
})
