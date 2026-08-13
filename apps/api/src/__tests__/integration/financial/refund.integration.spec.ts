import crypto from "node:crypto"
import {
  OrderStatus,
  SettlementStatus,
  TransactionType,
} from "@guestpost/database"
import {
  expectFinancialState,
  setupFinancialTest,
} from "../factories/financial-fixture"
import { createTestApp } from "../helpers/create-test-app"

describe("[INTEGRATION] Financial — full refund after settlement release", () => {
  it("claws back publisher balance, credits wallet, and transitions order to REFUNDED", async () => {
    const { app, prisma, cleanup } = await createTestApp()
    try {
      const ctx = await setupFinancialTest(prisma, { orderAmount: 100 })

      const { SettlementsService } =
        require("../../../modules/settlements/settlements.service") as any
      const settlements: any = app.get(SettlementsService)

      // ── 1. Full settlement lifecycle (happy path) ──
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
      const released = await settlements.adminApprove(
        settlement.id,
        "Refund test approval",
        ctx.customer.user.id,
        "SUPER_ADMIN",
      )
      expect(released.status).toBe(SettlementStatus.RELEASED)

      // ── 2. Act: refundOrder with idempotencyKey ──
      const { RefundService } =
        require("../../../modules/orders/services/refund.service") as any
      const refund: any = app.get(RefundService)
      const idempotencyKey = `refund-test-${process.pid}-${crypto.randomUUID()}`
      const refundedOrder = await refund.refundOrder(
        ctx.order.id,
        "Integration test refund",
        ctx.customer.user.id,
        idempotencyKey,
        {
          responsibility: "SYSTEM",
          publisherCompensation: {
            amount: 80,
            reason:
              "Publisher completed the contracted delivery before the system-attributed refund.",
          },
        },
      )
      expect(refundedOrder.status).toBe(OrderStatus.REFUNDED)

      // ── 3. Assert financial invariants ──
      // Wallet: 0 after PURCHASE capture + 100 refund credit = 100
      // Publisher: original settlement is clawed back, then the explicit
      // system-funded compensation restores the reviewed 80 liability.
      // Settlement: RELEASED → CANCELLED
      // Order: COMPLETED → REFUNDED
      await expectFinancialState(ctx, {
        settlementId: settlement.id,
        settlementStatus: SettlementStatus.CANCELLED,
        orderStatus: OrderStatus.REFUNDED,
        walletAvailableBalance: 100,
        publisherWithdrawableBalance: 80,
        publisherLifetimeEarnings: 80,
        transactionCount: 6,
        transactionSum: 180,
      })

      // Verify the order-specific accounting chain. The deposit funds the
      // wallet, not one particular order, so it intentionally has no orderId.
      const txnTypes = await prisma.transaction.findMany({
        where: { orderId: ctx.order.id },
        select: { type: true, amount: true },
        orderBy: { createdAt: "asc" },
      })
      expect(txnTypes.map((t: any) => t.type)).toEqual([
        TransactionType.PURCHASE,
        TransactionType.SETTLEMENT_RELEASE,
        TransactionType.SETTLEMENT_CLAWBACK,
        TransactionType.REFUND,
        TransactionType.PUBLISHER_COMPENSATION,
      ])
      expect(Number(txnTypes[0].amount)).toBe(-100)
      expect(Number(txnTypes[1].amount)).toBe(80)
      expect(Number(txnTypes[2].amount)).toBe(-80)
      expect(Number(txnTypes[3].amount)).toBe(100)
      expect(Number(txnTypes[4].amount)).toBe(80)

      const compensation = await prisma.publisherCompensation.findUnique({
        where: { orderId: ctx.order.id },
      })
      expect(compensation).toMatchObject({
        publisherId: ctx.publisher.publisher.id,
        disposition: "EXACT_AMOUNT",
        responsibility: "SYSTEM",
        effectiveOrderStatus: "COMPLETED",
      })
      expect(Number(compensation?.amount)).toBe(80)
    } finally {
      await cleanup()
    }
  }, 30_000)
})
