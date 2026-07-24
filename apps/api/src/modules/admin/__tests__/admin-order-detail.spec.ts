import { NotFoundException } from "@nestjs/common"
import { AdminService } from "../admin.service"

describe("AdminService — order detail", () => {
  let prisma: any
  let service: AdminService

  beforeEach(() => {
    prisma = {
      order: { findFirst: jest.fn() },
      user: { findMany: jest.fn() },
    }
    service = new AdminService(prisma, {} as any, {} as any)
  })

  it("enriches human settlement approvers and preserves approval timestamps", async () => {
    const customerApprovedAt = new Date("2026-07-13T19:49:15.163Z")
    const systemApprovedAt = new Date("2026-07-13T20:09:11.283Z")
    prisma.order.findFirst.mockResolvedValue({
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

  it("returns an explicit Operations projection without financial or contact data", async () => {
    prisma.order.findFirst.mockResolvedValue({
      id: "order-ops",
      type: "GUEST_POST",
      title: "Operations order",
      instructions: "Follow the brief",
      status: "SUBMITTED",
      paymentStatus: "PAID",
      fulfillmentChannel: "PLATFORM",
      fulfillmentDueAt: new Date("2026-07-25T00:00:00.000Z"),
      amount: 250,
      currency: "USD",
      createdAt: new Date("2026-07-20T00:00:00.000Z"),
      updatedAt: new Date("2026-07-21T00:00:00.000Z"),
      version: 3,
      autoAcceptAt: null,
      verifyMethod: "AUTO",
      deliveryAcceptedMethod: null,
      organization: { id: "org-1", name: "Client org", slug: "client-org" },
      customer: {
        id: "customer-1",
        name: "Customer",
        email: "protected@example.com",
        userType: "CUSTOMER",
      },
      website: {
        id: "site-1",
        url: "https://example.com",
        name: "Example",
        ownershipType: "PLATFORM",
        verificationStatus: "VERIFIED",
        publisher: {
          id: "publisher-1",
          name: "Publisher",
          email: "publisher@example.com",
          tier: "GOLD",
          profile: { trustScore: 92 },
        },
        managedBy: {
          id: "ops-1",
          name: "Operator",
          email: "operator@example.com",
        },
      },
      items: [
        {
          id: "item-1",
          targetUrl: "https://target.example",
          anchorText: "Anchor",
          website: {
            id: "site-1",
            url: "https://example.com",
            publisherId: "publisher-1",
          },
        },
      ],
      events: [
        {
          id: "event-1",
          eventType: "ORDER_CREATED",
          message: "Created",
          metadata: { internal: "secret" },
          createdAt: new Date("2026-07-20T00:00:00.000Z"),
        },
        {
          id: "event-2",
          eventType: "ORDER_SUBMITTED",
          message: "Submitted",
          metadata: null,
          createdAt: new Date("2026-07-20T00:01:00.000Z"),
        },
      ],
      activeDeliveryVersion: null,
      settlements: [
        {
          id: "settlement-1",
          status: "PENDING",
          approvals: [],
        },
      ],
      dispute: null,
      cancellationRequests: [],
      fulfillmentAssignments: [
        {
          id: "assignment-1",
          assignedToUserId: "ops-1",
          status: "ASSIGNED",
          assignedAt: new Date("2026-07-20T00:00:00.000Z"),
          completedAt: null,
        },
      ],
      platformRevenue: { id: "revenue-1", platformFee: 50 },
    })

    const result = await service.getOrder("order-ops", {
      id: "ops-1",
      staffRole: "OPERATIONS",
    })

    expect(result.customer).toEqual({ id: "customer-1", name: "Customer" })
    expect(result.website?.publisher).toEqual({
      id: "publisher-1",
      name: "Publisher",
    })
    expect(result.website?.managedBy).toEqual({
      id: "ops-1",
      name: "Operator",
    })
    expect(result.items[0].website).toEqual({
      id: "site-1",
      url: "https://example.com",
    })
    expect(result.events[0]).not.toHaveProperty("metadata")
    expect(result.settlements).toEqual([])
    expect(result).not.toHaveProperty("platformRevenue")
    expect(result.integrity).toEqual(
      expect.objectContaining({
        state: "HEALTHY",
        checks: expect.arrayContaining([
          expect.objectContaining({ key: "ASSIGNMENT", status: "PASS" }),
          expect.objectContaining({ key: "EVENT_CHAIN", status: "PASS" }),
        ]),
      }),
    )
    expect(result.access).toEqual(
      expect.objectContaining({
        role: "OPERATIONS",
        canForceCancel: false,
        canViewFinancials: false,
        canWorkFulfillment: true,
      }),
    )
    expect(prisma.user.findMany).not.toHaveBeenCalled()
  })

  it("gives Finance financial evidence without customer contact or event metadata", async () => {
    prisma.order.findFirst.mockResolvedValue({
      id: "order-finance",
      status: "DELIVERED",
      fulfillmentChannel: "PUBLISHER",
      customer: {
        id: "customer-1",
        name: "Customer",
        email: "protected@example.com",
        userType: "CUSTOMER",
      },
      website: null,
      items: [],
      events: [
        {
          id: "event-1",
          eventType: "DELIVERED",
          message: "Delivered",
          metadata: { internal: "secret" },
          createdAt: new Date("2026-07-20T00:00:00.000Z"),
        },
      ],
      activeDeliveryVersion: null,
      settlements: [
        {
          id: "settlement-1",
          status: "UNDER_REVIEW",
          grossAmount: 250,
          platformFee: 50,
          publisherAmount: 200,
          releasePolicy: "MANUAL",
          reviewEndsAt: null,
          approvals: [],
        },
      ],
      dispute: null,
      cancellationRequests: [],
      fulfillmentAssignments: [],
    })

    const result = await service.getOrder("order-finance", {
      id: "finance-1",
      staffRole: "FINANCE",
    })

    expect(result.customer).toEqual({ id: "customer-1", name: "Customer" })
    expect(result.events[0]).not.toHaveProperty("metadata")
    expect(result.settlements).toHaveLength(1)
    expect(result.integrity).toEqual(
      expect.objectContaining({
        state: "BLOCKED",
        checks: expect.arrayContaining([
          expect.objectContaining({ key: "DELIVERY", status: "FAIL" }),
          expect.objectContaining({
            key: "FINANCIAL_RECORD",
            status: "PASS",
          }),
        ]),
      }),
    )
    expect(result.access).toEqual(
      expect.objectContaining({
        role: "FINANCE",
        canReviewDelivery: false,
        canViewFinancials: true,
        canWorkFulfillment: false,
      }),
    )
  })

  it("does not query approvers when the order does not exist", async () => {
    prisma.order.findFirst.mockResolvedValue(null)

    await expect(service.getOrder("missing-order")).rejects.toThrow(
      NotFoundException,
    )
    expect(prisma.user.findMany).not.toHaveBeenCalled()
  })
})
