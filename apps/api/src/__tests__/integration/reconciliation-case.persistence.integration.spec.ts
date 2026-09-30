import { persistReconciliationCases } from "@guestpost/shared/dist/reconciliation-case-core"
import { makeOrder, makeOrganization, makeUser } from "./factories"
import { createTestDatabase, type TestDatabase } from "./helpers/test-db"

describe("[INTEGRATION] Reconciliation case evidence persistence", () => {
  let database: TestDatabase | undefined
  let previousDatabaseUrl: string | undefined
  let prisma: any

  beforeAll(async () => {
    database = await createTestDatabase()
    previousDatabaseUrl = process.env.DATABASE_URL
    process.env.DATABASE_URL = database.url
    const { PrismaService } = require("../../common/prisma.service") as any
    prisma = new PrismaService()
    await prisma.$connect()
  })

  afterAll(async () => {
    try {
      await prisma?.$disconnect()
    } finally {
      await database?.teardown()
      if (previousDatabaseUrl !== undefined) {
        process.env.DATABASE_URL = previousDatabaseUrl
      } else {
        delete process.env.DATABASE_URL
      }
    }
  })

  it("retains one immutable evidence revision across repeated scans", async () => {
    const customer = await makeUser(prisma)
    const organization = await makeOrganization(prisma)
    const order = await makeOrder(prisma, {
      customerId: customer.id,
      organizationId: organization.id,
      type: "GUEST_POST",
    })
    const firstRunAt = new Date("2026-09-30T12:00:00.000Z")
    const findings = {
      id: "refund-drift",
      severity: "warning",
      category: "refund",
      code: "REFUND_PARTIAL",
      entityId: order.id,
      entityType: "Order",
      detectedAt: firstRunAt.toISOString(),
      metadata: { orderId: order.id },
    }
    const report = (ranAt: Date) =>
      ({
        version: 1,
        ranAt: ranAt.toISOString(),
        walletDrift: [],
        publisherDrift: [],
        settlementDrift: [],
        orderPaymentRecon: [],
        refundRecon: [findings],
        stuckFinancialOrders: [],
        stuckPayouts: [],
      }) as any

    await persistReconciliationCases(prisma, report(firstRunAt), {
      detector: "admin",
    })
    await persistReconciliationCases(
      prisma,
      report(new Date("2026-09-30T12:01:00.000Z")),
      { detector: "worker" },
    )

    const caseRow = await prisma.reconciliationCase.findUniqueOrThrow({
      where: {
        aggregateType_aggregateId: {
          aggregateType: "Order",
          aggregateId: order.id,
        },
      },
      include: { snapshots: true },
    })
    expect(caseRow.version).toBe(1)
    expect(caseRow.snapshots).toHaveLength(1)
    expect(caseRow.lastDetectedAt).toEqual(new Date("2026-09-30T12:01:00.000Z"))
    expect(
      await prisma.reconciliationScan.count({
        where: { ranAt: { gte: firstRunAt } },
      }),
    ).toBe(2)
  })
})
