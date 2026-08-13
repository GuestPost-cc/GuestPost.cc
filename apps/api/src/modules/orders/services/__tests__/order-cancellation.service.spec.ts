import {
  CancellationReasonCode,
  CancellationResponsibility,
} from "@guestpost/database"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from "@nestjs/common"
import { CancellationResponseAction } from "../../dto/order-cancellation.dto"
import { OrderCancellationService } from "../order-cancellation.service"

describe("OrderCancellationService", () => {
  let prisma: any
  let refund: any
  let audit: any
  let queue: any
  let service: OrderCancellationService

  const order = {
    id: "order-1",
    customerId: "customer-1",
    organizationId: "org-1",
    status: "ACCEPTED",
    paymentStatus: "PAID",
    amount: 100,
    currency: "USD",
    version: 4,
    fulfillmentChannel: "PUBLISHER",
    listingId: "listing-1",
    listingServiceId: "service-1",
    website: {
      ownershipType: "PUBLISHER",
      publisherId: "publisher-1",
      domain: "example.com",
    },
    cancellationRequests: [],
    dispute: null,
  }

  beforeEach(() => {
    prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue(order),
        findUniqueOrThrow: jest.fn().mockResolvedValue(order),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      orderCancellationRequest: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: "cancel-1",
          orderId: "order-1",
          status: "REQUESTED",
        }),
      },
      orderEvent: { create: jest.fn().mockResolvedValue({}) },
      membership: {
        findUnique: jest.fn().mockResolvedValue({
          role: "MEMBER",
          status: "ACTIVE",
          user: { banned: false, userType: "CUSTOMER" },
        }),
      },
      publisherMembership: {
        findUnique: jest.fn().mockResolvedValue({
          role: "PUBLISHER_OWNER",
          user: { banned: false, userType: "PUBLISHER" },
        }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      staffMembership: {
        findUnique: jest.fn().mockResolvedValue({
          role: "OPERATIONS",
          user: { banned: false, userType: "STAFF" },
        }),
      },
      fulfillmentAssignment: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      wallet: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      transaction: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: "release-transaction-1" }),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ id: "order-1" }]),
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: "wallet-1" }]),
      $transaction: jest
        .fn()
        .mockImplementation(async (callback: any) => callback(prisma)),
    }
    refund = {
      refundOrderInTransaction: jest.fn(),
      dispatchOrderRefundCommunicationsBestEffort: jest.fn(),
    }
    audit = { log: jest.fn().mockResolvedValue(undefined) }
    queue = { enqueueTrustRecompute: jest.fn().mockResolvedValue(undefined) }
    service = new OrderCancellationService(prisma, refund, audit, queue)
  })

  it("rejects an emergency force-cancel without a meaningful audit note", async () => {
    await expect(
      service.forceCancel("order-1", "admin-1", {
        reasonCode: CancellationReasonCode.LEGAL_OR_SECURITY_EMERGENCY,
        expectedVersion: 4,
        confirmationOrderId: "order-1",
        responsibility: CancellationResponsibility.SYSTEM,
        note: "Too short",
      }),
    ).rejects.toBeInstanceOf(BadRequestException)

    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it("locks the order aggregate before an emergency paid refund", async () => {
    refund.refundOrderInTransaction.mockResolvedValue({
      order: { ...order, status: "REFUNDED" },
      refundTransactionId: "refund-1",
    })

    await service.forceCancel("order-1", "admin-1", {
      reasonCode: CancellationReasonCode.LEGAL_OR_SECURITY_EMERGENCY,
      expectedVersion: 4,
      confirmationOrderId: "order-1",
      responsibility: CancellationResponsibility.SYSTEM,
      note: "Verified legal emergency requiring an immediate cancellation.",
    })

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1)
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      refund.refundOrderInTransaction.mock.invocationCallOrder[0],
    )
  })

  it("returns a request action after the acceptance boundary", async () => {
    const preview = await service.preview("order-1", {
      userId: "customer-1",
      kind: "CUSTOMER",
      organizationId: "org-1",
      customerRole: "MEMBER",
    })

    expect(preview.action).toBe("REQUEST_CANCELLATION")
    expect(preview.refund.type).toBe("NONE")
    expect(preview.expectedVersion).toBe(4)
  })

  it("claims the order version when creating a cancellation hold", async () => {
    await service.createRequest(
      "order-1",
      {
        userId: "customer-1",
        kind: "CUSTOMER",
        organizationId: "org-1",
        customerRole: "MEMBER",
      },
      {
        reasonCode: CancellationReasonCode.CUSTOMER_CHANGED_MIND,
        expectedVersion: 4,
        note: "Campaign was stopped",
      },
    )

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: "order-1", version: 4, status: "ACCEPTED" },
      data: { version: { increment: 1 } },
    })
    expect(prisma.orderCancellationRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId: "order-1",
          requesterType: "CUSTOMER",
          responsibility: "CUSTOMER",
        }),
      }),
    )
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.order.updateMany.mock.invocationCallOrder[0],
    )
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.orderCancellationRequest.create.mock.invocationCallOrder[0],
    )
  })

  it("re-checks membership in the locked transaction before creating a cancellation", async () => {
    prisma.membership.findUnique.mockResolvedValue(null)

    await expect(
      service.createRequest(
        "order-1",
        {
          userId: "customer-1",
          kind: "CUSTOMER",
          organizationId: "org-1",
          customerRole: "MEMBER",
        },
        {
          reasonCode: CancellationReasonCode.CUSTOMER_CHANGED_MIND,
          expectedVersion: 4,
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException)

    expect(prisma.order.updateMany).not.toHaveBeenCalled()
    expect(prisma.orderCancellationRequest.create).not.toHaveBeenCalled()
  })

  it("blocks fulfillment while an active case exists", async () => {
    prisma.orderCancellationRequest.findFirst.mockResolvedValue({
      id: "cancel-1",
      status: "UNDER_REVIEW",
    })

    await expect(
      service.assertNoActiveCancellation("order-1"),
    ).rejects.toBeInstanceOf(ConflictException)
  })

  it("requires a publisher owner to request cancellation", async () => {
    await expect(
      service.createRequest(
        "order-1",
        {
          userId: "publisher-member-1",
          kind: "PUBLISHER",
          publisherId: "publisher-1",
          publisherRole: "PUBLISHER_MEMBER",
        },
        {
          reasonCode: CancellationReasonCode.CAPACITY_UNAVAILABLE,
          expectedVersion: 4,
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException)

    expect(prisma.order.updateMany).not.toHaveBeenCalled()
  })

  it("does not advertise owner-only actions to publisher members", async () => {
    const preview = await service.preview("order-1", {
      userId: "publisher-member-1",
      kind: "PUBLISHER",
      publisherId: "publisher-1",
      publisherRole: "PUBLISHER_MEMBER",
    })

    expect(preview.actorCanMutate).toBe(false)
    expect(preview.action).toBe("NOT_ALLOWED")
  })

  it("only lets the assigned Operations user answer a platform request", async () => {
    prisma.orderCancellationRequest.findFirst.mockResolvedValue({
      id: "cancel-1",
      orderId: "order-1",
      status: "REQUESTED",
      requesterType: "CUSTOMER",
      fulfillmentChannel: "PLATFORM",
      order: {
        ...order,
        fulfillmentChannel: "PLATFORM",
        website: {
          ...order.website,
          ownershipType: "PLATFORM",
          publisherId: null,
        },
        fulfillmentAssignments: [{ assignedToUserId: "ops-assigned" }],
      },
    })

    await expect(
      service.respond(
        "order-1",
        "cancel-1",
        {
          userId: "ops-other",
          kind: "STAFF",
          staffRole: "OPERATIONS",
        },
        { action: CancellationResponseAction.CONTEST },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException)
  })

  it("resolves mutually accepted unattributed requests as shared", async () => {
    const request = {
      id: "cancel-1",
      orderId: "order-1",
      status: "REQUESTED",
      requesterType: "CUSTOMER",
      reasonCode: CancellationReasonCode.OTHER,
      responsibility: CancellationResponsibility.UNDETERMINED,
      fulfillmentChannel: "PUBLISHER",
      order,
    }
    prisma.orderCancellationRequest.findFirst.mockResolvedValue(request)
    prisma.orderCancellationRequest.updateMany = jest
      .fn()
      .mockResolvedValue({ count: 1 })
    prisma.orderCancellationRequest.findUniqueOrThrow = jest
      .fn()
      .mockResolvedValue({ ...request, status: "APPROVED" })
    refund.refundOrderInTransaction.mockResolvedValue({
      order: { ...order, status: "REFUNDED" },
      refundTransactionId: "refund-1",
    })

    await service.respond(
      "order-1",
      "cancel-1",
      {
        userId: "publisher-owner-1",
        kind: "PUBLISHER",
        publisherId: "publisher-1",
        publisherRole: "PUBLISHER_OWNER",
      },
      { action: CancellationResponseAction.ACCEPT },
    )

    expect(refund.refundOrderInTransaction).toHaveBeenCalledWith(
      prisma,
      order,
      expect.stringContaining("Mutually accepted cancellation"),
      "publisher-owner-1",
      "cancellation-request:cancel-1",
      "SHARED",
    )
    expect(prisma.orderCancellationRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ responsibility: "SHARED" }),
      }),
    )
  })

  it("re-checks counterparty authority before issuing a cancellation refund", async () => {
    const request = {
      id: "cancel-1",
      orderId: "order-1",
      status: "REQUESTED",
      requesterType: "CUSTOMER",
      reasonCode: CancellationReasonCode.OTHER,
      responsibility: CancellationResponsibility.UNDETERMINED,
      fulfillmentChannel: "PUBLISHER",
      order,
    }
    prisma.orderCancellationRequest.findFirst.mockResolvedValue(request)
    prisma.publisherMembership.findUnique.mockResolvedValue(null)

    await expect(
      service.respond(
        "order-1",
        "cancel-1",
        {
          userId: "publisher-owner-1",
          kind: "PUBLISHER",
          publisherId: "publisher-1",
          publisherRole: "PUBLISHER_OWNER",
        },
        { action: CancellationResponseAction.ACCEPT },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException)

    expect(refund.refundOrderInTransaction).not.toHaveBeenCalled()
    expect(prisma.orderEvent.create).not.toHaveBeenCalled()
  })

  it("requires Operations to claim a platform order before requesting cancellation", async () => {
    prisma.order.findUnique.mockResolvedValue({
      ...order,
      fulfillmentChannel: "PLATFORM",
      website: {
        ...order.website,
        ownershipType: "PLATFORM",
        publisherId: null,
      },
      fulfillmentAssignments: [{ assignedToUserId: "ops-assigned" }],
    })

    await expect(
      service.createRequest(
        "order-1",
        {
          userId: "ops-other",
          kind: "STAFF",
          staffRole: "OPERATIONS",
        },
        {
          reasonCode: CancellationReasonCode.PLATFORM_ERROR,
          expectedVersion: 4,
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException)

    expect(prisma.order.updateMany).not.toHaveBeenCalled()
  })

  it("cancels a draft and its stale platform assignment atomically", async () => {
    prisma.order.findUnique.mockResolvedValue({
      ...order,
      status: "DRAFT",
      paymentStatus: "PENDING",
      version: 1,
      fulfillmentChannel: "PLATFORM",
      cancellationRequests: [],
    })
    prisma.order.findUniqueOrThrow.mockResolvedValue({
      ...order,
      status: "CANCELLED",
    })

    await service.cancelNow(
      "order-1",
      {
        userId: "customer-1",
        kind: "CUSTOMER",
        organizationId: "org-1",
        customerRole: "MEMBER",
      },
      {
        reasonCode: CancellationReasonCode.CUSTOMER_CHANGED_MIND,
        expectedVersion: 1,
      },
    )

    expect(prisma.fulfillmentAssignment.updateMany).toHaveBeenCalledWith({
      where: {
        orderId: "order-1",
        status: { in: ["ASSIGNED", "IN_PROGRESS"] },
      },
      data: { status: "CANCELLED", version: { increment: 1 } },
    })
    expect(prisma.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "CANCELLED" }),
      }),
    )
  })

  it("repairs a legacy customer-cancel refund on exact authorized replay", async () => {
    const refundedOrder = {
      ...order,
      status: "REFUNDED",
      paymentStatus: "REFUNDED",
      refundResponsibility: "CUSTOMER",
      version: 5,
    }
    prisma.order.findUnique.mockResolvedValue(refundedOrder)
    prisma.transaction.findFirst.mockResolvedValue({
      id: "refund-legacy-1",
      type: "REFUND",
      orderId: "order-1",
      reference: "customer-cancel:order-1:cancel-command-1",
    })
    refund.refundOrderInTransaction.mockResolvedValue({
      order: refundedOrder,
      refundTransactionId: "refund-legacy-1",
    })

    const replay = await service.cancelNow(
      "order-1",
      {
        userId: "customer-1",
        kind: "CUSTOMER",
        organizationId: "org-1",
        customerRole: "MEMBER",
      },
      {
        reasonCode: CancellationReasonCode.CUSTOMER_CHANGED_MIND,
        expectedVersion: 4,
        idempotencyKey: "cancel-command-1",
      },
    )

    expect(replay).toBe(refundedOrder)
    expect(refund.refundOrderInTransaction).toHaveBeenCalledWith(
      prisma,
      refundedOrder,
      CancellationReasonCode.CUSTOMER_CHANGED_MIND,
      "customer-1",
      "customer-cancel:order-1:cancel-command-1",
      "SYSTEM",
    )
  })

  it("denies a cross-tenant idempotent cancellation replay before lookup", async () => {
    prisma.order.findUnique.mockResolvedValue({
      ...order,
      organizationId: "org-other",
      status: "REFUNDED",
      paymentStatus: "REFUNDED",
    })
    prisma.transaction.findFirst.mockResolvedValue({
      id: "refund-other-tenant",
      type: "REFUND",
      orderId: "order-1",
    })

    await expect(
      service.cancelNow(
        "order-1",
        {
          userId: "customer-1",
          kind: "CUSTOMER",
          organizationId: "org-1",
          customerRole: "MEMBER",
        },
        {
          reasonCode: CancellationReasonCode.CUSTOMER_CHANGED_MIND,
          expectedVersion: 4,
          idempotencyKey: "known-command",
        },
      ),
    ).rejects.toThrow("Order not found")
    expect(prisma.transaction.findFirst).not.toHaveBeenCalled()
    expect(refund.refundOrderInTransaction).not.toHaveBeenCalled()
  })

  it("blocks reserved-wallet releases while finance is locked", async () => {
    const previousMode = process.env.FINANCE_RUNTIME_MODE
    process.env.FINANCE_RUNTIME_MODE = "locked"
    prisma.order.findUnique.mockResolvedValue({
      ...order,
      status: "PENDING_PAYMENT",
      paymentStatus: "PENDING",
      version: 1,
      cancellationRequests: [],
    })

    try {
      await expect(
        service.cancelNow(
          "order-1",
          {
            userId: "customer-1",
            kind: "CUSTOMER",
            organizationId: "org-1",
            customerRole: "MEMBER",
          },
          {
            reasonCode: CancellationReasonCode.CUSTOMER_CHANGED_MIND,
            expectedVersion: 1,
          },
        ),
      ).rejects.toBeInstanceOf(ServiceUnavailableException)
    } finally {
      if (previousMode === undefined) {
        delete process.env.FINANCE_RUNTIME_MODE
      } else {
        process.env.FINANCE_RUNTIME_MODE = previousMode
      }
    }

    expect(prisma.wallet.findUnique).not.toHaveBeenCalled()
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
  })

  it("records the reservation release in the ledger atomically", async () => {
    const pendingOrder = {
      ...order,
      status: "PENDING_PAYMENT",
      paymentStatus: "PENDING",
      version: 1,
      cancellationRequests: [],
    }
    prisma.order.findUnique.mockResolvedValue(pendingOrder)
    prisma.wallet.findUnique.mockResolvedValue({ id: "wallet-1" })
    prisma.wallet.findUniqueOrThrow.mockResolvedValue({
      id: "wallet-1",
      organizationId: "org-1",
      currency: "USD",
      availableBalance: 0,
      reservedBalance: 100,
      version: 7,
    })
    prisma.transaction.findMany.mockResolvedValue([
      {
        id: "reservation-transaction-1",
        type: "RESERVATION",
        amount: -100,
        currency: "USD",
        publisherId: null,
        settlementId: null,
        provider: null,
        providerRef: null,
      },
    ])

    await service.cancelNow(
      "order-1",
      {
        userId: "customer-1",
        kind: "CUSTOMER",
        organizationId: "org-1",
        customerRole: "MEMBER",
      },
      {
        reasonCode: CancellationReasonCode.CUSTOMER_CHANGED_MIND,
        expectedVersion: 1,
      },
    )

    expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith(
      'SELECT "id" FROM "Wallet" WHERE "id" = $1 FOR UPDATE',
      "wallet-1",
    )
    expect(prisma.wallet.updateMany).toHaveBeenCalledWith({
      where: { id: "wallet-1", version: 7 },
      data: {
        reservedBalance: { decrement: expect.anything() },
        availableBalance: { increment: expect.anything() },
        version: { increment: 1 },
      },
    })
    expect(prisma.transaction.findMany).toHaveBeenCalledWith({
      where: {
        orderId: "order-1",
        walletId: "wallet-1",
        type: { in: ["RESERVATION", "PURCHASE", "RELEASE"] },
      },
      select: expect.objectContaining({
        id: true,
        type: true,
        amount: true,
      }),
    })
    expect(prisma.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        walletId: "wallet-1",
        orderId: "order-1",
        type: "RELEASE",
        currency: "USD",
        reference: "reservation-release:order-1",
      }),
    })
  })

  it("does not release another order's aggregate reservation", async () => {
    const pendingOrder = {
      ...order,
      status: "PENDING_PAYMENT",
      paymentStatus: "PENDING",
      version: 1,
      cancellationRequests: [],
    }
    prisma.order.findUnique.mockResolvedValue(pendingOrder)
    prisma.wallet.findUnique.mockResolvedValue({ id: "wallet-1" })
    prisma.wallet.findUniqueOrThrow.mockResolvedValue({
      id: "wallet-1",
      organizationId: "org-1",
      currency: "USD",
      availableBalance: 0,
      reservedBalance: 100,
      version: 7,
    })
    prisma.transaction.findMany.mockResolvedValue([])

    await expect(
      service.cancelNow(
        "order-1",
        {
          userId: "customer-1",
          kind: "CUSTOMER",
          organizationId: "org-1",
          customerRole: "MEMBER",
        },
        {
          reasonCode: CancellationReasonCode.CUSTOMER_CHANGED_MIND,
          expectedVersion: 1,
        },
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "RESERVATION_LEDGER_MISMATCH",
      }),
    })
    expect(prisma.wallet.updateMany).not.toHaveBeenCalled()
    expect(prisma.transaction.create).not.toHaveBeenCalled()
  })

  it("attributes a server-verified acceptance timeout to the fulfiller", async () => {
    const submittedOrder = {
      ...order,
      status: "SUBMITTED",
      version: 5,
      fulfillmentChannel: "PLATFORM",
      submittedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      website: { ...order.website, ownershipType: "PLATFORM" },
    }
    prisma.order.findUnique.mockResolvedValue(submittedOrder)
    refund.refundOrderInTransaction.mockResolvedValue({
      order: { ...submittedOrder, status: "REFUNDED" },
      refundTransactionId: "refund-1",
    })

    await service.cancelNow(
      "order-1",
      {
        userId: "customer-1",
        kind: "CUSTOMER",
        organizationId: "org-1",
        customerRole: "MEMBER",
      },
      {
        reasonCode: CancellationReasonCode.MISSED_DEADLINE,
        expectedVersion: 5,
      },
    )

    expect(refund.refundOrderInTransaction).toHaveBeenCalledWith(
      prisma,
      submittedOrder,
      CancellationReasonCode.MISSED_DEADLINE,
      "customer-1",
      "customer-cancel:order-1:5",
      "PLATFORM",
    )
  })

  it("rejects a customer deadline claim before the server deadline", async () => {
    prisma.order.findUnique.mockResolvedValue({
      ...order,
      status: "SUBMITTED",
      version: 5,
      submittedAt: new Date(),
    })

    await expect(
      service.cancelNow(
        "order-1",
        {
          userId: "customer-1",
          kind: "CUSTOMER",
          organizationId: "org-1",
          customerRole: "MEMBER",
        },
        {
          reasonCode: CancellationReasonCode.MISSED_DEADLINE,
          expectedVersion: 5,
        },
      ),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(refund.refundOrderInTransaction).not.toHaveBeenCalled()
  })
})
