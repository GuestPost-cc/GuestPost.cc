/**
 * Delivery intervention — manual approve/reject/override permissions + reason
 * enforcement + status guards + revision request. Pure service unit tests with
 * mocked prisma/audit/queue.
 */
import { BadRequestException, ForbiddenException, Logger } from "@nestjs/common"
import { DeliveryInterventionService } from "../services/delivery-intervention.service"

describe("DeliveryInterventionService", () => {
  let svc: DeliveryInterventionService
  let prisma: any
  let audit: any
  let queue: any

  const order = {
    id: "o1",
    organizationId: "org1",
    customerId: "c1",
    status: "PUBLISHED",
    websiteId: "w1",
    website: { publisherId: "pub1" },
    version: 1,
    activeDeliveryVersionId: "v1",
    publishedUrl: "https://x.com/p",
  }

  function versionWith(status: string) {
    return {
      id: "v1",
      orderId: "o1",
      publishedUrl: "https://x.com/p",
      verificationStatus: status,
      verificationVersion: 0,
      supersededByVersion: null,
    }
  }

  beforeEach(() => {
    audit = { log: jest.fn().mockResolvedValue(undefined) }
    queue = { addJob: jest.fn().mockResolvedValue(undefined) }
    prisma = {
      orderDeliveryVersion: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      order: {
        findUnique: jest.fn().mockResolvedValue(order),
        findFirst: jest.fn().mockResolvedValue(order),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      publisherMembership: {
        findMany: jest.fn().mockResolvedValue([{ userId: "pub-user" }]),
      },
      deliveryFraudFlag: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
      },
      deliveryFraudFlagResolution: {
        create: jest.fn().mockResolvedValue({ id: "fraud-resolution-1" }),
      },
      notification: { create: jest.fn().mockResolvedValue({}) },
      staffMembership: {
        findUnique: jest.fn().mockResolvedValue({
          role: "OPERATIONS",
          user: { userType: "STAFF", banned: false },
        }),
      },
      orderEvent: { create: jest.fn().mockResolvedValue({}) },
      revision: { create: jest.fn().mockResolvedValue({}) },
      $queryRaw: jest.fn().mockResolvedValue([{ id: "o1" }]),
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb(prisma)),
    }
    svc = new DeliveryInterventionService(
      prisma as any,
      audit as any,
      queue as any,
    )
  })

  const reason = "this is a sufficiently long reason"

  describe("manualApprove", () => {
    it("approves a FAILED delivery with a valid reason + audits", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("FAILED"),
      )
      const r = await svc.manualApprove("v1", "u1", "OPERATIONS", reason)
      expect(r.status).toBe("APPROVED")
      expect(prisma.orderDeliveryVersion.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ interventionStatus: "APPROVED" }),
        }),
      )
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "ORDER_DELIVERY_MANUAL_APPROVED" }),
        prisma,
      )
      expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.orderDeliveryVersion.updateMany.mock.invocationCallOrder[0],
      )
    })
    it("rejects a short reason", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("FAILED"),
      )
      await expect(
        svc.manualApprove("v1", "u1", "OPERATIONS", "too short"),
      ).rejects.toThrow(BadRequestException)
    })
    it("refuses to approve a VERIFIED delivery", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("VERIFIED"),
      )
      await expect(
        svc.manualApprove("v1", "u1", "OPERATIONS", reason),
      ).rejects.toThrow(BadRequestException)
    })

    it("clears only flags on the reviewed delivery with role-at-time evidence", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("FAILED"),
      )
      prisma.deliveryFraudFlag.findMany.mockResolvedValue([
        { id: "flag-1", deliveryVersionId: "v1", type: "URL_REUSED" },
      ])

      await svc.manualApprove("v1", "u1", "OPERATIONS", reason)

      expect(prisma.deliveryFraudFlag.findMany).toHaveBeenCalledWith({
        where: {
          orderId: "o1",
          deliveryVersionId: "v1",
          resolution: null,
        },
        select: { id: true, deliveryVersionId: true, type: true },
      })
      expect(prisma.deliveryFraudFlagResolution.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          fraudFlagId: "flag-1",
          resolvedByUserId: "u1",
          resolvedByRole: "OPERATIONS",
        }),
      })
    })
  })

  describe("resolveFraudFlag", () => {
    it.each([
      "VERIFIED",
      "DELIVERED",
    ])("resolves one hold on a %s order without changing lifecycle state", async (status) => {
      prisma.deliveryFraudFlag.findUnique
        .mockResolvedValueOnce({ orderId: "o1" })
        .mockResolvedValueOnce({
          id: "flag-1",
          orderId: "o1",
          deliveryVersionId: "v1",
          type: "URL_REUSED",
          resolution: null,
        })
      prisma.order.findUnique.mockResolvedValue({ ...order, status })

      await expect(
        svc.resolveFraudFlag("flag-1", "u1", "OPERATIONS", reason),
      ).resolves.toEqual({
        status: "RESOLVED",
        fraudFlagId: "flag-1",
        resolutionId: "fraud-resolution-1",
      })

      expect(prisma.order.updateMany).not.toHaveBeenCalled()
      expect(prisma.orderDeliveryVersion.updateMany).not.toHaveBeenCalled()
      expect(prisma.deliveryFraudFlagResolution.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          fraudFlagId: "flag-1",
          orderId: "o1",
          deliveryVersionId: "v1",
          resolvedByUserId: "u1",
          resolvedByRole: "OPERATIONS",
        }),
      })
    })

    it("fails closed when token role no longer matches current staff authority", async () => {
      prisma.deliveryFraudFlag.findUnique
        .mockResolvedValueOnce({ orderId: "o1" })
        .mockResolvedValueOnce({
          id: "flag-1",
          orderId: "o1",
          deliveryVersionId: "v1",
          type: "URL_REUSED",
          resolution: null,
        })
      prisma.staffMembership.findUnique.mockResolvedValue({
        role: "FINANCE",
        user: { userType: "STAFF", banned: false },
      })

      await expect(
        svc.resolveFraudFlag("flag-1", "u1", "OPERATIONS", reason),
      ).rejects.toBeInstanceOf(ForbiddenException)
      expect(prisma.deliveryFraudFlagResolution.create).not.toHaveBeenCalled()
    })

    it("returns the existing resolution idempotently", async () => {
      prisma.deliveryFraudFlag.findUnique
        .mockResolvedValueOnce({ orderId: "o1" })
        .mockResolvedValueOnce({
          id: "flag-1",
          orderId: "o1",
          deliveryVersionId: "v1",
          type: "URL_REUSED",
          resolution: { id: "resolution-existing" },
        })

      await expect(
        svc.resolveFraudFlag("flag-1", "u1", "OPERATIONS", reason),
      ).resolves.toEqual({
        status: "ALREADY_RESOLVED",
        fraudFlagId: "flag-1",
        resolutionId: "resolution-existing",
      })
      expect(prisma.deliveryFraudFlagResolution.create).not.toHaveBeenCalled()
    })

    it("rejects overlong resolution evidence before persistence", async () => {
      await expect(
        svc.resolveFraudFlag("flag-1", "u1", "OPERATIONS", "x".repeat(1001)),
      ).rejects.toBeInstanceOf(BadRequestException)
      expect(prisma.deliveryFraudFlag.findUnique).not.toHaveBeenCalled()
    })
  })

  describe("override", () => {
    it("allows SUPER_ADMIN to flip FAILED->VERIFIED", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("FAILED"),
      )
      prisma.staffMembership.findUnique.mockResolvedValue({
        role: "SUPER_ADMIN",
        user: { userType: "STAFF", banned: false },
      })
      const r = await svc.override(
        "v1",
        "admin",
        "SUPER_ADMIN",
        "VERIFIED",
        reason,
      )
      expect(r.status).toBe("VERIFIED")
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "ORDER_DELIVERY_OVERRIDDEN" }),
        prisma,
      )
    })
    it("forbids non-SUPER_ADMIN", async () => {
      await expect(
        svc.override("v1", "u1", "OPERATIONS", "VERIFIED", reason),
      ).rejects.toThrow(ForbiddenException)
    })
    it("fails closed when SUPER_ADMIN authority was demoted", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("FAILED"),
      )
      prisma.staffMembership.findUnique.mockResolvedValue({
        role: "OPERATIONS",
        user: { userType: "STAFF", banned: false },
      })

      await expect(
        svc.override("v1", "admin", "SUPER_ADMIN", "VERIFIED", reason),
      ).rejects.toBeInstanceOf(ForbiddenException)

      expect(prisma.orderDeliveryVersion.updateMany).not.toHaveBeenCalled()
      expect(audit.log).not.toHaveBeenCalled()
    })
    it("rejects invalid target status", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("FAILED"),
      )
      await expect(
        svc.override("v1", "admin", "SUPER_ADMIN", "PENDING" as any, reason),
      ).rejects.toThrow(BadRequestException)
    })
  })

  describe("manualReject", () => {
    it("rejects only the active, current delivery version", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("FAILED"),
      )

      await expect(
        svc.manualReject("v1", "u1", "OPERATIONS", reason),
      ).resolves.toEqual({ status: "REJECTED" })

      expect(prisma.orderDeliveryVersion.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: "v1",
            orderId: "o1",
            supersededByVersion: null,
            verificationVersion: 0,
          },
        }),
      )
    })

    it("refuses to reject a superseded delivery version", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue({
        ...versionWith("FAILED"),
        supersededByVersion: 2,
      })

      await expect(
        svc.manualReject("v1", "u1", "OPERATIONS", reason),
      ).rejects.toThrow(/no longer the active version/i)

      expect(prisma.orderDeliveryVersion.updateMany).not.toHaveBeenCalled()
      expect(audit.log).not.toHaveBeenCalled()
      expect(prisma.notification.create).not.toHaveBeenCalled()
    })

    it("fails closed when staff authority was demoted", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("FAILED"),
      )
      prisma.staffMembership.findUnique.mockResolvedValue({
        role: "FINANCE",
        user: { userType: "STAFF", banned: false },
      })

      await expect(
        svc.manualReject("v1", "u1", "OPERATIONS", reason),
      ).rejects.toBeInstanceOf(ForbiddenException)

      expect(prisma.orderDeliveryVersion.updateMany).not.toHaveBeenCalled()
      expect(audit.log).not.toHaveBeenCalled()
      expect(prisma.notification.create).not.toHaveBeenCalled()
    })

    it.each([
      "DELIVERED",
      "SETTLED",
      "COMPLETED",
      "CANCELLED",
      "REFUNDED",
    ])("keeps delivery evidence immutable for %s orders", async (status) => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("FAILED"),
      )
      prisma.order.findUnique
        .mockResolvedValueOnce(order)
        .mockResolvedValue({ ...order, status })

      await expect(
        svc.manualReject("v1", "u1", "OPERATIONS", reason),
      ).rejects.toThrow(/financially final/i)

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1)
      expect(prisma.orderDeliveryVersion.updateMany).not.toHaveBeenCalled()
      expect(audit.log).not.toHaveBeenCalled()
      expect(prisma.notification.create).not.toHaveBeenCalled()
    })
  })

  describe("reverify", () => {
    it("resets to PENDING + enqueues a signed verify job", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("FAILED"),
      )
      const r = await svc.reverify("v1", "u1")
      expect(r.status).toBe("PENDING")
      expect(prisma.orderDeliveryVersion.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            verificationStatus: "PENDING",
            interventionStatus: "NONE",
          }),
        }),
      )
      expect(queue.addJob).toHaveBeenCalledWith(
        "delivery-verification",
        "delivery-verify",
        expect.objectContaining({
          deliveryVersionId: "v1",
          verificationVersion: 1,
        }),
        expect.objectContaining({
          attempts: 3,
          jobId: "delivery-verify-v1-v1",
        }),
      )
    })

    it("surfaces a recoverable error after the database commit when enqueue fails", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("FAILED"),
      )
      queue.addJob.mockRejectedValue(new Error("redis unavailable"))
      const logger = jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => undefined)

      const error = await svc.reverify("v1", "u1").catch((value) => value)

      expect(error.getStatus()).toBe(503)
      expect(error.getResponse()).toEqual(
        expect.objectContaining({
          code: "DELIVERY_VERIFICATION_ENQUEUE_FAILED",
          deliveryVersionId: "v1",
        }),
      )
      expect(prisma.orderDeliveryVersion.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ verificationStatus: "PENDING" }),
        }),
      )
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "ORDER_DELIVERY_VERIFICATION_STARTED",
        }),
        prisma,
      )
      logger.mockRestore()
    })
    it("refuses to re-verify a superseded version", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue({
        ...versionWith("FAILED"),
        supersededByVersion: 2,
      })
      await expect(svc.reverify("v1", "u1")).rejects.toThrow(
        BadRequestException,
      )
    })
    it("does not enqueue when a concurrent intervention wins", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("FAILED"),
      )
      prisma.orderDeliveryVersion.updateMany.mockResolvedValue({ count: 0 })

      await expect(svc.reverify("v1", "u1")).rejects.toThrow(
        /modified by another request/i,
      )
      expect(queue.addJob).not.toHaveBeenCalled()
      expect(audit.log).not.toHaveBeenCalled()
    })

    it("retries rollback-safe DB work without enqueuing twice", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("FAILED"),
      )
      let attempt = 0
      prisma.$transaction.mockImplementation(async (callback: any) => {
        const result = await callback(prisma)
        attempt++
        if (attempt === 1) throw { code: "P2034" }
        return result
      })

      await svc.reverify("v1", "u1")

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2)
      expect(prisma.orderDeliveryVersion.updateMany).toHaveBeenCalledTimes(2)
      expect(queue.addJob).toHaveBeenCalledTimes(1)
    })

    it.each([
      "DELIVERED",
      "SETTLED",
      "COMPLETED",
      "CANCELLED",
      "REFUNDED",
    ])("does not re-verify financially final %s orders", async (status) => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("FAILED"),
      )
      prisma.order.findUnique
        .mockResolvedValueOnce(order)
        .mockResolvedValueOnce({ ...order, status })

      await expect(svc.reverify("v1", "u1")).rejects.toThrow(
        /financially final/i,
      )

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1)
      expect(prisma.orderDeliveryVersion.updateMany).not.toHaveBeenCalled()
      expect(audit.log).not.toHaveBeenCalled()
      expect(queue.addJob).not.toHaveBeenCalled()
    })
  })
})
