import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common"
import { OrderOperationsService } from "../order-operations.service"

describe("OrderOperationsService", () => {
  let service: OrderOperationsService
  let prismaMock: any
  let auditMock: any
  let queueMock: any
  let deliveryMock: any

  const mockPlatformOrder = {
    id: "order-1",
    organizationId: "org-1",
    customerId: "user-1",
    status: "SUBMITTED",
    version: 1,
    title: "Test order",
    website: { ownershipType: "PLATFORM", url: "https://example.com" },
  }

  const mockPublisherOrder = {
    id: "order-2",
    organizationId: "org-1",
    status: "SUBMITTED",
    version: 1,
    website: { ownershipType: "PUBLISHER", url: "https://publisher.com" },
  }

  beforeEach(() => {
    auditMock = { log: jest.fn().mockResolvedValue(undefined) }
    queueMock = { addJob: jest.fn().mockResolvedValue(undefined) }

    prismaMock = {
      order: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        updateMany: jest.fn(),
      },
      orderEvent: { create: jest.fn() },
      contentOrder: { upsert: jest.fn() },
      fulfillmentAssignment: {
        findFirst: jest.fn().mockResolvedValue({
          id: "fa-1",
          version: 0,
          assignedToUserId: "ops-user",
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(),
    }
    prismaMock.$transaction.mockImplementation(async (callback: any) =>
      callback(prismaMock),
    )

    deliveryMock = {
      submitDelivery: jest
        .fn()
        .mockImplementation(
          async (
            _order: any,
            _userId: string,
            _delivery: any,
            beforeCommit?: (tx: any) => Promise<void>,
          ) => {
            await beforeCommit?.(prismaMock)
            return { id: "dv-1" }
          },
        ),
    }
    service = new OrderOperationsService(
      prismaMock as any,
      auditMock as any,
      queueMock as any,
      deliveryMock as any,
      { assertNoActiveCancellation: jest.fn() } as any,
    )
  })

  describe("acceptOrder", () => {
    it("accepts a platform order in SUBMITTED status", async () => {
      prismaMock.order.findUnique.mockResolvedValue(mockPlatformOrder)
      prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
      prismaMock.order.findUniqueOrThrow.mockResolvedValue({
        ...mockPlatformOrder,
        status: "ACCEPTED",
        assigneeId: "ops-user",
        version: 2,
      })

      const result = await service.acceptOrder(
        "order-1",
        "ops-user",
        "OPERATIONS",
      )

      expect(result.status).toBe("ACCEPTED")
      expect(result.version).toBe(2)
      expect(prismaMock.fulfillmentAssignment.findFirst).toHaveBeenCalledWith({
        where: {
          orderId: "order-1",
          status: { in: ["ASSIGNED", "IN_PROGRESS"] },
          assignedToUserId: "ops-user",
        },
      })
      expect(prismaMock.orderEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ eventType: "ORDER_ACCEPTED" }),
        }),
      )
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "ORDER_ACCEPTED" }),
        prismaMock,
      )
    })

    it("rejects publisher orders", async () => {
      prismaMock.order.findUnique.mockResolvedValue(mockPublisherOrder)

      await expect(
        service.acceptOrder("order-2", "ops-user", "OPERATIONS"),
      ).rejects.toThrow(BadRequestException)
    })

    it("rejects non-SUBMITTED orders", async () => {
      prismaMock.order.findUnique.mockResolvedValue({
        ...mockPlatformOrder,
        status: "DRAFT",
      })

      await expect(
        service.acceptOrder("order-1", "ops-user", "OPERATIONS"),
      ).rejects.toThrow(BadRequestException)
    })

    it("throws NotFoundException for missing order", async () => {
      prismaMock.order.findUnique.mockResolvedValue(null)

      await expect(
        service.acceptOrder("missing", "ops-user", "OPERATIONS"),
      ).rejects.toThrow(NotFoundException)
    })

    it("throws ConflictException on version mismatch", async () => {
      prismaMock.order.findUnique.mockResolvedValue(mockPlatformOrder)
      prismaMock.order.updateMany.mockResolvedValue({ count: 0 })

      await expect(
        service.acceptOrder("order-1", "ops-user", "OPERATIONS"),
      ).rejects.toThrow(ConflictException)
    })

    it("allows the explicit Super Admin assignment override", async () => {
      prismaMock.order.findUnique.mockResolvedValue(mockPlatformOrder)
      prismaMock.fulfillmentAssignment.findFirst.mockResolvedValue(null)
      prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
      prismaMock.order.findUniqueOrThrow.mockResolvedValue({
        ...mockPlatformOrder,
        status: "ACCEPTED",
      })

      await expect(
        service.acceptOrder("order-1", "admin-user", "SUPER_ADMIN"),
      ).resolves.toEqual(expect.objectContaining({ status: "ACCEPTED" }))
    })
  })

  describe("submitContent", () => {
    it("accepts content for ACCEPTED platform orders", async () => {
      const acceptedOrder = { ...mockPlatformOrder, status: "ACCEPTED" }
      prismaMock.order.findUnique.mockResolvedValue(acceptedOrder)
      prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
      prismaMock.order.findUniqueOrThrow.mockResolvedValue({
        ...acceptedOrder,
        status: "CONTENT_CREATION",
        version: 2,
      })

      const result = await service.submitContent(
        "order-1",
        "ops-user",
        "OPERATIONS",
        "Sample content",
      )

      expect(result.status).toBe("CONTENT_CREATION")
      expect(prismaMock.contentOrder.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            brief: "Sample content",
            status: "IN_PROGRESS",
          }),
        }),
      )
    })

    it("rejects content for non-ACCEPTED orders", async () => {
      prismaMock.order.findUnique.mockResolvedValue(mockPlatformOrder)

      await expect(
        service.submitContent("order-1", "ops-user", "OPERATIONS", "content"),
      ).rejects.toThrow(BadRequestException)
    })
  })

  describe("submitContentForReview", () => {
    it("atomically stores content and advances to customer review", async () => {
      const contentOrder = {
        ...mockPlatformOrder,
        status: "CONTENT_CREATION",
      }
      prismaMock.order.findUnique.mockResolvedValue(contentOrder)
      prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
      prismaMock.order.findUniqueOrThrow.mockResolvedValue({
        ...contentOrder,
        status: "CUSTOMER_REVIEW",
        version: 2,
      })

      const result = await service.submitContentForReview(
        "order-1",
        "ops-user",
        "OPERATIONS",
        "Final content",
      )

      expect(result.status).toBe("CUSTOMER_REVIEW")
      expect(prismaMock.contentOrder.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ brief: "Final content" }),
          update: expect.objectContaining({ brief: "Final content" }),
        }),
      )
      expect(prismaMock.fulfillmentAssignment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            assignedToUserId: "ops-user",
            version: 0,
          }),
        }),
      )
      expect(queueMock.addJob).toHaveBeenCalledWith(
        expect.anything(),
        "push-in-app",
        expect.objectContaining({ userId: mockPlatformOrder.customerId }),
      )
    })

    it("rejects a stale assignment before review submission commits", async () => {
      prismaMock.order.findUnique.mockResolvedValue({
        ...mockPlatformOrder,
        status: "CONTENT_CREATION",
      })
      prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
      prismaMock.fulfillmentAssignment.updateMany.mockResolvedValue({
        count: 0,
      })

      await expect(
        service.submitContentForReview(
          "order-1",
          "ops-user",
          "OPERATIONS",
          "Final content",
        ),
      ).rejects.toThrow(ConflictException)
      expect(queueMock.addJob).not.toHaveBeenCalled()
    })
  })

  describe("markPublished", () => {
    it("creates a delivery version when an assigned ops user publishes", async () => {
      const approvedOrder = { ...mockPlatformOrder, status: "APPROVED" }
      prismaMock.order.findUnique.mockResolvedValue(approvedOrder)
      prismaMock.fulfillmentAssignment = {
        findFirst: jest.fn().mockResolvedValue({
          id: "fa-1",
          version: 0,
          assignedToUserId: "ops-user",
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      }
      prismaMock.order.findUniqueOrThrow.mockResolvedValue({
        ...approvedOrder,
        status: "PUBLISHED",
        publishedUrl: "https://example.com/article",
        version: 2,
      })

      const result = await service.markPublished(
        "order-1",
        "ops-user",
        "OPERATIONS",
        "https://example.com/article",
      )

      expect(result.status).toBe("PUBLISHED")
      // Delegates to the shared delivery service (immutable version + verify enqueue)
      expect((service as any).delivery.submitDelivery).toHaveBeenCalledWith(
        approvedOrder,
        "ops-user",
        expect.objectContaining({
          publishedUrl: "https://example.com/article",
        }),
        expect.any(Function),
      )
      expect(prismaMock.fulfillmentAssignment.updateMany).toHaveBeenCalled()
    })

    it("rolls publication back when the assignment changed concurrently", async () => {
      const approvedOrder = { ...mockPlatformOrder, status: "APPROVED" }
      prismaMock.order.findUnique.mockResolvedValue(approvedOrder)
      prismaMock.fulfillmentAssignment.updateMany.mockResolvedValue({
        count: 0,
      })

      await expect(
        service.markPublished(
          "order-1",
          "ops-user",
          "OPERATIONS",
          "https://example.com/article",
        ),
      ).rejects.toThrow(ConflictException)
    })

    it("rejects publish when ops user has no active assignment", async () => {
      const approvedOrder = { ...mockPlatformOrder, status: "APPROVED" }
      prismaMock.order.findUnique.mockResolvedValue(approvedOrder)
      prismaMock.fulfillmentAssignment = {
        findFirst: jest.fn().mockResolvedValue(null),
      }

      await expect(
        service.markPublished(
          "order-1",
          "ops-user",
          "OPERATIONS",
          "https://example.com/article",
        ),
      ).rejects.toThrow(ForbiddenException)
    })

    it("rejects publish for non-APPROVED orders", async () => {
      prismaMock.order.findUnique.mockResolvedValue(mockPlatformOrder)

      await expect(
        service.markPublished(
          "order-1",
          "ops-user",
          "OPERATIONS",
          "https://example.com/article",
        ),
      ).rejects.toThrow(BadRequestException)
    })

    it("rejects publish for publisher orders", async () => {
      prismaMock.order.findUnique.mockResolvedValue(mockPublisherOrder)

      await expect(
        service.markPublished(
          "order-2",
          "ops-user",
          "OPERATIONS",
          "https://example.com/article",
        ),
      ).rejects.toThrow(BadRequestException)
    })
  })
})
