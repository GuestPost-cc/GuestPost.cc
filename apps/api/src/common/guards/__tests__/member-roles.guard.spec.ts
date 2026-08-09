import { ForbiddenException } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { MemberRolesGuard } from "../member-roles.guard"

describe("MemberRolesGuard", () => {
  let guard: MemberRolesGuard
  let reflector: Reflector
  let prisma: any

  beforeEach(() => {
    reflector = new Reflector()
    prisma = {
      activeContext: { findUnique: jest.fn() },
      membership: { findUnique: jest.fn() },
      publisherMembership: { findFirst: jest.fn() },
      staffMembership: { findUnique: jest.fn() },
    }
    guard = new MemberRolesGuard(reflector, prisma)
  })

  const mockContext = (user?: any) => {
    const request = { user }
    return {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as any
  }

  it("allows access when no roles are required", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(undefined)
    await expect(
      guard.canActivate(
        mockContext({ userType: "CUSTOMER", customerRole: "OWNER" }),
      ),
    ).resolves.toBe(true)
    expect(prisma.activeContext.findUnique).not.toHaveBeenCalled()
  })

  it("allows CUSTOMER only from its fresh active membership", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["OWNER"])
    prisma.activeContext.findUnique.mockResolvedValue({
      activeOrganizationId: "organization-1",
    })
    prisma.membership.findUnique.mockResolvedValue({
      role: "OWNER",
      status: "ACTIVE",
      user: { banned: false, userType: "CUSTOMER" },
    })
    const user = { id: "customer-1", userType: "CUSTOMER", customerRole: null }

    await expect(guard.canActivate(mockContext(user))).resolves.toBe(true)
    expect(prisma.membership.findUnique).toHaveBeenCalledWith({
      where: {
        userId_organizationId: {
          userId: "customer-1",
          organizationId: "organization-1",
        },
      },
      select: {
        role: true,
        status: true,
        user: { select: { banned: true, userType: true } },
      },
    })
    expect(user).toMatchObject({
      organizationId: "organization-1",
      customerRole: "OWNER",
      memberRole: "OWNER",
    })
  })

  it("allows CUSTOMER with fresh MEMBER role", async () => {
    jest
      .spyOn(reflector, "getAllAndOverride")
      .mockReturnValue(["OWNER", "MEMBER"])
    prisma.activeContext.findUnique.mockResolvedValue({
      activeOrganizationId: "organization-1",
    })
    prisma.membership.findUnique.mockResolvedValue({
      role: "MEMBER",
      status: "ACTIVE",
      user: { banned: false, userType: "CUSTOMER" },
    })
    await expect(
      guard.canActivate(
        mockContext({ id: "customer-1", userType: "CUSTOMER" }),
      ),
    ).resolves.toBe(true)
  })

  it("allows PUBLISHER only from its fresh active publisher membership", async () => {
    jest
      .spyOn(reflector, "getAllAndOverride")
      .mockReturnValue(["PUBLISHER_OWNER"])
    prisma.activeContext.findUnique.mockResolvedValue({
      activePublisherId: "publisher-1",
    })
    prisma.publisherMembership.findFirst.mockResolvedValue({
      role: "PUBLISHER_OWNER",
      user: { banned: false, userType: "PUBLISHER" },
      publisher: { organizationId: "publisher-org-1" },
    })
    const user = { id: "publisher-user-1", userType: "PUBLISHER" }

    await expect(guard.canActivate(mockContext(user))).resolves.toBe(true)
    expect(user).toMatchObject({
      publisherId: "publisher-1",
      publisherOrganizationId: "publisher-org-1",
      publisherRole: "PUBLISHER_OWNER",
    })
  })

  it("allows STAFF only from its fresh staff membership", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["SUPER_ADMIN"])
    prisma.staffMembership.findUnique.mockResolvedValue({
      role: "SUPER_ADMIN",
      user: { banned: false, userType: "STAFF" },
    })
    await expect(
      guard.canActivate(
        mockContext({ id: "staff-1", userType: "STAFF", staffRole: "FINANCE" }),
      ),
    ).resolves.toBe(true)
  })

  it("denies a stale cached OWNER after durable demotion to MEMBER", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["OWNER"])
    prisma.activeContext.findUnique.mockResolvedValue({
      activeOrganizationId: "organization-1",
    })
    prisma.membership.findUnique.mockResolvedValue({
      role: "MEMBER",
      status: "ACTIVE",
      user: { banned: false, userType: "CUSTOMER" },
    })
    await expect(
      guard.canActivate(
        mockContext({
          id: "customer-1",
          userType: "CUSTOMER",
          customerRole: "OWNER",
        }),
      ),
    ).rejects.toThrow(ForbiddenException)
  })

  it("denies a pending membership even when the cache says OWNER", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["OWNER"])
    prisma.activeContext.findUnique.mockResolvedValue({
      activeOrganizationId: "organization-1",
    })
    prisma.membership.findUnique.mockResolvedValue({
      role: "OWNER",
      status: "PENDING",
      user: { banned: false, userType: "CUSTOMER" },
    })

    await expect(
      guard.canActivate(
        mockContext({
          id: "customer-1",
          userType: "CUSTOMER",
          customerRole: "OWNER",
        }),
      ),
    ).rejects.toThrow(ForbiddenException)
  })

  it("denies a stale cached CUSTOMER role after the durable user is banned", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["OWNER"])
    prisma.activeContext.findUnique.mockResolvedValue({
      activeOrganizationId: "organization-1",
    })
    prisma.membership.findUnique.mockResolvedValue({
      role: "OWNER",
      status: "ACTIVE",
      user: { banned: true, userType: "CUSTOMER" },
    })

    await expect(
      guard.canActivate(
        mockContext({
          id: "customer-1",
          userType: "CUSTOMER",
          customerRole: "OWNER",
        }),
      ),
    ).rejects.toThrow(ForbiddenException)
  })

  it("denies a stale cached PUBLISHER role after the durable user is banned", async () => {
    jest
      .spyOn(reflector, "getAllAndOverride")
      .mockReturnValue(["PUBLISHER_OWNER"])
    prisma.activeContext.findUnique.mockResolvedValue({
      activePublisherId: "publisher-1",
    })
    prisma.publisherMembership.findFirst.mockResolvedValue({
      role: "PUBLISHER_OWNER",
      user: { banned: true, userType: "PUBLISHER" },
      publisher: { organizationId: "publisher-org-1" },
    })

    await expect(
      guard.canActivate(
        mockContext({
          id: "publisher-user-1",
          userType: "PUBLISHER",
          publisherRole: "PUBLISHER_OWNER",
        }),
      ),
    ).rejects.toThrow(ForbiddenException)
  })

  it("denies a membership after the durable user type changes", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["OWNER"])
    prisma.activeContext.findUnique.mockResolvedValue({
      activeOrganizationId: "organization-1",
    })
    prisma.membership.findUnique.mockResolvedValue({
      role: "OWNER",
      status: "ACTIVE",
      user: { banned: false, userType: "PUBLISHER" },
    })

    await expect(
      guard.canActivate(
        mockContext({
          id: "user-1",
          userType: "CUSTOMER",
          customerRole: "OWNER",
        }),
      ),
    ).rejects.toThrow(ForbiddenException)
  })

  it("throws when user is null", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["OWNER"])
    await expect(guard.canActivate(mockContext(null))).rejects.toThrow(
      ForbiddenException,
    )
  })

  it("throws when user is undefined", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["OWNER"])
    await expect(guard.canActivate(mockContext(undefined))).rejects.toThrow(
      ForbiddenException,
    )
  })

  it("throws when user has no durable role for their userType", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["OWNER"])
    prisma.activeContext.findUnique.mockResolvedValue({
      activeOrganizationId: null,
    })
    await expect(
      guard.canActivate(
        mockContext({
          id: "customer-1",
          userType: "CUSTOMER",
          customerRole: "OWNER",
        }),
      ),
    ).rejects.toThrow(ForbiddenException)
  })
})
