import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants"
import { Reflector } from "@nestjs/core"
import { STAFF_ROLES_KEY } from "../../../common/decorators/staff-roles.decorator"
import { DeliveriesController } from "../deliveries.controller"

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

describe("DeliveriesController — RBAC coverage", () => {
  const handlers = getRouteHandlers(DeliveriesController)

  it("DeliveriesController has at least 15 handlers (sanity check)", () => {
    expect(handlers.length).toBeGreaterThanOrEqual(15)
  })

  it("every route declares its own @StaffRoles (no class-level inheritance fallback)", () => {
    const violations: string[] = []

    for (const h of handlers) {
      const prototype = DeliveriesController.prototype as any
      const roles = Reflect.getMetadata(STAFF_ROLES_KEY, prototype[h.name])

      if (!roles || !Array.isArray(roles) || roles.length === 0) {
        violations.push(
          `  ${h.httpMethod} ${h.path}  →  ${h.name}() is missing @StaffRoles(...)`,
        )
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `\nFound ${violations.length} DeliveriesController route(s) without per-handler @StaffRoles:\n` +
          violations.join("\n") +
          `\n\nAdd @StaffRoles("SUPER_ADMIN", ...) to each handler. The fail-closed ` +
          `StaffRolesGuard will refuse these routes at runtime, but this test catches ` +
          `the regression before deploy.`,
      )
    }

    expect(violations).toEqual([])
  })

  it("every route's @StaffRoles is a subset of {SUPER_ADMIN, OPERATIONS, FINANCE}", () => {
    const valid = new Set(["SUPER_ADMIN", "OPERATIONS", "FINANCE"])
    const violations: string[] = []

    for (const h of handlers) {
      const prototype = DeliveriesController.prototype as any
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

  it("read endpoints include all three staff roles", () => {
    const reads = [
      "listDeliveries",
      "getDelivery",
      "evidence",
      "snapshots",
      "audit",
      "disputeEvidence",
    ]

    for (const method of reads) {
      const handler = (DeliveriesController.prototype as any)[method]
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

  it("mutation endpoints exclude FINANCE (approve, reject, override)", () => {
    const mutations = ["manualApprove", "manualReject", "override"]

    for (const method of mutations) {
      const handler = (DeliveriesController.prototype as any)[method]
      if (!handler) continue
      const roles =
        (Reflect.getMetadata(STAFF_ROLES_KEY, handler) as string[]) ?? []
      expect([method, roles.includes("FINANCE")]).toEqual([method, false])
    }
  })

  it("self-service fulfillment endpoints include SUPER_ADMIN and OPERATIONS", () => {
    const fulfillmentEndpoints = [
      "fulfillmentQueue",
      "operationsInbox",
      "operationsOrder",
      "claim",
      "submitPlatformDelivery",
      "reverify",
    ]

    for (const method of fulfillmentEndpoints) {
      const handler = (DeliveriesController.prototype as any)[method]
      if (!handler) continue
      const roles = (
        (Reflect.getMetadata(STAFF_ROLES_KEY, handler) as string[]) ?? []
      ).sort()
      expect([method, roles]).toEqual([method, ["OPERATIONS", "SUPER_ADMIN"]])
    }
  })

  it("cross-staff assignment and reassignment are SUPER_ADMIN-only", () => {
    for (const method of ["assign", "reassign"]) {
      const handler = (DeliveriesController.prototype as any)[method]
      const roles =
        (Reflect.getMetadata(STAFF_ROLES_KEY, handler) as string[]) ?? []
      expect([method, roles]).toEqual([method, ["SUPER_ADMIN"]])
    }
  })
})
