import { BadRequestException } from "@nestjs/common"
import { CommunicationsService } from "../communications.service"

function createHarness(
  userOverrides: Record<string, unknown> = {},
  financialDocumentKind: "PAID_INVOICE" | "CREDIT_NOTE" = "PAID_INVOICE",
) {
  let insertedSnapshot: unknown = null
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: "event-1" }]),
    $executeRaw: jest
      .fn()
      .mockImplementation(
        async (_query: TemplateStringsArray, ...values: unknown[]) => {
          insertedSnapshot = JSON.parse(String(values[12]))
          return 1
        },
      ),
    communicationEvent: {
      upsert: jest.fn().mockImplementation(({ create }: any) =>
        Promise.resolve({
          id: "event-1",
          ...create,
          payload: create.payload ?? null,
        }),
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: "user-1",
          email: "member@example.com",
          emailVerified: true,
          banned: false,
          notificationPreferences: [],
          emailSuppressions: [],
          ...userOverrides,
        },
      ]),
    },
    notification: {
      upsert: jest.fn().mockResolvedValue({ id: "notification-1" }),
    },
    communicationDelivery: {
      count: jest.fn().mockResolvedValue(1),
      upsert: jest
        .fn()
        .mockResolvedValue({ id: "delivery-1", status: "PENDING" }),
    },
    order: {
      findUnique: jest.fn().mockResolvedValue({
        id: "order-1",
        customerId: "user-1",
        type: "GUEST_POST",
        amount: "100.00",
        currency: "USD",
        organization: {
          id: "org-1",
          name: "Acme Ltd.",
          billingProfile: null,
          memberships: [],
        },
      }),
    },
    transaction: {
      findUnique: jest.fn().mockResolvedValue({
        id: "refund-transaction-1",
        type: "REFUND",
        orderId: "order-1",
        amount: "100.00",
        currency: "USD",
        wallet: { organizationId: "org-1", currency: "USD" },
      }),
    },
    orderEvent: {
      findFirst: jest.fn().mockResolvedValue({ id: "refund-event-1" }),
    },
    financialDocument: {
      findUnique: jest.fn().mockImplementation(async () => ({
        id: "document-1",
        kind: financialDocumentKind,
        aggregateType: "Order",
        aggregateId: "order-1",
        organizationId: "org-1",
        currency: "USD",
        subtotal: "100.00",
        taxAmount: "0.00",
        total: "100.00",
        relatedDocumentId: null,
        snapshot: insertedSnapshot,
      })),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  }
  const prisma = {
    ...tx,
    notificationPreference: { findMany: jest.fn() },
    $transaction: jest.fn(),
  }
  const queue = { addJob: jest.fn() }
  return {
    tx,
    prisma,
    queue,
    service: new CommunicationsService(prisma as any, queue as any),
  }
}

const baseEvent = {
  aggregateType: "Order",
  aggregateId: "order-1",
  organizationId: "org-1",
  title: "Order accepted",
  message: "Work started",
  actionPath: "/dashboard/orders/order-1",
  recipientUserIds: ["user-1"],
}

describe("CommunicationsService", () => {
  it("resolves staff recipients only from live STAFF identities", async () => {
    const tx = {
      staffMembership: {
        findMany: jest.fn().mockResolvedValue([{ userId: "staff-1" }]),
      },
    }
    const service = new CommunicationsService({} as any, {} as any)

    await expect(
      service.staffRecipients(["FINANCE", "SUPER_ADMIN"], tx as any),
    ).resolves.toEqual(["staff-1"])
    expect(tx.staffMembership.findMany).toHaveBeenCalledWith({
      where: {
        role: { in: ["FINANCE", "SUPER_ADMIN"] },
        user: { banned: false, userType: "STAFF" },
      },
      select: { userId: true },
    })
  })

  it("rejects outbox writes against the root client", async () => {
    const { service, prisma } = createHarness()

    await expect(
      service.record(
        {
          ...baseEvent,
          type: "ORDER_ACCEPTED",
          dedupKey: "order:order-1:accepted",
        },
        prisma as any,
      ),
    ).rejects.toThrow(/authoritative domain transaction/i)
    expect(prisma.communicationEvent.upsert).not.toHaveBeenCalled()
  })

  it("honors an email opt-out for an optional order event", async () => {
    const { service, tx } = createHarness({
      notificationPreferences: [{ channel: "EMAIL", enabled: false }],
    })
    await service.record(
      {
        ...baseEvent,
        type: "ORDER_ACCEPTED",
        dedupKey: "order:order-1:accepted",
      },
      tx as any,
    )
    expect(tx.notification.upsert).toHaveBeenCalledTimes(1)
    expect(tx.communicationDelivery.upsert).not.toHaveBeenCalled()
  })

  it("delivers a required receipt and invoice to the explicitly listed payer", async () => {
    const { service, tx } = createHarness({
      notificationPreferences: [
        { channel: "IN_APP", enabled: false },
        { channel: "EMAIL", enabled: false },
      ],
    })
    await service.record(
      {
        ...baseEvent,
        type: "ORDER_PAYMENT_CAPTURED",
        dedupKey: "order:order-1:payment-captured",
        actorUserId: "user-1",
      },
      tx as any,
    )
    expect(tx.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["user-1"] } } }),
    )
    expect(tx.notification.upsert).toHaveBeenCalledTimes(1)
    expect(tx.communicationDelivery.upsert).toHaveBeenCalledTimes(1)
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1)
    expect(tx.communicationEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          payload: { financialDocumentId: "document-1" },
        }),
      }),
    )
  })

  it("delivers a required credit note to the explicitly listed refund actor", async () => {
    const { service, tx } = createHarness(
      {
        notificationPreferences: [
          { channel: "IN_APP", enabled: false },
          { channel: "EMAIL", enabled: false },
        ],
      },
      "CREDIT_NOTE",
    )

    await service.record(
      {
        ...baseEvent,
        type: "ORDER_REFUNDED",
        dedupKey: "order:order-1:refunded",
        actorUserId: "user-1",
        payload: {
          amount: "100.00",
          currency: "USD",
          refundTransactionId: "refund-transaction-1",
        },
      },
      tx as any,
    )

    expect(tx.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["user-1"] } } }),
    )
    expect(tx.notification.upsert).toHaveBeenCalledTimes(1)
    expect(tx.communicationDelivery.upsert).toHaveBeenCalledTimes(1)
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1)
  })

  it("keeps self-notification excluded by default for activity events", async () => {
    const { service, tx } = createHarness()

    const result = await service.record(
      {
        ...baseEvent,
        type: "ORDER_ACCEPTED",
        dedupKey: "order:order-1:accepted",
        actorUserId: "user-1",
      },
      tx as any,
    )

    expect(result.deliveryIds).toEqual([])
    expect(tx.user.findMany).not.toHaveBeenCalled()
    expect(tx.notification.upsert).not.toHaveBeenCalled()
    expect(tx.communicationDelivery.upsert).not.toHaveBeenCalled()
  })

  it.each([
    ["ORDER_PAYMENT_CAPTURED" as const, "PAID_INVOICE" as const],
    ["ORDER_REFUNDED" as const, "CREDIT_NOTE" as const],
  ])("never adds an actor who was not resolved for %s", async (type, financialDocumentKind) => {
    const { service, tx } = createHarness({}, financialDocumentKind)

    await service.record(
      {
        ...baseEvent,
        type,
        dedupKey: `order:order-1:${type.toLowerCase()}`,
        actorUserId: "user-2",
        ...(type === "ORDER_REFUNDED"
          ? {
              payload: {
                amount: "100.00",
                currency: "USD",
                refundTransactionId: "refund-transaction-1",
              },
            }
          : {}),
      },
      tx as any,
    )

    expect(tx.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["user-1"] } } }),
    )
    expect(tx.notification.upsert).toHaveBeenCalledTimes(1)
    expect(tx.communicationDelivery.upsert).toHaveBeenCalledTimes(1)
  })

  it("rolls back the authoritative mutation on a dedup collision", async () => {
    const { service, tx, prisma } = createHarness()
    let authoritativeStatus = "BEFORE"
    prisma.$transaction.mockImplementation(
      async (work: (tx: any) => unknown) => {
        const snapshot = authoritativeStatus
        try {
          return await work(tx)
        } catch (error) {
          authoritativeStatus = snapshot
          throw error
        }
      },
    )
    tx.communicationEvent.upsert.mockResolvedValue({
      id: "other-tenant-event",
      type: "ORDER_ACCEPTED",
      category: "ORDERS",
      severity: "SUCCESS",
      aggregateType: "Order",
      aggregateId: "order-1",
      organizationId: "other-org",
      title: "Order accepted",
      message: "Work started",
      actionPath: "/dashboard/orders/order-1",
      payload: null,
    })

    await expect(
      prisma.$transaction(async (transaction: any) => {
        authoritativeStatus = "MUTATED"
        await service.record(
          {
            ...baseEvent,
            type: "ORDER_ACCEPTED",
            dedupKey: "reused:cross-tenant:key",
          },
          transaction,
        )
      }),
    ).rejects.toThrow(/conflicts with immutable event inputs/i)

    expect(authoritativeStatus).toBe("BEFORE")
    expect(tx.notification.upsert).not.toHaveBeenCalled()
    expect(tx.communicationDelivery.upsert).not.toHaveBeenCalled()
  })

  it("does not deliver to banned users", async () => {
    const { service, tx } = createHarness({ banned: true })
    await service.record(
      {
        ...baseEvent,
        type: "ORDER_ACCEPTED",
        dedupKey: "order:order-1:accepted",
      },
      tx as any,
    )
    expect(tx.notification.upsert).not.toHaveBeenCalled()
    expect(tx.communicationDelivery.upsert).not.toHaveBeenCalled()
  })

  it.each([
    ["another organization", { organizationId: "org-2" }],
    [
      "another event type",
      { type: "ORDER_CANCELLED", category: "ORDERS", severity: "WARNING" },
    ],
    ["another aggregate", { aggregateId: "order-2" }],
    ["different content", { message: "Conflicting private content" }],
    ["different payload", { payload: { privateReference: "other" } }],
  ])("fails closed when a reused key belongs to %s", async (_case, conflictingWinner) => {
    const { service, tx } = createHarness()
    tx.communicationEvent.upsert.mockResolvedValue({
      id: "event-from-another-command",
      type: "ORDER_ACCEPTED",
      category: "ORDERS",
      severity: "SUCCESS",
      aggregateType: "Order",
      aggregateId: "order-1",
      organizationId: "org-1",
      title: "Order accepted",
      message: "Work started",
      actionPath: "/dashboard/orders/order-1",
      payload: null,
      ...conflictingWinner,
    })

    await expect(
      service.record(
        {
          ...baseEvent,
          type: "ORDER_ACCEPTED",
          dedupKey: "reused:cross-boundary:key",
        },
        tx as any,
      ),
    ).rejects.toThrow(/conflicts with immutable event inputs/i)

    expect(tx.user.findMany).not.toHaveBeenCalled()
    expect(tx.notification.upsert).not.toHaveBeenCalled()
    expect(tx.communicationDelivery.upsert).not.toHaveBeenCalled()
    expect(tx.communicationEvent.updateMany).not.toHaveBeenCalled()
  })

  it("allows an exact replay with a new request context and repairs projections", async () => {
    const { service, tx } = createHarness()

    await expect(
      service.record(
        {
          ...baseEvent,
          type: "ORDER_ACCEPTED",
          dedupKey: "order:order-1:accepted",
        },
        tx as any,
      ),
    ).resolves.toMatchObject({ eventId: "event-1" })

    expect(tx.notification.upsert).toHaveBeenCalledTimes(1)
    expect(tx.communicationDelivery.upsert).toHaveBeenCalledTimes(1)
  })

  it("keeps a subset replay pending while an older delivery is outstanding", async () => {
    const { service, tx } = createHarness()

    await service.record(
      {
        ...baseEvent,
        recipientUserIds: [],
        type: "ORDER_ACCEPTED",
        dedupKey: "order:order-1:accepted",
      },
      tx as any,
    )

    expect(tx.communicationDelivery.count).toHaveBeenCalledWith({
      where: {
        eventId: "event-1",
        status: {
          in: ["PENDING", "PROCESSING", "FAILED", "DELIVERY_UNCERTAIN"],
        },
      },
    })
    expect(tx.communicationEvent.updateMany).toHaveBeenCalledWith({
      where: { id: "event-1", status: "PROCESSED" },
      data: { status: "PENDING", processedAt: null },
    })
    expect(tx.communicationEvent.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "PROCESSED" }),
      }),
    )
  })

  it("refuses to disable protected preference categories", async () => {
    const { service } = createHarness()
    await expect(
      service.updatePreferences("user-1", false, [
        { category: "SECURITY", inApp: true, email: false },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException)
  })
})
