import { BadRequestException, NotFoundException, ConflictException } from "@nestjs/common"
import { OrderPaymentService } from "../order-payment.service"
import { Decimal } from "@prisma/client/runtime/library"

describe("OrderPaymentService", () => {
  let service: OrderPaymentService
  let prismaMock: any
  let auditMock: any
  let billingMock: any

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
    status: "DRAFT",
    amount: new Decimal(500),
    version: 1,
    type: "GUEST_POST",
  }

  const mockWallet = {
    id: "wallet-1",
    organizationId: "org-1",
    availableBalance: new Decimal(1000),
    reservedBalance: new Decimal(0),
    version: 1,
  }

  const mockItems = [
    { id: "item-1", websiteId: "site-1", price: new Decimal(500), status: "PENDING_PAYMENT" },
  ]

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
      orderItem: { findMany: jest.fn() },
      // Phase 6 — production uses tx.listingService.findUnique on the snapshotted
      // listingServiceId. marketplaceListing.findFirst is the legacy fallback path
      // that orders.service.ts uses at create time, not order-payment.
      listingService: { findUnique: jest.fn() },
      orderEvent: { create: jest.fn() },
      $transaction: jest.fn(),
    }

    service = new OrderPaymentService(prismaMock as any, auditMock as any, billingMock as any)
  })

  describe("submitPayment", () => {
    it("transitions DRAFT order to PAID+SUBMITTED in one transaction", async () => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.order.findFirst.mockResolvedValue(mockOrder)
        prismaMock.wallet.findFirst.mockResolvedValue(mockWallet)
        prismaMock.orderItem.findMany.mockResolvedValue(mockItems)
        prismaMock.listingService.findUnique.mockResolvedValue({
          price: new Decimal(500),
          availability: "AVAILABLE",
        })
        prismaMock.wallet.findUniqueOrThrow.mockResolvedValue(mockWallet)
        prismaMock.order.updateMany
          .mockResolvedValue({ count: 1 }) // captured
        prismaMock.order.findUnique.mockResolvedValue({
          ...mockOrder,
          paymentStatus: "PAID",
          status: "SUBMITTED",
          version: 2,
        })
        return cb(prismaMock)
      })

      const result = await service.submitPayment("order-1", "user-1", "org-1")

      // reserve/pay now run inside the order transaction (5th arg = tx) so the
      // debit is atomic with the version-guarded order claim
      expect(billingMock.reserve).toHaveBeenCalledWith(
        "wallet-1", 500, "order-1", { id: "user-1", organizationId: "org-1" }, expect.anything(),
      )
      expect(billingMock.payFromReserved).toHaveBeenCalledWith(
        "wallet-1", 500, "order-1", { id: "user-1", organizationId: "org-1" }, expect.anything(),
      )
      expect(prismaMock.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ paymentStatus: "PAID", status: "PAID" }),
        }),
      )
      expect(prismaMock.order.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: "SUBMITTED" } }),
      )
      expect(result.status).toBe("SUBMITTED")
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "PAYMENT_CAPTURED" }),
        expect.anything(), // tx — audit runs inside the payment transaction
      )
    })

    it("rejects non-DRAFT orders", async () => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.order.findFirst.mockResolvedValue({ ...mockOrder, status: "SUBMITTED" })
        return cb(prismaMock)
      })

      await expect(service.submitPayment("order-1", "user-1", "org-1")).rejects.toThrow(
        BadRequestException,
      )
    })

    it("rejects orders with zero amount", async () => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.order.findFirst.mockResolvedValue({ ...mockOrder, amount: new Decimal(0) })
        return cb(prismaMock)
      })

      await expect(service.submitPayment("order-1", "user-1", "org-1")).rejects.toThrow(
        BadRequestException,
      )
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

      await expect(service.submitPayment("order-1", "user-1", "org-1")).rejects.toThrow(
        BadRequestException,
      )
    })

    it("rejects when listing is no longer available", async () => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.order.findFirst.mockResolvedValue(mockOrder)
        prismaMock.wallet.findFirst.mockResolvedValue(mockWallet)
        prismaMock.orderItem.findMany.mockResolvedValue(mockItems)
        prismaMock.listingService.findUnique.mockResolvedValue(null)
        return cb(prismaMock)
      })

      await expect(service.submitPayment("order-1", "user-1", "org-1")).rejects.toThrow(
        BadRequestException,
      )
    })

    it("throws ConflictException on order version mismatch", async () => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        prismaMock.order.findFirst.mockResolvedValue(mockOrder)
        prismaMock.wallet.findFirst.mockResolvedValue(mockWallet)
        prismaMock.orderItem.findMany.mockResolvedValue(mockItems)
        prismaMock.listingService.findUnique.mockResolvedValue({
          price: new Decimal(500),
          availability: "AVAILABLE",
        })
        prismaMock.wallet.findUniqueOrThrow.mockResolvedValue(mockWallet)
        prismaMock.order.updateMany.mockResolvedValue({ count: 0 })
        return cb(prismaMock)
      })

      await expect(service.submitPayment("order-1", "user-1", "org-1")).rejects.toThrow(
        ConflictException,
      )
    })
  })
})
