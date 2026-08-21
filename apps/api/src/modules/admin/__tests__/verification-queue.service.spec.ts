import { AdminVerificationQueueService } from "../verification-queue.service"

describe("AdminVerificationQueueService", () => {
  it("returns the order and delivery fields required by the staff queue", async () => {
    const submittedAt = new Date("2026-07-17T08:00:00.000Z")
    const prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "order-1",
            version: 4,
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
            fraudFlags: [
              {
                id: "fraud-flag-1",
                deliveryVersionId: "delivery-1",
                type: "URL_REUSED",
                details: { match: "internal-evidence" },
                createdAt: submittedAt,
                finding: {
                  id: "finding-1",
                  cancellationRequestId: "cancellation-1",
                  outcome: "CONFIRMED_FRAUD",
                  internalReason:
                    "The immutable evidence confirms intentional URL reuse.",
                  decidedByRole: "OPERATIONS",
                  createdAt: submittedAt,
                },
                deliveryVersion: {
                  id: "delivery-1",
                  version: 2,
                  publishedUrl: "https://example.com/article",
                  verificationStatus: "MANUAL_REVIEW",
                  verificationVersion: 3,
                  supersededByVersion: null,
                  evidence: [],
                },
              },
            ],
          },
        ]),
      },
    }
    const service = new AdminVerificationQueueService(
      prisma as any,
      {} as any,
      {} as any,
    )

    await expect(service.listQueue("SUPER_ADMIN")).resolves.toEqual([
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
          fraudFlags: [
            expect.objectContaining({
              id: "fraud-flag-1",
              finding: expect.objectContaining({
                id: "finding-1",
                cancellationRequestId: "cancellation-1",
              }),
            }),
          ],
        }),
      }),
    ])
    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            {
              status: "PUBLISHED",
              activeDeliveryVersion: {
                verificationStatus: { in: ["FAILED", "MANUAL_REVIEW"] },
              },
            },
            {
              status: { notIn: ["CANCELLED", "REFUNDED", "COMPLETED"] },
              fraudHolds: { some: {} },
            },
          ],
        },
      }),
    )

    const operations = await service.listQueue("OPERATIONS")
    const finance = await service.listQueue("FINANCE")
    const operationsFinding =
      operations[0].deliveryVersion?.fraudFlags[0].finding
    const financeFinding = finance[0].deliveryVersion?.fraudFlags[0].finding
    expect(operationsFinding).not.toHaveProperty("reason")
    expect(financeFinding).toMatchObject({
      reason: "The immutable evidence confirms intentional URL reuse.",
    })
  })

  it("delegates approval to the canonical fraud-aware intervention path", async () => {
    const prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue({
          status: "PUBLISHED",
          activeDeliveryVersionId: "delivery-1",
        }),
      },
    }
    const intervention = {
      manualApprove: jest.fn().mockResolvedValue({ status: "VERIFIED" }),
    }
    const service = new AdminVerificationQueueService(
      prisma as any,
      {} as any,
      intervention as any,
    )

    await service.markVerified(
      "order-1",
      "staff-1",
      "OPERATIONS",
      "CRAWLER_BLOCKED",
      "The live article was reviewed in a normal browser.",
    )

    expect(intervention.manualApprove).toHaveBeenCalledWith(
      "delivery-1",
      "staff-1",
      "OPERATIONS",
      expect.stringContaining("CRAWLER_BLOCKED"),
      {
        overrideReason: "CRAWLER_BLOCKED",
        notes: "The live article was reviewed in a normal browser.",
      },
    )
  })

  it("delegates rejection to the canonical intervention path", async () => {
    const prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue({
          status: "PUBLISHED",
          activeDeliveryVersionId: "delivery-1",
        }),
      },
    }
    const intervention = {
      manualReject: jest.fn().mockResolvedValue({ status: "REJECTED" }),
    }
    const service = new AdminVerificationQueueService(
      prisma as any,
      {} as any,
      intervention as any,
    )

    await service.reject(
      "order-1",
      "staff-1",
      "OPERATIONS",
      "Published page does not contain the purchased placement.",
    )

    expect(intervention.manualReject).toHaveBeenCalledWith(
      "delivery-1",
      "staff-1",
      "OPERATIONS",
      "Published page does not contain the purchased placement.",
    )
  })
})
