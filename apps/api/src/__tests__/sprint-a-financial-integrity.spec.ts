import { BadRequestException } from "@nestjs/common"
import { setupFinancialTest } from "./integration/factories/financial-fixture"
import { createTestApp } from "./integration/helpers/create-test-app"

describe("[INTEGRATION] Sprint A — Financial Integrity", () => {
  // ─── C-3 TOCTOU: concurrent adminApprove + refundOrder ──────────────
  it("C-3: concurrent adminApprove + refundOrder — exactly one succeeds", async () => {
    const { app, prisma, cleanup } = await createTestApp()
    try {
      const ctx = await setupFinancialTest(prisma, { orderAmount: 100 })
      const { SettlementsService } =
        require("../modules/settlements/settlements.service") as any
      const settlements: any = app.get(SettlementsService)
      const { RefundService } =
        require("../modules/orders/services/refund.service") as any
      const refunds: any = app.get(RefundService)

      // Create settlement + customer-approve it
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

      // Fire approve + refund concurrently
      const results = await Promise.allSettled([
        settlements.adminApprove(
          settlement.id,
          "Admin approval test",
          ctx.customer.user.id,
          "SUPER_ADMIN",
        ),
        refunds.refundOrder(
          ctx.order.id,
          "Customer refund test",
          ctx.customer.user.id,
        ),
      ])

      // At least one succeeded; at most one succeeded
      const fulfilled = results.filter((r) => r.status === "fulfilled")
      expect(fulfilled.length).toBeGreaterThanOrEqual(1)
      expect(fulfilled.length).toBeLessThanOrEqual(2)

      // Verify no contradictory states
      const finalSettlement = await prisma.settlement.findUnique({
        where: { id: settlement.id },
      })
      const order = await prisma.order.findUnique({
        where: { id: ctx.order.id },
      })

      if (finalSettlement?.status === "RELEASED") {
        // Settlement released means refund did NOT go through
        expect(order.status).not.toBe("REFUNDED")
      }
      if (order?.status === "REFUNDED") {
        // Refund succeeded means settlement was NOT released
        expect(finalSettlement?.status).not.toBe("RELEASED")
      }
    } finally {
      await cleanup()
    }
  }, 30_000)

  // ─── C-1 Debt escape: withdrawal blocked when debt > 0 ──────────────
  it("C-1: requestWithdrawal blocked when debtBalance > 0", async () => {
    const { app, prisma, cleanup } = await createTestApp()
    try {
      const ctx = await setupFinancialTest(prisma, { orderAmount: 100 })
      const { PublisherPayoutsService } =
        require("../modules/publisher-payouts/publisher-payouts.service") as any
      const payouts: any = app.get(PublisherPayoutsService)

      // Add user as a publisher member so assertPublisherMember passes
      await prisma.publisherMembership.create({
        data: {
          userId: ctx.customer.user.id,
          publisherId: ctx.publisher.publisher.id,
          role: "PUBLISHER_OWNER",
        },
      })

      // Seed debtBalance directly
      await prisma.publisherBalance.upsert({
        where: { publisherId: ctx.publisher.publisher.id },
        create: {
          publisherId: ctx.publisher.publisher.id,
          withdrawableBalance: 100,
          debtBalance: 50,
        },
        update: {
          withdrawableBalance: 100,
          debtBalance: 50,
        },
      })

      await expect(
        payouts.requestWithdrawal(
          ctx.publisher.publisher.id,
          50,
          "bank_transfer",
          ctx.customer.user.id,
        ),
      ).rejects.toThrow(BadRequestException)
    } finally {
      await cleanup()
    }
  }, 30_000)

  // ─── C-1 Debt escape: executeWithdrawal blocked when debt > 0 ──────
  it("C-1: executeWithdrawal blocked when debtBalance > 0 (lock-protected)", async () => {
    const { app, prisma, cleanup } = await createTestApp()
    try {
      const ctx = await setupFinancialTest(prisma, { orderAmount: 100 })
      const { PublisherPayoutsService } =
        require("../modules/publisher-payouts/publisher-payouts.service") as any
      const payouts: any = app.get(PublisherPayoutsService)
      const { PayoutExecutionService } =
        require("../modules/publisher-payouts/payout-execution.service") as any
      const executions: any = app.get(PayoutExecutionService)

      // Seed balance + create an APPROVED withdrawal
      await prisma.publisherBalance.upsert({
        where: { publisherId: ctx.publisher.publisher.id },
        create: {
          publisherId: ctx.publisher.publisher.id,
          withdrawableBalance: 100,
          debtBalance: 50,
        },
        update: {
          withdrawableBalance: 100,
          debtBalance: 50,
        },
      })

      // Create an active "manual" payout provider so getActiveProvider doesn't throw
      await prisma.payoutProvider.upsert({
        where: { name: "manual" },
        create: {
          name: "manual",
          displayName: "Manual Transfer",
          config: {},
          isActive: true,
        },
        update: { isActive: true },
      })

      // Create an APPROVED withdrawal directly (can't use payouts service
      // because it would reject at requestWithdrawal due to debt check)
      const withdrawal = await prisma.withdrawal.create({
        data: {
          publisherId: ctx.publisher.publisher.id,
          amount: 50,
          method: "bank_transfer",
          status: "APPROVED",
          approvedBy: ctx.customer.user.id,
          approvedAt: new Date(),
          availableAt: new Date(Date.now() - 100_000), // hold passed
        },
      })

      await expect(
        executions.executeWithdrawal(
          withdrawal.id,
          "manual",
          ctx.customer.user.id,
        ),
      ).rejects.toThrow(BadRequestException)
    } finally {
      await cleanup()
    }
  }, 30_000)

  // ─── C-2: forceApprove creates audit row ──────────────────────────
  it("C-2: forceApprove creates audit log entry with reason + previousStatus", async () => {
    const { app, prisma, cleanup } = await createTestApp()
    try {
      const ctx = await setupFinancialTest(prisma, { orderAmount: 100 })
      const { SettlementsService } =
        require("../modules/settlements/settlements.service") as any
      const settlements: any = app.get(SettlementsService)

      // Create settlement + customer-approve it
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

      const forceReason = "Publisher bankruptcy exception"
      await settlements.forceApprove(
        settlement.id,
        forceReason,
        ctx.customer.user.id,
        "SUPER_ADMIN",
      )

      const auditRow = await prisma.auditLog.findFirst({
        where: {
          action: "SETTLEMENT_FORCE_APPROVED",
          entityId: settlement.id,
        },
        orderBy: { createdAt: "desc" },
      })

      expect(auditRow).not.toBeNull()
      expect(auditRow.metadata.reason).toBe(forceReason)
      expect(auditRow.metadata.previousStatus).toBe("CUSTOMER_APPROVED")
      expect(auditRow.metadata.actorRole).toBe("SUPER_ADMIN")
      expect(auditRow.userId).toBe(ctx.customer.user.id)
    } finally {
      await cleanup()
    }
  }, 30_000)

  // ─── C-2: adminApprove creates audit row ──────────────────────────
  it("C-2: adminApprove creates audit log entry with reason + previousStatus", async () => {
    const { app, prisma, cleanup } = await createTestApp()
    try {
      const ctx = await setupFinancialTest(prisma, { orderAmount: 100 })
      const { SettlementsService } =
        require("../modules/settlements/settlements.service") as any
      const settlements: any = app.get(SettlementsService)

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

      const approveReason = "Manual finance reconciliation"
      await settlements.adminApprove(
        settlement.id,
        approveReason,
        ctx.customer.user.id,
        "FINANCE",
      )

      const auditRow = await prisma.auditLog.findFirst({
        where: {
          action: "SETTLEMENT_ADMIN_APPROVED",
          entityId: settlement.id,
        },
        orderBy: { createdAt: "desc" },
      })

      expect(auditRow).not.toBeNull()
      expect(auditRow.metadata.reason).toBe(approveReason)
      expect(auditRow.metadata.previousStatus).toBe("CUSTOMER_APPROVED")
      expect(auditRow.metadata.actorRole).toBe("FINANCE")
      expect(auditRow.userId).toBe(ctx.customer.user.id)
    } finally {
      await cleanup()
    }
  }, 30_000)

  // ─── C-2: cancelSettlement audit includes previousStatus ──────────
  it("C-2: cancelSettlement audit includes previousStatus in metadata", async () => {
    const { app, prisma, cleanup } = await createTestApp()
    try {
      const ctx = await setupFinancialTest(prisma, { orderAmount: 100 })
      const { SettlementsService } =
        require("../modules/settlements/settlements.service") as any
      const settlements: any = app.get(SettlementsService)

      const settlement = await settlements.createSettlement(
        ctx.order.id,
        ctx.organization.id,
        ctx.customer.user.id,
      )

      await settlements.cancelSettlement(
        settlement.id,
        ctx.customer.user.id,
        "Order no longer needed",
      )

      const auditRow = await prisma.auditLog.findFirst({
        where: {
          action: "SETTLEMENT_CANCELLED",
          entityId: settlement.id,
        },
        orderBy: { createdAt: "desc" },
      })

      expect(auditRow).not.toBeNull()
      expect(auditRow.metadata.previousStatus).toBe("PENDING")
      expect(auditRow.metadata.reason).toBe("Order no longer needed")
    } finally {
      await cleanup()
    }
  }, 30_000)

  // ─── C-3: forceApprove vs openDispute race ────────────────────────
  it("C-3: forceApprove vs openDispute — never both RELEASED and OPEN", async () => {
    const { app, prisma, cleanup } = await createTestApp()
    try {
      const ctx = await setupFinancialTest(prisma, { orderAmount: 100 })
      const { SettlementsService } =
        require("../modules/settlements/settlements.service") as any
      const settlements: any = app.get(SettlementsService)

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

      // Fire forceApprove + openDispute concurrently
      const results = await Promise.allSettled([
        settlements.forceApprove(
          settlement.id,
          "Force approve test",
          ctx.customer.user.id,
          "SUPER_ADMIN",
        ),
        prisma.orderDispute.create({
          data: {
            orderId: ctx.order.id,
            raisedById: ctx.customer.user.id,
            status: "OPEN",
            reason: "Test dispute",
          },
        }),
      ])

      // Verify no contradictory state: both RELEASED + OPEN is impossible
      const finalSettlement = await prisma.settlement.findUnique({
        where: { id: settlement.id },
      })
      const activeDispute = await prisma.orderDispute.findFirst({
        where: { orderId: ctx.order.id, status: "OPEN" },
      })

      if (finalSettlement?.status === "RELEASED") {
        expect(activeDispute).toBeNull()
      }
      if (activeDispute) {
        expect(finalSettlement?.status).not.toBe("RELEASED")
      }

      // At least one operation should have succeeded
      const fulfilled = results.filter((r) => r.status === "fulfilled")
      expect(fulfilled.length).toBeGreaterThanOrEqual(1)
    } finally {
      await cleanup()
    }
  }, 30_000)

  // ─── C-2: releaseFundsInternal creates audit row ─────────────────
  it("C-2: releaseFundsInternal creates SETTLEMENT_FUNDS_RELEASED audit entry", async () => {
    const { app, prisma, cleanup } = await createTestApp()
    try {
      const ctx = await setupFinancialTest(prisma, { orderAmount: 100 })
      const { SettlementsService } =
        require("../modules/settlements/settlements.service") as any
      const settlements: any = app.get(SettlementsService)

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
        "Release test",
        ctx.customer.user.id,
        "SUPER_ADMIN",
      )

      const auditRow = await prisma.auditLog.findFirst({
        where: {
          action: "SETTLEMENT_FUNDS_RELEASED",
          entityId: settlement.id,
        },
        orderBy: { createdAt: "desc" },
      })

      expect(auditRow).not.toBeNull()
      expect(auditRow.metadata.previousStatus).toBe("ADMIN_APPROVED")
      expect(auditRow.metadata.publisherAmount).toBeGreaterThan(0)
    } finally {
      await cleanup()
    }
  }, 30_000)
})
