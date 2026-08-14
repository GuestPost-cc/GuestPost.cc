import { HttpClient } from "../client"
import {
  AdminService,
  type OperationsInboxOrder,
  type OperationsOrderDetail,
} from "../services/admin"

describe("AdminService order monitor", () => {
  it("omits UI all-filter sentinels from the API query", async () => {
    const client = { get: jest.fn().mockResolvedValue({ items: [] }) }
    const service = new AdminService(client as any)

    await service.listOrders({
      status: "all",
      channel: "all",
      focus: "completed",
      take: 20,
      skip: 0,
    })

    expect(client.get).toHaveBeenCalledWith("/admin/orders", {
      params: {
        status: undefined,
        channel: undefined,
        focus: "completed",
        take: 20,
        skip: 0,
      },
    })
  })

  it("preserves fulfillment eligibility while exposing role-aware claim and assignment capabilities", async () => {
    const client = new HttpClient({
      baseUrl: "https://api.example.test/api/v1",
    })
    const service = new AdminService(client)
    const order = {
      id: "order-1",
      type: "GUEST_POST",
      title: "Platform placement",
      status: "SUBMITTED",
      amount: "125.00",
      currency: "USD",
      version: 1,
      turnaroundDays: 7,
      fulfillmentDueAt: null,
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
      website: null,
      customer: null,
      organization: null,
      fulfillmentAssignments: [],
      activeDeliveryVersion: null,
      cancellationRequests: [],
      claimable: true,
      canSelfClaim: false,
      canAssign: true,
      canProgress: false,
      nextAction: "ASSIGN",
    } satisfies OperationsInboxOrder
    const get = jest.spyOn(client, "get").mockResolvedValueOnce({
      items: [order],
      total: 1,
      take: 20,
      skip: 0,
      summary: null,
    })

    const result = await service.operationsInbox({
      view: "available",
      take: 20,
      includeSummary: false,
    })

    expect(result.items[0]).toMatchObject({
      claimable: true,
      canSelfClaim: false,
      canAssign: true,
      nextAction: "ASSIGN",
    })
    expect(get).toHaveBeenCalledWith("/operations/fulfillment", {
      params: {
        view: "available",
        take: 20,
        includeSummary: false,
      },
    })

    const detailAccess = {
      claimable: true,
      canSelfClaim: true,
      canAssign: false,
      canProgress: false,
      readOnly: true,
    } satisfies OperationsOrderDetail["access"]
    expect(detailAccess).toMatchObject({
      canSelfClaim: true,
      canAssign: false,
    })
  })

  it("maps self-claim to the Operations-only fulfillment command", async () => {
    const client = new HttpClient({
      baseUrl: "https://api.example.test/api/v1",
    })
    const service = new AdminService(client)
    const post = jest.spyOn(client, "post").mockResolvedValueOnce({
      id: "assignment-1",
      orderId: "order-1",
      assignedToUserId: "ops-1",
      assignedByUserId: "ops-1",
      assignedAt: "2026-08-14T00:00:00.000Z",
      completedAt: null,
      status: "ASSIGNED",
      version: 1,
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
    })

    await service.claimOrder("order-1")

    expect(post).toHaveBeenCalledWith("/orders/order-1/claim")
  })
})
