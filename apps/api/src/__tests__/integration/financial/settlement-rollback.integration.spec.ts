import { OrderStatus, SettlementStatus } from "@guestpost/database"
import { BadRequestException } from "@nestjs/common"
import {
  expectFinancialState,
  setupFinancialTest,
} from "../factories/financial-fixture"
import { createTestApp } from "../helpers/create-test-app"

describe("[INTEGRATION] Financial — settlement transaction rollback", () => {
  it("duplicate createSettlement does not create orphan state", async () => {
    const { app, prisma, cleanup } = await createTestApp()
    try {
      const ctx = await setupFinancialTest(prisma, { orderAmount: 100 })

      const { SettlementsService } =
        require("../../../modules/settlements/settlements.service") as any
      const settlements: any = app.get(SettlementsService)

      // First call succeeds
      const settlement = await settlements.createSettlement(
        ctx.order.id,
        ctx.organization.id,
        ctx.customer.user.id,
      )
      expect(settlement.status).toBe(SettlementStatus.PENDING)

      // Second call for the same order — should fail
      const promise = settlements.createSettlement(
        ctx.order.id,
        ctx.organization.id,
        ctx.customer.user.id,
      )
      await expect(promise).rejects.toThrow(BadRequestException)
      await expect(promise).rejects.toMatchObject({
        message: expect.stringContaining("Settlement already exists"),
      })

      // Assert: exactly 1 settlement, no duplicate, no orphan state
      const settlementCount = await prisma.settlement.count({
        where: { orderId: ctx.order.id, status: { not: "CANCELLED" } },
      })
      expect(settlementCount).toBe(1)

      // Wallet and publisher balance unchanged (no release happened)
      await expectFinancialState(ctx, {
        settlementId: settlement.id,
        settlementStatus: SettlementStatus.PENDING,
        orderStatus: OrderStatus.DELIVERED,
        walletAvailableBalance: 100,
        publisherWithdrawableBalance: 0,
        transactionCount: 1,
        transactionSum: 100,
      })
    } finally {
      await cleanup()
    }
  }, 30_000)

  it("createSettlement on non-DELIVERED order rolls back cleanly", async () => {
    const { app, prisma, cleanup } = await createTestApp()
    try {
      const ctx = await setupFinancialTest(prisma, {
        orderAmount: 100,
        orderStatus: "PAID",
      })
      expect(ctx.order.status).toBe(OrderStatus.PAID)

      const { SettlementsService } =
        require("../../../modules/settlements/settlements.service") as any
      const settlements: any = app.get(SettlementsService)

      // Not DELIVERED — early check in createSettlement
      const promise = settlements.createSettlement(
        ctx.order.id,
        ctx.organization.id,
        ctx.customer.user.id,
      )
      await expect(promise).rejects.toThrow(BadRequestException)

      // No state leakage
      const settlementCount = await prisma.settlement.count({
        where: { orderId: ctx.order.id },
      })
      expect(settlementCount).toBe(0)

      await expectFinancialState(ctx, {
        orderStatus: OrderStatus.PAID,
        walletAvailableBalance: 100,
        transactionCount: 1,
        transactionSum: 100,
      })
    } finally {
      await cleanup()
    }
  }, 30_000)
})
