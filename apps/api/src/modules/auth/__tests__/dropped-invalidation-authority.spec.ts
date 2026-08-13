jest.mock("@guestpost/auth", () => ({
  auth: { api: { getSession: jest.fn() } },
}))

import { auth } from "@guestpost/auth"
import { ForbiddenException } from "@nestjs/common"
import {
  clearAuthContextCache,
  setCachedAuthContext,
} from "../../../common/auth-context-cache"
import { MemberRolesGuard } from "../../../common/guards/member-roles.guard"
import { PermissionsGuard } from "../../../common/guards/permissions.guard"
import { StaffRolesGuard } from "../../../common/guards/staff-roles.guard"
import { AuthGuard } from "../auth.guard"
import { CurrentAuthorityGuard } from "../current-authority.guard"
import { CurrentAuthorityService } from "../current-authority.service"

const getSession = auth.api.getSession as unknown as jest.Mock

function context(request: Record<string, unknown>) {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => request }),
  } as any
}

function reflector(value: unknown) {
  return { getAllAndOverride: jest.fn().mockReturnValue(value) } as any
}

async function runAuthPipeline(
  userId: string,
  staleProjection: Record<string, unknown>,
  durableUser: Record<string, unknown>,
) {
  setCachedAuthContext(userId, {
    id: userId,
    emailVerified: true,
    ...staleProjection,
  })
  getSession.mockResolvedValue({
    session: {
      id: `session-${userId}`,
      userId,
      createdAt: new Date(),
    },
    user: {
      id: userId,
      banned: false,
      userType: staleProjection.userType,
    },
  })
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue(durableUser) },
    session: { deleteMany: jest.fn() },
  }
  const request: any = {
    headers: {},
    method: "GET",
    originalUrl: "/protected",
    path: "/protected",
  }
  const executionContext = context(request)
  const authorities = new CurrentAuthorityService(prisma as any)

  await new AuthGuard(reflector(false), prisma as any, {} as any).canActivate(
    executionContext,
  )
  await new CurrentAuthorityGuard(reflector(false), authorities).canActivate(
    executionContext,
  )

  return { authorities, executionContext, prisma, request }
}

describe("fresh authority when cache invalidation is dropped", () => {
  beforeEach(() => {
    clearAuthContextCache()
    getSession.mockReset()
  })

  afterEach(() => {
    clearAuthContextCache()
  })

  it("denies an OWNER-only route immediately after durable demotion", async () => {
    const result = await runAuthPipeline(
      "customer-1",
      {
        userType: "CUSTOMER",
        organizationId: "organization-1",
        customerRole: "OWNER",
        memberRole: "OWNER",
      },
      {
        id: "customer-1",
        userType: "CUSTOMER",
        role: "SEO_SPECIALIST",
        banned: false,
        emailVerified: true,
        activeContext: {
          activeOrganizationId: "organization-1",
          activePublisherId: null,
          activeOrganization: { memberships: [{ role: "MEMBER" }] },
          activePublisher: null,
        },
        staffMemberships: [],
      },
    )

    expect(result.request).toMatchObject({
      user: { customerRole: "MEMBER" },
    })
    const guard = new MemberRolesGuard(reflector(["OWNER"]), result.authorities)
    await expect(
      guard.canActivate(result.executionContext),
    ).rejects.toBeInstanceOf(ForbiddenException)
    expect(result.prisma.user.findUnique).toHaveBeenCalledTimes(1)
  })

  it("denies publisher access immediately after membership deletion", async () => {
    const result = await runAuthPipeline(
      "publisher-user-1",
      {
        userType: "PUBLISHER",
        publisherId: "publisher-1",
        publisherRole: "PUBLISHER_OWNER",
      },
      {
        id: "publisher-user-1",
        userType: "PUBLISHER",
        role: "SEO_SPECIALIST",
        banned: false,
        emailVerified: true,
        activeContext: {
          activeOrganizationId: null,
          activePublisherId: "publisher-1",
          activeOrganization: null,
          activePublisher: {
            organizationId: "publisher-org-1",
            publisherMemberships: [],
          },
        },
        staffMemberships: [],
      },
    )

    expect(result.request).toMatchObject({
      user: { publisherId: null, publisherRole: null },
    })
    const guard = new MemberRolesGuard(
      reflector(["PUBLISHER_OWNER"]),
      result.authorities,
    )
    await expect(
      guard.canActivate(result.executionContext),
    ).rejects.toBeInstanceOf(ForbiddenException)
  })

  it("denies stale staff role and decrypt permission after durable removal", async () => {
    const result = await runAuthPipeline(
      "staff-1",
      {
        userType: "STAFF",
        staffRole: "SUPER_ADMIN",
        staffPermissions: ["FINANCIAL_DATA_DECRYPT"],
      },
      {
        id: "staff-1",
        userType: "STAFF",
        role: "SEO_SPECIALIST",
        banned: false,
        emailVerified: true,
        activeContext: null,
        staffMemberships: [{ role: "OPERATIONS", permissions: [] }],
      },
    )

    expect(result.request).toMatchObject({
      user: { staffRole: "OPERATIONS", staffPermissions: [] },
    })
    await expect(
      new StaffRolesGuard(
        reflector(["SUPER_ADMIN"]),
        result.authorities,
      ).canActivate(result.executionContext),
    ).rejects.toBeInstanceOf(ForbiddenException)
    await expect(
      new PermissionsGuard(
        reflector(["FINANCIAL_DATA_DECRYPT"]),
        result.authorities,
      ).canActivate(result.executionContext),
    ).rejects.toBeInstanceOf(ForbiddenException)
  })
})
