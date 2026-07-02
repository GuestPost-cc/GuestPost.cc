import { SettlementStatus } from "@guestpost/database"
import { BadRequestException } from "@nestjs/common"
import {
  expectFinancialState,
  setupFinancialTest,
} from "../factories/financial-fixture"
import { createTestApp } from "../helpers/create-test-app"

describe("[INTEGRATION] Financial — concurrent settlement creation", () => {
  it("5 concurrent createSettlement calls: exactly 1 succeeds, 4 fail", async () => {
    const { app, prisma, cleanup } = await createTestApp()
    try {
      const ctx = await setupFinancialTest(prisma, { orderAmount: 100 })

      const { SettlementsService } =
        require("../../../modules/settlements/settlements.service") as any
      const settlements: any = app.get(SettlementsService)

      // Fire 5 concurrent createSettlement calls
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          settlements.createSettlement(
            ctx.order.id,
            ctx.organization.id,
            ctx.customer.user.id,
          ),
        ),
      )

      const fulfilled = results.filter((r) => r.status === "fulfilled")
      const rejected = results.filter(
        (r) => r.status === "rejected",
      ) as PromiseRejectedResult[]

      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(4)

      // Verify failure type
      rejected.forEach((r) => {
        expect(r.reason).toBeInstanceOf(BadRequestException)
        expect(r.reason.message).toBe(
          "Settlement already exists for this order",
        )
      })

      // Verify exactly 1 non-CANCELLED settlement
      const activeSettlements = await prisma.settlement.count({
        where: {
          orderId: ctx.order.id,
          status: { not: "CANCELLED" },
        },
      })
      expect(activeSettlements).toBe(1)

      // Verify no financial records created until approval (wallet untouched)
      await expectFinancialState(ctx, {
        walletAvailableBalance: 100,
        publisherWithdrawableBalance: 0,
        publisherLifetimeEarnings: 0,
        transactionCount: 1, // only the deposit
        transactionSum: 100,
      })

      // Verify the winning settlement can be approved + released normally
      const winner = (fulfilled[0] as PromiseFulfilledResult<any>).value
      expect(winner.status).toBe(SettlementStatus.PENDING)
    } finally {
      await cleanup()
    }
  }, 30_000)
})
