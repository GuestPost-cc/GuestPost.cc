import crypto from "node:crypto"
import {
  CancellationReasonCode,
  CancellationResponsibility,
} from "@guestpost/database"
import { BadRequestException } from "@nestjs/common"
import { makeUser } from "./factories"
import { setupFinancialTest } from "./factories/financial-fixture"
import { createTestApp } from "./helpers/create-test-app"

describe("[INTEGRATION] Sprint A — Financial Integrity", () => {
  // ─── C-3 TOCTOU: concurrent release + emergency force-cancel ───────
  it("C-3: serializes settlement release against emergency force-cancel", async () => {
    const { app, prisma, cleanup } = await createTestApp()
    try {
      const ctx = await setupFinancialTest(prisma, { orderAmount: 100 })
      const { SettlementsService } =
        require("../../modules/settlements/settlements.service") as any
      const settlements: any = app.get(SettlementsService)
      const { OrderCancellationService } =
        require("../../modules/orders/services/order-cancellation.service") as any
      const cancellations: any = app.get(OrderCancellationService)

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

      const orderBeforeRace = await prisma.order.findUniqueOrThrow({
        where: { id: ctx.order.id },
      })

      // Fire the ordinary release and the emergency refund command at the same
      // time. Either ordering is legal; the final accounting chain must be the
      // same and the publisher may be credited exactly once.
      const results = await Promise.allSettled([
        settlements.adminApprove(
          settlement.id,
          "Admin approval test",
          ctx.customer.user.id,
          "SUPER_ADMIN",
        ),
        cancellations.forceCancel(ctx.order.id, ctx.customer.user.id, {
          reasonCode: CancellationReasonCode.LEGAL_OR_SECURITY_EMERGENCY,
          note: "Verified system emergency requiring an immediate refund.",
          expectedVersion: orderBeforeRace.version,
          confirmationOrderId: ctx.order.id,
          responsibility: CancellationResponsibility.SYSTEM,
          publisherCompensation: {
            amount: 80,
            reason:
              "Publisher delivery remains payable if the system-attributed refund wins the race.",
          },
        }),
      ])

      // Force-cancel is the terminal command and must eventually succeed. The
      // release may win first (then be clawed back) or lose to cancellation.
      const fulfilled = results.filter((r) => r.status === "fulfilled")
      expect(fulfilled.length).toBeGreaterThanOrEqual(1)
      expect(fulfilled.length).toBeLessThanOrEqual(2)
      expect(results[1].status).toBe("fulfilled")

      // Verify one coherent terminal chain, regardless of lock acquisition
      // order: refund + explicit compensation, never a live released
      // settlement alongside a refunded order.
      const finalSettlement = await prisma.settlement.findUnique({
        where: { id: settlement.id },
      })
      const order = await prisma.order.findUnique({
        where: { id: ctx.order.id },
      })

      expect(order?.status).toBe("REFUNDED")
      expect(finalSettlement?.status).toBe("CANCELLED")

      const [releaseCount, refundCount, compensationCount, balance, wallet] =
        await Promise.all([
          prisma.transaction.count({
            where: { orderId: ctx.order.id, type: "SETTLEMENT_RELEASE" },
          }),
          prisma.transaction.count({
            where: { orderId: ctx.order.id, type: "REFUND" },
          }),
          prisma.transaction.count({
            where: { orderId: ctx.order.id, type: "PUBLISHER_COMPENSATION" },
          }),
          prisma.publisherBalance.findUniqueOrThrow({
            where: { publisherId: ctx.publisher.publisher.id },
          }),
          prisma.wallet.findUniqueOrThrow({
            where: { organizationId: ctx.organization.id },
          }),
        ])
      expect(releaseCount).toBeLessThanOrEqual(1)
      expect(refundCount).toBe(1)
      expect(compensationCount).toBe(1)
      expect(Number(balance.withdrawableBalance)).toBe(80)
      expect(Number(balance.debtBalance)).toBe(0)
      expect(Number(balance.lifetimeEarnings)).toBe(80)
      expect(Number(wallet.availableBalance)).toBe(100)
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
        require("../../modules/publisher-payouts/publisher-payouts.service") as any
      const payouts: any = app.get(PublisherPayoutsService)

      // Use a real, eligible publisher user and a real encrypted payout
      // method so the request reaches the debt gate rather than failing an
      // earlier requester/method precondition.
      const publisherOwner = await makeUser(prisma, {
        userType: "PUBLISHER",
      })
      await prisma.publisherMembership.create({
        data: {
          userId: publisherOwner.id,
          publisherId: ctx.publisher.publisher.id,
          role: "PUBLISHER_OWNER",
        },
      })
      const payoutMethod = await payouts.createPayoutMethod(
        ctx.publisher.publisher.id,
        publisherOwner.id,
        {
          type: "bank_transfer",
          label: "Debt-gate request test",
          details: {
            bankName: "Test Bank",
            accountHolderName: "Debt Gate Publisher",
            accountNumber: "000012345678",
          },
          isDefault: true,
        },
      )

      // Seed debtBalance directly
      const balanceBefore = await prisma.publisherBalance.upsert({
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

      const withdrawalCountBefore = await prisma.withdrawal.count({
        where: { publisherId: ctx.publisher.publisher.id },
      })
      const transactionCountBefore = await prisma.transaction.count({
        where: { publisherId: ctx.publisher.publisher.id },
      })

      let caught: unknown
      try {
        await payouts.requestWithdrawal(
          ctx.publisher.publisher.id,
          50,
          "bank_transfer",
          publisherOwner.id,
          "debt-gate-request-1",
          payoutMethod.id,
        )
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(BadRequestException)
      expect((caught as Error).message).toBe(
        "Cannot withdraw while outstanding debt of 50.00 exists. Repay through future settlements.",
      )

      const balanceAfter = await prisma.publisherBalance.findUniqueOrThrow({
        where: { publisherId: ctx.publisher.publisher.id },
      })
      expect(Number(balanceAfter.withdrawableBalance)).toBe(
        Number(balanceBefore.withdrawableBalance),
      )
      expect(Number(balanceAfter.debtBalance)).toBe(
        Number(balanceBefore.debtBalance),
      )
      expect(balanceAfter.version).toBe(balanceBefore.version)
      await expect(
        prisma.withdrawal.count({
          where: { publisherId: ctx.publisher.publisher.id },
        }),
      ).resolves.toBe(withdrawalCountBefore)
      await expect(
        prisma.transaction.count({
          where: { publisherId: ctx.publisher.publisher.id },
        }),
      ).resolves.toBe(transactionCountBefore)
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
        require("../../modules/publisher-payouts/publisher-payouts.service") as any
      const payouts: any = app.get(PublisherPayoutsService)
      const { PayoutExecutionService } =
        require("../../modules/publisher-payouts/payout-execution.service") as any
      const executions: any = app.get(PayoutExecutionService)

      const publisherOwner = await makeUser(prisma, {
        userType: "PUBLISHER",
      })
      const financeApprover = await makeUser(prisma, { userType: "STAFF" })
      const payoutInitiator = await makeUser(prisma, { userType: "STAFF" })
      await prisma.publisherMembership.create({
        data: {
          userId: publisherOwner.id,
          publisherId: ctx.publisher.publisher.id,
          role: "PUBLISHER_OWNER",
        },
      })
      await Promise.all(
        [financeApprover, payoutInitiator].map((actor) =>
          prisma.staffMembership.create({
            data: {
              userId: actor.id,
              role: "FINANCE",
            },
          }),
        ),
      )
      const payoutMethod = await payouts.createPayoutMethod(
        ctx.publisher.publisher.id,
        publisherOwner.id,
        {
          type: "bank_transfer",
          label: "Debt-gate execution test",
          details: {
            bankName: "Test Bank",
            accountHolderName: "Debt Gate Publisher",
            accountNumber: "000087654321",
          },
          isDefault: true,
        },
      )

      // Model the state after a legitimate 50 USD reservation: the
      // withdrawable balance is already reduced and an immutable allocation
      // exactly covers the APPROVED withdrawal.
      await prisma.publisherBalance.upsert({
        where: { publisherId: ctx.publisher.publisher.id },
        create: {
          publisherId: ctx.publisher.publisher.id,
          withdrawableBalance: 50,
          debtBalance: 50,
          allocationCarryForward: 100,
          allocationCarryForwardUsed: 50,
        },
        update: {
          withdrawableBalance: 50,
          debtBalance: 50,
          allocationCarryForward: 100,
          allocationCarryForwardUsed: 50,
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

      // Build the same canonical PENDING -> APPROVED history produced by the
      // service. The request service cannot be used here because this test
      // intentionally starts with debt and is exercising the execution gate.
      const requestedWithdrawal = await prisma.$transaction(async (tx: any) => {
        const created = await tx.withdrawal.create({
          data: {
            publisherId: ctx.publisher.publisher.id,
            amount: 50,
            currency: "USD",
            publicReference: `WD-DEBT-${crypto.randomUUID()}`,
            payoutFee: 0,
            netAmount: 50,
            feePolicyVersion: "integration-debt-gate-v1",
            method: "bank_transfer",
            status: "PENDING",
            idempotencyKey: "debt-gate-execution-1",
            payoutMethodId: payoutMethod.id,
            requestedBy: publisherOwner.id,
            availableAt: new Date(Date.now() - 100_000), // hold passed
          },
        })
        await tx.withdrawalAllocation.create({
          data: {
            withdrawalId: created.id,
            sourceType: "CARRY_FORWARD",
            amount: 50,
            currency: "USD",
            sequence: 0,
          },
        })
        return created
      })
      const withdrawal = await prisma.withdrawal.update({
        where: { id: requestedWithdrawal.id },
        data: {
          status: "APPROVED",
          approvedBy: financeApprover.id,
          approvedAt: new Date(),
          version: { increment: 1 },
        },
      })
      await prisma.transaction.create({
        data: {
          amount: -50,
          currency: "USD",
          type: "WITHDRAWAL",
          publisherId: ctx.publisher.publisher.id,
          reference: `withdrawal-${withdrawal.id}`,
          description: "Debt-gate execution test reservation",
        },
      })

      const balanceBefore = await prisma.publisherBalance.findUniqueOrThrow({
        where: { publisherId: ctx.publisher.publisher.id },
      })
      const transactionCountBefore = await prisma.transaction.count({
        where: { publisherId: ctx.publisher.publisher.id },
      })

      let caught: unknown
      try {
        await executions.executeWithdrawal(
          withdrawal.id,
          "manual",
          payoutInitiator.id,
          "Reviewed publisher debt before payout send",
        )
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(BadRequestException)
      expect((caught as Error).message).toBe(
        "Publisher has outstanding debt of 50.00 — resolve before executing payout",
      )

      const balanceAfter = await prisma.publisherBalance.findUniqueOrThrow({
        where: { publisherId: ctx.publisher.publisher.id },
      })
      expect(Number(balanceAfter.withdrawableBalance)).toBe(
        Number(balanceBefore.withdrawableBalance),
      )
      expect(Number(balanceAfter.debtBalance)).toBe(
        Number(balanceBefore.debtBalance),
      )
      expect(balanceAfter.version).toBe(balanceBefore.version)
      await expect(
        prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } }),
      ).resolves.toMatchObject({
        status: "APPROVED",
        version: withdrawal.version,
      })
      await expect(
        prisma.payoutExecution.count({
          where: { withdrawalId: withdrawal.id },
        }),
      ).resolves.toBe(0)
      await expect(
        prisma.transaction.count({
          where: { publisherId: ctx.publisher.publisher.id },
        }),
      ).resolves.toBe(transactionCountBefore)
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
        require("../../modules/settlements/settlements.service") as any
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
        require("../../modules/settlements/settlements.service") as any
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
        require("../../modules/settlements/settlements.service") as any
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
        require("../../modules/settlements/settlements.service") as any
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
        require("../../modules/settlements/settlements.service") as any
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
