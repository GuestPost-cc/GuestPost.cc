/**
 * Self-serve publisher onboarding (audit A-1). The conversion must be
 * impossible for staff, existing publishers, and members of customer
 * organizations — only fresh accounts convert, and they start at NEW tier
 * (maximum withdrawal fraud-hold).
 */
import { BadRequestException, ForbiddenException } from "@nestjs/common"
import { IdentityService } from "../identity.service"

describe("IdentityService.becomePublisher", () => {
  let service: IdentityService
  let prisma: any
  let audit: any

  const freshUser = { id: "u1", email: "new@pub.test", name: "New Pub", userType: "CUSTOMER" }

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
      membership: { count: jest.fn().mockResolvedValue(0) },
      publisherMembership: { count: jest.fn().mockResolvedValue(0), create: jest.fn().mockResolvedValue({}) },
      organization: { create: jest.fn().mockResolvedValue({ id: "org-1" }) },
      publisher: { create: jest.fn().mockResolvedValue({ id: "pub-1", name: "New Pub", tier: "NEW" }) },
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb(prisma)),
    }
    audit = { log: jest.fn().mockResolvedValue(undefined) }
    service = new IdentityService(prisma, audit)
  })

  it("converts a fresh account: own org + publisher + membership + userType, NEW tier, audited", async () => {
    prisma.user.findUnique.mockResolvedValue(freshUser)

    const result = await service.becomePublisher("u1")

    expect(result.tier).toBe("NEW")
    expect(prisma.publisher.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tier: "NEW", organizationId: "org-1" }),
    })
    expect(prisma.publisherMembership.create).toHaveBeenCalledWith({
      data: { userId: "u1", publisherId: "pub-1", role: "PUBLISHER_OWNER" },
    })
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { userType: "PUBLISHER" },
    })
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "PUBLISHER_SELF_ONBOARDED" }),
      prisma,
    )
  })

  it("refuses staff accounts", async () => {
    prisma.user.findUnique.mockResolvedValue({ ...freshUser, userType: "STAFF" })
    await expect(service.becomePublisher("u1")).rejects.toThrow(ForbiddenException)
    expect(prisma.publisher.create).not.toHaveBeenCalled()
  })

  it("refuses accounts that are already publishers", async () => {
    prisma.user.findUnique.mockResolvedValue(freshUser)
    prisma.publisherMembership.count.mockResolvedValue(1)
    await expect(service.becomePublisher("u1")).rejects.toThrow(BadRequestException)
    expect(prisma.publisher.create).not.toHaveBeenCalled()
  })

  it("refuses accounts with customer-organization memberships (no silent re-typing)", async () => {
    prisma.user.findUnique.mockResolvedValue(freshUser)
    prisma.membership.count.mockResolvedValue(2)
    await expect(service.becomePublisher("u1")).rejects.toThrow(/customer organization/)
    expect(prisma.user.update).not.toHaveBeenCalled()
  })
})
