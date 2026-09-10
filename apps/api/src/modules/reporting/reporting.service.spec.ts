import { ReportingService } from "./reporting.service"

jest.mock("../../common/customer-website-access", () => ({
  canCustomerViewWebsite: jest.fn().mockResolvedValue(false),
}))

describe("ReportingService", () => {
  it("uses an explicit customer projection and filters internal events", async () => {
    const prisma = {
      order: {
        findFirst: jest.fn().mockResolvedValue({
          id: "order-1",
          customerId: "customer-1",
          status: "PUBLISHED",
          amount: 100,
          currency: "USD",
          fulfillmentChannel: "PUBLISHER",
          website: {
            id: "website-1",
            name: "Hidden until unlocked",
            url: "https://publisher.example",
            ownershipType: "PUBLISHER",
          },
          items: [],
          events: [
            {
              id: "event-public",
              eventType: "ORDER_CREATED",
              message: "internal wording",
              metadata: { version: 1, staffNote: "secret" },
              createdAt: new Date(),
            },
            {
              id: "event-internal",
              eventType: "PAYOUT_APPROVED",
              message: "finance secret",
              metadata: { amount: 90 },
              createdAt: new Date(),
            },
          ],
          platformRevenue: { amount: 10 },
          customer: { email: "private@example.com" },
        }),
      },
    }
    const service = new ReportingService(prisma as any, {} as any)

    const result = await service.getOrderReport("order-1", "org-1")

    const query = prisma.order.findFirst.mock.calls[0][0]
    expect(query.where).toEqual({ id: "order-1", organizationId: "org-1" })
    expect(query.select.platformRevenue).toBeUndefined()
    expect(query.select.customer).toBeUndefined()
    expect(query.select.events.take).toBe(101)
    expect(result).not.toHaveProperty("platformRevenue")
    expect(result).not.toHaveProperty("customer")
    expect(result.events).toHaveLength(1)
    expect(result.events[0].metadata).toEqual({ version: 1 })
    expect(result.eventsTruncated).toBe(false)
  })

  it("strips unknown and legacy-sensitive fields from stored report data", async () => {
    const prisma = {
      report: {
        findFirst: jest.fn().mockResolvedValue({
          id: "report-1",
          type: "generated",
          format: "pdf",
          data: {
            orderId: "order-1",
            status: "PUBLISHED",
            campaignProgress: { staffNotes: "nested secret" },
            website: "https://publisher.example",
            publisher: "publisher-1",
            platformRevenue: "10.00",
            staffNotes: "secret",
          },
        }),
      },
    }

    const result = await new ReportingService(
      prisma as any,
      {} as any,
    ).getReport("report-1", "org-1")

    expect(result.data).toEqual({ orderId: "order-1", status: "PUBLISHED" })
    expect(prisma.report.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "report-1", order: { organizationId: "org-1" } },
      }),
    )
  })
})
