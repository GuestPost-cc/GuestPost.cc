import { plainToInstance } from "class-transformer"
import { validate } from "class-validator"
import { AdminService } from "../../admin/admin.service"
import { CreateWebsiteDto } from "../dto/websites.dto"
import { WebsitesService } from "../websites.service"

const validInput = {
  url: "https://example.com",
  listingTitle: "Technology guest posts on Example",
  description:
    "Editorial technology coverage for founders, developers, and software buyers.",
}

describe("website enlistment input enforcement", () => {
  it.each([
    { categoryIds: [] },
    {
      categoryIds: Array.from({ length: 8 }, (_, index) => `category-${index}`),
    },
    { categoryIds: ["category-1", "category-1"] },
  ])("rejects invalid category selections: $categoryIds", async ({
    categoryIds,
  }) => {
    const dto = plainToInstance(CreateWebsiteDto, {
      ...validInput,
      country: "US",
      language: "English",
      categoryIds,
      sportsGamingAllowed: false,
      pharmacyAllowed: false,
      cryptoAllowed: false,
      backlinkCount: 1,
      linkType: "DOFOLLOW",
      linkValidity: "PERMANENT",
      googleNews: false,
      markedSponsored: false,
      foreignLanguageAllowed: false,
    })

    const errors = await validate(dto)
    expect(errors.some((error) => error.property === "categoryIds")).toBe(true)
  })

  it("rejects a publisher listing title that is only a website address", async () => {
    const prisma = {
      publisher: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: "publisher-1", organizationId: "org-1" }),
      },
      website: { findFirst: jest.fn() },
    }
    const service = new WebsitesService(
      prisma as any,
      { log: jest.fn() } as any,
      {} as any,
    )

    await expect(
      service.createWebsite(
        "publisher-1",
        "org-1",
        { ...validInput, listingTitle: "example.com" } as any,
        { id: "user-1" },
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "LISTING_TITLE_IS_WEBSITE_URL",
        field: "listingTitle",
      }),
    })
    expect(prisma.website.findFirst).not.toHaveBeenCalled()
  })

  it("rejects a non-root platform website URL before persistence", async () => {
    const prisma = { website: { findFirst: jest.fn() } }
    const service = new AdminService(
      prisma as any,
      { log: jest.fn() } as any,
      {} as any,
    )

    await expect(
      service.createPlatformWebsite(
        { ...validInput, url: "https://example.com/guest-posts" },
        { id: "ops-1", staffRole: "OPERATIONS" },
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "INVALID_WEBSITE_URL",
        field: "url",
      }),
    })
    expect(prisma.website.findFirst).not.toHaveBeenCalled()
  })
})
