import { ForbiddenException } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { StaffRolesGuard } from "../staff-roles.guard"
import { STAFF_ROLES_KEY } from "../../decorators/staff-roles.decorator"

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

  it("allows access when no roles are required", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(undefined)
    expect(guard.canActivate(mockContext({ userType: "STAFF", staffRole: "SUPER_ADMIN" }))).toBe(true)
  })

  it("allows SUPER_ADMIN access", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["SUPER_ADMIN"])
    expect(guard.canActivate(mockContext({ userType: "STAFF", staffRole: "SUPER_ADMIN" }))).toBe(true)
  })

  it("allows FINANCE access when FINANCE is required", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["FINANCE"])
    expect(guard.canActivate(mockContext({ userType: "STAFF", staffRole: "FINANCE" }))).toBe(true)
  })

  it("allows OPERATIONS access when OPERATIONS is required", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["OPERATIONS"])
    expect(guard.canActivate(mockContext({ userType: "STAFF", staffRole: "OPERATIONS" }))).toBe(true)
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
      guard.canActivate(mockContext({ userType: "STAFF", staffRole: "OPERATIONS" })),
    ).toThrow(ForbiddenException)
  })

  it("throws when user is null", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["SUPER_ADMIN"])
    expect(() => guard.canActivate(mockContext(null))).toThrow(ForbiddenException)
  })

  it("throws when user is undefined", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["SUPER_ADMIN"])
    expect(() => guard.canActivate(mockContext(undefined))).toThrow(ForbiddenException)
  })
})
