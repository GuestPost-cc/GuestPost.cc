import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common"
import { OrderOperationsService } from "../order-operations.service"

describe("OrderOperationsService", () => {
  let service: OrderOperationsService
  let prismaMock: any
  let auditMock: any
  let queueMock: any

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
      $transaction: jest.fn(),
    }

    const deliveryMock = {
      submitDelivery: jest.fn().mockResolvedValue({ id: "dv-1" }),
    }
    service = new OrderOperationsService(
      prismaMock as any,
      auditMock as any,
      queueMock as any,
      deliveryMock as any,
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

      const result = await service.acceptOrder("order-1", "ops-user")

      expect(result.status).toBe("ACCEPTED")
      expect(result.version).toBe(2)
      expect(prismaMock.orderEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ eventType: "ORDER_ACCEPTED" }),
        }),
      )
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "ORDER_ACCEPTED" }),
      )
    })

    it("rejects publisher orders", async () => {
      prismaMock.order.findUnique.mockResolvedValue(mockPublisherOrder)

      await expect(service.acceptOrder("order-2", "ops-user")).rejects.toThrow(
        BadRequestException,
      )
    })

    it("rejects non-SUBMITTED orders", async () => {
      prismaMock.order.findUnique.mockResolvedValue({
        ...mockPlatformOrder,
        status: "DRAFT",
      })

      await expect(service.acceptOrder("order-1", "ops-user")).rejects.toThrow(
        BadRequestException,
      )
    })

    it("throws NotFoundException for missing order", async () => {
      prismaMock.order.findUnique.mockResolvedValue(null)

      await expect(service.acceptOrder("missing", "ops-user")).rejects.toThrow(
        NotFoundException,
      )
    })

    it("throws ConflictException on version mismatch", async () => {
      prismaMock.order.findUnique.mockResolvedValue(mockPlatformOrder)
      prismaMock.order.updateMany.mockResolvedValue({ count: 0 })

      await expect(service.acceptOrder("order-1", "ops-user")).rejects.toThrow(
        ConflictException,
      )
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
        service.submitContent("order-1", "ops-user", "content"),
      ).rejects.toThrow(BadRequestException)
    })
  })

  describe("markPublished", () => {
    it("creates a delivery version when an assigned ops user publishes", async () => {
      const approvedOrder = { ...mockPlatformOrder, status: "APPROVED" }
      prismaMock.order.findUnique.mockResolvedValue(approvedOrder)
      prismaMock.fulfillmentAssignment = {
        findFirst: jest.fn().mockResolvedValue({ id: "fa-1", version: 0 }),
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
      )
      expect(prismaMock.fulfillmentAssignment.updateMany).toHaveBeenCalled()
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
          "https://example.com/article",
        ),
      ).rejects.toThrow(BadRequestException)
    })

    it("rejects publish for non-APPROVED orders", async () => {
      prismaMock.order.findUnique.mockResolvedValue(mockPlatformOrder)

      await expect(
        service.markPublished(
          "order-1",
          "ops-user",
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
          "https://example.com/article",
        ),
      ).rejects.toThrow(BadRequestException)
    })
  })
})
