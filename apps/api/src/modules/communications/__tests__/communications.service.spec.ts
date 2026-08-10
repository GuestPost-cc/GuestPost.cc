import { BadRequestException } from "@nestjs/common"
import { CommunicationsService } from "../communications.service"

function createHarness(userOverrides: Record<string, unknown> = {}) {
  const tx = {
    communicationEvent: {
      upsert: jest.fn().mockResolvedValue({ id: "event-1" }),
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
      upsert: jest
        .fn()
        .mockResolvedValue({ id: "delivery-1", status: "PENDING" }),
    },
    order: {
      findUnique: jest.fn().mockResolvedValue({
        id: "order-1",
        type: "GUEST_POST",
        amount: "100.00",
        currency: "USD",
        organization: { name: "Acme Ltd.", billingProfile: null },
      }),
    },
    financialDocument: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: "document-1" }),
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

  it("ignores opt-outs for required payment receipts", async () => {
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
      },
      tx as any,
    )
    expect(tx.notification.upsert).toHaveBeenCalledTimes(1)
    expect(tx.communicationDelivery.upsert).toHaveBeenCalledTimes(1)
    expect(tx.financialDocument.create).toHaveBeenCalledTimes(1)
    expect(tx.communicationEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          payload: { financialDocumentId: "document-1" },
        }),
      }),
    )
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

  it("refuses to disable protected preference categories", async () => {
    const { service } = createHarness()
    await expect(
      service.updatePreferences("user-1", false, [
        { category: "SECURITY", inApp: true, email: false },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException)
  })
})
