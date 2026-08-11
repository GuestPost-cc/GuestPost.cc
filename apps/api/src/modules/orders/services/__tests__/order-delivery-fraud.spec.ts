import { ConflictException } from "@nestjs/common"
import { OrderDeliveryService } from "../order-delivery.service"

describe("OrderDeliveryService customer fraud controls", () => {
  const order = {
    id: "order-1",
    organizationId: "organization-1",
    customerId: "customer-1",
    status: "PUBLISHED",
    version: 4,
    activeDeliveryVersionId: "delivery-1",
    website: { publisherId: "publisher-1" },
  }
  const delivery = {
    id: "delivery-1",
    orderId: "order-1",
    publishedUrl: "https://publisher.example/reused",
    normalizedUrl: "https://publisher.example/reused",
    verificationStatus: "MANUAL_REVIEW",
    verificationVersion: 2,
    supersededByVersion: null,
  }

  function setup(holds: any[]) {
    const activeHolds = [...holds]
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: order.id }]),
      $transaction: jest
        .fn()
        .mockImplementation(async (callback: (tx: any) => Promise<unknown>) =>
          callback(prisma),
        ),
      order: {
        findFirst: jest.fn().mockResolvedValue(order),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ status: "DELIVERED" }),
      },
      membership: {
        findFirst: jest.fn().mockResolvedValue({ role: "MEMBER" }),
      },
      orderDeliveryVersion: {
        findUnique: jest.fn().mockResolvedValue(delivery),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      deliveryFraudFlag: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation(({ data }: any) => {
          const created = { id: "fresh-url-reuse-flag", ...data }
          activeHolds.push({
            fraudFlagId: created.id,
            deliveryVersionId: data.deliveryVersionId,
            type: data.type,
          })
          return Promise.resolve(created)
        }),
      },
      deliveryFraudHold: {
        findMany: jest.fn().mockImplementation(async () => activeHolds),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
      staffMembership: {
        findMany: jest.fn().mockResolvedValue([{ userId: "staff-user" }]),
      },
      user: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "staff-user",
            email: "staff@example.test",
            emailVerified: true,
            banned: false,
            notificationPreferences: [],
            emailSuppressions: [],
          },
        ]),
      },
      notification: { upsert: jest.fn().mockResolvedValue({}) },
      communicationEvent: {
        upsert: jest.fn().mockImplementation(({ create }: any) =>
          Promise.resolve({
            id: "communication-url-reuse",
            ...create,
            payload: create.payload ?? null,
          }),
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      communicationDelivery: {
        count: jest.fn().mockResolvedValue(1),
        upsert: jest.fn().mockResolvedValue({
          id: "communication-delivery-url-reuse",
          status: "PENDING",
        }),
      },
      orderEvent: { create: jest.fn().mockResolvedValue({}) },
    }
    const audit = { log: jest.fn().mockResolvedValue(undefined) }
    const review = {
      createSettlementForOrder: jest.fn().mockResolvedValue(undefined),
    }
    const cancellation = {
      assertNoActiveCancellation: jest.fn().mockResolvedValue(undefined),
    }
    const service = new OrderDeliveryService(
      prisma,
      audit as any,
      {} as any,
      review as any,
      cancellation as any,
    )
    return { audit, cancellation, prisma, review, service }
  }

  it("blocks a customer from accepting a reused URL before any lifecycle or money write", async () => {
    const { audit, prisma, review, service } = setup([
      {
        fraudFlagId: "flag-1",
        deliveryVersionId: delivery.id,
        type: "URL_REUSED",
      },
    ])

    const error = await service
      .customerAcceptDelivery(
        order.id,
        order.organizationId,
        order.customerId,
        "MEMBER",
      )
      .catch((value) => value)

    expect(error).toBeInstanceOf(ConflictException)
    expect(error.getResponse()).toEqual({
      code: "DELIVERY_FRAUD_REVIEW_REQUIRED",
      message:
        "This delivery is under security review and cannot be accepted yet. Support will notify you when review is complete.",
    })
    expect(prisma.orderDeliveryVersion.updateMany).not.toHaveBeenCalled()
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
    expect(review.createSettlementForOrder).not.toHaveBeenCalled()
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ORDER_DELIVERY_CUSTOMER_MANUAL_ACCEPT_BLOCKED_FRAUD",
        metadata: expect.objectContaining({
          fraudTypes: ["URL_REUSED"],
          decision: "BLOCKED_PENDING_STAFF_REVIEW",
        }),
      }),
      prisma,
    )
  })

  it("still permits the customer fallback for a technical review with no fraud hold", async () => {
    const { prisma, review, service } = setup([])

    await expect(
      service.customerAcceptDelivery(
        order.id,
        order.organizationId,
        order.customerId,
        "MEMBER",
      ),
    ).resolves.toEqual({ status: "DELIVERED", acceptedBy: "customer" })

    expect(prisma.orderDeliveryVersion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ interventionStatus: "APPROVED" }),
      }),
    )
    expect(prisma.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "DELIVERED",
          verifyMethod: "CUSTOMER_MANUAL",
        }),
      }),
    )
    expect(review.createSettlementForOrder).toHaveBeenCalledWith(
      prisma,
      order.id,
    )
  })

  it("dispatches only dedup keys returned by the committed serializable attempt", async () => {
    const { audit, cancellation, prisma, review } = setup([])
    let transactionAttempt = 0
    prisma.$transaction.mockImplementation(async (callback: any) => {
      transactionAttempt++
      const value = await callback(prisma)
      if (transactionAttempt === 1) throw { code: "P2034" }
      return value
    })
    review.createSettlementForOrder.mockImplementation(async () => [
      `settlement-attempt-${transactionAttempt}`,
    ])
    const communications = {
      customerOrderRecipients: jest.fn().mockResolvedValue(["customer-1"]),
      publisherRecipients: jest.fn().mockResolvedValue(["publisher-user"]),
      record: jest.fn().mockResolvedValue({ eventId: "event" }),
      dispatchManyByDedupKeyBestEffort: jest.fn(),
    }
    const service = new OrderDeliveryService(
      prisma,
      audit as any,
      {} as any,
      review as any,
      cancellation as any,
      communications as any,
    )

    await service.customerAcceptDelivery(
      order.id,
      order.organizationId,
      order.customerId,
      "MEMBER",
    )

    expect(transactionAttempt).toBe(2)
    expect(
      communications.dispatchManyByDedupKeyBestEffort,
    ).toHaveBeenCalledTimes(1)
    expect(
      communications.dispatchManyByDedupKeyBestEffort,
    ).toHaveBeenCalledWith([
      "settlement-attempt-2",
      `order:${order.id}:delivered`,
    ])
  })

  it("creates a fresh hold when an authorized reused URL gains another claimant before manual acceptance", async () => {
    const { audit, prisma, review, service } = setup([])
    prisma.orderDeliveryVersion.findMany.mockResolvedValue([
      { id: "delivery-other-1", orderId: "order-other-1" },
      { id: "delivery-other-2", orderId: "order-other-2" },
    ])
    prisma.orderDeliveryVersion.count.mockResolvedValue(2)
    prisma.deliveryFraudFlag.findMany.mockResolvedValue([
      {
        id: "authorized-url-reuse-flag",
        details: {
          otherOrderId: "order-other-1",
          otherVersionId: "delivery-other-1",
          reuseCount: 1,
        },
        resolution: {
          kind: "STAFF_CLEARED",
          resolvedByUserId: "finance-user",
          resolvedByRole: "FINANCE",
          evidence: {
            adjudicatedDeliveryVersionId: delivery.id,
            fraudType: "URL_REUSED",
            disposition: "AUTHORIZED_REUSE",
            evidenceReference: "CASE-1001",
            roleAtTime: "FINANCE",
          },
        },
      },
    ])

    const error = await service
      .customerAcceptDelivery(
        order.id,
        order.organizationId,
        order.customerId,
        "MEMBER",
      )
      .catch((value) => value)

    expect(error).toBeInstanceOf(ConflictException)
    expect(prisma.deliveryFraudFlag.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId: order.id,
          deliveryVersionId: delivery.id,
          type: "URL_REUSED",
          details: expect.objectContaining({
            reuseCount: 2,
            claimFingerprintVersion: 1,
            claimFingerprint: expect.any(String),
          }),
        }),
      }),
    )
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ORDER_DELIVERY_URL_REUSE_FRESHNESS_FLAGGED",
        }),
      }),
    )
    expect(prisma.orderDeliveryVersion.updateMany).not.toHaveBeenCalled()
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
    expect(review.createSettlementForOrder).not.toHaveBeenCalled()
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ORDER_DELIVERY_CUSTOMER_MANUAL_ACCEPT_BLOCKED_FRAUD",
      }),
      prisma,
    )
    // Canonical Order lock, then normalized-URL advisory lock.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3)
  })
})
