import { ConflictException } from "@nestjs/common"
import { AdminService } from "../admin.service"

function listing(status: string) {
  return {
    id: "listing-1",
    websiteId: null,
    status,
    ownerType: "PUBLISHER",
    moderationVersion: status === "PENDING_REVIEW" ? 0 : 1,
    activeModerationAction:
      status === "REJECTED" ? "REQUEST_CHANGES" : "SUBMIT_FOR_REVIEW",
    activeModerationAuthority:
      status === "REJECTED" ? "SUPER_ADMIN" : "PUBLISHER",
    activeModerationReasonCode:
      status === "REJECTED" ? "INCOMPLETE_LISTING" : "INITIAL_SUBMISSION",
    activeModerationMessage:
      status === "REJECTED"
        ? "Please complete the missing listing details."
        : null,
    activeModerationPreviousStatus: "DRAFT",
    moderationResubmissionAllowed: status === "REJECTED",
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
  it("routes the legacy listing delete alias through explicit archive moderation", async () => {
    const service = new AdminService({} as any, {} as any, {} as any, {} as any)
    const updateListingStatus = jest
      .spyOn(service, "updateListingStatus")
      .mockResolvedValue({ id: "listing-1", status: "ARCHIVED" } as any)
    const actor = { id: "admin-1", staffRole: "SUPER_ADMIN" }

    await expect(
      service.deleteListing("listing-1", actor),
    ).resolves.toMatchObject({ status: "ARCHIVED" })
    expect(updateListingStatus).toHaveBeenCalledWith(
      "listing-1",
      "ARCHIVED",
      actor,
      false,
      expect.objectContaining({
        reasonCode: "DUPLICATE_OR_INVALID",
        publisherMessage: expect.any(String),
        internalNote: expect.any(String),
      }),
    )
  })

  it("rejects a distinct listing command when the locked predecessor changed", async () => {
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: "listing-1" }]),
      marketplaceListing: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({
            websiteId: null,
            status: "PENDING_REVIEW",
            moderationVersion: 0,
          })
          .mockResolvedValueOnce(listing("APPROVED")),
        updateMany: jest.fn(),
      },
      moderationEvent: { create: jest.fn() },
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
      service.moderateListing(
        "listing-1",
        {
          action: "REQUEST_CHANGES",
          reasonCode: "INCOMPLETE_LISTING",
          publisherMessage: "Please complete the missing listing details.",
          expectedVersion: 0,
        } as any,
        { id: "admin-1", staffRole: "SUPER_ADMIN" },
      ),
    ).rejects.toBeInstanceOf(ConflictException)

    expect(prisma.marketplaceListing.updateMany).not.toHaveBeenCalled()
    expect(audit.log).not.toHaveBeenCalled()
    expect(communications.record).not.toHaveBeenCalled()
  })

  it("rejects an identical retry with a stale moderation version", async () => {
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: "listing-1" }]),
      marketplaceListing: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({
            websiteId: null,
            status: "REJECTED",
            moderationVersion: 1,
          })
          .mockResolvedValueOnce(listing("REJECTED")),
        updateMany: jest.fn(),
      },
      moderationEvent: { create: jest.fn() },
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
      service.moderateListing(
        "listing-1",
        {
          action: "REQUEST_CHANGES",
          reasonCode: "INCOMPLETE_LISTING",
          publisherMessage: "Please complete the missing listing details.",
          expectedVersion: 0,
        } as any,
        { id: "admin-1", staffRole: "SUPER_ADMIN" },
      ),
    ).rejects.toBeInstanceOf(ConflictException)

    expect(prisma.marketplaceListing.updateMany).not.toHaveBeenCalled()
    expect(audit.log).not.toHaveBeenCalled()
    expect(communications.record).not.toHaveBeenCalled()
  })

  it("uses the immutable moderation event identity for one transactional notice", async () => {
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: "listing-1" }]),
      marketplaceListing: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({
            websiteId: null,
            status: "PENDING_REVIEW",
            moderationVersion: 0,
          })
          .mockResolvedValueOnce(listing("PENDING_REVIEW")),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(listing("REJECTED")),
      },
      moderationEvent: {
        create: jest.fn().mockResolvedValue({ id: "moderation-event-1" }),
      },
      $transaction: jest.fn(async (work: (tx: any) => unknown) => work(prisma)),
    }
    const audit = {
      log: jest.fn().mockResolvedValue({ id: "audit-1" }),
    }
    const communications = communicationsHarness()
    const service = new AdminService(
      prisma,
      audit as any,
      {} as any,
      communications as any,
    )
    await service.moderateListing(
      "listing-1",
      {
        action: "REQUEST_CHANGES",
        reasonCode: "INCOMPLETE_LISTING",
        publisherMessage: "Please complete the missing listing details.",
        expectedVersion: 0,
      } as any,
      { id: "admin-1", staffRole: "SUPER_ADMIN" },
    )

    const rejectedEvents = communications.record.mock.calls
      .map(([input]) => input)
      .filter((input) => input.type === "MARKETPLACE_LISTING_REJECTED")
    expect(rejectedEvents).toHaveLength(1)
    expect(rejectedEvents[0].dedupKey).toBe(
      "listing:listing-1:moderation:moderation-event-1",
    )
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(1)
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "LISTING_MODERATION_REQUEST_CHANGES" }),
      prisma,
    )
    expect(communications.dispatchManyBestEffort).toHaveBeenCalledWith([
      "event-1",
    ])
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
