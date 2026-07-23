import { AdminService } from "../services/admin"

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
})
