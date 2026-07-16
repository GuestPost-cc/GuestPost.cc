import { AdminVerificationQueueService } from "../verification-queue.service"

describe("AdminVerificationQueueService", () => {
  it("returns the order and delivery fields required by the staff queue", async () => {
    const submittedAt = new Date("2026-07-17T08:00:00.000Z")
    const prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "order-1",
            status: "PUBLISHED",
            title: "Platform delivery",
            amount: 250,
            targetUrl: "https://customer.example/target",
            anchorText: "customer anchor",
            createdAt: new Date("2026-07-16T08:00:00.000Z"),
            customer: {
              id: "customer-1",
              name: "Customer",
              email: "customer@example.com",
            },
            website: {
              id: "website-1",
              name: "Example Site",
              url: "https://example.com",
              domain: "example.com",
              ownershipType: "PUBLISHER",
              publisherId: "publisher-1",
              publisher: {
                id: "publisher-1",
                name: "Example Publisher",
                email: "publisher@example.com",
                tier: "TRUSTED",
              },
            },
            activeDeliveryVersion: {
              id: "delivery-1",
              version: 2,
              verificationStatus: "MANUAL_REVIEW",
              verificationFailureReason: "Crawler challenge",
              publishedUrl: "https://example.com/article",
              submittedAt,
              createdAt: submittedAt,
              verificationVersion: 3,
              adminOverrideReason: null,
              adminVerifiedNotes: null,
              evidence: [
                {
                  httpStatus: 403,
                  resolvedUrl: "https://example.com/article",
                  anchorFound: false,
                  linkFound: false,
                  targetUrlMatched: false,
                  redirectChain: null,
                  checkedAt: submittedAt,
                },
              ],
              fraudFlags: [],
            },
          },
        ]),
      },
    }
    const service = new AdminVerificationQueueService(
      prisma as any,
      {} as any,
      {} as any,
    )

    await expect(service.listQueue()).resolves.toEqual([
      expect.objectContaining({
        orderId: "order-1",
        website: {
          id: "website-1",
          name: "Example Site",
          url: "https://example.com",
          domain: "example.com",
          ownershipType: "PUBLISHER",
        },
        publisher: {
          id: "publisher-1",
          name: "Example Publisher",
          email: "publisher@example.com",
          tier: "TRUSTED",
        },
        deliveryVersion: expect.objectContaining({
          id: "delivery-1",
          verificationStatus: "MANUAL_REVIEW",
          publishedUrl: "https://example.com/article",
        }),
      }),
    ])
    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: "PUBLISHED",
          activeDeliveryVersion: {
            verificationStatus: { in: ["FAILED", "MANUAL_REVIEW"] },
          },
        },
      }),
    )
  })
})
