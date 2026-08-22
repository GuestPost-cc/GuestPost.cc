import { MarketplaceService } from "../marketplace.service"

const buyerWebsite = {
  isActive: true,
  verificationStatus: "VERIFIED",
}

describe("MarketplaceService domain availability", () => {
  it.each([
    { isActive: false, verificationStatus: "VERIFIED" },
    { isActive: true, verificationStatus: "PENDING_VERIFICATION" },
    { isActive: true, verificationStatus: "REVOKED" },
  ])("hides listing services when the website is $verificationStatus / active=$isActive", async (website) => {
    const prisma: any = {
      marketplaceListing: {
        findUnique: jest.fn().mockResolvedValue({
          id: "listing-1",
          status: "APPROVED",
          ownerType: "PUBLISHER",
          website,
          services: [],
        }),
      },
    }

    await expect(
      new MarketplaceService(prisma, {} as any).getListingServices("listing-1"),
    ).rejects.toMatchObject({ status: 404 })
  })

  it("keeps owner publisher inventory visible while gating the public page", async () => {
    const prisma: any = {
      publisherMembership: {
        findFirst: jest.fn().mockResolvedValue({ id: "membership-1" }),
      },
      marketplaceListing: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    }
    const service = new MarketplaceService(prisma, {} as any)

    await service.getPublisherListings("publisher-1")
    expect(prisma.marketplaceListing.findMany.mock.calls[0][0].where).toEqual({
      publisherId: "publisher-1",
      status: "APPROVED",
      website: buyerWebsite,
    })

    await service.getPublisherListings("publisher-1", "publisher-owner-user")
    expect(prisma.marketplaceListing.findMany.mock.calls[1][0].where).toEqual({
      publisherId: "publisher-1",
    })
  })

  it("applies the same website predicate to favorites and saved-list projections", async () => {
    const prisma: any = {
      marketplaceFavorite: { findMany: jest.fn().mockResolvedValue([]) },
      marketplaceSavedList: { findMany: jest.fn().mockResolvedValue([]) },
    }
    const service = new MarketplaceService(prisma, {} as any)

    await service.getFavorites("user-1")
    expect(prisma.marketplaceFavorite.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: "user-1",
          listing: {
            status: "APPROVED",
            website: buyerWebsite,
          },
        },
      }),
    )

    await service.getSavedLists("user-1")
    expect(prisma.marketplaceSavedList.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          items: expect.objectContaining({
            where: {
              listing: {
                status: "APPROVED",
                website: buyerWebsite,
              },
            },
          }),
        }),
      }),
    )
  })

  it("gates internal-service inventory and trending recommendations", async () => {
    const prisma: any = {
      marketplaceListing: { findMany: jest.fn().mockResolvedValue([]) },
      marketplaceListingView: { groupBy: jest.fn().mockResolvedValue([]) },
    }
    const service = new MarketplaceService(prisma, {} as any)

    await service.getServices()
    expect(prisma.marketplaceListing.findMany.mock.calls[0][0].where).toEqual({
      status: "APPROVED",
      website: buyerWebsite,
      fulfillmentType: "INTERNAL",
      services: { some: { availability: "AVAILABLE" } },
    })

    await service.getRecommendations("user-1", {})
    expect(prisma.marketplaceListing.findMany.mock.calls[1][0].where).toEqual({
      id: { in: [] },
      status: "APPROVED",
      website: buyerWebsite,
    })
  })

  it("calculates public statistics only from buyer-visible inventory", async () => {
    const prisma: any = {
      marketplaceListing: { count: jest.fn().mockResolvedValue(0) },
      marketplaceReview: {
        count: jest.fn().mockResolvedValue(0),
        aggregate: jest.fn().mockResolvedValue({ _avg: { rating: null } }),
      },
      listingService: {
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      marketplaceListingCategory: {
        groupBy: jest.fn().mockResolvedValue([]),
      },
    }
    const service = new MarketplaceService(prisma, {} as any)
    const buyerListing = {
      status: "APPROVED",
      website: buyerWebsite,
    }

    await service.getMarketplaceStats()

    expect(prisma.marketplaceListing.count).toHaveBeenCalledTimes(2)
    for (const [args] of prisma.marketplaceListing.count.mock.calls) {
      expect(args).toEqual({ where: buyerListing })
    }
    expect(prisma.marketplaceReview.count).toHaveBeenCalledWith({
      where: { status: "APPROVED", listing: buyerListing },
    })
    expect(prisma.marketplaceReview.aggregate).toHaveBeenCalledWith({
      _avg: { rating: true },
      where: { status: "APPROVED", listing: buyerListing },
    })
    expect(prisma.listingService.count).toHaveBeenNthCalledWith(1, {
      where: { listing: buyerListing },
    })
    expect(prisma.listingService.count).toHaveBeenNthCalledWith(2, {
      where: { availability: "AVAILABLE", listing: buyerListing },
    })
    expect(prisma.marketplaceListingCategory.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { listing: buyerListing } }),
    )
  })
})
