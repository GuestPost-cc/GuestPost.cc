import "reflect-metadata"
import { plainToInstance } from "class-transformer"
import { validate } from "class-validator"
import { CreateListingDto, UpdateListingDto } from "../dto/marketplace.dto"
import { MarketplaceService } from "../marketplace.service"

describe("publisher listing management", () => {
  it("rejects publisher-supplied privileged create fields", async () => {
    const errors = await validate(
      plainToInstance(CreateListingDto, {
        title: "Example listing",
        description: "A complete buyer-facing listing description.",
        status: "APPROVED",
        featured: true,
        verified: true,
      }),
      { whitelist: true, forbidNonWhitelisted: true },
    )

    expect(errors.some((error) => error.property === "status")).toBe(true)
    expect(errors.some((error) => error.property === "featured")).toBe(true)
    expect(errors.some((error) => error.property === "verified")).toBe(true)
  })

  it("hardcodes DRAFT even for a direct service caller that injects status", async () => {
    const prisma: any = {
      marketplaceListing: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            id: "listing-1",
            ...data,
            categories: [],
            tags: [],
            services: [],
          }),
        ),
      },
      publisherMembership: {
        findFirst: jest.fn().mockResolvedValue({ id: "membership-1" }),
      },
      publisher: {
        findUnique: jest.fn().mockResolvedValue({
          id: "publisher-1",
          organizationId: "organization-1",
        }),
      },
      website: {
        findUnique: jest.fn().mockResolvedValue({
          id: "website-1",
          publisherId: "publisher-1",
          verificationStatus: "VERIFIED",
        }),
      },
      marketplaceCategory: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: "category-1", name: "Technology", slug: "technology" },
          ]),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    }

    await new MarketplaceService(prisma, {} as any).createListing(
      "user-1",
      "publisher-1",
      {
        title: "Example listing",
        description: "A complete buyer-facing listing description.",
        websiteId: "website-1",
        categoryIds: ["category-1"],
        language: "English",
        currency: "USD",
        status: "APPROVED",
        featured: true,
        verified: true,
        type: "GUEST_POST",
        price: 1,
        turnaroundDays: 1,
        revisionRounds: 1,
      } as any,
    )

    const createdData = prisma.marketplaceListing.create.mock.calls[0][0].data
    expect(createdData.status).toBe("DRAFT")
    expect(createdData.featured).toBe(false)
    expect(createdData.verified).toBe(false)
    expect(createdData).not.toHaveProperty("type")
    expect(createdData).not.toHaveProperty("price")
    expect(createdData).not.toHaveProperty("turnaroundDays")
    expect(createdData).not.toHaveProperty("revisionRounds")
  })

  it("enforces the 500-character description contract on create and update", async () => {
    const description = "x".repeat(501)
    const createErrors = await validate(
      plainToInstance(CreateListingDto, {
        title: "Example listing",
        description,
      }),
    )
    const updateErrors = await validate(
      plainToInstance(UpdateListingDto, {
        title: "Example listing",
        description,
      }),
    )

    expect(createErrors.some((error) => error.property === "description")).toBe(
      true,
    )
    expect(updateErrors.some((error) => error.property === "description")).toBe(
      true,
    )
  })

  it("rejects more than seven categories on a listing update", async () => {
    const errors = await validate(
      plainToInstance(UpdateListingDto, {
        title: "Example listing",
        description: "A complete buyer-facing listing description.",
        categoryIds: Array.from(
          { length: 8 },
          (_, index) => `category-${index}`,
        ),
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
      }),
    )

    expect(errors.some((error) => error.property === "categoryIds")).toBe(true)
  })

  it("allowlists publisher metadata and ignores privileged update fields", async () => {
    const prisma: any = {
      $transaction: jest.fn((callback) => callback(prisma)),
      marketplaceListing: {
        findUnique: jest.fn().mockResolvedValue({
          id: "listing-1",
          publisherId: "publisher-1",
          organizationId: "organization-1",
          websiteId: null,
        }),
        update: jest.fn().mockResolvedValue({ id: "listing-1" }),
      },
      marketplaceCategory: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: "category-1", name: "Technology", slug: "technology" },
          ]),
      },
      publisherMembership: {
        findFirst: jest.fn().mockResolvedValue({ id: "membership-1" }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    }
    const service = new MarketplaceService(prisma, {} as any)

    await service.updateListing("user-1", "publisher-1", "listing-1", {
      title: "Updated listing",
      description: "A clear buyer-facing description",
      categoryIds: ["category-1"],
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
      status: "APPROVED",
      featured: true,
      verified: true,
      websiteId: "other-website",
    } as any)

    const data = prisma.marketplaceListing.update.mock.calls[0][0].data
    expect(data).toEqual(
      expect.objectContaining({
        title: "Updated listing",
        description: "A clear buyer-facing description",
        categories: expect.objectContaining({ deleteMany: {} }),
      }),
    )
    expect(data).not.toHaveProperty("status")
    expect(data).not.toHaveProperty("featured")
    expect(data).not.toHaveProperty("verified")
    expect(data).not.toHaveProperty("websiteId")
  })

  it("requires a category before publisher moderation submission", async () => {
    const listing = {
      id: "listing-1",
      publisherId: "publisher-1",
      organizationId: "organization-1",
      websiteId: "website-1",
      status: "DRAFT",
      ownerType: "PUBLISHER",
      moderationVersion: 0,
      activeModerationAction: null,
      activeModerationAuthority: null,
      activeModerationReasonCode: null,
      activeModerationMessage: null,
      activeModerationPreviousStatus: null,
      moderationResubmissionAllowed: false,
      categories: [],
      description: "A valid buyer-facing description",
      title: "Example listing",
      website: {
        isActive: true,
        verificationStatus: "VERIFIED",
        ownershipType: "PUBLISHER",
      },
    }
    const prisma: any = {
      $transaction: jest.fn((callback) => callback(prisma)),
      $queryRaw: jest.fn().mockResolvedValue([{ id: "listing-1" }]),
      marketplaceListing: {
        findUnique: jest.fn().mockResolvedValue(listing),
        updateMany: jest.fn(),
      },
      listingService: {
        count: jest.fn().mockResolvedValue(1),
      },
      publisherMembership: {
        findFirst: jest.fn().mockResolvedValue({ id: "membership-1" }),
      },
    }
    const service = new MarketplaceService(prisma, {} as any)

    await expect(
      service.submitListingForReview("user-1", "publisher-1", "listing-1"),
    ).rejects.toMatchObject({
      response: { code: "LISTING_CATEGORIES_REQUIRED" },
    })
    expect(prisma.marketplaceListing.updateMany).not.toHaveBeenCalled()
  })

  it("does not let a publisher submit through an active staff archive", async () => {
    const listing = {
      id: "listing-1",
      publisherId: "publisher-1",
      organizationId: "organization-1",
      websiteId: "website-1",
      status: "ARCHIVED",
      ownerType: "PUBLISHER",
      moderationVersion: 3,
      activeModerationAction: "ARCHIVE",
      activeModerationAuthority: "OPERATIONS",
      activeModerationReasonCode: "POLICY_VIOLATION",
      activeModerationMessage: "Archived by Operations for policy review.",
      activeModerationPreviousStatus: "APPROVED",
      moderationResubmissionAllowed: false,
      categories: [{ categoryId: "category-1" }],
      description: "A valid buyer-facing description",
      title: "Example listing",
      website: {
        isActive: true,
        verificationStatus: "VERIFIED",
        ownershipType: "PUBLISHER",
      },
    }
    const prisma: any = {
      $transaction: jest.fn((callback) => callback(prisma)),
      $queryRaw: jest.fn().mockResolvedValue([{ id: "locked" }]),
      marketplaceListing: {
        findUnique: jest.fn().mockResolvedValue(listing),
        updateMany: jest.fn(),
      },
      publisherMembership: {
        findFirst: jest.fn().mockResolvedValue({ id: "membership-1" }),
      },
    }

    await expect(
      new MarketplaceService(prisma, {} as any).submitListingForReview(
        "user-1",
        "publisher-1",
        "listing-1",
      ),
    ).rejects.toMatchObject({ response: { code: "MODERATION_HOLD" } })
    expect(prisma.marketplaceListing.updateMany).not.toHaveBeenCalled()
  })

  it("atomically records an allowed correction resubmission", async () => {
    const listing = {
      id: "listing-1",
      publisherId: "publisher-1",
      organizationId: "organization-1",
      websiteId: "website-1",
      status: "REJECTED",
      ownerType: "PUBLISHER",
      moderationVersion: 4,
      activeModerationAction: "REQUEST_CHANGES",
      activeModerationAuthority: "OPERATIONS",
      activeModerationReasonCode: "INCOMPLETE_POLICY",
      activeModerationMessage: "Complete the placement policy and resubmit.",
      activeModerationPreviousStatus: "PENDING_REVIEW",
      moderationResubmissionAllowed: true,
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
      description: "A valid buyer-facing description",
      title: "Example listing",
      website: {
        isActive: true,
        verificationStatus: "VERIFIED",
        ownershipType: "PUBLISHER",
      },
    }
    const prisma: any = {
      $transaction: jest.fn((callback) => callback(prisma)),
      $queryRaw: jest.fn().mockResolvedValue([{ id: "locked" }]),
      marketplaceListing: {
        findUnique: jest.fn().mockResolvedValue(listing),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ ...listing, status: "PENDING_REVIEW" }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      listingService: { count: jest.fn().mockResolvedValue(1) },
      websiteMetric: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { key: "AHREFS_ORGANIC_TRAFFIC" },
            { key: "MOZ_DOMAIN_AUTHORITY" },
          ]),
      },
      moderationEvent: {
        create: jest.fn().mockResolvedValue({ id: "event-1" }),
      },
      publisherMembership: {
        findFirst: jest.fn().mockResolvedValue({ id: "membership-1" }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({ id: "audit-1" }) },
    }

    await new MarketplaceService(prisma, {} as any).submitListingForReview(
      "user-1",
      "publisher-1",
      "listing-1",
    )

    expect(prisma.marketplaceListing.updateMany).toHaveBeenCalledWith({
      where: {
        id: "listing-1",
        status: "REJECTED",
        moderationVersion: 4,
      },
      data: expect.objectContaining({
        status: "PENDING_REVIEW",
        activeModerationAction: "SUBMIT_FOR_REVIEW",
        activeModerationAuthority: "PUBLISHER",
        activeModerationReasonCode: "CORRECTIONS_COMPLETE",
        moderationResubmissionAllowed: false,
        moderationVersion: { increment: 1 },
      }),
    })
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "SUBMIT_FOR_REVIEW",
          previousModerationAction: "REQUEST_CHANGES",
          authority: "PUBLISHER",
        }),
      }),
    )
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1)
  })
})
