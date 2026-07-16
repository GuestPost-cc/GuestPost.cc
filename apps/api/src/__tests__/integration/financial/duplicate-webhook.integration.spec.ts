import crypto from "node:crypto"
import { OrderStatus, SettlementStatus } from "@guestpost/database"
import {
  expectFinancialState,
  setupFinancialTest,
} from "../factories/financial-fixture"
import { createTestApp } from "../helpers/create-test-app"

describe("[INTEGRATION] Financial — duplicate webhook idempotency", () => {
  it("refundOrder with same idempotencyKey is idempotent — no double credit", async () => {
    const { app, prisma, cleanup } = await createTestApp()
    try {
      const ctx = await setupFinancialTest(prisma, { orderAmount: 100 })

      const { SettlementsService } =
        require("../../../modules/settlements/settlements.service") as any
      const settlements: any = app.get(SettlementsService)

      // Reach full settlement release
      const settlement = await settlements.createSettlement(
        ctx.order.id,
        ctx.organization.id,
        ctx.customer.user.id,
      )
      await settlements.customerApprove(
        settlement.id,
        ctx.customer.user.id,
        ctx.organization.id,
        "OWNER",
        "OWNER",
      )
      await settlements.adminApprove(
        settlement.id,
        "Duplicate webhook test approval",
        ctx.customer.user.id,
        "SUPER_ADMIN",
      )

      const { RefundService } =
        require("../../../modules/orders/services/refund.service") as any
      const refund: any = app.get(RefundService)
      const idempotencyKey = `dup-test-${process.pid}-${crypto.randomUUID()}`

      // Act 1: first call succeeds
      const first = await refund.refundOrder(
        ctx.order.id,
        "Duplicate test refund",
        ctx.customer.user.id,
        idempotencyKey,
        { responsibility: "SYSTEM" },
      )
      expect(first.status).toBe(OrderStatus.REFUNDED)

      // Act 2: second call with same idempotencyKey — should be a no-op
      const second = await refund.refundOrder(
        ctx.order.id,
        "Duplicate test refund",
        ctx.customer.user.id,
        idempotencyKey,
        { responsibility: "SYSTEM" },
      )
      expect(second.status).toBe(OrderStatus.REFUNDED)

      // Assert: exactly 1 REFUND transaction, wallet credited exactly once
      await expectFinancialState(ctx, {
        settlementId: settlement.id,
        settlementStatus: SettlementStatus.CANCELLED,
        orderStatus: OrderStatus.REFUNDED,
        walletAvailableBalance: 200,
        publisherWithdrawableBalance: 0,
        transactionCount: 4,
        transactionSum: 200,
      })

      // Verify only 1 REFUND transaction exists
      const refundTxns = await prisma.transaction.count({
        where: { type: "REFUND" },
      })
      expect(refundTxns).toBe(1)
    } finally {
      await cleanup()
    }
  }, 30_000)
})
