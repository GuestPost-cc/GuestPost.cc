import { OrderStatus, SettlementStatus } from "@guestpost/database"
import {
  expectFinancialState,
  setupFinancialTest,
} from "../factories/financial-fixture"
import { createTestApp } from "../helpers/create-test-app"

describe("[INTEGRATION] Financial — deposit → settle → release happy path", () => {
  it("completes the full settlement lifecycle via service calls", async () => {
    const { app, prisma, cleanup } = await createTestApp()
    try {
      const ctx = await setupFinancialTest(prisma, { orderAmount: 100 })

      const { SettlementsService } =
        require("../../../modules/settlements/settlements.service") as any
      const settlements: any = app.get(SettlementsService)

      // Act 1: createSettlement
      const settlement = await settlements.createSettlement(
        ctx.order.id,
        ctx.organization.id,
        ctx.customer.user.id,
      )
      expect(settlement.status).toBe(SettlementStatus.PENDING)
      expect(Number(settlement.grossAmount)).toBe(100)
      expect(Number(settlement.platformFee)).toBe(20)
      expect(Number(settlement.publisherAmount)).toBe(80)

      // Act 2: customer approve
      const customerApproved = await settlements.customerApprove(
        settlement.id,
        ctx.customer.user.id,
        ctx.organization.id,
        "OWNER",
        "OWNER",
      )
      expect(customerApproved.status).toBe(SettlementStatus.CUSTOMER_APPROVED)

      // Act 3: admin approve → releaseFundsInternal
      const released = await settlements.adminApprove(
        settlement.id,
        "Happy path test approval",
        ctx.customer.user.id,
        "SUPER_ADMIN",
      )
      expect(released.status).toBe(SettlementStatus.RELEASED)

      // Assert: financial state invariants
      await expectFinancialState(ctx, {
        settlementId: settlement.id,
        settlementStatus: SettlementStatus.RELEASED,
        orderStatus: OrderStatus.COMPLETED,
        publisherWithdrawableBalance: 80,
        publisherLifetimeEarnings: 80,
        publisherPendingBalance: 0,
        walletAvailableBalance: 100,
        transactionCount: 2,
        transactionSum: 180,
      })
    } finally {
      await cleanup()
    }
  }, 30_000)
})
