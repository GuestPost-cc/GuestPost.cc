import { ForbiddenException } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { StaffRolesGuard } from "../staff-roles.guard"

describe("StaffRolesGuard", () => {
  let guard: StaffRolesGuard
  let reflector: Reflector

  beforeEach(() => {
    reflector = new Reflector()
    guard = new StaffRolesGuard(reflector)
  })

  const mockContext = (user?: any) =>
    ({
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
    }) as any

  // Phase 6.7 — fail-closed: a route guarded by StaffRolesGuard but missing
  // @StaffRoles metadata is REFUSED, not allowed. The two tests below cover
  // both fail-closed branches in staff-roles.guard.ts:34–39 (undefined metadata
  // + empty array). admin-rbac-coverage.spec.ts asserts the positive side
  // (every AdminController handler declares @StaffRoles); these assert the
  // guard's actual response to a missing/empty declaration.
  it("DENIES access when no @StaffRoles metadata is declared (fail-closed)", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(undefined)
    expect(() =>
      guard.canActivate(
        mockContext({ userType: "STAFF", staffRole: "SUPER_ADMIN" }),
      ),
    ).toThrow(ForbiddenException)
  })

  it("DENIES access when an empty roles array is declared (fail-closed)", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue([])
    expect(() =>
      guard.canActivate(
        mockContext({ userType: "STAFF", staffRole: "SUPER_ADMIN" }),
      ),
    ).toThrow(ForbiddenException)
  })

  it("allows SUPER_ADMIN access", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["SUPER_ADMIN"])
    expect(
      guard.canActivate(
        mockContext({ userType: "STAFF", staffRole: "SUPER_ADMIN" }),
      ),
    ).toBe(true)
  })

  it("allows FINANCE access when FINANCE is required", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["FINANCE"])
    expect(
      guard.canActivate(
        mockContext({ userType: "STAFF", staffRole: "FINANCE" }),
      ),
    ).toBe(true)
  })

  it("allows OPERATIONS access when OPERATIONS is required", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["OPERATIONS"])
    expect(
      guard.canActivate(
        mockContext({ userType: "STAFF", staffRole: "OPERATIONS" }),
      ),
    ).toBe(true)
  })

  it("denies CUSTOMER user", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["SUPER_ADMIN"])
    expect(() =>
      guard.canActivate(mockContext({ userType: "CUSTOMER" })),
    ).toThrow(ForbiddenException)
  })

  it("denies user with no staffRole", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["SUPER_ADMIN"])
    expect(() =>
      guard.canActivate(mockContext({ userType: "STAFF", staffRole: null })),
    ).toThrow(ForbiddenException)
  })

  it("denies user with insufficient role", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["SUPER_ADMIN"])
    expect(() =>
      guard.canActivate(
        mockContext({ userType: "STAFF", staffRole: "OPERATIONS" }),
      ),
    ).toThrow(ForbiddenException)
  })

  it("throws when user is null", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["SUPER_ADMIN"])
    expect(() => guard.canActivate(mockContext(null))).toThrow(
      ForbiddenException,
    )
  })

  it("throws when user is undefined", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["SUPER_ADMIN"])
    expect(() => guard.canActivate(mockContext(undefined))).toThrow(
      ForbiddenException,
    )
  })
})
