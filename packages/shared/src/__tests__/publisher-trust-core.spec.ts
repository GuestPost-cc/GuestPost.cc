import { recomputePublisherTrustCore } from "../publisher-trust-core"

describe("publisher trust atomicity", () => {
  it("fails closed when the authoritative tier transition cannot be written", async () => {
    const tierWriteFailure = new Error("publisher tier write failed")
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: "publisher-1" }]),
      publisher: {
        findUnique: jest.fn().mockResolvedValue({
          id: "publisher-1",
          name: "Publisher",
          tier: "LEGACY_TIER",
          profile: { trustScore: 50 },
        }),
        update: jest.fn().mockRejectedValue(tierWriteFailure),
      },
      publisherProfile: { upsert: jest.fn().mockResolvedValue({}) },
      orderReview: {
        aggregate: jest.fn().mockResolvedValue({
          _avg: { rating: 5 },
          _count: { _all: 10 },
        }),
      },
      order: {
        count: jest.fn().mockResolvedValue(10),
      },
      orderDispute: { count: jest.fn().mockResolvedValue(0) },
      deliveryFraudFlag: { count: jest.fn().mockResolvedValue(0) },
      website: { count: jest.fn().mockResolvedValue(0) },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: "audit-transition-1" }),
      },
      // Production transaction clients expose this delegate, disabling the
      // compatibility notification fallback in the core.
      communicationEvent: {},
    }

    await expect(
      recomputePublisherTrustCore(tx, "publisher-1", {
        sourceEvent: "ORDER_COMPLETED",
      }),
    ).rejects.toBe(tierWriteFailure)

    expect(tx.publisherProfile.upsert).toHaveBeenCalledTimes(1)
    expect(tx.publisher.update).toHaveBeenCalledTimes(1)
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })
})
