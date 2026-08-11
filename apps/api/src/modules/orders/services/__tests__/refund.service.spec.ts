import { BadRequestException } from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/client"
import { RefundService } from "../refund.service"

describe("RefundService", () => {
  let service: RefundService
  let prismaMock: any
  let auditMock: any
  let queueMock: any
  let communicationsMock: any

  const baseOrder = {
    id: "order-1",
    organizationId: "org-1",
    status: "DELIVERED",
    paymentStatus: "PAID",
    amount: new Decimal(100),
    currency: "USD",
    version: 3,
    website: { ownershipType: "PUBLISHER", publisherId: "pub-1" },
  }

  const wallet = {
    id: "wallet-1",
    organizationId: "org-1",
    currency: "USD",
    version: 1,
  }

  beforeEach(() => {
    auditMock = { log: jest.fn().mockResolvedValue(undefined) }
    prismaMock = {
      order: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ ...baseOrder, status: "REFUNDED" }),
      },
      transaction: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: "refund-tx-1" }),
      },
      settlement: {
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      platformRevenue: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        delete: jest.fn(),
      },
      fulfillmentAssignment: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      publisherBalance: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({}),
      },
      publisher: {
        findUnique: jest.fn().mockResolvedValue({
          organizationId: "publisher-org-1",
          publisherMemberships: [{ userId: "publisher-user-1" }],
        }),
      },
      notification: {
        upsert: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
      communicationEvent: {
        findMany: jest.fn().mockResolvedValue([{ id: "event-1" }]),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      communicationDelivery: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      financialDocument: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      wallet: {
        findFirst: jest.fn().mockResolvedValue(wallet),
        findUnique: jest.fn().mockResolvedValue(wallet),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      orderEvent: {
        create: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue({ id: "refund-event-1" }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest
        .fn()
        .mockImplementation(async (cb: any) => cb(prismaMock)),
    }
    queueMock = {
      enqueueTrustRecompute: jest.fn().mockResolvedValue(undefined),
    }
    communicationsMock = {
      customerOrderRecipients: jest.fn().mockResolvedValue(["customer-user-1"]),
      staffRecipients: jest.fn().mockResolvedValue(["finance-user-1"]),
      record: jest.fn().mockResolvedValue({ eventId: "event-1" }),
      repairValidatedLegacyEvent: jest
        .fn()
        .mockResolvedValue({ eventId: "legacy-event", deliveryIds: [] }),
      dispatchManyBestEffort: jest.fn(),
    }
    service = new RefundService(
      prismaMock as any,
      auditMock as any,
      queueMock as any,
      communicationsMock as any,
    )
  })

  function configureOriginMainLegacyReplay() {
    const sourceOrder = {
      ...baseOrder,
      customerId: "customer-user-1",
      type: "GUEST_POST",
      organization: {
        id: "org-1",
        name: "Acme Content Ltd.",
        billingProfile: null,
      },
    }
    const terminalOrder = {
      ...baseOrder,
      status: "REFUNDED",
      paymentStatus: "REFUNDED",
      refundResponsibility: "SYSTEM",
    }
    const refund = {
      id: "refund-tx-existing",
      orderId: "order-1",
      type: "REFUND",
      amount: new Decimal(100),
      currency: "USD",
      walletId: "wallet-1",
      reference: "refund-command-1",
      description: "Refund for order order-1: original reason",
    }
    const snapshot = {
      schemaVersion: 1,
      environment: "PRODUCTION",
      issuer: {
        legalName: "GuestPost.cc Inc.",
        billingEmail: "billing@guestpost.cc",
        addressLine1: "100 Marketplace Avenue",
        city: "Austin",
        region: "TX",
        postalCode: "78701",
        countryCode: "US",
      },
      recipient: { legalName: "Acme Content Ltd." },
      lineItems: [
        {
          description: "Refund - Guest Post service",
          quantity: 1,
          unitAmount: "100.00",
          lineTotal: "100.00",
        },
      ],
      payment: {
        status: "REFUNDED",
        method: "GuestPost.cc wallet",
        reference: "Order order-1",
      },
      tax: {
        label: "Tax",
        treatment: "NOT_SEPARATELY_CHARGED",
        note: "No tax was separately charged on this document.",
      },
      relatedDocumentNumber: null,
      notes: [],
    }
    const document = {
      id: "legacy-credit-note",
      kind: "CREDIT_NOTE",
      numberPrefix: "GP",
      sequenceNumber: 42n,
      aggregateType: "Order",
      aggregateId: "order-1",
      organizationId: "org-1",
      relatedDocumentId: null,
      relatedDocument: null,
      currency: "USD",
      subtotal: new Decimal(100),
      taxAmount: new Decimal(0),
      total: new Decimal(100),
      dedupKey: "financial-document:order:order-1:refunded",
      snapshot,
    }
    const event = {
      id: "legacy-refund-event",
      type: "ORDER_REFUNDED",
      category: "BILLING",
      severity: "WARNING",
      aggregateType: "Order",
      aggregateId: "order-1",
      organizationId: "org-1",
      title: "Order refund completed",
      message: "100.00 USD was returned to your wallet for order order-1.",
      actionPath: "/dashboard/orders/order-1",
      payload: {
        amount: "100",
        currency: "USD",
        responsibility: "SYSTEM",
        financialDocumentId: document.id,
      },
      dedupKey: "order:order-1:refunded",
    }
    prismaMock.transaction.findFirst.mockResolvedValue(refund)
    prismaMock.orderEvent.findFirst.mockResolvedValue(null)
    prismaMock.orderEvent.findMany.mockResolvedValue([
      {
        id: "legacy-refund-order-event",
        actorId: "admin-1",
        message: "Order refunded: original reason",
        metadata: {
          reason: "original reason",
          refundedBy: "admin-1",
          responsibility: "SYSTEM",
          settlementCancelled: null,
        },
      },
    ])
    prismaMock.order.findUniqueOrThrow.mockResolvedValue(terminalOrder)
    prismaMock.order.findUnique.mockResolvedValue(sourceOrder)
    prismaMock.communicationEvent.findUnique.mockResolvedValue(event)
    prismaMock.financialDocument.findUnique.mockResolvedValue(document)
    prismaMock.$queryRaw.mockResolvedValue([{ id: event.id }])
    return { document, event, refund, snapshot, sourceOrder, terminalOrder }
  }

  it("records the credit-note outbox event atomically for an unaccepted refund", async () => {
    prismaMock.order.findUnique.mockResolvedValue({
      ...baseOrder,
      status: "SUBMITTED",
      submittedAt: new Date("2026-08-11T00:00:00.000Z"),
    })
    prismaMock.order.findUniqueOrThrow.mockResolvedValue({
      ...baseOrder,
      status: "REFUNDED",
      paymentStatus: "REFUNDED",
      refundResponsibility: "PUBLISHER",
    })

    await service.refundOrder(
      "order-1",
      "publisher did not accept",
      "customer-user-1",
      "refund-command-1",
      { responsibility: "PUBLISHER" },
    )

    expect(communicationsMock.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ORDER_REFUNDED",
        aggregateId: "order-1",
        dedupKey: "order:order-1:refunded",
        recipientUserIds: ["customer-user-1"],
        actorUserId: "customer-user-1",
        payload: expect.objectContaining({
          responsibility: "PUBLISHER",
          refundTransactionId: "refund-tx-1",
        }),
      }),
      prismaMock,
    )
    expect(prismaMock.transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "REFUND",
          reference: "refund-command-1",
        }),
      }),
    )
    await Promise.resolve()
    expect(communicationsMock.dispatchManyBestEffort).toHaveBeenCalledWith([
      "event-1",
    ])
  })

  it("repairs a missing refund communication on an exact idempotent replay", async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({
      id: "refund-tx-existing",
      orderId: "order-1",
      type: "REFUND",
      amount: new Decimal(100),
      currency: "USD",
      walletId: "wallet-1",
      reference: "refund-command-1",
    })
    prismaMock.order.findUniqueOrThrow.mockResolvedValue({
      ...baseOrder,
      status: "REFUNDED",
      paymentStatus: "REFUNDED",
      refundResponsibility: "SYSTEM",
    })

    const result = await service.refundOrder(
      "order-1",
      "retry",
      "admin-1",
      "refund-command-1",
      { responsibility: "SYSTEM" },
    )

    expect(result.status).toBe("REFUNDED")
    expect(prismaMock.wallet.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.transaction.create).not.toHaveBeenCalled()
    expect(communicationsMock.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ORDER_REFUNDED",
        dedupKey: "order:order-1:refunded",
      }),
      prismaMock,
    )
    await Promise.resolve()
    expect(communicationsMock.dispatchManyBestEffort).toHaveBeenCalledWith([
      "event-1",
    ])
  })

  it("re-reads idempotent refund evidence after locking the Order", async () => {
    prismaMock.transaction.findFirst
      .mockResolvedValueOnce({
        id: "refund-tx-existing",
        orderId: "order-1",
        type: "REFUND",
        reference: "refund-command-1",
      })
      .mockResolvedValueOnce(null)

    await expect(
      service.refundOrder("order-1", "retry", "admin-1", "refund-command-1", {
        responsibility: "SYSTEM",
      }),
    ).rejects.toThrow("evidence changed before replay")
    expect(communicationsMock.record).not.toHaveBeenCalled()
  })

  it("grandfathers an exact origin/main credit note and repairs its missing customer projection", async () => {
    const { event } = configureOriginMainLegacyReplay()

    const result = await service.refundOrder(
      "order-1",
      "retry",
      "customer-user-1",
      "refund-command-1",
      { responsibility: "SYSTEM" },
    )

    expect(result.status).toBe("REFUNDED")
    expect(prismaMock.transaction.create).not.toHaveBeenCalled()
    expect(communicationsMock.record).not.toHaveBeenCalled()
    expect(communicationsMock.repairValidatedLegacyEvent).toHaveBeenCalledWith(
      event,
      ["customer-user-1"],
      "customer-user-1",
      prismaMock,
    )
  })

  it("rejects a cross-tenant origin/main credit note before repairing projections", async () => {
    const { document } = configureOriginMainLegacyReplay()
    document.organizationId = "org-other"

    await expect(
      service.refundOrder(
        "order-1",
        "retry",
        "customer-user-1",
        "refund-command-1",
        { responsibility: "SYSTEM" },
      ),
    ).rejects.toThrow("does not match completed order evidence")
    expect(communicationsMock.repairValidatedLegacyEvent).not.toHaveBeenCalled()
  })

  it("rejects unauthorized legacy financial projections", async () => {
    configureOriginMainLegacyReplay()
    prismaMock.communicationDelivery.findMany.mockResolvedValue([
      { userId: "publisher-user-1" },
    ])

    await expect(
      service.refundOrder(
        "order-1",
        "retry",
        "customer-user-1",
        "refund-command-1",
        { responsibility: "SYSTEM" },
      ),
    ).rejects.toThrow("audience does not match the customer account")
    expect(communicationsMock.repairValidatedLegacyEvent).not.toHaveBeenCalled()
  })

  it("rejects a legacy payload changed before the event lock is acquired", async () => {
    const { event } = configureOriginMainLegacyReplay()
    prismaMock.communicationEvent.findUnique
      .mockResolvedValueOnce(event)
      .mockResolvedValueOnce({
        ...event,
        payload: { ...event.payload, amount: "999" },
      })

    await expect(
      service.refundOrder(
        "order-1",
        "retry",
        "customer-user-1",
        "refund-command-1",
        { responsibility: "SYSTEM" },
      ),
    ).rejects.toThrow("does not match completed order evidence")
    expect(communicationsMock.repairValidatedLegacyEvent).not.toHaveBeenCalled()
  })

  it("rejects an unbound legacy OrderEvent whose reason does not join the refund ledger", async () => {
    const { refund } = configureOriginMainLegacyReplay()
    refund.description = "Refund for order order-1: different reason"

    await expect(
      service.refundOrder(
        "order-1",
        "retry",
        "customer-user-1",
        "refund-command-1",
        { responsibility: "SYSTEM" },
      ),
    ).rejects.toThrow("does not match completed order evidence")
    expect(communicationsMock.record).not.toHaveBeenCalled()
    expect(communicationsMock.repairValidatedLegacyEvent).not.toHaveBeenCalled()
  })

  it("serializes concurrent first-use of one refund idempotency key", async () => {
    let currentOrder: any = {
      ...baseOrder,
      status: "SUBMITTED",
      submittedAt: new Date("2026-08-11T00:00:00.000Z"),
    }
    let refundRow: any = null
    let refundCreates = 0
    let outsideChecks = 0
    let releaseOutside!: () => void
    const bothOutside = new Promise<void>((resolve) => {
      releaseOutside = resolve
    })
    let transactionTail = Promise.resolve()

    const concurrentPrisma: any = {
      order: {
        async findUnique() {
          return { ...currentOrder }
        },
      },
      transaction: {
        async findFirst() {
          outsideChecks += 1
          if (outsideChecks === 2) releaseOutside()
          await bothOutside
          return null
        },
      },
      communicationEvent: {
        findMany: jest.fn().mockResolvedValue([{ id: "event-1" }]),
      },
      async $transaction(operation: (tx: any) => Promise<unknown>) {
        let releaseTransaction!: () => void
        const predecessor = transactionTail
        transactionTail = new Promise<void>((resolve) => {
          releaseTransaction = resolve
        })
        await predecessor
        const tx: any = {
          $queryRaw: jest.fn().mockResolvedValue([{ id: "order-1" }]),
          order: {
            async findUnique() {
              return { ...currentOrder }
            },
            async findUniqueOrThrow() {
              return { ...currentOrder }
            },
            async updateMany() {
              currentOrder = {
                ...currentOrder,
                status: "REFUNDED",
                paymentStatus: "REFUNDED",
                refundResponsibility: "SYSTEM",
                version: currentOrder.version + 1,
              }
              return { count: 1 }
            },
          },
          wallet: {
            findUnique: jest.fn().mockResolvedValue(wallet),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
          fulfillmentAssignment: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
          transaction: {
            async findFirst(input: { where: any }) {
              if (!refundRow) return null
              if (
                input.where.reference === refundRow.reference ||
                (input.where.orderId === refundRow.orderId &&
                  input.where.type === "REFUND")
              ) {
                return refundRow
              }
              return null
            },
            async create(input: { data: any }) {
              refundCreates += 1
              refundRow = {
                id: "refund-tx-concurrent",
                ...input.data,
              }
              return refundRow
            },
          },
          orderEvent: {
            async create() {
              return { id: "refund-event-1" }
            },
            async findFirst(input: { where: any }) {
              return input.where.metadata.equals === refundRow?.id
                ? { id: "refund-event-1" }
                : null
            },
          },
        }
        try {
          return await operation(tx)
        } finally {
          releaseTransaction()
        }
      },
    }
    const concurrentCommunications = {
      customerOrderRecipients: jest.fn().mockResolvedValue(["customer-user-1"]),
      staffRecipients: jest.fn().mockResolvedValue([]),
      record: jest.fn().mockResolvedValue({ eventId: "event-1" }),
      dispatchManyBestEffort: jest.fn(),
    }
    const concurrentService = new RefundService(
      concurrentPrisma,
      auditMock,
      queueMock,
      concurrentCommunications as any,
    )

    const results = await Promise.all([
      concurrentService.refundOrder(
        "order-1",
        "timeout",
        "admin-1",
        "refund-command-concurrent",
        { responsibility: "SYSTEM" },
      ),
      concurrentService.refundOrder(
        "order-1",
        "timeout replay",
        "admin-1",
        "refund-command-concurrent",
        { responsibility: "SYSTEM" },
      ),
    ])

    expect(results[0].status).toBe("REFUNDED")
    expect(results[1].status).toBe("REFUNDED")
    expect(refundCreates).toBe(1)
    expect(concurrentCommunications.record).toHaveBeenCalledTimes(2)
  })

  it.each([
    ["amount", { amount: new Decimal(99) }],
    ["currency", { currency: "EUR" }],
    ["wallet", { walletId: "wallet-other" }],
  ])("rejects tampered idempotent refund %s evidence", async (_, override) => {
    prismaMock.transaction.findFirst.mockResolvedValue({
      id: "refund-tx-existing",
      orderId: "order-1",
      type: "REFUND",
      amount: new Decimal(100),
      currency: "USD",
      walletId: "wallet-1",
      reference: "refund-command-1",
      ...override,
    })
    prismaMock.order.findUniqueOrThrow.mockResolvedValue({
      ...baseOrder,
      status: "REFUNDED",
      paymentStatus: "REFUNDED",
      refundResponsibility: "SYSTEM",
    })

    await expect(
      service.refundOrder("order-1", "retry", "admin-1", "refund-command-1", {
        responsibility: "SYSTEM",
      }),
    ).rejects.toThrow("does not match completed order evidence")
    expect(communicationsMock.record).not.toHaveBeenCalled()
  })

  it("rejects duplicate refunds", async () => {
    prismaMock.order.findUnique.mockResolvedValue(baseOrder)
    prismaMock.transaction.findFirst.mockResolvedValue({ id: "tx-existing" })

    await expect(
      service.refundOrder("order-1", "dup", "admin-1", undefined, {
        responsibility: "SYSTEM",
      }),
    ).rejects.toThrow(BadRequestException)
    expect(prismaMock.wallet.updateMany).not.toHaveBeenCalled()
  })

  it("reverses PlatformRevenue for platform orders instead of deleting", async () => {
    prismaMock.order.findUnique.mockResolvedValue({
      ...baseOrder,
      website: { ownershipType: "PLATFORM" },
    })

    await service.refundOrder("order-1", "bad content", "admin-1", undefined, {
      responsibility: "PLATFORM",
    })

    expect(prismaMock.platformRevenue.updateMany).toHaveBeenCalledWith({
      where: { orderId: "order-1", reversedAt: null },
      data: { reversedAt: expect.any(Date) },
    })
    expect(prismaMock.platformRevenue.delete).not.toHaveBeenCalled()
    expect(prismaMock.wallet.updateMany).toHaveBeenCalled()
  })

  it("cancels a pending settlement and credits the wallet", async () => {
    prismaMock.order.findUnique.mockResolvedValue(baseOrder)
    prismaMock.settlement.findFirst.mockResolvedValue({
      id: "set-1",
      status: "PENDING",
      version: 0,
      publisherId: "pub-1",
      publisherAmount: new Decimal(80),
    })

    await service.refundOrder("order-1", "cancelled", "admin-1", undefined, {
      responsibility: "PUBLISHER",
    })

    expect(prismaMock.settlement.updateMany).toHaveBeenCalledWith({
      where: { id: "set-1", version: 0 },
      data: { status: "CANCELLED", version: { increment: 1 } },
    })
    expect(prismaMock.publisherBalance.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.wallet.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          availableBalance: { increment: new Decimal(100) },
        }),
      }),
    )
  })

  it("claws back the full amount when withdrawable covers it", async () => {
    prismaMock.order.findUnique.mockResolvedValue(baseOrder)
    prismaMock.settlement.findFirst.mockResolvedValue({
      id: "set-1",
      status: "RELEASED",
      version: 2,
      publisherId: "pub-1",
      publisherAmount: new Decimal(80),
    })
    prismaMock.$queryRaw.mockResolvedValue([
      {
        publisherId: "pub-1",
        currency: "USD",
        withdrawableBalance: new Decimal(200),
        version: 5,
      },
    ])

    await service.refundOrder("order-1", "dispute", "admin-1", undefined, {
      responsibility: "PUBLISHER",
    })

    const balanceCall = prismaMock.publisherBalance.updateMany.mock.calls[0][0]
    expect(
      balanceCall.data.withdrawableBalance.decrement.equals(new Decimal(80)),
    ).toBe(true)
    expect(balanceCall.data.debtBalance.increment.equals(new Decimal(0))).toBe(
      true,
    )

    const clawbackTx = prismaMock.transaction.create.mock.calls.find(
      (c: any) => c[0].data.type === "SETTLEMENT_CLAWBACK",
    )
    expect(clawbackTx).toBeDefined()
    expect(clawbackTx[0].data.amount.equals(new Decimal(-80))).toBe(true)
    expect(clawbackTx[0].data.currency).toBe("USD")
    expect(clawbackTx[0].data.reference).toBe("clawback-order-1")
    expect(prismaMock.settlement.updateMany).toHaveBeenCalledWith({
      where: { id: "set-1", status: "RELEASED", version: 2 },
      data: { status: "CANCELLED", version: { increment: 1 } },
    })
  })

  it("records remainder as debt when publisher already withdrew", async () => {
    prismaMock.order.findUnique.mockResolvedValue(baseOrder)
    prismaMock.settlement.findFirst.mockResolvedValue({
      id: "set-1",
      status: "RELEASED",
      version: 2,
      publisherId: "pub-1",
      publisherAmount: new Decimal(80),
    })
    // Only 30 left withdrawable — 50 must become debt, not a failed decrement
    prismaMock.$queryRaw.mockResolvedValue([
      {
        publisherId: "pub-1",
        currency: "USD",
        withdrawableBalance: new Decimal(30),
        version: 5,
      },
    ])

    await service.refundOrder("order-1", "dispute", "admin-1", undefined, {
      responsibility: "PUBLISHER",
    })

    const balanceCall = prismaMock.publisherBalance.updateMany.mock.calls[0][0]
    expect(
      balanceCall.data.withdrawableBalance.decrement.equals(new Decimal(30)),
    ).toBe(true)
    expect(balanceCall.data.debtBalance.increment.equals(new Decimal(50))).toBe(
      true,
    )
    expect(prismaMock.notification.upsert).toHaveBeenCalledWith({
      where: {
        userId_dedupKey: {
          userId: "publisher-user-1",
          dedupKey: "publisher-debt:order-1:publisher-user-1",
        },
      },
      create: expect.objectContaining({
        userId: "publisher-user-1",
        organizationId: "publisher-org-1",
        type: "PUBLISHER_DEBT_CREATED",
        message: expect.stringContaining("50.00 USD"),
        dedupKey: "publisher-debt:order-1:publisher-user-1",
      }),
      update: {},
    })

    // Customer still gets the FULL refund regardless of publisher debt
    expect(prismaMock.wallet.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          availableBalance: { increment: new Decimal(100) },
        }),
      }),
    )
  })

  it("records and explains full debt when the publisher has no balance row", async () => {
    prismaMock.order.findUnique.mockResolvedValue(baseOrder)
    prismaMock.settlement.findFirst.mockResolvedValue({
      id: "set-1",
      status: "RELEASED",
      version: 2,
      publisherId: "pub-1",
      publisherAmount: new Decimal(80),
    })
    prismaMock.$queryRaw.mockResolvedValue([])

    await service.refundOrder("order-1", "dispute", "admin-1", undefined, {
      responsibility: "PUBLISHER",
    })

    expect(prismaMock.publisherBalance.create).toHaveBeenCalledWith({
      data: {
        publisherId: "pub-1",
        currency: "USD",
        debtBalance: new Decimal(80),
      },
    })
    expect(prismaMock.notification.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          message: expect.stringContaining("80.00 USD"),
        }),
      }),
    )
  })

  it("refuses unpaid orders", async () => {
    prismaMock.order.findUnique.mockResolvedValue({
      ...baseOrder,
      paymentStatus: "PENDING",
    })
    await expect(
      service.refundOrder("order-1", "x", "admin-1", undefined, {
        responsibility: "SYSTEM",
      }),
    ).rejects.toThrow(BadRequestException)
  })

  it("rejects a non-USD order before changing any financial state", async () => {
    prismaMock.order.findUnique.mockResolvedValue({
      ...baseOrder,
      currency: "EUR",
    })

    await expect(
      service.refundOrder("order-1", "x", "admin-1", undefined, {
        responsibility: "SYSTEM",
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "ORDER_CURRENCY_UNSUPPORTED",
      }),
    })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(prismaMock.wallet.updateMany).not.toHaveBeenCalled()
  })

  it("requires explicit final responsibility", async () => {
    await expect(
      (service.refundOrder as any)("order-1", "x", "admin-1"),
    ).rejects.toThrow("final refund responsibility")
  })

  it("cancels active assignments and only penalizes publisher-attributed refunds", async () => {
    prismaMock.order.findUnique.mockResolvedValue(baseOrder)

    await service.refundOrder(
      "order-1",
      "publisher missed deadline",
      "admin-1",
      undefined,
      { responsibility: "PUBLISHER" },
    )

    expect(prismaMock.fulfillmentAssignment.updateMany).toHaveBeenCalledWith({
      where: {
        orderId: "order-1",
        status: { in: ["ASSIGNED", "IN_PROGRESS"] },
      },
      data: { status: "CANCELLED", version: { increment: 1 } },
    })
    expect(prismaMock.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          refundResponsibility: "PUBLISHER",
        }),
      }),
    )
    expect(queueMock.enqueueTrustRecompute).toHaveBeenCalledWith(
      "pub-1",
      "REFUND_ISSUED",
      expect.stringContaining("publisher-attributed"),
    )
  })
})
