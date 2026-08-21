import { AdminService } from "../admin.service"

describe("AdminService website moderation", () => {
  it("pauses a publisher website atomically without rewriting listing lifecycle", async () => {
    const website = {
      id: "website-1",
      url: "https://example.com",
      domain: "example.com",
      name: "Example",
      publisherId: "publisher-1",
      ownershipType: "PUBLISHER",
      managedByUserId: null,
      isActive: true,
      activeModerationAction: null,
      activeModerationAuthority: null,
      activeModerationReasonCode: null,
      activeModerationMessage: null,
      activeModerationPreviousActive: null,
      moderationVersion: 0,
    }
    const updatedWebsite = {
      ...website,
      isActive: false,
      activeModerationAction: "PAUSE",
      activeModerationAuthority: "OPERATIONS",
      activeModerationReasonCode: "OPERATIONAL_HOLD",
      activeModerationMessage:
        "We are reviewing a domain availability concern with this website.",
      activeModerationPreviousActive: true,
      moderationVersion: 1,
    }
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: website.id }]),
      website: {
        findUnique: jest.fn().mockResolvedValue(website),
        findUniqueOrThrow: jest.fn().mockResolvedValue(updatedWebsite),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      marketplaceListing: {
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      moderationEvent: {
        create: jest.fn().mockResolvedValue({ id: "moderation-event-1" }),
      },
      $transaction: jest.fn(async (work: (tx: any) => unknown) => work(prisma)),
    }
    const audit = { log: jest.fn().mockResolvedValue({ id: "audit-1" }) }
    const communications = {
      publisherRecipients: jest.fn().mockResolvedValue(["publisher-user-1"]),
      record: jest
        .fn()
        .mockResolvedValue({ eventId: "communication-1", deliveryIds: [] }),
      dispatchManyBestEffort: jest.fn(),
    }
    const service = new AdminService(
      prisma,
      audit as any,
      {} as any,
      communications as any,
    )

    const result = await service.moderateWebsite(
      website.id,
      {
        action: "PAUSE",
        reasonCode: "OPERATIONAL_HOLD",
        publisherMessage:
          "We are reviewing a domain availability concern with this website.",
        internalNote: "Ticket OPS-1042 confirms an availability review.",
        expectedVersion: 0,
      } as any,
      { id: "ops-1", staffRole: "OPERATIONS" },
    )

    expect(result).toMatchObject({
      id: website.id,
      isActive: false,
      moderation: {
        version: 1,
        active: { action: "PAUSE", authority: "OPERATIONS" },
      },
    })
    expect(prisma.website.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: website.id, moderationVersion: 0 },
        data: expect.objectContaining({
          isActive: false,
          moderationVersion: { increment: 1 },
        }),
      }),
    )
    expect(prisma.marketplaceListing.update).not.toHaveBeenCalled()
    expect(prisma.marketplaceListing.updateMany).not.toHaveBeenCalled()
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "PAUSE",
          previousWebsiteActive: true,
          resultingWebsiteActive: false,
        }),
      }),
    )
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "WEBSITE_MODERATION_PAUSE",
        metadata: expect.objectContaining({
          listingLifecyclePreserved: true,
          moderationEventId: "moderation-event-1",
        }),
      }),
      prisma,
    )
    expect(communications.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "MARKETPLACE_WEBSITE_PAUSED",
        dedupKey: "website:website-1:moderation:moderation-event-1",
      }),
      prisma,
    )
    expect(communications.dispatchManyBestEffort).toHaveBeenCalledWith([
      "communication-1",
    ])
  })
})
