import { ForbiddenException } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { StaffRolesGuard } from "../staff-roles.guard"

const staffAuthority = (staffRole: string | null) => ({
  id: "staff-1",
  userType: "STAFF",
  role: "SEO_SPECIALIST",
  emailVerified: true,
  organizationId: null,
  publisherId: null,
  publisherOrganizationId: null,
  customerRole: null,
  memberRole: null,
  publisherRole: null,
  staffRole,
  staffPermissions: [],
})

describe("StaffRolesGuard", () => {
  let guard: StaffRolesGuard
  let reflector: Reflector
  let authorities: { resolveRequest: jest.Mock }

  beforeEach(() => {
    reflector = new Reflector()
    authorities = { resolveRequest: jest.fn() }
    guard = new StaffRolesGuard(reflector, authorities as any)
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

  it.each([
    undefined,
    [],
  ])("denies missing or empty @StaffRoles metadata (%p)", async (required) => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(required)
    const { context } = mockContext({ id: "staff-1" })

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException)
    expect(authorities.resolveRequest).not.toHaveBeenCalled()
  })

  it.each([
    "SUPER_ADMIN",
    "FINANCE",
    "OPERATIONS",
  ])("allows a fresh %s membership when required", async (role) => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue([role])
    authorities.resolveRequest.mockResolvedValue(staffAuthority(role))
    const { context, request } = mockContext({
      id: "staff-1",
      userType: "STAFF",
      staffRole: "STALE",
    })

    await expect(guard.canActivate(context)).resolves.toBe(true)
    expect(authorities.resolveRequest).toHaveBeenCalledWith(request)
  })

  it("denies a stale SUPER_ADMIN projection after durable demotion", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["SUPER_ADMIN"])
    authorities.resolveRequest.mockResolvedValue(staffAuthority("OPERATIONS"))
    const { context } = mockContext({
      id: "staff-1",
      userType: "STAFF",
      staffRole: "SUPER_ADMIN",
    })

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException)
  })

  it("denies a stale role after durable membership deletion", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["SUPER_ADMIN"])
    authorities.resolveRequest.mockResolvedValue(staffAuthority(null))
    const { context } = mockContext({
      id: "staff-1",
      userType: "STAFF",
      staffRole: "SUPER_ADMIN",
    })

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException)
  })

  it("denies when the durable actor type is no longer STAFF", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["SUPER_ADMIN"])
    authorities.resolveRequest.mockResolvedValue({
      ...staffAuthority(null),
      userType: "CUSTOMER",
      organizationId: "organization-1",
      customerRole: "OWNER",
      memberRole: "OWNER",
    })
    const { context } = mockContext({
      id: "staff-1",
      userType: "STAFF",
      staffRole: "SUPER_ADMIN",
    })

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException)
  })

  it("denies when no authenticated user is attached", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["SUPER_ADMIN"])
    const { context } = mockContext(undefined)

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException)
    expect(authorities.resolveRequest).not.toHaveBeenCalled()
  })
})
