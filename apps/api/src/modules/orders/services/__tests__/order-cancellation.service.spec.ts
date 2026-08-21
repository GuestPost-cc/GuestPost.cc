import {
  CancellationReasonCode,
  CancellationResolution,
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
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        create: jest.fn().mockResolvedValue({
          id: "cancel-1",
          orderId: "order-1",
          status: "REQUESTED",
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      orderEvent: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
      auditLog: { findMany: jest.fn().mockResolvedValue([]) },
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
      deliveryFraudFinding: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      orderDispute: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: "dispute-1" }),
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

  it("cannot bypass a confirmed-fraud Finance case through emergency force-cancel", async () => {
    prisma.deliveryFraudFinding.findFirst.mockResolvedValue({
      cancellationRequestId: "fraud-cancellation-1",
    })

    await expect(
      service.forceCancel("order-1", "admin-1", {
        reasonCode: CancellationReasonCode.LEGAL_OR_SECURITY_EMERGENCY,
        expectedVersion: 4,
        confirmationOrderId: "order-1",
        responsibility: CancellationResponsibility.SYSTEM,
        note: "Verified legal emergency requiring an immediate cancellation.",
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "CONFIRMED_FRAUD_FINANCE_WORKFLOW_REQUIRED",
      }),
    })

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1)
    expect(refund.refundOrderInTransaction).not.toHaveBeenCalled()
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
    expect(prisma.orderEvent.create).not.toHaveBeenCalled()
    expect(audit.log).not.toHaveBeenCalled()
  })

  it("passes the locked post-publication compensation decision into Finance approval", async () => {
    const request = {
      id: "cancel-1",
      orderId: order.id,
      status: "PENDING_FINANCE",
      responsibility: "PLATFORM",
      resolution: "FULL_REFUND",
      resolutionReason: "Operations confirmed the security cancellation.",
      previousOrderStatus: "PUBLISHED",
      order: { ...order, status: "PUBLISHED" },
    }
    prisma.orderCancellationRequest.findUnique.mockResolvedValue(request)
    prisma.orderCancellationRequest.findUniqueOrThrow.mockResolvedValue({
      ...request,
      status: "APPROVED",
    })
    refund.refundOrderInTransaction.mockResolvedValue({
      order: { ...request.order, status: "REFUNDED" },
      refundTransactionId: "refund-1",
    })
    prisma.$queryRaw.mockResolvedValue([
      { role: "FINANCE", banned: false, userType: "STAFF" },
    ])

    await service.financeApprove("cancel-1", "finance-1", "FINANCE", {
      reason:
        "Finance verified the fraud evidence and approved the final refund.",
      publisherCompensation: {
        amount: "80.25",
        reason:
          "Platform-funded compensation for completed publisher delivery work.",
      },
    })

    expect(refund.refundOrderInTransaction).toHaveBeenCalledWith(
      prisma,
      request.order,
      expect.stringContaining("Finance verified the fraud evidence"),
      "finance-1",
      "cancellation-request:cancel-1",
      "PLATFORM",
      {
        amount: "80.25",
        reason:
          "Platform-funded compensation for completed publisher delivery work.",
        effectiveOrderStatus: "PUBLISHED",
      },
    )
  })

  it.each([
    ["a concurrent role demotion", "OPERATIONS", false, "STAFF"],
    ["a concurrent account ban", "FINANCE", true, "STAFF"],
    ["a concurrent user-type change", "FINANCE", false, "CUSTOMER"],
  ])("fails closed after %s reaches the locked authority read", async (_label, role, banned, userType) => {
    prisma.orderCancellationRequest.findUnique.mockResolvedValue({
      id: "cancel-1",
      orderId: order.id,
      status: "PENDING_FINANCE",
      responsibility: "PLATFORM",
      previousOrderStatus: "PUBLISHED",
      order: { ...order, status: "DISPUTED" },
    })
    // The first raw query is the canonical Order lock. The second is the
    // live authority lock/read after a concurrent staff mutation commits.
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: order.id }])
      .mockResolvedValueOnce([{ role, banned, userType }])

    await expect(
      service.financeApprove("cancel-1", "finance-1", "FINANCE", {
        reason: "Finance reviewed the case and approved the customer refund.",
        publisherCompensation: {
          amount: "50.00",
          reason:
            "Publisher completed contract work before the platform failure.",
        },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException)

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2)
    expect(refund.refundOrderInTransaction).not.toHaveBeenCalled()
    expect(prisma.orderCancellationRequest.update).not.toHaveBeenCalled()
  })

  it("replays the exact committed Finance approval and repairs only its audience projections", async () => {
    const financeReason =
      "Finance verified the fraud evidence and approved the final refund."
    const approved = {
      id: "cancel-1",
      orderId: order.id,
      status: "APPROVED",
      resolution: "FULL_REFUND",
      responsibility: "PLATFORM",
      resolutionReason: "Operations confirmed the security cancellation.",
      previousOrderStatus: "PUBLISHED",
      financeApprovedByUserId: "finance-1",
      refundTransactionId: "refund-1",
      resolvedAt: new Date("2026-08-15T00:00:00.000Z"),
      order: {
        ...order,
        status: "REFUNDED",
        paymentStatus: "REFUNDED",
        refundResponsibility: "PLATFORM",
      },
    }
    prisma.orderCancellationRequest.findUnique.mockResolvedValue(approved)
    prisma.orderCancellationRequest.findUniqueOrThrow.mockResolvedValue(
      approved,
    )
    prisma.$queryRaw.mockResolvedValue([
      { role: "FINANCE", banned: false, userType: "STAFF" },
    ])
    prisma.orderEvent.findMany.mockResolvedValue([
      {
        actorId: "finance-1",
        message: "Cancellation refund approved by Finance",
        metadata: {
          requestId: approved.id,
          responsibility: "PLATFORM",
          refundTransactionId: "refund-1",
        },
      },
    ])
    prisma.auditLog.findMany.mockResolvedValue([
      {
        metadata: {
          orderId: order.id,
          responsibility: "PLATFORM",
          refundTransactionId: "refund-1",
          reason: financeReason,
        },
      },
    ])
    refund.refundOrderInTransaction.mockResolvedValue({
      order: approved.order,
      refundTransactionId: "refund-1",
    })
    const communications = {
      customerOrderRecipients: jest.fn().mockResolvedValue(["customer-user-1"]),
      publisherRecipients: jest.fn().mockResolvedValue(["publisher-user-1"]),
      record: jest.fn().mockResolvedValue({ eventId: "communication-1" }),
      dispatchByDedupKeyBestEffort: jest.fn(),
    }
    const replayService = new OrderCancellationService(
      prisma,
      refund,
      audit,
      queue,
      communications as any,
    )

    const result = await replayService.financeApprove(
      approved.id,
      "finance-1",
      "FINANCE",
      {
        reason: financeReason,
        publisherCompensation: {
          amount: "80.25",
          reason:
            "Platform-funded compensation for completed publisher delivery work.",
        },
      },
    )

    expect(result).toBe(approved)
    expect(refund.refundOrderInTransaction).toHaveBeenCalledTimes(1)
    expect(prisma.orderCancellationRequest.update).not.toHaveBeenCalled()
    expect(prisma.orderEvent.create).not.toHaveBeenCalled()
    expect(audit.log).not.toHaveBeenCalled()
    expect(communications.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ORDER_CANCELLATION_RESOLVED",
        dedupKey: "cancel-request:cancel-1:order_cancellation_resolved",
      }),
      prisma,
    )
  })

  it("replays an ordinary non-post-publication approval without inventing a compensation intent", async () => {
    const financeReason =
      "Finance verified the cancellation and approved the customer refund."
    let current: any = {
      id: "cancel-ordinary",
      orderId: order.id,
      status: "PENDING_FINANCE",
      resolution: "FULL_REFUND",
      responsibility: "PLATFORM",
      resolutionReason: "Operations approved the pre-publication cancellation.",
      previousOrderStatus: "ACCEPTED",
      fulfillmentChannel: "PUBLISHER",
      financeApprovedByUserId: null,
      refundTransactionId: null,
      resolvedAt: null,
      order: {
        ...order,
        status: "DISPUTED",
        settlements: [],
      },
    }
    prisma.orderCancellationRequest.findUnique.mockImplementation(() =>
      Promise.resolve(current),
    )
    prisma.orderCancellationRequest.findUniqueOrThrow.mockImplementation(() =>
      Promise.resolve(current),
    )
    prisma.orderCancellationRequest.update.mockImplementation(
      ({ data }: any) => {
        current = {
          ...current,
          ...data,
          order: {
            ...current.order,
            status: "REFUNDED",
            paymentStatus: "REFUNDED",
            refundResponsibility: "PLATFORM",
          },
        }
        return Promise.resolve(current)
      },
    )
    prisma.$queryRaw.mockResolvedValue([
      { role: "FINANCE", banned: false, userType: "STAFF" },
    ])
    refund.refundOrderInTransaction.mockResolvedValue({
      order: { ...current.order, status: "REFUNDED" },
      refundTransactionId: "refund-ordinary",
    })

    await service.financeApprove(current.id, "finance-1", "FINANCE", {
      reason: financeReason,
    })

    prisma.orderEvent.findMany.mockResolvedValue([
      {
        actorId: "finance-1",
        message: "Cancellation refund approved by Finance",
        metadata: {
          requestId: current.id,
          responsibility: "PLATFORM",
          refundTransactionId: "refund-ordinary",
        },
      },
    ])
    prisma.auditLog.findMany.mockResolvedValue([
      {
        metadata: {
          orderId: order.id,
          responsibility: "PLATFORM",
          refundTransactionId: "refund-ordinary",
          reason: financeReason,
        },
      },
    ])

    const replay = await service.financeApprove(
      current.id,
      "finance-1",
      "FINANCE",
      { reason: financeReason },
    )

    expect(replay.status).toBe("APPROVED")
    expect(refund.refundOrderInTransaction).toHaveBeenCalledTimes(2)
    for (const call of refund.refundOrderInTransaction.mock.calls) {
      expect(call[6]).toBeUndefined()
    }
    expect(prisma.orderCancellationRequest.update).toHaveBeenCalledTimes(1)
  })

  it("requires a publisher disposition when a pre-publication snapshot has an active settlement", async () => {
    const request = {
      id: "cancel-settled-1",
      orderId: order.id,
      status: "PENDING_FINANCE",
      resolution: "FULL_REFUND",
      responsibility: "PLATFORM",
      resolutionReason: "Operations approved cancellation after settlement.",
      previousOrderStatus: "ACCEPTED",
      fulfillmentChannel: "PUBLISHER",
      order: {
        ...order,
        status: "DISPUTED",
        settlements: [{ id: "settlement-1" }],
      },
    }
    prisma.orderCancellationRequest.findUnique.mockResolvedValue(request)
    prisma.orderCancellationRequest.findUniqueOrThrow.mockResolvedValue({
      ...request,
      status: "APPROVED",
    })
    prisma.$queryRaw.mockResolvedValue([
      { role: "FINANCE", banned: false, userType: "STAFF" },
    ])
    refund.refundOrderInTransaction.mockResolvedValue({
      order: { ...request.order, status: "REFUNDED" },
      refundTransactionId: "refund-settled-1",
    })

    await service.financeApprove(request.id, "finance-1", "FINANCE", {
      reason:
        "Finance verified the settlement and approved the customer refund.",
      publisherCompensation: {
        amount: "40.00",
        reason:
          "Publisher compensation reflects work represented by the active settlement.",
      },
    })

    expect(refund.refundOrderInTransaction).toHaveBeenCalledWith(
      prisma,
      request.order,
      expect.any(String),
      "finance-1",
      `cancellation-request:${request.id}`,
      "PLATFORM",
      {
        amount: "40.00",
        reason:
          "Publisher compensation reflects work represented by the active settlement.",
        effectiveOrderStatus: "ACCEPTED",
      },
    )
    expect(prisma.orderCancellationRequest.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          order: expect.objectContaining({
            include: expect.objectContaining({
              settlements: expect.objectContaining({
                where: { status: { not: "CANCELLED" } },
                take: 1,
              }),
            }),
          }),
        }),
      }),
    )
  })

  it.each([
    CancellationResolution.CONTINUE_ORDER,
    CancellationResolution.ESCALATE_TO_DISPUTE,
  ])("rejects %s for a cancellation linked to confirmed fraud", async (resolution) => {
    const request = {
      id: "cancel-fraud-1",
      orderId: order.id,
      status: "UNDER_REVIEW",
      previousOrderStatus: "ACCEPTED",
      requestedByUserId: "customer-1",
      order,
    }
    prisma.orderCancellationRequest.findUnique.mockResolvedValue(request)
    prisma.deliveryFraudFinding.findFirst.mockResolvedValue({
      id: "finding-1",
    })
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: order.id }])
      .mockResolvedValueOnce([
        { role: "OPERATIONS", banned: false, userType: "STAFF" },
      ])

    await expect(
      service.review(request.id, "operations-1", "OPERATIONS", {
        resolution,
        responsibility: CancellationResponsibility.PLATFORM,
        reason:
          "Confirmed delivery fraud requires a customer financial remedy.",
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "CONFIRMED_FRAUD_REFUND_REQUIRED",
      }),
    })

    expect(prisma.orderCancellationRequest.update).not.toHaveBeenCalled()
    expect(prisma.deliveryFraudFinding.findFirst).toHaveBeenCalledWith({
      where: { cancellationRequestId: request.id },
      select: { id: true },
    })
    expect(prisma.orderDispute.create).not.toHaveBeenCalled()
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
    expect(prisma.orderEvent.create).not.toHaveBeenCalled()
  })

  it("advances a confirmed-fraud cancellation only to Finance for a full refund", async () => {
    const request = {
      id: "cancel-fraud-1",
      orderId: order.id,
      status: "UNDER_REVIEW",
      previousOrderStatus: "ACCEPTED",
      requestedByUserId: "customer-1",
      order,
    }
    const pendingFinance = {
      ...request,
      status: "PENDING_FINANCE",
      resolution: "FULL_REFUND",
      responsibility: "PLATFORM",
    }
    prisma.orderCancellationRequest.findUnique.mockResolvedValue(request)
    prisma.orderCancellationRequest.findUniqueOrThrow.mockResolvedValue(
      pendingFinance,
    )
    prisma.deliveryFraudFinding.findFirst.mockResolvedValue({ id: "finding-1" })
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: order.id }])
      .mockResolvedValueOnce([
        { role: "OPERATIONS", banned: false, userType: "STAFF" },
      ])

    const result = await service.review(
      request.id,
      "operations-1",
      "OPERATIONS",
      {
        resolution: CancellationResolution.FULL_REFUND,
        responsibility: CancellationResponsibility.PLATFORM,
        reason:
          "  Confirmed delivery fraud requires a full customer refund review.  ",
      },
    )

    expect(result).toBe(pendingFinance)
    expect(prisma.orderCancellationRequest.update).toHaveBeenCalledWith({
      where: { id: request.id },
      data: expect.objectContaining({
        status: "PENDING_FINANCE",
        resolution: "FULL_REFUND",
        responsibility: "PLATFORM",
        resolutionReason:
          "Confirmed delivery fraud requires a full customer refund review.",
      }),
    })
  })

  it("returns the exact confirmed-fraud review replay without duplicate evidence", async () => {
    const reason =
      "Confirmed delivery fraud requires a full customer refund review."
    const pendingFinance = {
      id: "cancel-fraud-1",
      orderId: order.id,
      status: "PENDING_FINANCE",
      previousOrderStatus: "ACCEPTED",
      reviewedByUserId: "operations-1",
      resolution: "FULL_REFUND",
      responsibility: "PLATFORM",
      resolutionReason: reason,
      order,
    }
    prisma.orderCancellationRequest.findUnique.mockResolvedValue(pendingFinance)
    prisma.orderCancellationRequest.findUniqueOrThrow.mockResolvedValue(
      pendingFinance,
    )
    prisma.deliveryFraudFinding.findFirst.mockResolvedValue({ id: "finding-1" })
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: order.id }])
      .mockResolvedValueOnce([
        { role: "OPERATIONS", banned: false, userType: "STAFF" },
      ])

    const result = await service.review(
      pendingFinance.id,
      "operations-1",
      "OPERATIONS",
      {
        resolution: CancellationResolution.FULL_REFUND,
        responsibility: CancellationResponsibility.PLATFORM,
        reason: `  ${reason}  `,
      },
    )

    expect(result).toBe(pendingFinance)
    expect(prisma.orderCancellationRequest.update).not.toHaveBeenCalled()
    expect(prisma.orderEvent.create).not.toHaveBeenCalled()
    expect(audit.log).not.toHaveBeenCalled()
  })

  it.each([
    "too short",
    "x".repeat(2001),
  ])("rejects an invalid normalized cancellation review reason before database work", async (reason) => {
    await expect(
      service.review("cancel-fraud-1", "operations-1", "OPERATIONS", {
        resolution: CancellationResolution.FULL_REFUND,
        responsibility: CancellationResponsibility.PLATFORM,
        reason,
      }),
    ).rejects.toBeInstanceOf(BadRequestException)

    expect(prisma.orderCancellationRequest.findUnique).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it.each([
    ["a role demotion", "FINANCE", false, "STAFF"],
    ["an account ban", "OPERATIONS", true, "STAFF"],
    ["a user-type change", "OPERATIONS", false, "CUSTOMER"],
  ])("rejects cancellation review after %s wins the authority race", async (_label, role, banned, userType) => {
    const request = {
      id: "cancel-fraud-1",
      orderId: order.id,
      status: "ESCALATED",
      previousOrderStatus: "PUBLISHED",
      requestedByUserId: "operations-1",
      order,
    }
    prisma.orderCancellationRequest.findUnique.mockResolvedValueOnce(request)
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: order.id }])
      .mockResolvedValueOnce([{ role, banned, userType }])

    await expect(
      service.review(request.id, "operations-1", "OPERATIONS", {
        resolution: CancellationResolution.FULL_REFUND,
        responsibility: CancellationResponsibility.PLATFORM,
        reason:
          "Confirmed delivery fraud requires a full customer refund review.",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException)

    expect(prisma.orderCancellationRequest.findUnique).toHaveBeenCalledTimes(1)
    expect(prisma.deliveryFraudFinding.findFirst).not.toHaveBeenCalled()
    expect(prisma.orderCancellationRequest.update).not.toHaveBeenCalled()
    expect(prisma.orderEvent.create).not.toHaveBeenCalled()
    expect(audit.log).not.toHaveBeenCalled()
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
