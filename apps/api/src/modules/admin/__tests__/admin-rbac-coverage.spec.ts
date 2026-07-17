import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants"
import { Reflector } from "@nestjs/core"
import { STAFF_ROLES_KEY } from "../../../common/decorators/staff-roles.decorator"
import { AdminController } from "../admin.controller"

// Phase 6.7 — Audit finding #2 + V-1 closure.
//
// This is a metadata-only test: it reflects over AdminController's prototype
// and asserts that EVERY HTTP route handler declares its own @StaffRoles
// authorization metadata. The fail-closed StaffRolesGuard refuses routes
// without metadata at runtime, but catching it at test time means a regression
// PR can't merge in the first place.
//
// Why this matters: NestJS's Reflector + getAllAndOverride pattern silently
// inherits class-level decorators. Before this audit, AdminController had a
// class-level @StaffRoles("SUPER_ADMIN", "OPERATIONS", "FINANCE") that meant
// any handler missing its own decorator was wide open to all three staff
// roles, defeating per-route narrowing for the handlers that didn't
// override. The class-level grant is gone (the controller relies on
// per-handler declarations only) and this test guards the contract.

const _reflector = new Reflector()

function getRouteHandlers(
  controllerClass: any,
): Array<{ name: string; httpMethod: string; path: string }> {
  const prototype = controllerClass.prototype
  const methodNames = Object.getOwnPropertyNames(prototype).filter(
    (name) => name !== "constructor" && typeof prototype[name] === "function",
  )

  const handlers: Array<{ name: string; httpMethod: string; path: string }> = []
  for (const name of methodNames) {
    const path = Reflect.getMetadata(PATH_METADATA, prototype[name])
    const method = Reflect.getMetadata(METHOD_METADATA, prototype[name])
    if (path !== undefined && method !== undefined) {
      // Nest maps RequestMethod enum integers to verbs. Stringify for the
      // failure message.
      const verb =
        [
          "GET",
          "POST",
          "HEAD",
          "DELETE",
          "PUT",
          "PATCH",
          "OPTIONS",
          "ALL",
          "SEARCH",
        ][method] ?? `?(${method})`
      handlers.push({
        name,
        httpMethod: verb,
        path: typeof path === "string" ? path : String(path),
      })
    }
  }
  return handlers
}

describe("AdminController — Phase 6.7 RBAC coverage", () => {
  const handlers = getRouteHandlers(AdminController)

  it("AdminController is discoverable + has at least 30 handlers (sanity check)", () => {
    // The controller has ~60 handlers as of Phase 6.7. If this drops below 30
    // the reflection probably broke (e.g., a metadata key change). Catch
    // that regression early rather than silently passing an empty matrix.
    expect(handlers.length).toBeGreaterThanOrEqual(30)
  })

  it("every AdminController route declares its own @StaffRoles (no class-level inheritance fallback)", () => {
    const violations: string[] = []

    for (const h of handlers) {
      // We deliberately read HANDLER-level metadata only here — not
      // class-level. The audit finding was that class-level inheritance
      // silently widened access for handlers that forgot their own
      // decorator. Per-handler explicit declaration is the contract this
      // test enforces.
      const prototype = AdminController.prototype as any
      const roles = Reflect.getMetadata(STAFF_ROLES_KEY, prototype[h.name])

      if (!roles || !Array.isArray(roles) || roles.length === 0) {
        violations.push(
          `  ${h.httpMethod} /admin/${h.path}  →  ${h.name}() is missing @StaffRoles(...)`,
        )
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `\nFound ${violations.length} AdminController route(s) without per-handler @StaffRoles:\n` +
          violations.join("\n") +
          `\n\nAdd @StaffRoles("SUPER_ADMIN", ...) to each handler. The fail-closed ` +
          `StaffRolesGuard will refuse these routes at runtime, but this test catches ` +
          `the regression before deploy. See apps/api/src/modules/admin/admin.controller.ts ` +
          `header comment for the role-allocation guide.`,
      )
    }

    expect(violations).toEqual([])
  })

  it("every AdminController route's @StaffRoles is a subset of {SUPER_ADMIN, OPERATIONS, FINANCE}", () => {
    const valid = new Set(["SUPER_ADMIN", "OPERATIONS", "FINANCE"])
    const violations: string[] = []

    for (const h of handlers) {
      const prototype = AdminController.prototype as any
      const roles =
        (Reflect.getMetadata(STAFF_ROLES_KEY, prototype[h.name]) as string[]) ??
        []
      const bad = roles.filter((r) => !valid.has(r))
      if (bad.length > 0) {
        violations.push(
          `  ${h.name}() declares unknown role(s): ${bad.join(", ")}`,
        )
      }
    }

    expect(violations).toEqual([])
  })

  it("every destructive override is SUPER_ADMIN-only (force-cancel, force-approve, staff-role, user-role, audit-logs, listing-delete)", () => {
    const expectations: Array<{ method: string; expected: string[] }> = [
      { method: "forceCancelOrder", expected: ["SUPER_ADMIN"] },
      { method: "forceApproveSettlement", expected: ["SUPER_ADMIN"] },
      { method: "updateUserRole", expected: ["SUPER_ADMIN"] },
      { method: "updateStaffRole", expected: ["SUPER_ADMIN"] },
      { method: "createStaff", expected: ["SUPER_ADMIN"] },
      { method: "staffPerformance", expected: ["SUPER_ADMIN"] },
      { method: "deleteListing", expected: ["SUPER_ADMIN"] },
      { method: "deleteWebsite", expected: ["SUPER_ADMIN"] },
      { method: "listAuditLogs", expected: ["SUPER_ADMIN"] },
      // Site reassignment is a SUPER_ADMIN-only trust action: OPERATIONS can
      // manage listings on sites already assigned to them, but transferring
      // ownership of a platform website is reserved for SUPER_ADMIN (see the
      // assignWebsite decorator + header comment in admin.controller.ts).
      { method: "assignWebsite", expected: ["SUPER_ADMIN"] },
    ]

    for (const { method, expected } of expectations) {
      const handler = (AdminController.prototype as any)[method]
      if (!handler) continue // Method may have been renamed; coverage caught by the universal test above.
      const roles =
        (Reflect.getMetadata(STAFF_ROLES_KEY, handler) as string[]) ?? []
      expect([method, [...roles].sort()]).toEqual([
        method,
        [...expected].sort(),
      ])
    }
  })

  it("every money-write route includes FINANCE (refund, settlement approve/cancel, withdrawal lifecycle, payout execute/retry/cancel/decrypt, platform fee)", () => {
    const moneyWrites = [
      "refundOrder",
      "adminApproveSettlement",
      "cancelSettlement",
      "approveWithdrawal",
      "markWithdrawalPaid",
      "rejectWithdrawal",
      "reverseWithdrawal",
      "executeWithdrawal",
      "retryPayoutExecution",
      "cancelPayoutExecution",
      "decryptPayoutMethod",
      "updatePublisherTier",
      "updatePlatformFee",
    ]

    for (const method of moneyWrites) {
      const handler = (AdminController.prototype as any)[method]
      if (!handler) continue
      const roles =
        (Reflect.getMetadata(STAFF_ROLES_KEY, handler) as string[]) ?? []
      expect([method, roles.includes("FINANCE")]).toEqual([method, true])
    }
  })

  it("every operational workflow route includes OPERATIONS (manual verify, fulfillment, listing status moderation, disputes, verification queue)", () => {
    const opsWrites = [
      "manualVerify",
      "acceptPlatformOrder",
      "submitPlatformContent",
      "submitPlatformContentForReview",
      "markPlatformContentReady",
      "submitPlatformForReview",
      "markPlatformPublished",
      "reviewDispute",
      "resolveDispute",
      "updateListingStatus",
      "recomputePublisherTrust",
      "recomputeTrust",
      "bulkRetryVerification",
      "listVerificationQueue",
      "retryVerification",
      "markVerified",
      "rejectVerification",
      "requestReverify",
    ]

    for (const method of opsWrites) {
      const handler = (AdminController.prototype as any)[method]
      if (!handler) continue
      const roles =
        (Reflect.getMetadata(STAFF_ROLES_KEY, handler) as string[]) ?? []
      expect([method, roles.includes("OPERATIONS")]).toEqual([method, true])
    }
  })

  it("allows Operations to edit platform listing services", () => {
    const platformServiceWrites = [
      "addPlatformListingService",
      "updatePlatformListingService",
      "pausePlatformListingService",
    ]
    for (const method of platformServiceWrites) {
      const handler = (AdminController.prototype as any)[method]
      const roles =
        (Reflect.getMetadata(STAFF_ROLES_KEY, handler) as string[]) ?? []
      expect([method, roles]).toEqual([method, ["SUPER_ADMIN", "OPERATIONS"]])
    }
  })

  it("lets Operations create an auto-assigned platform website", () => {
    const handler = (AdminController.prototype as any).createWebsite
    const roles =
      (Reflect.getMetadata(STAFF_ROLES_KEY, handler) as string[]) ?? []
    expect(roles).toEqual(["SUPER_ADMIN", "OPERATIONS"])
  })

  it("keeps other marketplace and platform-website inventory edits SUPER_ADMIN-only", () => {
    const inventoryWrites = [
      "toggleListingFeatured",
      "toggleListingVerified",
      "deleteListing",
      "updateWebsite",
      "pauseWebsite",
      "deleteWebsite",
      "assignWebsite",
    ]

    for (const method of inventoryWrites) {
      const handler = (AdminController.prototype as any)[method]
      const roles =
        (Reflect.getMetadata(STAFF_ROLES_KEY, handler) as string[]) ?? []
      expect([method, roles]).toEqual([method, ["SUPER_ADMIN"]])
    }
  })

  it("global user and organization directories are SUPER_ADMIN-only", () => {
    const superAdminOnly = [
      "listUsers",
      "getUser",
      "createStaff",
      "staffPerformance",
      "listOrganizations",
      "listOpsStaff",
    ]

    for (const method of superAdminOnly) {
      const handler = (AdminController.prototype as any)[method]
      const roles =
        (Reflect.getMetadata(STAFF_ROLES_KEY, handler) as string[]) ?? []
      expect([method, roles]).toEqual([method, ["SUPER_ADMIN"]])
    }
  })

  it("publisher directory is available to Finance but not Operations", () => {
    const handler = (AdminController.prototype as any).listPublishers
    const roles = (
      (Reflect.getMetadata(STAFF_ROLES_KEY, handler) as string[]) ?? []
    ).sort()
    expect(roles).toEqual(["FINANCE", "SUPER_ADMIN"])
  })

  it("inventory reads are available to Operations but not Finance", () => {
    for (const method of [
      "listWebsites",
      "getWebsite",
      "listMarketplaceListings",
      "getMarketplaceStats",
      "getListingForStaff",
    ]) {
      const handler = (AdminController.prototype as any)[method]
      const roles = (
        (Reflect.getMetadata(STAFF_ROLES_KEY, handler) as string[]) ?? []
      ).sort()
      expect([method, roles]).toEqual([method, ["OPERATIONS", "SUPER_ADMIN"]])
    }
  })

  it("shared contextual reads include all three staff roles", () => {
    const universalReads = [
      "listOrders",
      "listSupportTickets",
      "getSupportTicket",
      "getPlatformSettings",
    ]

    for (const method of universalReads) {
      const handler = (AdminController.prototype as any)[method]
      if (!handler) continue
      const roles = (
        (Reflect.getMetadata(STAFF_ROLES_KEY, handler) as string[]) ?? []
      ).sort()
      expect([method, roles]).toEqual([
        method,
        ["FINANCE", "OPERATIONS", "SUPER_ADMIN"],
      ])
    }
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Fail-closed guard contract — sanity check that the guard itself refuses
// routes with empty/missing metadata. Importing the real class so a change
// to the fail-open vs fail-closed behavior surfaces immediately.

import { ForbiddenException } from "@nestjs/common"
import { StaffRolesGuard } from "../../../common/guards/staff-roles.guard"

describe("StaffRolesGuard — fail-closed contract", () => {
  function makeCtx(_metadata: string[] | undefined, user: any) {
    return {
      getHandler: () => (() => {}) as any,
      getClass: () => class {} as any,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as any
  }

  it("refuses a route with no @StaffRoles metadata (fail-closed)", () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(undefined),
    } as unknown as Reflector
    const guard = new StaffRolesGuard(reflector)
    expect(() =>
      guard.canActivate(
        makeCtx(undefined, { userType: "STAFF", staffRole: "SUPER_ADMIN" }),
      ),
    ).toThrow(ForbiddenException)
  })

  it("refuses a route with empty @StaffRoles array (also fail-closed)", () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue([]),
    } as unknown as Reflector
    const guard = new StaffRolesGuard(reflector)
    expect(() =>
      guard.canActivate(
        makeCtx([], { userType: "STAFF", staffRole: "SUPER_ADMIN" }),
      ),
    ).toThrow(ForbiddenException)
  })

  it("refuses a non-STAFF user even when role declared", () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(["SUPER_ADMIN"]),
    } as unknown as Reflector
    const guard = new StaffRolesGuard(reflector)
    expect(() =>
      guard.canActivate(makeCtx(["SUPER_ADMIN"], { userType: "CUSTOMER" })),
    ).toThrow(ForbiddenException)
  })

  it("refuses a STAFF user whose role is not in the allowlist", () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(["SUPER_ADMIN"]),
    } as unknown as Reflector
    const guard = new StaffRolesGuard(reflector)
    expect(() =>
      guard.canActivate(
        makeCtx(["SUPER_ADMIN"], { userType: "STAFF", staffRole: "FINANCE" }),
      ),
    ).toThrow(ForbiddenException)
  })

  it("allows a STAFF user whose role is in the allowlist", () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(["SUPER_ADMIN", "FINANCE"]),
    } as unknown as Reflector
    const guard = new StaffRolesGuard(reflector)
    expect(
      guard.canActivate(
        makeCtx(["SUPER_ADMIN", "FINANCE"], {
          userType: "STAFF",
          staffRole: "FINANCE",
        }),
      ),
    ).toBe(true)
  })
})
