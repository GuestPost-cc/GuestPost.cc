/**
 * Phase 7.10.2 Spec 1 — Phase 7.14 #23 FulfillmentAssignment claim race
 * (INTEGRATION).
 *
 * Closes the documented gap in apps/api/src/__tests__/phase-7-14-fulfillment-
 * claim-race.spec.ts:24-26: "deep '5-caller real Promise.allSettled race'
 * integration belongs in the manual-smoke step or the future Phase 7.10.2
 * Nest+supertest harness — not jest." Now it ships as a real automated test.
 *
 * Bypasses the HTTP layer entirely — calls OrderFulfillmentAssignmentService
 * .claim(orderId, userId) directly via app.get(Service). No TestAuthGuard
 * needed for this spec (HTTP-layer integration ships in Phase 7.10.2.1
 * fast-follow alongside auth-forgery).
 *
 * Timing budget targets (recorded actuals in PR body):
 *   Clone:    ≤500ms (Phase 7.14/7.13.x verification showed ~200-400ms locally)
 *   Boot:     ≤2s    (Gate 0.25 measured 1999ms for AppModule compile)
 *   Seed:     ≤500ms (5 user inserts + 1 org + 1 site + 1 order)
 *   Teardown: ≤500ms (app.close + prisma.$disconnect + DROP DATABASE)
 *   Total:    ≤3.5s per test
 */
import { ConflictException } from "@nestjs/common"
import {
  makeOrder,
  makeOrganization,
  makeUser,
  makeWebsite,
} from "../factories"
import { createTestApp } from "../helpers/create-test-app"

describe("[INTEGRATION] Phase 7.14 #23 — FulfillmentAssignment claim race", () => {
  it("5 concurrent claim() calls on the same order: exactly 1 succeeds, 4 reject with ConflictException", async () => {
    // ── 1. Boot harness ──
    console.time("[claim-race] boot")
    const { app, prisma, dbName, cleanup } = await createTestApp()
    console.timeEnd("[claim-race] boot")
    console.log(`[claim-race] dbName: ${dbName}`)

    try {
      // ── 2. Seed minimum FK chain ──
      console.time("[claim-race] seed")
      const org = await makeOrganization(prisma)
      const customer = await makeUser(prisma)
      const website = await makeWebsite(prisma, { ownershipType: "PLATFORM" })
      const order = await makeOrder(prisma, {
        organizationId: org.id,
        customerId: customer.id,
        websiteId: website.id,
        fulfillmentChannel: "PLATFORM",
        status: "APPROVED",
      })
      const opUsers = await Promise.all([
        makeUser(prisma, { userType: "STAFF" }),
        makeUser(prisma, { userType: "STAFF" }),
        makeUser(prisma, { userType: "STAFF" }),
        makeUser(prisma, { userType: "STAFF" }),
        makeUser(prisma, { userType: "STAFF" }),
      ])
      console.timeEnd("[claim-race] seed")

      // ── 3. Fire 5 concurrent claim() calls via the service directly ──
      // Use a late require to avoid eager-importing the service at module-load
      // time (which would compete with createTestApp's deferred-import dance).
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const {
        OrderFulfillmentAssignmentService,
      } = require("../../../modules/orders/services/order-fulfillment-assignment.service")
      const service = app.get(OrderFulfillmentAssignmentService) as any

      console.time("[claim-race] concurrent-claims")
      const results = await Promise.allSettled(
        opUsers.map((u) => service.claim(order.id, u.id)),
      )
      console.timeEnd("[claim-race] concurrent-claims")

      // ── 4. Assertions — exactly 1 fulfilled + 4 rejected with ConflictException ──
      const fulfilled = results.filter((r) => r.status === "fulfilled")
      const rejected = results.filter(
        (r) => r.status === "rejected",
      ) as PromiseRejectedResult[]

      console.log(
        `[claim-race] results: ${fulfilled.length} fulfilled, ${rejected.length} rejected`,
      )
      if (rejected.length > 0) {
        console.log(
          `[claim-race] first rejection: ${rejected[0].reason?.message}`,
        )
      }

      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(4)
      rejected.forEach((r, _i) => {
        expect(r.reason).toBeInstanceOf(ConflictException)
        expect(r.reason.message).toBe("Order is already assigned")
      })

      // ── 5. Steady-state check: exactly 1 ASSIGNED row for this orderId ──
      const activeCount = await prisma.fulfillmentAssignment.count({
        where: {
          orderId: order.id,
          status: { in: ["ASSIGNED", "IN_PROGRESS"] },
        },
      })
      expect(activeCount).toBe(1)
      console.log(`[claim-race] activeCount: ${activeCount} (expect 1)`)
    } finally {
      console.time("[claim-race] teardown")
      await cleanup()
      console.timeEnd("[claim-race] teardown")
    }
  }, 30_000)
})
