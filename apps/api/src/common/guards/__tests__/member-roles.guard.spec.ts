import { ForbiddenException } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { MemberRolesGuard } from "../member-roles.guard"

const baseAuthority = {
  id: "user-1",
  userType: "CUSTOMER",
  role: "SEO_SPECIALIST",
  emailVerified: true,
  organizationId: "organization-1",
  publisherId: null,
  publisherOrganizationId: null,
  customerRole: "OWNER",
  memberRole: "OWNER",
  publisherRole: null,
  staffRole: null,
  staffPermissions: [],
}

describe("MemberRolesGuard", () => {
  let guard: MemberRolesGuard
  let reflector: Reflector
  let authorities: { resolveRequest: jest.Mock }

  beforeEach(() => {
    reflector = new Reflector()
    authorities = { resolveRequest: jest.fn() }
    guard = new MemberRolesGuard(reflector, authorities as any)
  })

  const mockContext = (user?: any) => {
    const request = { user }
    return {
      request,
      context: {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({ getRequest: () => request }),
      } as any,
    }
  }

  it("allows access when no roles are required without resolving authority", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(undefined)
    const { context } = mockContext({ id: "user-1" })

    await expect(guard.canActivate(context)).resolves.toBe(true)
    expect(authorities.resolveRequest).not.toHaveBeenCalled()
  })

  it.each([
    ["CUSTOMER", "OWNER", ["OWNER"]],
    ["CUSTOMER", "MEMBER", ["OWNER", "MEMBER"]],
    ["PUBLISHER", "PUBLISHER_OWNER", ["PUBLISHER_OWNER"]],
    ["PUBLISHER", "PUBLISHER_MEMBER", ["PUBLISHER_OWNER", "PUBLISHER_MEMBER"]],
  ])("allows a fresh %s %s grant", async (userType, role, required) => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(required)
    const authority = {
      ...baseAuthority,
      userType,
      organizationId: userType === "CUSTOMER" ? "organization-1" : null,
      customerRole: userType === "CUSTOMER" ? role : null,
      memberRole: userType === "CUSTOMER" ? role : null,
      publisherId: userType === "PUBLISHER" ? "publisher-1" : null,
      publisherRole: userType === "PUBLISHER" ? role : null,
    }
    authorities.resolveRequest.mockResolvedValue(authority)
    const { context, request } = mockContext({
      id: "user-1",
      userType,
      customerRole: "STALE",
    })

    await expect(guard.canActivate(context)).resolves.toBe(true)
    expect(authorities.resolveRequest).toHaveBeenCalledWith(request)
  })

  it("denies a stale cached OWNER after durable demotion", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["OWNER"])
    authorities.resolveRequest.mockResolvedValue({
      ...baseAuthority,
      customerRole: "MEMBER",
      memberRole: "MEMBER",
    })
    const { context } = mockContext({
      id: "user-1",
      userType: "CUSTOMER",
      customerRole: "OWNER",
    })

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException)
  })

  it.each([
    [
      "deleted customer membership",
      {
        ...baseAuthority,
        customerRole: null,
        memberRole: null,
        organizationId: null,
      },
    ],
    [
      "deleted publisher membership",
      {
        ...baseAuthority,
        userType: "PUBLISHER",
        organizationId: null,
        customerRole: null,
        memberRole: null,
        publisherId: null,
        publisherRole: null,
      },
    ],
  ])("denies after %s despite cached authority", async (_case, authority) => {
    jest
      .spyOn(reflector, "getAllAndOverride")
      .mockReturnValue(["OWNER", "PUBLISHER_OWNER"])
    authorities.resolveRequest.mockResolvedValue(authority)
    const { context } = mockContext({
      id: "user-1",
      userType: authority.userType,
      customerRole: "OWNER",
      publisherRole: "PUBLISHER_OWNER",
    })

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException)
  })

  it("throws when no authenticated user is attached", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["OWNER"])
    const { context } = mockContext(undefined)

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException)
    expect(authorities.resolveRequest).not.toHaveBeenCalled()
  })
})
