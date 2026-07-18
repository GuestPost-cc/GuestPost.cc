import "reflect-metadata"
import { plainToInstance } from "class-transformer"
import { validate } from "class-validator"
import { CreateListingDto, UpdateListingDto } from "../dto/marketplace.dto"
import { MarketplaceService } from "../marketplace.service"

describe("publisher listing management", () => {
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
    const prisma: any = {
      marketplaceListing: {
        findUnique: jest.fn().mockResolvedValue({
          id: "listing-1",
          publisherId: "publisher-1",
          organizationId: "organization-1",
          websiteId: "website-1",
          status: "DRAFT",
          categories: [],
          description: "A valid buyer-facing description",
          title: "Example listing",
          website: {
            verificationStatus: "VERIFIED",
            ownershipType: "PUBLISHER",
          },
        }),
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
})
