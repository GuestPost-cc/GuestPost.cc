import crypto from "node:crypto"
import {
  makeOrder,
  makeOrderDeliveryVersion,
  makeOrderItem,
  makeOrganization,
  makePublisher,
  makeTransaction,
  makeUser,
  makeWallet,
  makeWebsite,
} from "./index"

type AnyPrisma = any

export interface FinancialTestContext {
  organization: Awaited<ReturnType<typeof makeOrganization>>
  customer: {
    user: Awaited<ReturnType<typeof makeUser>>
    wallet: Awaited<ReturnType<typeof makeWallet>>
  }
  publisher: {
    publisher: Awaited<ReturnType<typeof makePublisher>>
    balance: any
  }
  website: Awaited<ReturnType<typeof makeWebsite>>
  order: Awaited<ReturnType<typeof makeOrder>>
  depositTransaction: Awaited<ReturnType<typeof makeTransaction>>
  deliveryVersion: Awaited<ReturnType<typeof makeOrderDeliveryVersion>>
  prisma: AnyPrisma
}

export interface FinancialFixtureOptions {
  orderAmount?: number
  orderStatus?: string
  withDeposit?: boolean
}

/**
 * Sets up a complete financial test baseline with all prerequisites for
 * SettlementService.createSettlement():
 *
 *   org → customer + publisher + website
 *       → order (PAID) + orderItem + DELIVERED + activeDeliveryVersion (VERIFIED)
 *       → wallet → deposit transaction
 *
 * Does NOT create a settlement — specs call SettlementService.createSettlement()
 * to test the production code path.
 *
 * orderStatus controls the final order status. Default is "DELIVERED" (ready
 * for settlement). Pass "CANCELLED" etc. for negative tests — the fixture
 * still creates the delivery version but does NOT link it as active.
 */
export async function setupFinancialTest(
  prisma: AnyPrisma,
  opts: FinancialFixtureOptions = {},
): Promise<FinancialTestContext> {
  const orderAmount = opts.orderAmount ?? 100
  const orderStatus = opts.orderStatus ?? "DELIVERED"

  const organization = await makeOrganization(prisma)
  const user = await makeUser(prisma, { userType: "CUSTOMER" })
  const pub = await makePublisher(prisma, { organizationId: organization.id })
  const website = await makeWebsite(prisma, {
    publisherId: pub.id,
    ownershipType: "PUBLISHER",
  })

  // Create order in an intermediate status first, before we add the
  // delivery version.
  const order = await makeOrder(prisma, {
    organizationId: organization.id,
    customerId: user.id,
    websiteId: website.id,
    amount: orderAmount,
    status: "PAID",
    paymentStatus: "PAID",
    fulfillmentChannel: "PUBLISHER",
  })

  // OrderItem with websiteId so createSettlement can resolve the publisher.
  await makeOrderItem(prisma, {
    orderId: order.id,
    websiteId: website.id,
    price: orderAmount,
  })

  // DeliveryVersion with VERIFIED status — required by settlement gating.
  const deliveryVersion = await makeOrderDeliveryVersion(prisma, {
    orderId: order.id,
    submittedByUserId: user.id,
    verificationStatus: "VERIFIED",
  })

  if (orderStatus === "DELIVERED") {
    // Wire delivery + status to make the order settlement-eligible.
    await prisma.order.update({
      where: { id: order.id },
      data: {
        status: "DELIVERED",
        activeDeliveryVersionId: deliveryVersion.id,
      },
    })
    order.status = "DELIVERED"
    order.activeDeliveryVersionId = deliveryVersion.id
  } else {
    // Non-DELIVERED status — still create the delivery version but don't
    // link it, so the order won't pass settlement eligibility.
    await prisma.order.update({
      where: { id: order.id },
      data: { status: orderStatus },
    })
    order.status = orderStatus
  }

  const wallet = await makeWallet(prisma, {
    organizationId: organization.id,
    availableBalance: opts.withDeposit !== false ? orderAmount : 0,
  })

  let depositTransaction: Awaited<ReturnType<typeof makeTransaction>> | null =
    null
  if (opts.withDeposit !== false) {
    depositTransaction = await makeTransaction(prisma, {
      walletId: wallet.id,
      amount: orderAmount,
      type: "DEPOSIT",
      reference: `txn-${process.pid}-${crypto.randomUUID()}`,
      orderId: order.id,
      description: "Test deposit",
    })
  }

  const balance = await prisma.publisherBalance.findUnique({
    where: { publisherId: pub.id },
  })

  return {
    organization,
    customer: { user, wallet },
    publisher: { publisher: pub, balance },
    website,
    order,
    depositTransaction: depositTransaction!,
    deliveryVersion,
    prisma,
  }
}

export interface FinancialStateExpectations {
  walletAvailableBalance?: number
  walletReservedBalance?: number
  publisherPendingBalance?: number
  publisherApprovedBalance?: number
  publisherWithdrawableBalance?: number
  publisherDebtBalance?: number
  publisherLifetimeEarnings?: number
  settlementStatus?: string
  settlementId?: string
  orderStatus?: string
  transactionCount?: number
  transactionSum?: number
}

/**
 * Pure DB assertion layer. Reads current state via Prisma finds and SQL
 * aggregates, then compares against expected values. Spec computes expected
 * values — this helper only verifies what's persisted.
 */
export async function expectFinancialState(
  ctx: FinancialTestContext,
  expected: FinancialStateExpectations,
): Promise<void> {
  const { prisma } = ctx

  if (expected.walletAvailableBalance !== undefined) {
    const wallet = await prisma.wallet.findUnique({
      where: { id: ctx.customer.wallet.id },
    })
    expect(Number(wallet.availableBalance)).toBe(
      expected.walletAvailableBalance,
    )
  }

  if (expected.walletReservedBalance !== undefined) {
    const wallet = await prisma.wallet.findUnique({
      where: { id: ctx.customer.wallet.id },
    })
    expect(Number(wallet.reservedBalance)).toBe(expected.walletReservedBalance)
  }

  if (
    expected.publisherPendingBalance !== undefined ||
    expected.publisherApprovedBalance !== undefined ||
    expected.publisherWithdrawableBalance !== undefined ||
    expected.publisherDebtBalance !== undefined ||
    expected.publisherLifetimeEarnings !== undefined
  ) {
    const balance = await prisma.publisherBalance.findUnique({
      where: { publisherId: ctx.publisher.publisher.id },
    })
    const zero = {
      pendingBalance: 0,
      approvedBalance: 0,
      withdrawableBalance: 0,
      debtBalance: 0,
      lifetimeEarnings: 0,
    }
    const b = balance ?? zero
    if (expected.publisherPendingBalance !== undefined) {
      expect(Number(b.pendingBalance)).toBe(expected.publisherPendingBalance)
    }
    if (expected.publisherApprovedBalance !== undefined) {
      expect(Number(b.approvedBalance)).toBe(expected.publisherApprovedBalance)
    }
    if (expected.publisherWithdrawableBalance !== undefined) {
      expect(Number(b.withdrawableBalance)).toBe(
        expected.publisherWithdrawableBalance,
      )
    }
    if (expected.publisherDebtBalance !== undefined) {
      expect(Number(b.debtBalance)).toBe(expected.publisherDebtBalance)
    }
    if (expected.publisherLifetimeEarnings !== undefined) {
      expect(Number(b.lifetimeEarnings)).toBe(
        expected.publisherLifetimeEarnings,
      )
    }
  }

  if (expected.settlementId && expected.settlementStatus !== undefined) {
    const settlement = await prisma.settlement.findUnique({
      where: { id: expected.settlementId },
    })
    expect(settlement).not.toBeNull()
    expect(settlement.status).toBe(expected.settlementStatus)
  }

  if (expected.orderStatus !== undefined) {
    const order = await prisma.order.findUnique({
      where: { id: ctx.order.id },
    })
    expect(order.status).toBe(expected.orderStatus)
  }

  if (expected.transactionCount !== undefined) {
    const count = await prisma.transaction.count()
    expect(count).toBe(expected.transactionCount)
  }

  if (expected.transactionSum !== undefined) {
    const result: Array<{ sum: string }> = await prisma.$queryRawUnsafe(
      `SELECT COALESCE(SUM(amount), 0) as sum FROM "Transaction"`,
    )
    expect(Number(result[0].sum)).toBe(expected.transactionSum)
  }
}
