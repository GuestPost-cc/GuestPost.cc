import { NotFoundException } from "@nestjs/common"
import { AdminService } from "../admin.service"

describe("AdminService — order detail", () => {
  let prisma: any
  let service: AdminService

  beforeEach(() => {
    prisma = {
      order: { findUnique: jest.fn() },
      user: { findMany: jest.fn() },
    }
    service = new AdminService(prisma, {} as any, {} as any, {} as any)
  })

  it("enriches human settlement approvers and preserves approval timestamps", async () => {
    const customerApprovedAt = new Date("2026-07-13T19:49:15.163Z")
    const systemApprovedAt = new Date("2026-07-13T20:09:11.283Z")
    prisma.order.findUnique.mockResolvedValue({
      id: "order-completed",
      status: "COMPLETED",
      settlements: [
        {
          id: "settlement-1",
          status: "RELEASED",
          approvals: [
            {
              id: "approval-customer",
              type: "CUSTOMER",
              approvedBy: "customer-1",
              roleAtTime: "CUSTOMER_OWNER",
              approvedAt: customerApprovedAt,
            },
            {
              id: "approval-system",
              type: "ADMIN",
              approvedBy: "SYSTEM_AUTO_RELEASE",
              roleAtTime: "SYSTEM",
              approvedAt: systemApprovedAt,
            },
          ],
        },
      ],
    })
    prisma.user.findMany.mockResolvedValue([
      {
        id: "customer-1",
        name: "Sarah Client",
        email: "client@guestpost.local",
      },
    ])

    const result = await service.getOrder("order-completed")

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["customer-1"] } },
      select: { id: true, name: true, email: true },
    })
    expect(result.settlements[0].approvals).toEqual([
      expect.objectContaining({
        approvedBy: "customer-1",
        approvedByUser: {
          id: "customer-1",
          name: "Sarah Client",
          email: "client@guestpost.local",
        },
        approvedAt: customerApprovedAt,
      }),
      expect.objectContaining({
        approvedBy: "SYSTEM_AUTO_RELEASE",
        approvedByUser: null,
        approvedAt: systemApprovedAt,
      }),
    ])
  })

  it("does not query approvers when the order does not exist", async () => {
    prisma.order.findUnique.mockResolvedValue(null)

    await expect(service.getOrder("missing-order")).rejects.toThrow(
      NotFoundException,
    )
    expect(prisma.user.findMany).not.toHaveBeenCalled()
  })
})
