import { OrderStatus, ServiceType } from "@guestpost/database"
import { OrdersService } from "../orders.service"

describe("OrdersService.listOrders", () => {
  let prisma: any
  let service: OrdersService

  beforeEach(() => {
    prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      $transaction: jest.fn((operations: Array<Promise<unknown>>) =>
        Promise.all(operations),
      ),
    }
    service = new OrdersService(prisma)
  })

  it("keeps all queue filters inside the authenticated organization", async () => {
    await service.listOrders("org-1", {
      campaignId: "campaign-1",
      serviceType: ServiceType.GUEST_POST,
      statuses: [OrderStatus.PAID, OrderStatus.CUSTOMER_REVIEW],
      search: "acme",
      take: 20,
      skip: 40,
    })

    const query = prisma.order.findMany.mock.calls[0][0]
    expect(query.where).toEqual({
      organizationId: "org-1",
      campaignId: "campaign-1",
      type: ServiceType.GUEST_POST,
      status: { in: [OrderStatus.PAID, OrderStatus.CUSTOMER_REVIEW] },
      AND: [
        {
          OR: [
            { id: { contains: "acme", mode: "insensitive" } },
            { title: { contains: "acme", mode: "insensitive" } },
            {
              website: {
                is: { url: { contains: "acme", mode: "insensitive" } },
              },
            },
            {
              campaign: {
                is: { name: { contains: "acme", mode: "insensitive" } },
              },
            },
          ],
        },
      ],
    })
    expect(query.take).toBe(20)
    expect(query.skip).toBe(40)
    expect(prisma.order.count).toHaveBeenCalledWith({ where: query.where })
  })

  it("scopes member attention items to that member and counterparty requests", async () => {
    await service.listOrders("org-1", {
      needsAction: true,
      actionableCustomerId: "member-1",
      sort: "priority",
    })

    const query = prisma.order.findMany.mock.calls[0][0]
    expect(query.where.organizationId).toBe("org-1")
    expect(query.where.AND).toEqual([
      {
        customerId: "member-1",
        OR: [
          {
            status: {
              in: [
                OrderStatus.DRAFT,
                OrderStatus.PENDING_PAYMENT,
                OrderStatus.CUSTOMER_REVIEW,
                OrderStatus.VERIFIED,
              ],
            },
          },
          {
            cancellationRequests: {
              some: {
                status: "REQUESTED",
                requesterType: { not: "CUSTOMER" },
              },
            },
          },
        ],
      },
    ])
    expect(query.orderBy).toEqual([
      { autoAcceptAt: { sort: "asc", nulls: "last" } },
      { fulfillmentDueAt: { sort: "asc", nulls: "last" } },
      { updatedAt: "desc" },
    ])
  })
})
