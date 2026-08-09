import { ConflictException, ForbiddenException } from "@nestjs/common"
import { invalidateAuthContext } from "../../../common/auth-context-cache"
import { IdentityService } from "../identity.service"

jest.mock("../../../common/auth-context-cache", () => ({
  invalidateAuthContext: jest.fn(),
}))

describe("IdentityService organization owner invariant", () => {
  let service: IdentityService
  let prisma: any
  let audit: any

  beforeEach(() => {
    jest.clearAllMocks()
    prisma = {
      membership: {
        count: jest.fn(),
        delete: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ id: "organization-1" }]),
      $transaction: jest
        .fn()
        .mockImplementation(async (callback: any) => callback(prisma)),
    }
    audit = { log: jest.fn().mockResolvedValue(undefined) }
    service = new IdentityService(prisma, audit, {} as any)
  })

  it("refuses to remove the last active organization owner", async () => {
    prisma.membership.findFirst.mockResolvedValue({
      id: "membership-1",
      role: "OWNER",
      status: "ACTIVE",
    })
    prisma.membership.findUnique.mockResolvedValue({
      id: "membership-1",
      userId: "owner-1",
      organizationId: "organization-1",
      role: "OWNER",
      status: "ACTIVE",
    })
    prisma.membership.count.mockResolvedValue(1)

    await expect(
      service.removeMember("organization-1", "owner-1", "owner-1"),
    ).rejects.toThrow(ForbiddenException)

    expect(prisma.membership.count).toHaveBeenCalledWith({
      where: {
        organizationId: "organization-1",
        role: "OWNER",
        status: "ACTIVE",
      },
    })
    expect(prisma.membership.delete).not.toHaveBeenCalled()
    expect(audit.log).not.toHaveBeenCalled()
    expect(invalidateAuthContext).not.toHaveBeenCalled()
  })

  it("removes an owner atomically when another active owner remains", async () => {
    const targetMembership = {
      id: "membership-2",
      userId: "owner-2",
      organizationId: "organization-1",
      role: "OWNER",
      status: "ACTIVE",
    }
    prisma.membership.findFirst.mockResolvedValue({
      id: "membership-1",
      role: "OWNER",
      status: "ACTIVE",
    })
    prisma.membership.findUnique.mockResolvedValue(targetMembership)
    prisma.membership.count.mockResolvedValue(2)

    await service.removeMember("organization-1", "owner-1", "owner-2")

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3)
    expect(prisma.$queryRaw.mock.calls.map((call: any[]) => call[1])).toEqual([
      "owner-1",
      "owner-2",
      "organization-1",
    ])
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    })
    expect(prisma.membership.delete).toHaveBeenCalledWith({
      where: { id: "membership-2" },
    })
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MEMBER_REMOVED",
        entityId: "membership-2",
        organizationId: "organization-1",
      }),
      prisma,
    )
    expect(invalidateAuthContext).toHaveBeenCalledWith("owner-2")
  })

  it("fails closed when the pg adapter wraps a concurrent membership change", async () => {
    prisma.$transaction.mockRejectedValue({
      code: "P2010",
      meta: {
        driverAdapterError: { cause: { originalCode: "40001" } },
      },
    })

    await expect(
      service.removeMember("organization-1", "owner-1", "owner-2"),
    ).rejects.toThrow(ConflictException)

    expect(prisma.membership.delete).not.toHaveBeenCalled()
    expect(audit.log).not.toHaveBeenCalled()
    expect(invalidateAuthContext).not.toHaveBeenCalled()
  })

  it("requires active owner authority for invitation commands", async () => {
    prisma.membership.findFirst.mockResolvedValue(null)

    await expect(
      service.inviteMember(
        "organization-1",
        "owner-1",
        "invitee@test.local",
        "MEMBER",
      ),
    ).rejects.toThrow(ForbiddenException)

    expect(prisma.membership.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: "organization-1",
        userId: "owner-1",
        role: "OWNER",
        status: "ACTIVE",
      },
    })
  })
})
