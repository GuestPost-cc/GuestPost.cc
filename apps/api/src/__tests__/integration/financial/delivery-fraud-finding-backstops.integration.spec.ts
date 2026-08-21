import crypto from "node:crypto"
import {
  makeOrder,
  makeOrderDeliveryVersion,
  makeOrganization,
  makeUser,
} from "../factories"
import { setupFinancialTest } from "../factories/financial-fixture"
import { createTestApp } from "../helpers/create-test-app"

const DECISION_REASON =
  "Confirmed delivery fraud evidence was reviewed by authorized Operations staff."
const REVIEW_REASON =
  "Confirmed delivery fraud requires a canonical full customer refund."
const FINANCE_REASON =
  "Finance approved the exact customer refund after reviewing the fraud case."

describe("[INTEGRATION] Financial — confirmed delivery fraud persistence backstops", () => {
  let context: Awaited<ReturnType<typeof createTestApp>> | undefined
  let prisma: any
  let alternatePrisma: any
  let app: any

  beforeAll(async () => {
    context = await createTestApp()
    prisma = context.prisma
    app = context.app
    const { PrismaService } = require("../../../common/prisma.service") as any
    alternatePrisma = new PrismaService()
    await alternatePrisma.$connect()
  })

  afterAll(async () => {
    await alternatePrisma?.$disconnect()
    await context?.cleanup()
  })

  async function waitForDatabaseLock(pid: number) {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT "wait_event_type" AS "waitEventType"
         FROM pg_catalog.pg_stat_activity
         WHERE "pid" = $1`,
        pid,
      )
      if (rows[0]?.waitEventType === "Lock") return
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(
      `database session ${pid} did not block on the approved refund evidence lock`,
    )
  }

  function retryableDatabaseErrorText(error: unknown): string {
    const facts: string[] = []
    const seen = new Set<unknown>()
    const visit = (value: unknown, depth: number) => {
      if (depth > 5 || value === null || value === undefined || seen.has(value))
        return
      if (typeof value !== "object") {
        facts.push(String(value))
        return
      }
      seen.add(value)
      for (const key of Object.getOwnPropertyNames(value)) {
        try {
          visit((value as Record<string, unknown>)[key], depth + 1)
        } catch {
          // Diagnostic extraction must never mask the original database error.
        }
      }
    }
    visit(error, 0)
    return facts.join(" ")
  }

  function expectRetryableDatabaseAbort(
    outcome: PromiseSettledResult<unknown>,
  ) {
    expect(outcome.status).toBe("rejected")
    if (outcome.status === "rejected") {
      expect(retryableDatabaseErrorText(outcome.reason)).toMatch(
        /40P01|40001|P2034|deadlock|serializ/i,
      )
    }
  }

  async function makeStaff(role: "OPERATIONS" | "FINANCE" | "SUPER_ADMIN") {
    const user = await makeUser(prisma, { userType: "STAFF" })
    const membership = await prisma.staffMembership.create({
      data: { userId: user.id, role },
    })
    return { user, membership }
  }

  async function makeMinimalFraudFixture() {
    const organization = await makeOrganization(prisma)
    const customer = await makeUser(prisma, { userType: "CUSTOMER" })
    const order = await makeOrder(prisma, {
      organizationId: organization.id,
      customerId: customer.id,
      status: "DRAFT",
      paymentStatus: "PENDING",
      fulfillmentChannel: "PLATFORM",
    })
    const delivery = await makeOrderDeliveryVersion(prisma, {
      orderId: order.id,
      submittedByUserId: customer.id,
      verificationStatus: "VERIFIED",
    })
    const operations = await makeStaff("OPERATIONS")
    const cancellation = await makeFraudCancellation({
      order,
      actorUserId: operations.user.id,
    })
    return {
      organization,
      customer,
      order,
      delivery,
      operations,
      cancellation,
    }
  }

  async function makeFraudCancellation(input: {
    order: {
      id: string
      status: string
      fulfillmentChannel: string
    }
    actorUserId: string
  }) {
    return prisma.orderCancellationRequest.create({
      data: {
        orderId: input.order.id,
        requestedByUserId: input.actorUserId,
        requesterType: "STAFF",
        actorSnapshot: {
          userId: input.actorUserId,
          kind: "STAFF",
          staffRole: "OPERATIONS",
          source: "DELIVERY_FRAUD_CONFIRMATION",
        },
        reasonCode: "LEGAL_OR_SECURITY_EMERGENCY",
        note: "Confirmed delivery integrity issue requires formal review.",
        status: "ESCALATED",
        previousOrderStatus: input.order.status,
        fulfillmentChannel: input.order.fulfillmentChannel,
        responsibility: "UNDETERMINED",
        requestedResolution: "FULL_REFUND",
        idempotencyKey: `delivery-fraud:${crypto.randomUUID()}`,
      },
    })
  }

  async function makeFraudFlag(input: {
    orderId: string
    deliveryVersionId: string
    type?: string
  }) {
    return prisma.deliveryFraudFlag.create({
      data: {
        orderId: input.orderId,
        deliveryVersionId: input.deliveryVersionId,
        type: input.type ?? "URL_REUSED",
        details: { source: "integration-backstop-test" },
      },
    })
  }

  async function makeFindingWithClient(
    client: any,
    input: {
      flagId: string
      orderId: string
      deliveryVersionId: string
      cancellationRequestId: string
      actorUserId: string
      actorRole?: "OPERATIONS" | "SUPER_ADMIN"
    },
  ) {
    const [order, delivery] = await Promise.all([
      client.order.findUniqueOrThrow({ where: { id: input.orderId } }),
      client.orderDeliveryVersion.findUniqueOrThrow({
        where: { id: input.deliveryVersionId },
      }),
    ])
    const idempotencyKey = crypto.randomUUID()
    return client.deliveryFraudFinding.create({
      data: {
        fraudFlagId: input.flagId,
        orderId: input.orderId,
        deliveryVersionId: input.deliveryVersionId,
        cancellationRequestId: input.cancellationRequestId,
        outcome: "CONFIRMED_FRAUD",
        internalReason: DECISION_REASON,
        decidedByUserId: input.actorUserId,
        decidedByRole: input.actorRole ?? "OPERATIONS",
        expectedOrderVersion: order.version,
        expectedVerificationVersion: delivery.verificationVersion,
        idempotencyKey,
        requestFingerprint: crypto
          .createHash("sha256")
          .update(`finding:${idempotencyKey}`)
          .digest("hex"),
      },
    })
  }

  async function makeFinding(input: {
    flagId: string
    orderId: string
    deliveryVersionId: string
    cancellationRequestId: string
    actorUserId: string
    actorRole?: "OPERATIONS" | "SUPER_ADMIN"
  }) {
    return makeFindingWithClient(prisma, input)
  }

  async function makeClearance(input: {
    flagId: string
    orderId: string
    deliveryVersionId: string
    actorUserId: string
  }) {
    return prisma.deliveryFraudFlagResolution.create({
      data: {
        fraudFlagId: input.flagId,
        orderId: input.orderId,
        deliveryVersionId: input.deliveryVersionId,
        kind: "STAFF_CLEARED",
        reason:
          "Operations verified that this immutable signal was a false positive.",
        resolvedByUserId: input.actorUserId,
        resolvedByRole: "OPERATIONS",
        evidence: {
          disposition: "FALSE_POSITIVE",
          evidenceReference: null,
        },
      },
    })
  }

  async function makePendingFinanceFraudFixture() {
    const financial = await setupFinancialTest(prisma, {
      orderAmount: 137.41,
      orderStatus: "DELIVERED",
    })
    const operations = await makeStaff("OPERATIONS")
    const finance = await makeStaff("FINANCE")
    const cancellation = await makeFraudCancellation({
      order: financial.order,
      actorUserId: operations.user.id,
    })
    const flag = await makeFraudFlag({
      orderId: financial.order.id,
      deliveryVersionId: financial.deliveryVersion.id,
    })
    await makeFinding({
      flagId: flag.id,
      orderId: financial.order.id,
      deliveryVersionId: financial.deliveryVersion.id,
      cancellationRequestId: cancellation.id,
      actorUserId: operations.user.id,
    })
    await prisma.orderCancellationRequest.update({
      where: { id: cancellation.id },
      data: {
        status: "PENDING_FINANCE",
        reviewedByUserId: operations.user.id,
        responsibility: "SYSTEM",
        resolution: "FULL_REFUND",
        resolutionReason: REVIEW_REASON,
      },
    })
    const candidateRefund = await prisma.transaction.create({
      data: {
        amount: 137.41,
        type: "REFUND",
        currency: "USD",
        orderId: financial.order.id,
        walletId: financial.customer.wallet.id,
        reference: `fraud-race-refund:${crypto.randomUUID()}`,
        description: "Canonical refund candidate for concurrency testing",
      },
    })
    return {
      financial,
      operations,
      finance,
      cancellation,
      flag,
      candidateRefund,
    }
  }

  it("keeps confirmed holds permanent, rejects later clearance, and protects a shared multi-flag handoff", async () => {
    const fixture = await makeMinimalFraudFixture()
    const firstFlag = await makeFraudFlag({
      orderId: fixture.order.id,
      deliveryVersionId: fixture.delivery.id,
      type: "URL_REUSED",
    })
    const secondFlag = await makeFraudFlag({
      orderId: fixture.order.id,
      deliveryVersionId: fixture.delivery.id,
      type: "ANCHOR_MISMATCH",
    })

    const firstFinding = await makeFinding({
      flagId: firstFlag.id,
      orderId: fixture.order.id,
      deliveryVersionId: fixture.delivery.id,
      cancellationRequestId: fixture.cancellation.id,
      actorUserId: fixture.operations.user.id,
    })
    const secondFinding = await makeFinding({
      flagId: secondFlag.id,
      orderId: fixture.order.id,
      deliveryVersionId: fixture.delivery.id,
      cancellationRequestId: fixture.cancellation.id,
      actorUserId: fixture.operations.user.id,
    })

    await expect(
      makeClearance({
        flagId: firstFlag.id,
        orderId: fixture.order.id,
        deliveryVersionId: fixture.delivery.id,
        actorUserId: fixture.operations.user.id,
      }),
    ).rejects.toThrow(/confirmed fraud flag cannot be cleared or restored/i)
    await expect(
      prisma.orderCancellationRequest.update({
        where: { id: fixture.cancellation.id },
        data: { status: "REJECTED", resolvedAt: new Date() },
      }),
    ).rejects.toThrow(/must progress to Finance full-refund review/i)

    await expect(
      prisma.deliveryFraudHold.findMany({
        where: { orderId: fixture.order.id },
        orderBy: { type: "asc" },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        fraudFlagId: secondFlag.id,
        type: "ANCHOR_MISMATCH",
      }),
      expect.objectContaining({
        fraudFlagId: firstFlag.id,
        type: "URL_REUSED",
      }),
    ])
    await expect(
      prisma.deliveryFraudFinding.findMany({
        where: { cancellationRequestId: fixture.cancellation.id },
        select: { id: true },
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { id: firstFinding.id },
        { id: secondFinding.id },
      ]),
    )
    await expect(
      prisma.orderCancellationRequest.findUniqueOrThrow({
        where: { id: fixture.cancellation.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "ESCALATED" })
  })

  it("rejects a finding after clearance and leaves the cleared hold absent", async () => {
    const fixture = await makeMinimalFraudFixture()
    const flag = await makeFraudFlag({
      orderId: fixture.order.id,
      deliveryVersionId: fixture.delivery.id,
    })
    const resolution = await makeClearance({
      flagId: flag.id,
      orderId: fixture.order.id,
      deliveryVersionId: fixture.delivery.id,
      actorUserId: fixture.operations.user.id,
    })

    await expect(
      makeFinding({
        flagId: flag.id,
        orderId: fixture.order.id,
        deliveryVersionId: fixture.delivery.id,
        cancellationRequestId: fixture.cancellation.id,
        actorUserId: fixture.operations.user.id,
      }),
    ).rejects.toThrow(/resolved fraud flag cannot receive a confirmed finding/i)

    await expect(
      prisma.deliveryFraudFlagResolution.findUniqueOrThrow({
        where: { fraudFlagId: flag.id },
        select: { id: true },
      }),
    ).resolves.toEqual({ id: resolution.id })
    await expect(
      prisma.deliveryFraudHold.findUnique({ where: { fraudFlagId: flag.id } }),
    ).resolves.toBeNull()
    await expect(
      prisma.deliveryFraudFinding.findUnique({
        where: { fraudFlagId: flag.id },
      }),
    ).resolves.toBeNull()
  })

  it("fails closed when Operations authority is revoked before finding insertion", async () => {
    const fixture = await makeMinimalFraudFixture()
    const flag = await makeFraudFlag({
      orderId: fixture.order.id,
      deliveryVersionId: fixture.delivery.id,
    })
    await prisma.staffMembership.delete({
      where: { id: fixture.operations.membership.id },
    })

    await expect(
      makeFinding({
        flagId: flag.id,
        orderId: fixture.order.id,
        deliveryVersionId: fixture.delivery.id,
        cancellationRequestId: fixture.cancellation.id,
        actorUserId: fixture.operations.user.id,
      }),
    ).rejects.toThrow(/live Operations or Super Admin actor/i)

    await expect(
      prisma.deliveryFraudFinding.findUnique({
        where: { fraudFlagId: flag.id },
      }),
    ).resolves.toBeNull()
    await expect(
      prisma.deliveryFraudHold.findUnique({ where: { fraudFlagId: flag.id } }),
    ).resolves.toEqual(expect.objectContaining({ fraudFlagId: flag.id }))
  })

  it("rechecks an uncommitted finding when a pre-started cancellation rewrite wakes", async () => {
    const fixture = await makeMinimalFraudFixture()
    const flag = await makeFraudFlag({
      orderId: fixture.order.id,
      deliveryVersionId: fixture.delivery.id,
    })

    let markFindingReady!: () => void
    let allowFindingCommit!: () => void
    const findingReady = new Promise<void>((resolve) => {
      markFindingReady = resolve
    })
    const findingMayCommit = new Promise<void>((resolve) => {
      allowFindingCommit = resolve
    })
    const finding = alternatePrisma.$transaction(async (tx: any) => {
      const created = await makeFindingWithClient(tx, {
        flagId: flag.id,
        orderId: fixture.order.id,
        deliveryVersionId: fixture.delivery.id,
        cancellationRequestId: fixture.cancellation.id,
        actorUserId: fixture.operations.user.id,
      })
      markFindingReady()
      await findingMayCommit
      return created
    })
    await findingReady

    let markCancellationStarted!: (pid: number) => void
    const cancellationStarted = new Promise<number>((resolve) => {
      markCancellationStarted = resolve
    })
    const forbiddenRewrite = prisma.$transaction(async (tx: any) => {
      const [session] = await tx.$queryRawUnsafe(
        'SELECT pg_catalog.pg_backend_pid()::int AS "pid"',
      )
      markCancellationStarted(session.pid)
      return tx.orderCancellationRequest.update({
        where: { id: fixture.cancellation.id },
        data: { status: "REJECTED", resolvedAt: new Date() },
      })
    })
    const cancellationPid = await cancellationStarted

    let lockWaitError: unknown
    try {
      await waitForDatabaseLock(cancellationPid)
    } catch (error) {
      lockWaitError = error
    } finally {
      allowFindingCommit()
    }

    const [findingResult, rewriteResult] = await Promise.allSettled([
      finding,
      forbiddenRewrite,
    ])
    if (lockWaitError) throw lockWaitError
    expect(findingResult.status).toBe("fulfilled")
    expect(rewriteResult.status).toBe("rejected")
    if (rewriteResult.status === "rejected") {
      expect(String(rewriteResult.reason)).toMatch(
        /must progress to Finance full-refund review/i,
      )
    }
    await expect(
      prisma.orderCancellationRequest.findUniqueOrThrow({
        where: { id: fixture.cancellation.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "ESCALATED" })
    await expect(
      prisma.deliveryFraudFinding.count({ where: { fraudFlagId: flag.id } }),
    ).resolves.toBe(1)
  }, 30_000)

  it("aborts one side when cancellation-tuple-first races finding Order-first", async () => {
    const fixture = await makeMinimalFraudFixture()
    const flag = await makeFraudFlag({
      orderId: fixture.order.id,
      deliveryVersionId: fixture.delivery.id,
    })

    let markCancellationLocked!: () => void
    let allowCancellationRewrite!: () => void
    const cancellationLocked = new Promise<void>((resolve) => {
      markCancellationLocked = resolve
    })
    const cancellationMayRewrite = new Promise<void>((resolve) => {
      allowCancellationRewrite = resolve
    })
    const forbiddenRewrite = alternatePrisma.$transaction(
      async (tx: any) => {
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM public."OrderCancellationRequest" WHERE "id" = $1 FOR UPDATE',
          fixture.cancellation.id,
        )
        markCancellationLocked()
        await cancellationMayRewrite
        return tx.orderCancellationRequest.update({
          where: { id: fixture.cancellation.id },
          data: { status: "REJECTED", resolvedAt: new Date() },
        })
      },
      { isolationLevel: "Serializable", timeout: 30_000 },
    )
    await cancellationLocked

    let markFindingStarted!: (pid: number) => void
    const findingStarted = new Promise<number>((resolve) => {
      markFindingStarted = resolve
    })
    const finding = prisma.$transaction(
      async (tx: any) => {
        const [session] = await tx.$queryRawUnsafe(
          'SELECT pg_catalog.pg_backend_pid()::int AS "pid"',
        )
        markFindingStarted(session.pid)
        return makeFindingWithClient(tx, {
          flagId: flag.id,
          orderId: fixture.order.id,
          deliveryVersionId: fixture.delivery.id,
          cancellationRequestId: fixture.cancellation.id,
          actorUserId: fixture.operations.user.id,
        })
      },
      { isolationLevel: "Serializable", timeout: 30_000 },
    )
    const findingPid = await findingStarted

    let lockWaitError: unknown
    try {
      await waitForDatabaseLock(findingPid)
    } catch (error) {
      lockWaitError = error
    } finally {
      allowCancellationRewrite()
    }

    const [findingResult, rewriteResult] = await Promise.allSettled([
      finding,
      forbiddenRewrite,
    ])
    if (lockWaitError) throw lockWaitError
    expect(
      [findingResult, rewriteResult].filter(
        (outcome) => outcome.status === "fulfilled",
      ),
    ).toHaveLength(1)
    const rejected = [findingResult, rewriteResult].find(
      (outcome) => outcome.status === "rejected",
    )
    expect(rejected).toBeDefined()
    if (rejected) expectRetryableDatabaseAbort(rejected)

    const [persistedFinding, persistedCancellation] = await Promise.all([
      prisma.deliveryFraudFinding.findUnique({
        where: { fraudFlagId: flag.id },
        select: { id: true },
      }),
      prisma.orderCancellationRequest.findUniqueOrThrow({
        where: { id: fixture.cancellation.id },
        select: { status: true },
      }),
    ])
    expect(
      persistedFinding !== null && persistedCancellation.status === "REJECTED",
    ).toBe(false)
    if (persistedFinding) {
      expect(persistedCancellation.status).toBe("ESCALATED")
    } else {
      expect(persistedCancellation.status).toBe("REJECTED")
    }
  }, 30_000)

  it("requires live Finance and a canonical exact-decimal refund, then freezes the approved evidence", async () => {
    const financial = await setupFinancialTest(prisma, {
      orderAmount: 137.41,
      orderStatus: "DELIVERED",
    })
    const operations = await makeStaff("OPERATIONS")
    const finance = await makeStaff("FINANCE")
    const cancellation = await makeFraudCancellation({
      order: financial.order,
      actorUserId: operations.user.id,
    })
    const flag = await makeFraudFlag({
      orderId: financial.order.id,
      deliveryVersionId: financial.deliveryVersion.id,
      type: "URL_REUSED",
    })
    await makeFinding({
      flagId: flag.id,
      orderId: financial.order.id,
      deliveryVersionId: financial.deliveryVersion.id,
      cancellationRequestId: cancellation.id,
      actorUserId: operations.user.id,
    })
    await prisma.orderCancellationRequest.update({
      where: { id: cancellation.id },
      data: {
        status: "PENDING_FINANCE",
        reviewedByUserId: operations.user.id,
        responsibility: "SYSTEM",
        resolution: "FULL_REFUND",
        resolutionReason: REVIEW_REASON,
      },
    })

    const { RefundService } =
      require("../../../modules/orders/services/refund.service") as any
    const refunds: any = app.get(RefundService)
    await expect(
      refunds.refundOrder(
        financial.order.id,
        FINANCE_REASON,
        finance.user.id,
        `direct-bypass:${cancellation.id}`,
        {
          responsibility: "SYSTEM",
          publisherCompensation: {
            amount: "0",
            reason:
              "No publisher credit is payable for this confirmed integrity incident.",
          },
        },
      ),
    ).rejects.toThrow(/approved full-refund case/i)

    await expect(
      prisma.orderCancellationRequest.update({
        where: { id: cancellation.id },
        data: {
          status: "APPROVED",
          financeApprovedByUserId: finance.user.id,
          refundTransactionId: financial.purchaseTransaction.id,
          resolvedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/canonical completed full refund/i)

    await prisma.user.update({
      where: { id: finance.user.id },
      data: { banned: true },
    })
    await expect(
      prisma.orderCancellationRequest.update({
        where: { id: cancellation.id },
        data: {
          status: "APPROVED",
          financeApprovedByUserId: finance.user.id,
          refundTransactionId: financial.purchaseTransaction.id,
          resolvedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/live Finance or Super Admin authority/i)
    await prisma.user.update({
      where: { id: finance.user.id },
      data: { banned: false },
    })

    const { OrderCancellationService } =
      require("../../../modules/orders/services/order-cancellation.service") as any
    const cancellations: any = app.get(OrderCancellationService)
    const approved = await cancellations.financeApprove(
      cancellation.id,
      finance.user.id,
      "FINANCE",
      {
        reason: FINANCE_REASON,
        publisherCompensation: {
          amount: "0",
          reason:
            "No publisher credit is payable for this confirmed integrity incident.",
        },
      },
    )
    const refundTransaction = await prisma.transaction.findFirstOrThrow({
      where: { orderId: financial.order.id, type: "REFUND" },
    })
    expect(refundTransaction.amount.toString()).toBe("137.41")
    expect(refundTransaction.currency).toBe("USD")
    expect(approved).toMatchObject({
      status: "APPROVED",
      resolution: "FULL_REFUND",
      responsibility: "SYSTEM",
      financeApprovedByUserId: finance.user.id,
      refundTransactionId: refundTransaction.id,
    })

    for (const forbiddenStatus of [
      "PUBLISHED",
      "DISPUTED",
      "CANCELLED",
      "COMPLETED",
    ]) {
      await expect(
        prisma.order.update({
          where: { id: financial.order.id },
          data: { status: forbiddenStatus },
        }),
      ).rejects.toThrow(
        /approved confirmed fraud case requires the order to remain fully refunded/i,
      )
    }
    await expect(
      prisma.order.update({
        where: { id: financial.order.id },
        data: { refundResponsibility: "PLATFORM" },
      }),
    ).rejects.toThrow(
      /confirmed fraud refund requires its exact linked approved Finance evidence/i,
    )
    await expect(
      prisma.order.findUniqueOrThrow({
        where: { id: financial.order.id },
        select: {
          status: true,
          paymentStatus: true,
          refundResponsibility: true,
        },
      }),
    ).resolves.toEqual({
      status: "REFUNDED",
      paymentStatus: "REFUNDED",
      refundResponsibility: "SYSTEM",
    })

    await expect(
      prisma.orderCancellationRequest.update({
        where: { id: cancellation.id },
        data: { resolutionReason: `${REVIEW_REASON} rewritten` },
      }),
    ).rejects.toThrow(
      /approved confirmed fraud cancellation evidence is append-only/i,
    )
    await expect(
      prisma.orderCancellationRequest.delete({
        where: { id: cancellation.id },
      }),
    ).rejects.toThrow(/linked to confirmed fraud cannot be deleted/i)
    await expect(
      prisma.transaction.update({
        where: { id: refundTransaction.id },
        data: { description: "Rewritten refund evidence" },
      }),
    ).rejects.toThrow(/confirmed fraud refund ledger evidence is append-only/i)
    await expect(
      prisma.transaction.delete({ where: { id: refundTransaction.id } }),
    ).rejects.toThrow(/confirmed fraud refund ledger evidence is append-only/i)

    await expect(
      prisma.orderCancellationRequest.findUniqueOrThrow({
        where: { id: cancellation.id },
      }),
    ).resolves.toMatchObject({
      status: "APPROVED",
      resolutionReason: REVIEW_REASON,
      refundTransactionId: refundTransaction.id,
    })
    await expect(
      prisma.transaction.findUniqueOrThrow({
        where: { id: refundTransaction.id },
      }),
    ).resolves.toMatchObject({
      type: "REFUND",
      currency: "USD",
      description: expect.not.stringMatching(/^Rewritten/),
    })
  })

  it("serializes Finance approval ahead of a concurrent REFUND rewrite", async () => {
    const { financial, finance, cancellation, candidateRefund } =
      await makePendingFinanceFraudFixture()

    let markApprovalReady!: () => void
    let allowApprovalCommit!: () => void
    const approvalReady = new Promise<void>((resolve) => {
      markApprovalReady = resolve
    })
    const approvalMayCommit = new Promise<void>((resolve) => {
      allowApprovalCommit = resolve
    })
    const approval = alternatePrisma.$transaction(async (tx: any) => {
      await tx.order.update({
        where: { id: financial.order.id },
        data: {
          status: "REFUNDED",
          paymentStatus: "REFUNDED",
          refundResponsibility: "SYSTEM",
        },
      })
      await tx.orderCancellationRequest.update({
        where: { id: cancellation.id },
        data: {
          status: "APPROVED",
          financeApprovedByUserId: finance.user.id,
          refundTransactionId: candidateRefund.id,
          resolvedAt: new Date(),
        },
      })
      markApprovalReady()
      await approvalMayCommit
    })
    await approvalReady

    let markRewriteStarted!: (pid: number) => void
    const rewriteStarted = new Promise<number>((resolve) => {
      markRewriteStarted = resolve
    })
    const rewrite = prisma.$transaction(async (tx: any) => {
      const [session] = await tx.$queryRawUnsafe(
        'SELECT pg_catalog.pg_backend_pid()::int AS "pid"',
      )
      markRewriteStarted(session.pid)
      return tx.transaction.update({
        where: { id: candidateRefund.id },
        data: { amount: 138.41 },
      })
    })
    const rewritePid = await rewriteStarted

    let lockWaitError: unknown
    try {
      await waitForDatabaseLock(rewritePid)
    } catch (error) {
      lockWaitError = error
    } finally {
      allowApprovalCommit()
    }

    const [approvalResult, rewriteResult] = await Promise.allSettled([
      approval,
      rewrite,
    ])
    if (lockWaitError) throw lockWaitError
    expect(approvalResult.status).toBe("fulfilled")
    expect(rewriteResult.status).toBe("rejected")
    if (rewriteResult.status === "rejected") {
      expect(String(rewriteResult.reason)).toMatch(
        /confirmed fraud refund ledger evidence is append-only/i,
      )
    }
    await expect(
      prisma.orderCancellationRequest.findUniqueOrThrow({
        where: { id: cancellation.id },
        select: { status: true, refundTransactionId: true },
      }),
    ).resolves.toEqual({
      status: "APPROVED",
      refundTransactionId: candidateRefund.id,
    })
    const persistedRefund = await prisma.transaction.findUniqueOrThrow({
      where: { id: candidateRefund.id },
      select: { amount: true },
    })
    expect(persistedRefund.amount.toString()).toBe("137.41")
  }, 30_000)

  it("aborts one side when REFUND-tuple-first races approval Order-first", async () => {
    const { financial, finance, cancellation, candidateRefund } =
      await makePendingFinanceFraudFixture()

    let markRefundLocked!: () => void
    let allowRefundRewrite!: () => void
    const refundLocked = new Promise<void>((resolve) => {
      markRefundLocked = resolve
    })
    const refundMayRewrite = new Promise<void>((resolve) => {
      allowRefundRewrite = resolve
    })
    const rewrite = alternatePrisma.$transaction(
      async (tx: any) => {
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM public."Transaction" WHERE "id" = $1 FOR UPDATE',
          candidateRefund.id,
        )
        markRefundLocked()
        await refundMayRewrite
        return tx.transaction.update({
          where: { id: candidateRefund.id },
          data: { amount: 138.41 },
        })
      },
      { isolationLevel: "Serializable", timeout: 30_000 },
    )
    await refundLocked

    let markApprovalStarted!: (pid: number) => void
    const approvalStarted = new Promise<number>((resolve) => {
      markApprovalStarted = resolve
    })
    const approval = prisma.$transaction(
      async (tx: any) => {
        const [session] = await tx.$queryRawUnsafe(
          'SELECT pg_catalog.pg_backend_pid()::int AS "pid"',
        )
        markApprovalStarted(session.pid)
        await tx.order.update({
          where: { id: financial.order.id },
          data: {
            status: "REFUNDED",
            paymentStatus: "REFUNDED",
            refundResponsibility: "SYSTEM",
          },
        })
        return tx.orderCancellationRequest.update({
          where: { id: cancellation.id },
          data: {
            status: "APPROVED",
            financeApprovedByUserId: finance.user.id,
            refundTransactionId: candidateRefund.id,
            resolvedAt: new Date(),
          },
        })
      },
      { isolationLevel: "Serializable", timeout: 30_000 },
    )
    const approvalPid = await approvalStarted

    let lockWaitError: unknown
    try {
      await waitForDatabaseLock(approvalPid)
    } catch (error) {
      lockWaitError = error
    } finally {
      allowRefundRewrite()
    }

    const [approvalResult, rewriteResult] = await Promise.allSettled([
      approval,
      rewrite,
    ])
    if (lockWaitError) throw lockWaitError
    expect(
      [approvalResult, rewriteResult].filter(
        (outcome) => outcome.status === "fulfilled",
      ),
    ).toHaveLength(1)
    const rejected = [approvalResult, rewriteResult].find(
      (outcome) => outcome.status === "rejected",
    )
    expect(rejected).toBeDefined()
    if (rejected) expectRetryableDatabaseAbort(rejected)

    const [persistedCancellation, persistedOrder, persistedRefund] =
      await Promise.all([
        prisma.orderCancellationRequest.findUniqueOrThrow({
          where: { id: cancellation.id },
          select: { status: true, refundTransactionId: true },
        }),
        prisma.order.findUniqueOrThrow({
          where: { id: financial.order.id },
          select: { status: true, paymentStatus: true },
        }),
        prisma.transaction.findUniqueOrThrow({
          where: { id: candidateRefund.id },
          select: { amount: true },
        }),
      ])
    const persistedAmount = persistedRefund.amount.toString()
    expect(
      persistedCancellation.status === "APPROVED" &&
        persistedAmount === "138.41",
    ).toBe(false)
    if (persistedCancellation.status === "APPROVED") {
      expect(persistedCancellation.refundTransactionId).toBe(candidateRefund.id)
      expect(persistedOrder).toEqual({
        status: "REFUNDED",
        paymentStatus: "REFUNDED",
      })
      expect(persistedAmount).toBe("137.41")
    } else {
      expect(persistedCancellation).toEqual({
        status: "PENDING_FINANCE",
        refundTransactionId: null,
      })
      expect(persistedOrder).toEqual({
        status: "DELIVERED",
        paymentStatus: "PAID",
      })
      expect(persistedAmount).toBe("138.41")
    }
  }, 30_000)
})
