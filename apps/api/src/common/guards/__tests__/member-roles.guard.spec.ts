import { ForbiddenException } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { MemberRolesGuard } from "../member-roles.guard"
import { MEMBER_ROLES_KEY } from "../../decorators/member-roles.decorator"

describe("MemberRolesGuard", () => {
  let guard: MemberRolesGuard
  let reflector: Reflector

  beforeEach(() => {
    reflector = new Reflector()
    guard = new MemberRolesGuard(reflector)
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
    expect(
      guard.canActivate(mockContext({ userType: "CUSTOMER", customerRole: "OWNER" })),
    ).toBe(true)
  })

  it("allows CUSTOMER with OWNER role", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["OWNER"])
    expect(
      guard.canActivate(mockContext({ userType: "CUSTOMER", customerRole: "OWNER" })),
    ).toBe(true)
  })

  it("allows CUSTOMER with MEMBER role", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["OWNER", "MEMBER"])
    expect(
      guard.canActivate(mockContext({ userType: "CUSTOMER", customerRole: "MEMBER" })),
    ).toBe(true)
  })

  it("allows PUBLISHER with PUBLISHER_OWNER role", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["PUBLISHER_OWNER"])
    expect(
      guard.canActivate(mockContext({ userType: "PUBLISHER", publisherRole: "PUBLISHER_OWNER" })),
    ).toBe(true)
  })

  it("allows STAFF with staffRole", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["SUPER_ADMIN"])
    expect(
      guard.canActivate(mockContext({ userType: "STAFF", staffRole: "SUPER_ADMIN" })),
    ).toBe(true)
  })

  it("denies CUSTOMER with MEMBER when OWNER required", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["OWNER"])
    expect(() =>
      guard.canActivate(mockContext({ userType: "CUSTOMER", customerRole: "MEMBER" })),
    ).toThrow(ForbiddenException)
  })

  it("throws when user is null", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["OWNER"])
    expect(() => guard.canActivate(mockContext(null))).toThrow(ForbiddenException)
  })

  it("throws when user is undefined", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["OWNER"])
    expect(() => guard.canActivate(mockContext(undefined))).toThrow(ForbiddenException)
  })

  it("throws when user has no role for their userType", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["OWNER"])
    expect(() =>
      guard.canActivate(mockContext({ userType: "CUSTOMER", customerRole: null })),
    ).toThrow(ForbiddenException)
  })
})
