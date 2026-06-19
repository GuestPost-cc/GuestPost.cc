/**
 * Phase 7.12 #18 — Auto-assignment actor correctness.
 *
 * Previously: orders.service.ts:291 wrote `assignedByUserId: userId` (the
 * customer who created the order) on the auto-created FulfillmentAssignment.
 * That made audit reads say "customer assigned the order to Ops" — which is
 * a lie. The system did the assignment.
 *
 * Fix: assignedByUserId = snapshot.managedByUserId (self-assignment).
 * The `auto: true` metadata flag on the OrderEvent already disambiguates
 * this from a manual human claim, so audit-log readers can still tell
 * system vs. human apart.
 *
 * Static-source assertions — same approach as the #24 spec. Deeper "create
 * order, query FulfillmentAssignment row" coverage belongs in Phase 7.10.2's
 * future Nest+supertest harness.
 */
import { readFileSync } from "fs"
import { join } from "path"

describe("Phase 7.12 #18 — Auto-assignment actor correctness", () => {
  const ordersServicePath = join(__dirname, "..", "modules", "orders", "orders.service.ts")
  const ordersServiceSource = readFileSync(ordersServicePath, "utf-8")

  // Narrow to the autoAssignedToUserId block — the one inside the PLATFORM
  // + managedByUserId conditional at line 282-296. Other manual-claim
  // call sites legitimately write the human claimer's userId.
  const autoAssignBlock = (() => {
    const startIdx = ordersServiceSource.indexOf("autoAssignedToUserId")
    expect(startIdx).toBeGreaterThan(-1)
    // The conditional block + comments + the closing `autoAssignedToUserId =`
    // assignment spans ~18-25 lines (~1500 chars with long comment lines).
    // Take 2000 chars for headroom.
    return ordersServiceSource.slice(startIdx, startIdx + 2000)
  })()

  describe("auto-assignment writes the staffer (self), not the customer", () => {
    it("assignedByUserId is snapshot.managedByUserId (self-assignment)", () => {
      expect(autoAssignBlock).toMatch(
        /assignedByUserId:\s*snapshot\.managedByUserId/,
      )
    })

    it("does NOT write `assignedByUserId: userId` (the legacy buggy form)", () => {
      // Regression guard — the exact line that was the bug. The auto-block
      // can't contain a write of the customer's userId to assignedByUserId.
      expect(autoAssignBlock).not.toMatch(
        /assignedByUserId:\s*userId\b/,
      )
    })
  })

  describe("OrderEvent metadata still carries auto: true (disambiguator)", () => {
    it("the OrderEvent block following the auto-assignment includes the auto flag", () => {
      // Search the larger ORDER_CREATED OrderEvent block for the auto
      // disambiguator. This protects against a future refactor that drops
      // the flag — without it, audit readers can't distinguish system from
      // human assignments.
      const orderCreatedIdx = ordersServiceSource.indexOf("ORDER_CREATED")
      expect(orderCreatedIdx).toBeGreaterThan(-1)
      const eventBlock = ordersServiceSource.slice(orderCreatedIdx, orderCreatedIdx + 1500)
      expect(eventBlock).toMatch(/auto:\s*(true|autoAssignedToUserId)/)
    })
  })
})
