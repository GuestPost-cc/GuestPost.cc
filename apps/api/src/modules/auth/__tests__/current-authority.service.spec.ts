import { ForbiddenException, UnauthorizedException } from "@nestjs/common"
import { CurrentAuthorityService } from "../current-authority.service"

describe("CurrentAuthorityService", () => {
  const baseUser = {
    id: "user-1",
    userType: "CUSTOMER",
    role: "SEO_SPECIALIST",
    banned: false,
    emailVerified: true,
    activeContext: {
      activeOrganizationId: "org-1",
      activePublisherId: null,
      activeOrganization: { memberships: [{ role: "OWNER" }] },
      activePublisher: null,
    },
    staffMemberships: [],
  }

  const create = (resolved: unknown = baseUser) => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(resolved) },
    }
    return { prisma, service: new CurrentAuthorityService(prisma as any) }
  }

  it("resolves a customer only through its active durable membership", async () => {
    const { prisma, service } = create()

    await expect(service.resolveUser("user-1")).resolves.toMatchObject({
      id: "user-1",
      userType: "CUSTOMER",
      organizationId: "org-1",
      customerRole: "OWNER",
      publisherId: null,
      staffRole: null,
    })
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "user-1" },
        select: expect.objectContaining({
          activeContext: expect.any(Object),
          staffMemberships: expect.any(Object),
        }),
      }),
    )
  })

  it.each([
    {
      label: "deleted membership",
      user: {
        ...baseUser,
        activeContext: {
          ...baseUser.activeContext,
          activeOrganization: { memberships: [] },
        },
      },
    },
    {
      label: "pending membership",
      // The query selects ACTIVE memberships only, so PENDING resolves as an
      // empty relation just like a deleted membership.
      user: {
        ...baseUser,
        activeContext: {
          ...baseUser.activeContext,
          activeOrganization: { memberships: [] },
        },
      },
    },
    {
      label: "deleted active context",
      user: { ...baseUser, activeContext: null },
    },
  ])("removes stale tenant authority after a $label", async ({ user }) => {
    const { service } = create(user)

    await expect(service.resolveUser("user-1")).resolves.toMatchObject({
      organizationId: null,
      customerRole: null,
    })
  })

  it("observes a durable role demotion on the next request", async () => {
    const { service } = create({
      ...baseUser,
      activeContext: {
        ...baseUser.activeContext,
        activeOrganization: { memberships: [{ role: "MEMBER" }] },
      },
    })

    await expect(service.resolveUser("user-1")).resolves.toMatchObject({
      organizationId: "org-1",
      customerRole: "MEMBER",
    })
  })

  it("resolves publisher authority only through the active publisher membership", async () => {
    const { service } = create({
      ...baseUser,
      userType: "PUBLISHER",
      activeContext: {
        activeOrganizationId: null,
        activePublisherId: "publisher-1",
        activeOrganization: null,
        activePublisher: {
          organizationId: "publisher-org-1",
          publisherMemberships: [{ role: "PUBLISHER_OWNER" }],
        },
      },
    })

    await expect(service.resolveUser("user-1")).resolves.toMatchObject({
      userType: "PUBLISHER",
      organizationId: null,
      publisherId: "publisher-1",
      publisherOrganizationId: "publisher-org-1",
      publisherRole: "PUBLISHER_OWNER",
    })
  })

  it("removes publisher authority immediately after membership deletion", async () => {
    const { service } = create({
      ...baseUser,
      userType: "PUBLISHER",
      activeContext: {
        activeOrganizationId: null,
        activePublisherId: "publisher-1",
        activeOrganization: null,
        activePublisher: {
          organizationId: "publisher-org-1",
          publisherMemberships: [],
        },
      },
    })

    await expect(service.resolveUser("user-1")).resolves.toMatchObject({
      publisherId: null,
      publisherOrganizationId: null,
      publisherRole: null,
    })
  })

  it("resolves current staff role and permissions and observes their removal", async () => {
    const { prisma, service } = create({
      ...baseUser,
      userType: "STAFF",
      activeContext: null,
      staffMemberships: [
        {
          role: "SUPER_ADMIN",
          permissions: ["FINANCIAL_DATA_DECRYPT", "FINANCIAL_DATA_DECRYPT"],
        },
      ],
    })

    await expect(service.resolveUser("user-1")).resolves.toMatchObject({
      staffRole: "SUPER_ADMIN",
      staffPermissions: ["FINANCIAL_DATA_DECRYPT"],
    })

    prisma.user.findUnique.mockResolvedValue({
      ...baseUser,
      userType: "STAFF",
      activeContext: null,
      staffMemberships: [],
    })
    await expect(service.resolveUser("user-1")).resolves.toMatchObject({
      staffRole: null,
      staffPermissions: [],
    })
  })

  it("memoizes only within a request, not across requests", async () => {
    const { prisma, service } = create()
    const firstRequest = { authenticatedUserId: "user-1" }

    const [first, sameRequest] = await Promise.all([
      service.resolveRequest(firstRequest),
      service.resolveRequest(firstRequest),
    ])
    expect(first).toBe(sameRequest)
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1)

    prisma.user.findUnique.mockResolvedValue({
      ...baseUser,
      activeContext: {
        ...baseUser.activeContext,
        activeOrganization: { memberships: [{ role: "MEMBER" }] },
      },
    })
    await expect(
      service.resolveRequest({ authenticatedUserId: "user-1" }),
    ).resolves.toMatchObject({ customerRole: "MEMBER" })
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(2)
  })

  it("binds resolution to the authenticated session identity", async () => {
    const { prisma, service } = create()

    await service.resolveRequest({
      authenticatedUserId: "session-user",
      user: { id: "stale-or-substituted-user" },
    })

    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "session-user" } }),
    )
  })

  it("does not accept a pre-attached authority for another session subject", async () => {
    const { prisma, service } = create()

    await service.resolveRequest({
      authenticatedUserId: "session-user",
      currentAuthority: {
        id: "attacker-user",
        userType: "STAFF",
        role: "SEO_SPECIALIST",
        emailVerified: true,
        organizationId: null,
        publisherId: null,
        publisherOrganizationId: null,
        customerRole: null,
        memberRole: null,
        publisherRole: null,
        staffRole: "SUPER_ADMIN",
        staffPermissions: [],
      },
    })

    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "session-user" } }),
    )
  })

  it("clears failed request memoization so a retry performs a new read", async () => {
    const { prisma, service } = create(null)
    const request = { authenticatedUserId: "user-1" }

    await expect(service.resolveRequest(request)).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
    prisma.user.findUnique.mockResolvedValue(baseUser)
    await expect(service.resolveRequest(request)).resolves.toMatchObject({
      id: "user-1",
    })
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(2)
  })

  it("fails closed when the subject was deleted or banned", async () => {
    const missing = create(null).service
    await expect(missing.resolveUser("user-1")).rejects.toBeInstanceOf(
      UnauthorizedException,
    )

    const banned = create({ ...baseUser, banned: true }).service
    await expect(banned.resolveUser("user-1")).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })
})
