import { BadRequestException, ConflictException } from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/client"
import { OrderPaymentService } from "../order-payment.service"

describe("OrderPaymentService", () => {
  let service: OrderPaymentService
  let prismaMock: any
  let auditMock: any
  let billingMock: any
  let submitReviewedPayment: () => Promise<any>

  const mockOrder = {
    id: "order-1",
    organizationId: "org-1",
    // Phase 6.9 — assertOwnerOrCreator runs before any status/amount check.
    // customerId == userId ("user-1") makes the actor the creator, which
    // passes the gate so the BadRequest/Conflict paths below can actually
    // fire. (Alternative: pass actorRole: "OWNER" as a 4th arg to
    // submitPayment — both paths exercise the same downstream code.)
    customerId: "user-1",
    // Phase 6 snapshot — submitPayment's price-drift check reads
    // tx.listingService.findUnique({ where: { id: order.listingServiceId } }).
    // Without this field the service throws BadRequestException at
    // order-payment.service.ts:64 ("Order has no listingServiceId snapshot").
    listingServiceId: "ls-1",
    listingId: "listing-1",
    websiteId: "site-1",
    status: "DRAFT",
    paymentStatus: "PENDING",
    amount: new Decimal(500),
    currency: "USD",
    version: 1,
    type: "GUEST_POST",
  }

  const mockWallet = {
    id: "wallet-1",
    organizationId: "org-1",
    availableBalance: new Decimal(1000),
    reservedBalance: new Decimal(0),
    currency: "USD",
    version: 1,
  }

  const mockItems = [
    {
      id: "item-1",
      websiteId: "site-1",
      price: new Decimal(500),
      status: "PENDING_PAYMENT",
    },
  ]

  const reviewedCheckout = {
    expectedVersion: 1,
    expectedAmount: "500.00",
    expectedCurrency: "USD",
  }

  const mockCatalogService = {
    id: "ls-1",
    listingId: "listing-1",
    serviceType: "GUEST_POST",
    price: new Decimal(500),
    availability: "AVAILABLE",
    currency: "USD",
    listing: {
      id: "listing-1",
      status: "APPROVED",
      currency: "USD",
      websiteId: "site-1",
      website: {
        id: "site-1",
        isActive: true,
        verificationStatus: "VERIFIED",
      },
    },
  }

  beforeEach(() => {
    auditMock = { log: jest.fn().mockResolvedValue(undefined) }
    billingMock = {
      reserve: jest.fn().mockResolvedValue(undefined),
      payFromReserved: jest.fn().mockResolvedValue(undefined),
    }

    prismaMock = {
      order: {
        findFirst: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
      },
      wallet: {
        findFirst: jest.fn(),
        findUniqueOrThrow: jest.fn(),
      },
      orderItem: { findMany: jest.fn(), updateMany: jest.fn() },
      // Phase 6 — production uses tx.listingService.findUnique on the snapshotted
      // listingServiceId. marketplaceListing.findFirst is the legacy fallback path
      // that orders.service.ts uses at create time, not order-payment.
      listingService: { findUnique: jest.fn() },
      orderEvent: { create: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([{ id: "order-1" }]),
      $transaction: jest.fn(),
    }
    prismaMock.orderItem.findMany.mockResolvedValue(mockItems)

    service = new OrderPaymentService(
      prismaMock as any,
      auditMock as any,
      billingMock as any,
    )
    submitReviewedPayment = () =>
      service.submitPayment(
        "order-1",
        "user-1",
        "org-1",
        "OWNER",
        reviewedCheckout,
      )
  })

  describe("submitPayment", () => {
    it("transitions DRAFT order to PAID+SUBMITTED in one transaction", async () => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.order.findFirst.mockResolvedValue(mockOrder)
        prismaMock.wallet.findFirst.mockResolvedValue(mockWallet)
        prismaMock.orderItem.findMany.mockResolvedValue(mockItems)
        prismaMock.listingService.findUnique.mockResolvedValue(
          mockCatalogService,
        )
        prismaMock.wallet.findUniqueOrThrow.mockResolvedValue(mockWallet)
        prismaMock.order.updateMany.mockResolvedValue({ count: 1 }) // captured
        prismaMock.order.findUnique.mockResolvedValue({
          ...mockOrder,
          paymentStatus: "PAID",
          status: "SUBMITTED",
          version: 2,
        })
        return cb(prismaMock)
      })

      const result = await submitReviewedPayment()

      // reserve/pay now run inside the order transaction (5th arg = tx) so the
      // debit is atomic with the version-guarded order claim
      expect(billingMock.reserve).toHaveBeenCalledWith(
        "wallet-1",
        new Decimal(500),
        "order-1",
        { id: "user-1", organizationId: "org-1" },
        expect.anything(),
      )
      expect(billingMock.payFromReserved).toHaveBeenCalledWith(
        "wallet-1",
        new Decimal(500),
        "order-1",
        { id: "user-1", organizationId: "org-1" },
        expect.anything(),
      )
      expect(prismaMock.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            paymentStatus: "PAID",
            status: "PAID",
          }),
        }),
      )
      expect(prismaMock.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "SUBMITTED",
            submittedAt: expect.any(Date),
          }),
        }),
      )
      expect(result.status).toBe("SUBMITTED")
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "PAYMENT_CAPTURED" }),
        expect.anything(), // tx — audit runs inside the payment transaction
      )
    })

    it("retains the sole-owner payer as an authorized receipt recipient", async () => {
      const communicationsMock = {
        customerOrderRecipients: jest.fn().mockResolvedValue(["user-1"]),
        publisherRecipients: jest.fn().mockResolvedValue(["publisher-user-1"]),
        staffRecipients: jest.fn().mockResolvedValue([]),
        record: jest
          .fn()
          .mockResolvedValueOnce({ eventId: "customer-payment-event" })
          .mockResolvedValueOnce({ eventId: "publisher-order-event" }),
        dispatchBestEffort: jest.fn(),
      }
      service = new OrderPaymentService(
        prismaMock as any,
        auditMock as any,
        billingMock as any,
        communicationsMock as any,
      )
      prismaMock.website = {
        findUnique: jest.fn().mockResolvedValue({ publisherId: "publisher-1" }),
      }
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.order.findFirst.mockResolvedValue(mockOrder)
        prismaMock.wallet.findFirst.mockResolvedValue(mockWallet)
        prismaMock.orderItem.findMany.mockResolvedValue(mockItems)
        prismaMock.listingService.findUnique.mockResolvedValue(
          mockCatalogService,
        )
        prismaMock.wallet.findUniqueOrThrow.mockResolvedValue(mockWallet)
        prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
        prismaMock.order.findUnique.mockResolvedValue({
          ...mockOrder,
          paymentStatus: "PAID",
          status: "SUBMITTED",
          version: 2,
        })
        return cb(prismaMock)
      })

      await submitReviewedPayment()

      expect(communicationsMock.record).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          type: "ORDER_PAYMENT_CAPTURED",
          recipientUserIds: ["user-1"],
          actorUserId: "user-1",
        }),
        prismaMock,
      )
      expect(communicationsMock.dispatchBestEffort).toHaveBeenCalledWith(
        "customer-payment-event",
      )
    })

    it("rejects non-DRAFT orders", async () => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.order.findFirst.mockResolvedValue({
          ...mockOrder,
          status: "SUBMITTED",
        })
        return cb(prismaMock)
      })

      await expect(submitReviewedPayment()).rejects.toThrow(BadRequestException)
    })

    it("rejects an invalid persisted amount as changed checkout evidence", async () => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.order.findFirst.mockResolvedValue({
          ...mockOrder,
          amount: new Decimal(0),
        })
        return cb(prismaMock)
      })

      await expect(submitReviewedPayment()).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "ORDER_CHECKOUT_STATE_CHANGED",
        }),
      })
      expect(prismaMock.wallet.findFirst).not.toHaveBeenCalled()
    })

    it("rejects insufficient balance", async () => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.order.findFirst.mockResolvedValue(mockOrder)
        prismaMock.wallet.findFirst.mockResolvedValue({
          ...mockWallet,
          availableBalance: new Decimal(100),
        })
        return cb(prismaMock)
      })

      await expect(submitReviewedPayment()).rejects.toThrow(BadRequestException)
    })

    it("rejects when listing is no longer available", async () => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.order.findFirst.mockResolvedValue(mockOrder)
        prismaMock.wallet.findFirst.mockResolvedValue(mockWallet)
        prismaMock.orderItem.findMany.mockResolvedValue(mockItems)
        prismaMock.listingService.findUnique.mockResolvedValue(null)
        return cb(prismaMock)
      })

      await expect(submitReviewedPayment()).rejects.toThrow(BadRequestException)
    })

    it("throws ConflictException on order version mismatch", async () => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.order.findFirst.mockResolvedValue(mockOrder)
        prismaMock.wallet.findFirst.mockResolvedValue(mockWallet)
        prismaMock.orderItem.findMany.mockResolvedValue(mockItems)
        prismaMock.listingService.findUnique.mockResolvedValue(
          mockCatalogService,
        )
        prismaMock.wallet.findUniqueOrThrow.mockResolvedValue(mockWallet)
        prismaMock.order.updateMany.mockResolvedValue({ count: 0 })
        return cb(prismaMock)
      })

      await expect(submitReviewedPayment()).rejects.toThrow(ConflictException)
    })

    it("rejects a non-USD order as changed checkout evidence before wallet access", async () => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.order.findFirst.mockResolvedValue({
          ...mockOrder,
          currency: "EUR",
        })
        return cb(prismaMock)
      })

      await expect(submitReviewedPayment()).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "ORDER_CHECKOUT_STATE_CHANGED",
        }),
      })
      expect(prismaMock.wallet.findFirst).not.toHaveBeenCalled()
      expect(billingMock.reserve).not.toHaveBeenCalled()
    })

    it.each([
      {
        label: "version",
        command: { ...reviewedCheckout, expectedVersion: 0 },
      },
      {
        label: "amount",
        command: { ...reviewedCheckout, expectedAmount: "499.00" },
      },
    ])("rejects stale reviewed $label before any wallet or item read", async ({
      command,
    }) => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.order.findFirst.mockResolvedValue(mockOrder)
        return cb(prismaMock)
      })

      await expect(
        service.submitPayment("order-1", "user-1", "org-1", "OWNER", command),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "ORDER_CHECKOUT_STATE_CHANGED",
        }),
      })
      expect(prismaMock.wallet.findFirst).not.toHaveBeenCalled()
      expect(prismaMock.orderItem.findMany).not.toHaveBeenCalled()
      expect(billingMock.reserve).not.toHaveBeenCalled()
    })

    it("rejects malformed checkout evidence before opening a transaction", async () => {
      await expect(
        service.submitPayment("order-1", "user-1", "org-1", "OWNER", {
          ...reviewedCheckout,
          expectedAmount: "500",
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "CHECKOUT_EVIDENCE_INVALID",
        }),
      })
      expect(prismaMock.$transaction).not.toHaveBeenCalled()
    })

    it("rejects a non-USD wallet before claiming the order", async () => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.order.findFirst.mockResolvedValue(mockOrder)
        prismaMock.wallet.findFirst.mockResolvedValue({
          ...mockWallet,
          currency: "GBP",
        })
        return cb(prismaMock)
      })

      await expect(submitReviewedPayment()).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "WALLET_CURRENCY_MISMATCH",
        }),
      })
      expect(prismaMock.order.updateMany).not.toHaveBeenCalled()
      expect(billingMock.reserve).not.toHaveBeenCalled()
    })

    it("rejects listing currency drift before claiming or moving money", async () => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.order.findFirst.mockResolvedValue(mockOrder)
        prismaMock.wallet.findFirst.mockResolvedValue(mockWallet)
        prismaMock.orderItem.findMany.mockResolvedValue(mockItems)
        prismaMock.listingService.findUnique.mockResolvedValue({
          ...mockCatalogService,
          currency: "EUR",
        })
        return cb(prismaMock)
      })

      await expect(submitReviewedPayment()).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "LISTING_SERVICE_CURRENCY_MISMATCH",
        }),
      })
      expect(prismaMock.order.updateMany).not.toHaveBeenCalled()
      expect(billingMock.reserve).not.toHaveBeenCalled()
    })

    it.each([
      {
        label: "paused listing",
        catalog: {
          ...mockCatalogService,
          listing: { ...mockCatalogService.listing, status: "PAUSED" },
        },
        code: "LISTING_UNAVAILABLE",
      },
      {
        label: "revoked website",
        catalog: {
          ...mockCatalogService,
          listing: {
            ...mockCatalogService.listing,
            website: {
              ...mockCatalogService.listing.website,
              verificationStatus: "REVOKED",
            },
          },
        },
        code: "WEBSITE_UNAVAILABLE",
      },
      {
        label: "cross-website attribution",
        catalog: {
          ...mockCatalogService,
          listing: {
            ...mockCatalogService.listing,
            websiteId: "site-2",
            website: {
              ...mockCatalogService.listing.website,
              id: "site-2",
            },
          },
        },
        code: "CATALOG_CONTRACT_MISMATCH",
      },
    ])("rejects $label before claiming or moving money", async ({
      catalog,
      code,
    }) => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.order.findFirst.mockResolvedValue(mockOrder)
        prismaMock.wallet.findFirst.mockResolvedValue(mockWallet)
        prismaMock.orderItem.findMany.mockResolvedValue(mockItems)
        prismaMock.listingService.findUnique.mockResolvedValue(catalog)
        return cb(prismaMock)
      })

      await expect(submitReviewedPayment()).rejects.toMatchObject({
        response: expect.objectContaining({ code }),
      })
      expect(prismaMock.order.updateMany).not.toHaveBeenCalled()
      expect(billingMock.reserve).not.toHaveBeenCalled()
    })

    it("rejects a cart total mismatch before reading live price or moving money", async () => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.order.findFirst.mockResolvedValue(mockOrder)
        prismaMock.wallet.findFirst.mockResolvedValue(mockWallet)
        prismaMock.orderItem.findMany.mockResolvedValue([
          { ...mockItems[0], price: new Decimal(499) },
        ])
        return cb(prismaMock)
      })

      await expect(submitReviewedPayment()).rejects.toMatchObject({
        response: expect.objectContaining({ code: "ORDER_TOTAL_MISMATCH" }),
      })
      expect(prismaMock.listingService.findUnique).not.toHaveBeenCalled()
      expect(prismaMock.order.updateMany).not.toHaveBeenCalled()
      expect(billingMock.reserve).not.toHaveBeenCalled()
    })

    it.each([
      "DRAFT",
      "PAID",
      "SUBMITTED",
    ])("rejects item status %s before moving money", async (status) => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.order.findFirst.mockResolvedValue(mockOrder)
        prismaMock.wallet.findFirst.mockResolvedValue(mockWallet)
        prismaMock.orderItem.findMany.mockResolvedValue([
          { ...mockItems[0], status },
        ])
        return cb(prismaMock)
      })

      await expect(submitReviewedPayment()).rejects.toMatchObject({
        response: expect.objectContaining({ code: "ORDER_ITEMS_INVALID" }),
      })
      expect(billingMock.reserve).not.toHaveBeenCalled()
    })

    it("returns only the external customer projection after capture", async () => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.order.findFirst.mockResolvedValue(mockOrder)
        prismaMock.wallet.findFirst.mockResolvedValue(mockWallet)
        prismaMock.orderItem.findMany.mockResolvedValue(mockItems)
        prismaMock.listingService.findUnique.mockResolvedValue(
          mockCatalogService,
        )
        prismaMock.wallet.findUniqueOrThrow.mockResolvedValue(mockWallet)
        prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
        prismaMock.order.findUnique.mockResolvedValue({
          ...mockOrder,
          paymentStatus: "PAID",
          status: "SUBMITTED",
          version: 2,
          idempotencyKey: "internal-key",
          requestFingerprint: "a".repeat(64),
          settlementGateVersion: 4,
          reports: [{ id: "internal-report" }],
        })
        return cb(prismaMock)
      })

      const result = await submitReviewedPayment()

      expect(result).toEqual(
        expect.objectContaining({
          id: "order-1",
          status: "SUBMITTED",
          items: [],
          events: [],
          settlements: [],
        }),
      )
      expect(result).not.toHaveProperty("idempotencyKey")
      expect(result).not.toHaveProperty("requestFingerprint")
      expect(result).not.toHaveProperty("settlementGateVersion")
      expect(result).not.toHaveProperty("reports")
    })

    it("commits an exact DRAFT reprice, then returns a re-quote conflict without charging", async () => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.order.findFirst.mockResolvedValue(mockOrder)
        prismaMock.wallet.findFirst.mockResolvedValue(mockWallet)
        prismaMock.orderItem.findMany.mockResolvedValue(mockItems)
        prismaMock.listingService.findUnique.mockResolvedValue({
          ...mockCatalogService,
          price: new Decimal(525),
        })
        prismaMock.orderItem.updateMany.mockResolvedValue({ count: 1 })
        prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
        return cb(prismaMock)
      })

      await expect(submitReviewedPayment()).rejects.toMatchObject({
        response: expect.objectContaining({ code: "REQUOTE_REQUIRED" }),
      })
      expect(prismaMock.orderItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { price: new Decimal(525) } }),
      )
      expect(prismaMock.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            amount: new Decimal(525),
            version: { increment: 1 },
          }),
        }),
      )
      expect(billingMock.reserve).not.toHaveBeenCalled()
    })
  })
})
