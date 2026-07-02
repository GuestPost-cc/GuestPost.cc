import { OrderStatus } from "@guestpost/database"
import { BadRequestException } from "@nestjs/common"
import {
  expectFinancialState,
  setupFinancialTest,
} from "../factories/financial-fixture"
import { createTestApp } from "../helpers/create-test-app"

describe("[INTEGRATION] Financial — cancellation before settlement", () => {
  it("createSettlement throws when order is CANCELLED", async () => {
    const { app, prisma, cleanup } = await createTestApp()
    try {
      // Fixture creates a CANCELLED order (no delivery version linked as active)
      const ctx = await setupFinancialTest(prisma, {
        orderAmount: 100,
        orderStatus: "CANCELLED",
      })
      expect(ctx.order.status).toBe(OrderStatus.CANCELLED)

      const { SettlementsService } =
        require("../../../modules/settlements/settlements.service") as any
      const settlements: any = app.get(SettlementsService)

      // Act: try settlement on a cancelled order
      const promise = settlements.createSettlement(
        ctx.order.id,
        ctx.organization.id,
        ctx.customer.user.id,
      )

      // Assert: throws because order.status !== "DELIVERED"
      await expect(promise).rejects.toThrow(BadRequestException)
      await expect(promise).rejects.toMatchObject({
        message: expect.stringContaining("Order must be DELIVERED"),
      })

      // Assert: no orphan settlement or transaction
      const settlementCount = await prisma.settlement.count({
        where: { orderId: ctx.order.id },
      })
      expect(settlementCount).toBe(0)

      await expectFinancialState(ctx, {
        orderStatus: OrderStatus.CANCELLED,
        walletAvailableBalance: 100,
        transactionCount: 1,
        transactionSum: 100,
      })
    } finally {
      await cleanup()
    }
  }, 30_000)
})
