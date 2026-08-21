import { BadRequestException } from "@nestjs/common"
import { SettlementsService } from "./settlements.service"

describe("settlement URL reuse freshness", () => {
  it("commits a fresh URL_REUSED hold before denying an admin money release", async () => {
    const unresolvedFlags: any[] = []
    const order = {
      id: "order-1",
      organizationId: "organization-1",
      customerId: "customer-1",
      status: "DELIVERED",
      version: 4,
      currency: "USD",
      paymentStatus: "PAID",
      activeDeliveryVersionId: "delivery-1",
    }
    const activeDelivery = {
      id: "delivery-1",
      orderId: order.id,
      normalizedUrl: "https://publisher.example/reused",
      supersededByVersion: null,
      verificationStatus: "VERIFIED",
      interventionStatus: "NONE",
    }
    const existingAuthorization = {
      id: "url-reuse-authorized",
      details: {
        otherOrderId: "order-other-1",
        otherVersionId: "delivery-other-1",
        reuseCount: 1,
      },
      resolution: {
        kind: "STAFF_CLEARED",
        resolvedByUserId: "finance-reviewer",
        resolvedByRole: "FINANCE",
        evidence: {
          adjudicatedDeliveryVersionId: activeDelivery.id,
          fraudType: "URL_REUSED",
          disposition: "AUTHORIZED_REUSE",
          evidenceReference: "CASE-1001",
          roleAtTime: "FINANCE",
        },
      },
    }
    const settlement = {
      id: "settlement-1",
      orderId: order.id,
      publisherId: "publisher-1",
      publisherAmount: "80.00",
      currency: "USD",
      status: "CUSTOMER_APPROVED",
      version: 2,
      order,
    }
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: order.id }]),
      order: { findUnique: jest.fn().mockResolvedValue(order) },
      orderDeliveryVersion: {
        findUnique: jest.fn().mockResolvedValue(activeDelivery),
        findMany: jest.fn().mockResolvedValue([
          { id: "delivery-other-1", orderId: "order-other-1" },
          { id: "delivery-other-2", orderId: "order-other-2" },
        ]),
        count: jest.fn().mockResolvedValue(2),
      },
      deliveryFraudFlag: {
        findMany: jest.fn().mockResolvedValue([existingAuthorization]),
        create: jest.fn().mockImplementation(async ({ data }: any) => {
          const created = { id: "url-reuse-fresh", ...data }
          unresolvedFlags.push(created)
          return created
        }),
        count: jest.fn().mockImplementation(async () => unresolvedFlags.length),
      },
      deliveryFraudHold: {
        count: jest.fn().mockImplementation(async () => unresolvedFlags.length),
      },
      orderDispute: { findFirst: jest.fn().mockResolvedValue(null) },
      revision: { findFirst: jest.fn().mockResolvedValue(null) },
      orderCancellationRequest: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
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
      settlement: {
        updateMany: jest.fn(),
      },
    }
    let transactionCommitted = false
    const prisma: any = {
      settlement: { findUnique: jest.fn().mockResolvedValue(settlement) },
      $transaction: jest.fn().mockImplementation(async (operation: any) => {
        const result = await operation(tx)
        transactionCommitted = true
        return result
      }),
    }
    const service = new SettlementsService(
      prisma,
      { log: jest.fn() } as any,
      { enqueueTrustRecompute: jest.fn() } as any,
    )

    const error = await service
      .adminApprove(
        settlement.id,
        "Release after review",
        "finance-user",
        "FINANCE",
      )
      .catch((value) => value)

    expect(error).toBeInstanceOf(BadRequestException)
    expect(error.getResponse()).toEqual(
      expect.objectContaining({ code: "SETTLEMENT_BLOCKED" }),
    )
    expect(transactionCommitted).toBe(true)
    expect(tx.deliveryFraudFlag.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "URL_REUSED",
          details: expect.objectContaining({ reuseCount: 2 }),
        }),
      }),
    )
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ORDER_DELIVERY_URL_REUSE_FRESHNESS_FLAGGED",
          metadata: expect.objectContaining({
            source: "SETTLEMENT_ELIGIBILITY",
          }),
        }),
      }),
    )
    expect(tx.settlement.updateMany).not.toHaveBeenCalled()
  })
})
