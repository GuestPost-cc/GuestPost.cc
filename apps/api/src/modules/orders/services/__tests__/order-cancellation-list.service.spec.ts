import { BadRequestException, ForbiddenException } from "@nestjs/common"
import { OrderCancellationService } from "../order-cancellation.service"

describe("OrderCancellationService cancellation queue reads", () => {
  const requestId = "cm4linkedcancellation123"

  function setup(hasConfirmedFraud = true) {
    const request = {
      id: requestId,
      orderId: "order-1",
      requesterType: "STAFF",
      reasonCode: "LEGAL_OR_SECURITY_EMERGENCY",
      note: null,
      status: "APPROVED",
      previousOrderStatus: "VERIFIED",
      fulfillmentChannel: "PUBLISHER",
      responsibility: "SYSTEM",
      responseDeadlineAt: null,
      responseNote: null,
      createdAt: new Date("2026-08-15T00:00:00.000Z"),
      fraudFindings: hasConfirmedFraud ? [{ id: "finding-1" }] : [],
      order: {
        id: "order-1",
        title: "Linked cancellation",
        status: "REFUNDED",
        amount: "120.00",
        currency: "USD",
        fulfillmentChannel: "PUBLISHER",
        website: {
          id: "website-1",
          domain: "example.test",
          publisherId: "publisher-1",
          ownershipType: "PUBLISHER",
        },
        customer: {
          id: "customer-1",
          name: "Customer",
          email: "customer@example.test",
        },
        settlements: [],
      },
    }
    const prisma = {
      orderCancellationRequest: {
        findMany: jest.fn().mockResolvedValue([request]),
        count: jest.fn().mockResolvedValue(1),
      },
      $transaction: jest
        .fn()
        .mockImplementation(async (operations: Array<Promise<unknown>>) =>
          Promise.all(operations),
        ),
    }
    const service = new OrderCancellationService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
    )
    return { prisma, service }
  }

  it("finds a terminal case by exact ID without bypassing Operations projections", async () => {
    const { prisma, service } = setup()

    const result = await service.listRequests({
      requestId,
      role: "OPERATIONS",
    })

    expect(prisma.orderCancellationRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: requestId },
        include: expect.objectContaining({
          fraudFindings: {
            where: { outcome: "CONFIRMED_FRAUD" },
            select: { id: true },
            take: 1,
          },
        }),
      }),
    )
    expect(prisma.orderCancellationRequest.count).toHaveBeenCalledWith({
      where: { id: requestId },
    })
    expect(result).toMatchObject({
      total: 1,
      take: 50,
      skip: 0,
      items: [
        {
          id: requestId,
          status: "APPROVED",
          requiresConfirmedFraudFullRefund: true,
          order: {
            id: "order-1",
            customer: { id: "customer-1", name: "Customer" },
          },
        },
      ],
    })
    expect(result.items[0].order).not.toHaveProperty("amount")
    expect(result.items[0].order.customer).not.toHaveProperty("email")
    expect(result.items[0]).not.toHaveProperty("publisherCompensationPolicy")
    expect(result.items[0]).not.toHaveProperty("fraudFindings")
  })

  it("returns an explicit false capability when no confirmed finding is linked", async () => {
    const { service } = setup(false)

    const result = await service.listRequests({
      requestId,
      role: "FINANCE",
    })

    expect(result.items[0]).toMatchObject({
      id: requestId,
      requiresConfirmedFraudFullRefund: false,
    })
    expect(result.items[0]).not.toHaveProperty("fraudFindings")
  })

  it("returns the financial allowlist to Finance without exposing staff-only fields", async () => {
    const { service } = setup()

    const result = await service.listRequests({
      requestId,
      role: "FINANCE",
    })

    expect(result.items[0].order).toMatchObject({
      amount: "120.00",
      currency: "USD",
      customer: {
        id: "customer-1",
        name: "Customer",
      },
    })
    expect(result.items[0].order.customer).not.toHaveProperty("email")
    expect(result.items[0].order).not.toHaveProperty("paymentStatus")
    expect(result.items[0].order).not.toHaveProperty("targetUrl")
    expect(result.items[0].order).not.toHaveProperty("briefData")
  })

  it("returns customer email only to Super Admin", async () => {
    const { service } = setup()

    const result = await service.listRequests({
      requestId,
      role: "SUPER_ADMIN",
    })

    expect(result.items[0].order.customer).toMatchObject({
      email: "customer@example.test",
    })
  })

  it.each([
    "",
    "../cancel-1",
    "cancel id",
    "x".repeat(129),
  ])("rejects an invalid exact request ID (%s)", async (invalidRequestId) => {
    const { prisma, service } = setup()

    await expect(
      service.listRequests({
        requestId: invalidRequestId,
        role: "OPERATIONS",
      }),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(prisma.orderCancellationRequest.findMany).not.toHaveBeenCalled()
  })

  it("retains durable staff authorization for exact reads", async () => {
    const { prisma, service } = setup()

    await expect(
      service.listRequests({ requestId, role: "CUSTOMER" }),
    ).rejects.toBeInstanceOf(ForbiddenException)
    expect(prisma.orderCancellationRequest.findMany).not.toHaveBeenCalled()
  })
})
