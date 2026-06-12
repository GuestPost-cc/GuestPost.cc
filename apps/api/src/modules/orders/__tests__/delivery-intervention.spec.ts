/**
 * Delivery intervention — manual approve/reject/override permissions + reason
 * enforcement + status guards + revision request. Pure service unit tests with
 * mocked prisma/audit/queue.
 */
import { BadRequestException, ForbiddenException } from "@nestjs/common"
import { DeliveryInterventionService } from "../services/delivery-intervention.service"

describe("DeliveryInterventionService", () => {
  let svc: DeliveryInterventionService
  let prisma: any
  let audit: any
  let queue: any

  const order = { id: "o1", organizationId: "org1", customerId: "c1", status: "PUBLISHED", websiteId: "w1", website: { publisherId: "pub1" }, version: 1, activeDeliveryVersionId: "v1", publishedUrl: "https://x.com/p" }

  function versionWith(status: string) {
    return { id: "v1", orderId: "o1", publishedUrl: "https://x.com/p", verificationStatus: status, verificationVersion: 0, supersededByVersion: null }
  }

  beforeEach(() => {
    audit = { log: jest.fn().mockResolvedValue(undefined) }
    queue = { addJob: jest.fn().mockResolvedValue(undefined) }
    prisma = {
      orderDeliveryVersion: { findUnique: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      order: { findUnique: jest.fn().mockResolvedValue(order), findFirst: jest.fn().mockResolvedValue(order), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publisherMembership: { findMany: jest.fn().mockResolvedValue([{ userId: "pub-user" }]) },
      notification: { create: jest.fn().mockResolvedValue({}) },
      orderEvent: { create: jest.fn().mockResolvedValue({}) },
      revision: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb(prisma)),
    }
    svc = new DeliveryInterventionService(prisma as any, audit as any, queue as any)
  })

  const reason = "this is a sufficiently long reason"

  describe("manualApprove", () => {
    it("approves a FAILED delivery with a valid reason + audits", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(versionWith("FAILED"))
      const r = await svc.manualApprove("v1", "u1", "OPERATIONS", reason)
      expect(r.status).toBe("APPROVED")
      expect(prisma.orderDeliveryVersion.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ interventionStatus: "APPROVED" }) }))
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "ORDER_DELIVERY_MANUAL_APPROVED" }))
    })
    it("rejects a short reason", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(versionWith("FAILED"))
      await expect(svc.manualApprove("v1", "u1", "OPERATIONS", "too short")).rejects.toThrow(BadRequestException)
    })
    it("refuses to approve a VERIFIED delivery", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(versionWith("VERIFIED"))
      await expect(svc.manualApprove("v1", "u1", "OPERATIONS", reason)).rejects.toThrow(BadRequestException)
    })
  })

  describe("override", () => {
    it("allows SUPER_ADMIN to flip FAILED->VERIFIED", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(versionWith("FAILED"))
      const r = await svc.override("v1", "admin", "SUPER_ADMIN", "VERIFIED", reason)
      expect(r.status).toBe("VERIFIED")
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "ORDER_DELIVERY_OVERRIDDEN" }))
    })
    it("forbids non-SUPER_ADMIN", async () => {
      await expect(svc.override("v1", "u1", "OPERATIONS", "VERIFIED", reason)).rejects.toThrow(ForbiddenException)
    })
    it("rejects invalid target status", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(versionWith("FAILED"))
      await expect(svc.override("v1", "admin", "SUPER_ADMIN", "PENDING" as any, reason)).rejects.toThrow(BadRequestException)
    })
  })

  describe("reverify", () => {
    it("resets to PENDING + enqueues a signed verify job", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(versionWith("FAILED"))
      const r = await svc.reverify("v1", "u1")
      expect(r.status).toBe("PENDING")
      expect(queue.addJob).toHaveBeenCalledWith("delivery-verification", "delivery-verify", expect.objectContaining({ deliveryVersionId: "v1" }), expect.objectContaining({ attempts: 3 }))
    })
    it("refuses to re-verify a superseded version", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue({ ...versionWith("FAILED"), supersededByVersion: 2 })
      await expect(svc.reverify("v1", "u1")).rejects.toThrow(BadRequestException)
    })
  })

  describe("requestRevision", () => {
    it("creates a revision, returns order to APPROVED, audits", async () => {
      const r = await svc.requestRevision("o1", "org1", "c1", "please fix the anchor text placement")
      expect(r.status).toBe("REVISION_REQUESTED")
      expect(prisma.revision.create).toHaveBeenCalled()
      expect(prisma.order.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "APPROVED" }) }))
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "ORDER_DELIVERY_REVISION_REQUESTED" }), expect.anything())
    })
    it("refuses revision on a non-delivered order", async () => {
      prisma.order.findFirst.mockResolvedValue({ ...order, status: "PAID" })
      await expect(svc.requestRevision("o1", "org1", "c1", "please fix the anchor text placement")).rejects.toThrow(BadRequestException)
    })
  })
})
