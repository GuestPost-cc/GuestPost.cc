import { ForbiddenException } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { StaffRolesGuard } from "../staff-roles.guard"

describe("StaffRolesGuard", () => {
  let guard: StaffRolesGuard
  let reflector: Reflector
  let prisma: any

  beforeEach(() => {
    reflector = new Reflector()
    prisma = {
      staffMembership: { findUnique: jest.fn() },
    }
    guard = new StaffRolesGuard(reflector, prisma)
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
  it("DENIES access when no @StaffRoles metadata is declared (fail-closed)", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(undefined)
    await expect(
      guard.canActivate(
        mockContext({ userType: "STAFF", staffRole: "SUPER_ADMIN" }),
      ),
    ).rejects.toThrow(ForbiddenException)
  })

  it("DENIES access when an empty roles array is declared (fail-closed)", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue([])
    await expect(
      guard.canActivate(
        mockContext({ userType: "STAFF", staffRole: "SUPER_ADMIN" }),
      ),
    ).rejects.toThrow(ForbiddenException)
  })

  it("allows SUPER_ADMIN access from the durable membership", async () => {
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

  it("allows FINANCE access when FINANCE is required", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["FINANCE"])
    prisma.staffMembership.findUnique.mockResolvedValue({
      role: "FINANCE",
      user: { banned: false, userType: "STAFF" },
    })
    await expect(
      guard.canActivate(mockContext({ id: "staff-1", userType: "STAFF" })),
    ).resolves.toBe(true)
  })

  it("allows OPERATIONS access when OPERATIONS is required", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["OPERATIONS"])
    prisma.staffMembership.findUnique.mockResolvedValue({
      role: "OPERATIONS",
      user: { banned: false, userType: "STAFF" },
    })
    await expect(
      guard.canActivate(mockContext({ id: "staff-1", userType: "STAFF" })),
    ).resolves.toBe(true)
  })

  it("denies CUSTOMER user", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["SUPER_ADMIN"])
    await expect(
      guard.canActivate(mockContext({ userType: "CUSTOMER" })),
    ).rejects.toThrow(ForbiddenException)
  })

  it("denies user with no durable staff membership", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["SUPER_ADMIN"])
    prisma.staffMembership.findUnique.mockResolvedValue(null)
    await expect(
      guard.canActivate(
        mockContext({
          id: "staff-1",
          userType: "STAFF",
          staffRole: "SUPER_ADMIN",
        }),
      ),
    ).rejects.toThrow(ForbiddenException)
  })

  it("denies a stale cached SUPER_ADMIN after durable demotion", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["SUPER_ADMIN"])
    prisma.staffMembership.findUnique.mockResolvedValue({
      role: "OPERATIONS",
      user: { banned: false, userType: "STAFF" },
    })
    await expect(
      guard.canActivate(
        mockContext({
          id: "staff-1",
          userType: "STAFF",
          staffRole: "SUPER_ADMIN",
        }),
      ),
    ).rejects.toThrow(ForbiddenException)
  })

  it("denies a stale cached role after the durable user is banned", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["SUPER_ADMIN"])
    prisma.staffMembership.findUnique.mockResolvedValue({
      role: "SUPER_ADMIN",
      user: { banned: true, userType: "STAFF" },
    })

    await expect(
      guard.canActivate(
        mockContext({
          id: "staff-1",
          userType: "STAFF",
          staffRole: "SUPER_ADMIN",
        }),
      ),
    ).rejects.toThrow(ForbiddenException)
  })

  it("denies a stale STAFF projection after the durable user type changes", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["SUPER_ADMIN"])
    prisma.staffMembership.findUnique.mockResolvedValue({
      role: "SUPER_ADMIN",
      user: { banned: false, userType: "CUSTOMER" },
    })

    await expect(
      guard.canActivate(
        mockContext({
          id: "staff-1",
          userType: "STAFF",
          staffRole: "SUPER_ADMIN",
        }),
      ),
    ).rejects.toThrow(ForbiddenException)
  })

  it("throws when user is null", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["SUPER_ADMIN"])
    await expect(guard.canActivate(mockContext(null))).rejects.toThrow(
      ForbiddenException,
    )
  })

  it("throws when user is undefined", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["SUPER_ADMIN"])
    await expect(guard.canActivate(mockContext(undefined))).rejects.toThrow(
      ForbiddenException,
    )
  })
})
