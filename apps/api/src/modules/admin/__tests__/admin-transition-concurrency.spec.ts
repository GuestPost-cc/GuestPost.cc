import { ConflictException } from "@nestjs/common"
import { AdminService } from "../admin.service"

function listing(status: string) {
  return {
    id: "listing-1",
    status,
    title: "Example listing",
    organizationId: "org-1",
    publisherId: "publisher-1",
    publisher: { email: "publisher@example.com" },
    website: null,
    services: [{ id: "service-1" }],
    categories: [{ categoryId: "category-1" }],
    language: "English",
    sportsGamingAllowed: false,
    pharmacyAllowed: false,
    cryptoAllowed: false,
    backlinkCount: 1,
    linkType: "DOFOLLOW",
    linkValidity: "PERMANENT",
    googleNews: false,
    markedSponsored: false,
    foreignLanguageAllowed: false,
  }
}

function communicationsHarness() {
  let sequence = 0
  return {
    publisherRecipients: jest.fn().mockResolvedValue(["publisher-user"]),
    staffRecipients: jest.fn().mockResolvedValue(["staff-user"]),
    record: jest.fn().mockImplementation(() =>
      Promise.resolve({
        eventId: `event-${++sequence}`,
        deliveryIds: [],
      }),
    ),
    dispatchManyBestEffort: jest.fn(),
    dispatchManyByDedupKeyBestEffort: jest.fn(),
  }
}

describe("AdminService committed transition concurrency", () => {
  it("rejects a distinct listing command when the locked predecessor changed", async () => {
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: "listing-1" }]),
      marketplaceListing: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ status: "PENDING_REVIEW" })
          .mockResolvedValueOnce(listing("APPROVED")),
        updateMany: jest.fn(),
      },
      $transaction: jest.fn(async (work: (tx: any) => unknown) => work(prisma)),
    }
    const audit = { log: jest.fn() }
    const communications = communicationsHarness()
    const service = new AdminService(
      prisma,
      audit as any,
      {} as any,
      communications as any,
    )

    await expect(
      service.updateListingStatus(
        "listing-1",
        "REJECTED",
        { id: "admin-1", staffRole: "SUPER_ADMIN" },
        false,
      ),
    ).rejects.toBeInstanceOf(ConflictException)

    expect(prisma.marketplaceListing.updateMany).not.toHaveBeenCalled()
    expect(audit.log).not.toHaveBeenCalled()
    expect(communications.record).not.toHaveBeenCalled()
  })

  it("treats an identical listing command that won concurrently as a no-op", async () => {
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: "listing-1" }]),
      marketplaceListing: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ status: "PENDING_REVIEW" })
          .mockResolvedValueOnce(listing("REJECTED")),
        updateMany: jest.fn(),
      },
      $transaction: jest.fn(async (work: (tx: any) => unknown) => work(prisma)),
    }
    const audit = { log: jest.fn() }
    const communications = communicationsHarness()
    const service = new AdminService(
      prisma,
      audit as any,
      {} as any,
      communications as any,
    )

    await expect(
      service.updateListingStatus("listing-1", "REJECTED", {
        id: "admin-1",
        staffRole: "SUPER_ADMIN",
      }),
    ).resolves.toMatchObject({ status: "REJECTED" })

    expect(prisma.marketplaceListing.updateMany).not.toHaveBeenCalled()
    expect(audit.log).not.toHaveBeenCalled()
    expect(communications.record).not.toHaveBeenCalled()
  })

  it("uses durable audit identity so a later listing cycle sends a new notice", async () => {
    let status = "PENDING_REVIEW"
    let auditSequence = 0
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: "listing-1" }]),
      marketplaceListing: {
        findUnique: jest
          .fn()
          .mockImplementation((args: any) =>
            Promise.resolve(args.select?.status ? { status } : listing(status)),
          ),
        updateMany: jest.fn().mockImplementation(({ where, data }: any) => {
          if (where.status !== status) return Promise.resolve({ count: 0 })
          status = data.status
          return Promise.resolve({ count: 1 })
        }),
        findUniqueOrThrow: jest
          .fn()
          .mockImplementation(() => Promise.resolve(listing(status))),
      },
      $transaction: jest.fn(async (work: (tx: any) => unknown) => work(prisma)),
    }
    const audit = {
      log: jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve({ id: `listing-audit-${++auditSequence}` }),
        ),
    }
    const communications = communicationsHarness()
    const service = new AdminService(
      prisma,
      audit as any,
      {} as any,
      communications as any,
    )
    const actor = { id: "admin-1", staffRole: "SUPER_ADMIN" }

    await service.updateListingStatus("listing-1", "REJECTED", actor)
    await service.updateListingStatus("listing-1", "PENDING_REVIEW", actor)
    await service.updateListingStatus("listing-1", "REJECTED", actor)
    await service.updateListingStatus("listing-1", "REJECTED", actor)

    const rejectedEvents = communications.record.mock.calls
      .map(([input]) => input)
      .filter((input) => input.type === "MARKETPLACE_LISTING_REJECTED")
    expect(rejectedEvents).toHaveLength(2)
    expect(rejectedEvents.map((event) => event.dedupKey)).toEqual([
      "listing:listing-1:status-transition:listing-audit-1",
      "listing:listing-1:status-transition:listing-audit-3",
    ])
    expect(new Set(rejectedEvents.map((event) => event.dedupKey)).size).toBe(2)
    expect(audit.log).toHaveBeenCalledTimes(3)
  })

  it("rejects a distinct manual tier command after an automatic locked change", async () => {
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: "publisher-1" }]),
      publisher: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ tier: "NEW" })
          .mockResolvedValueOnce({
            id: "publisher-1",
            tier: "TRUSTED",
            organizationId: "org-1",
          }),
        updateMany: jest.fn(),
      },
      $transaction: jest.fn(async (work: (tx: any) => unknown) => work(prisma)),
    }
    const audit = { log: jest.fn() }
    const communications = communicationsHarness()
    const service = new AdminService(
      prisma,
      audit as any,
      {} as any,
      communications as any,
    )

    await expect(
      service.updatePublisherTier("publisher-1", "VERIFIED", {
        id: "admin-1",
      }),
    ).rejects.toBeInstanceOf(ConflictException)
    expect(prisma.publisher.updateMany).not.toHaveBeenCalled()
    expect(audit.log).not.toHaveBeenCalled()
    expect(communications.record).not.toHaveBeenCalled()
  })

  it("treats the same concurrent tier target as a no-op", async () => {
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: "publisher-1" }]),
      publisher: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ tier: "NEW" })
          .mockResolvedValueOnce({
            id: "publisher-1",
            tier: "TRUSTED",
            organizationId: "org-1",
          }),
        updateMany: jest.fn(),
      },
      $transaction: jest.fn(async (work: (tx: any) => unknown) => work(prisma)),
    }
    const audit = { log: jest.fn() }
    const communications = communicationsHarness()
    const service = new AdminService(
      prisma,
      audit as any,
      {} as any,
      communications as any,
    )

    await expect(
      service.updatePublisherTier("publisher-1", "TRUSTED", {
        id: "admin-1",
      }),
    ).resolves.toMatchObject({ tier: "TRUSTED" })
    expect(prisma.publisher.updateMany).not.toHaveBeenCalled()
    expect(audit.log).not.toHaveBeenCalled()
    expect(communications.record).not.toHaveBeenCalled()
  })

  it("uses a new durable identity when a publisher cycles back to a prior tier", async () => {
    let tier = "NEW"
    let auditSequence = 0
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: "publisher-1" }]),
      publisher: {
        findUnique: jest.fn().mockImplementation((args: any) =>
          Promise.resolve(
            args.select?.tier
              ? { tier }
              : {
                  id: "publisher-1",
                  name: "Publisher",
                  tier,
                  organizationId: "org-1",
                },
          ),
        ),
        updateMany: jest.fn().mockImplementation(({ where, data }: any) => {
          if (where.tier !== tier) return Promise.resolve({ count: 0 })
          tier = data.tier
          return Promise.resolve({ count: 1 })
        }),
        findUniqueOrThrow: jest.fn().mockImplementation(() =>
          Promise.resolve({
            id: "publisher-1",
            tier,
            organizationId: "org-1",
          }),
        ),
      },
      $transaction: jest.fn(async (work: (tx: any) => unknown) => work(prisma)),
    }
    const audit = {
      log: jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve({ id: `tier-audit-${++auditSequence}` }),
        ),
    }
    const communications = communicationsHarness()
    const service = new AdminService(
      prisma,
      audit as any,
      {} as any,
      communications as any,
    )

    await service.updatePublisherTier("publisher-1", "TRUSTED", {
      id: "admin-1",
    })
    await service.updatePublisherTier("publisher-1", "NEW", { id: "admin-1" })
    await service.updatePublisherTier("publisher-1", "TRUSTED", {
      id: "admin-1",
    })
    await service.updatePublisherTier("publisher-1", "TRUSTED", {
      id: "admin-1",
    })

    const publisherEvents = communications.record.mock.calls
      .map(([input]) => input)
      .filter((input) => input.type === "PUBLISHER_TIER_CHANGED")
    expect(publisherEvents.map((event) => event.dedupKey)).toEqual([
      "publisher:publisher-1:tier-change:tier-audit-1",
      "publisher:publisher-1:tier-change:tier-audit-2",
      "publisher:publisher-1:tier-change:tier-audit-3",
    ])
    expect(audit.log).toHaveBeenCalledTimes(3)
  })
})
