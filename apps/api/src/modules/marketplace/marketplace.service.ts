import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { 
  SearchListingsDto, 
  CreateListingDto, 
  UpdateListingDto, 
  CreateReviewDto,
  CreateFavoriteDto,
  CreateSavedListDto,
  AddToSavedListDto,
  GetListingFiltersDto,
  GetRecommendationsDto
} from "./dto/marketplace.dto"
import { ListingStatus, ListingType } from "@guestpost/database"
import { slugify } from "../../common/utils/slugify"

@Injectable()
export class MarketplaceService {
  constructor(private readonly prisma: PrismaService) {}

  // =============================================================================
  // LISTING CRUD
  // =============================================================================

  async searchListings(dto: SearchListingsDto) {
    const { query, category, type, tags, country, language, minPrice, maxPrice, minDR, maxDR, minTraffic, maxTurnaroundDays, sortBy, page = 1, limit = 20 } = dto

    const where: any = {
      status: ListingStatus.APPROVED,
    }

    if (category) {
      where.category = { slug: category }
    }

    if (type) {
      where.type = type
    }

    if (country) {
      where.country = country
    }

    if (language) {
      where.language = language
    }

    if (minPrice !== undefined || maxPrice !== undefined) {
      where.price = {}
      if (minPrice !== undefined) where.price.gte = minPrice
      if (maxPrice !== undefined) where.price.lte = maxPrice
    }

    if (minDR !== undefined || maxDR !== undefined) {
      where.domainRating = {}
      if (minDR !== undefined) where.domainRating.gte = minDR
      if (maxDR !== undefined) where.domainRating.lte = maxDR
    }

    if (minTraffic !== undefined) {
      where.traffic = { gte: minTraffic }
    }

    if (maxTurnaroundDays !== undefined) {
      where.turnaroundDays = { lte: maxTurnaroundDays }
    }

    if (tags && tags.length > 0) {
      where.tags = {
        some: {
          tag: { slug: { in: tags } }
        }
      }
    }

    if (query) {
      where.OR = [
        { title: { contains: query, mode: "insensitive" } },
        { description: { contains: query, mode: "insensitive" } },
        { slug: { contains: query, mode: "insensitive" } },
      ]
    }

    let orderBy: any = [{ createdAt: "desc" }]
    switch (sortBy) {
      case "dr":
        orderBy = [{ domainRating: "desc" }]
        break
      case "traffic":
        orderBy = [{ traffic: "desc" }]
        break
      case "price_asc":
        orderBy = [{ price: "asc" }]
        break
      case "price_desc":
        orderBy = [{ price: "desc" }]
        break
      case "newest":
        orderBy = [{ createdAt: "desc" }]
        break
      case "popular":
      case "most_ordered":
        orderBy = [{ views: { _count: "desc" } }]
        break
      case "best_rated":
        orderBy = [{ reviews: { _count: "desc" } }]
        break
      default:
        orderBy = [{ featured: "desc" }, { domainRating: "desc" }]
    }

    const [listings, total] = await Promise.all([
      this.prisma.marketplaceListing.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
        include: {
          category: true,
          tags: { include: { tag: true } },
          images: { where: { isPrimary: true }, take: 1 },
          reviews: { where: { status: "APPROVED" }, select: { rating: true } },
          publisher: { include: { profile: true } },
          website: true,
        },
      }),
      this.prisma.marketplaceListing.count({ where }),
    ])

    const listingsWithStats = listings.map(listing => {
      const avgRating = listing.reviews.length > 0
        ? listing.reviews.reduce((sum, r) => sum + r.rating, 0) / listing.reviews.length
        : null
      return {
        ...listing,
        tags: listing.tags.map(t => t.tag),
        image: listing.images[0]?.url || null,
        reviewCount: listing.reviews.length,
        avgRating,
      }
    })

    return {
      listings: listingsWithStats,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    }
  }

  async getListing(slug: string, userId?: string) {
    const listing = await this.prisma.marketplaceListing.findUnique({
      where: { slug },
      include: {
        category: true,
        tags: { include: { tag: true } },
        images: { orderBy: { sortOrder: "asc" } },
        pricingTiers: { orderBy: { sortOrder: "asc" } },
        reviews: { 
          where: { status: "APPROVED" },
          include: { user: { select: { id: true, name: true, image: true } } },
          orderBy: { createdAt: "desc" },
          take: 10,
        },
        publisher: { include: { profile: true } },
        website: true,
      },
    })

    if (!listing) {
      throw new NotFoundException("Listing not found")
    }

    // Non-APPROVED listings are visible only to a member of the owning publisher.
    // Everyone else gets 404 — do not reveal existence of draft/rejected/paused/archived.
    if (listing.status !== ListingStatus.APPROVED) {
      const isOwner = userId && listing.publisherId
        ? await this.verifyPublisherAccess(userId, listing.publisherId)
        : false
      if (!isOwner) {
        throw new NotFoundException("Listing not found")
      }
    }

    // Track view
    await this.prisma.marketplaceListingView.create({
      data: { listingId: listing.id, userId },
    })

    // Get related listings
    const relatedListings = await this.prisma.marketplaceListing.findMany({
      where: {
        id: { not: listing.id },
        status: ListingStatus.APPROVED,
        OR: [
          { categoryId: listing.categoryId },
          { type: listing.type },
        ],
      },
      take: 4,
      include: {
        category: true,
        images: { where: { isPrimary: true }, take: 1 },
        tags: { include: { tag: true } },
      },
    })

    const avgRating = listing.reviews.length > 0
      ? listing.reviews.reduce((sum, r) => sum + r.rating, 0) / listing.reviews.length
      : null

    let isFavorited = false
    if (userId) {
      const favorite = await this.prisma.marketplaceFavorite.findUnique({
        where: { userId_listingId: { userId, listingId: listing.id } },
      })
      isFavorited = !!favorite
    }

    return {
      ...listing,
      tags: listing.tags.map(t => t.tag),
      avgRating,
      reviewCount: listing.reviews.length,
      isFavorited,
      relatedListings: relatedListings.map(l => ({
        ...l,
        tags: l.tags.map(t => t.tag),
        image: l.images[0]?.url || null,
      })),
    }
  }

  // Resolves and authorizes the owning publisher for a listing mutation.
  // Ownership is keyed on PublisherMembership, NOT organizationId (publishers
  // have no active organization context, so an org check is unsound here).
  private async resolveOwnedPublisherId(userId: string, activePublisherId: string | null, dtoPublisherId?: string): Promise<string> {
    const publisherId = dtoPublisherId ?? activePublisherId
    if (!publisherId) {
      throw new BadRequestException("No publisher context for this listing")
    }
    const hasAccess = await this.verifyPublisherAccess(userId, publisherId)
    if (!hasAccess) {
      throw new ForbiddenException("You don't have access to this publisher")
    }
    return publisherId
  }

  async createListing(userId: string, activePublisherId: string | null, dto: CreateListingDto) {
    const slug = slugify(dto.title)

    // Check for duplicate slug
    const existing = await this.prisma.marketplaceListing.findUnique({ where: { slug } })
    if (existing) {
      throw new BadRequestException("A listing with this title already exists")
    }

    const publisherId = await this.resolveOwnedPublisherId(userId, activePublisherId, dto.publisherId)
    const publisher = await this.prisma.publisher.findUnique({ where: { id: publisherId } })
    if (!publisher) throw new NotFoundException("Publisher not found")

    const data: any = { ...dto }
    delete data.tags

    const listing = await this.prisma.marketplaceListing.create({
      data: {
        ...data,
        slug,
        publisherId,
        organizationId: publisher.organizationId,
        status: dto.status || ListingStatus.DRAFT,
        tags: dto.tags ? {
          create: dto.tags.map(tagId => ({ tag: { connect: { id: tagId } } }))
        } : undefined,
      },
      include: {
        category: true,
        tags: { include: { tag: true } },
      },
    })

    await this.createAuditLog(userId, publisher.organizationId, "LISTING_CREATED", listing.id, { title: listing.title })

    return listing
  }

  async updateListing(userId: string, activePublisherId: string | null, listingId: string, dto: UpdateListingDto) {
    const listing = await this.prisma.marketplaceListing.findUnique({ where: { id: listingId } })

    if (!listing) {
      throw new NotFoundException("Listing not found")
    }
    if (!listing.publisherId) {
      throw new ForbiddenException("You don't have access to this listing")
    }
    const hasAccess = await this.verifyPublisherAccess(userId, listing.publisherId)
    if (!hasAccess) {
      throw new ForbiddenException("You don't have access to this listing")
    }

    const updateData: any = { ...dto }
    delete updateData.tags
    // Ownership fields cannot be reassigned via update
    delete updateData.publisherId
    delete updateData.organizationId

    const updated = await this.prisma.marketplaceListing.update({
      where: { id: listingId },
      data: {
        ...updateData,
        tags: dto.tags ? {
          deleteMany: {},
          create: dto.tags.map(tagId => ({ tag: { connect: { id: tagId } } }))
        } : undefined,
      },
      include: {
        category: true,
        tags: { include: { tag: true } },
      },
    })

    await this.createAuditLog(userId, listing.organizationId, "LISTING_UPDATED", listingId, { changes: Object.keys(dto) })

    return updated
  }

  async deleteListing(userId: string, activePublisherId: string | null, listingId: string) {
    const listing = await this.prisma.marketplaceListing.findUnique({ where: { id: listingId } })

    if (!listing) {
      throw new NotFoundException("Listing not found")
    }
    if (!listing.publisherId) {
      throw new ForbiddenException("You don't have access to this listing")
    }
    const hasAccess = await this.verifyPublisherAccess(userId, listing.publisherId)
    if (!hasAccess) {
      throw new ForbiddenException("You don't have access to this listing")
    }

    await this.prisma.marketplaceListing.update({
      where: { id: listingId },
      data: { status: ListingStatus.ARCHIVED },
    })

    await this.createAuditLog(userId, listing.organizationId, "LISTING_DELETED", listingId, { title: listing.title })
  }

  // =============================================================================
  // CATEGORIES & TAGS
  // =============================================================================

  async getCategories() {
    return this.prisma.marketplaceCategory.findMany({
      where: { isActive: true, parentId: null },
      include: { children: { where: { isActive: true }, orderBy: { sortOrder: "asc" } } },
      orderBy: { sortOrder: "asc" },
    })
  }

  async getTags() {
    return this.prisma.marketplaceTag.findMany({
      orderBy: { name: "asc" },
    })
  }

  // =============================================================================
  // REVIEWS
  // =============================================================================

  async createReview(userId: string, dto: CreateReviewDto) {
    const listing = await this.prisma.marketplaceListing.findUnique({ where: { id: dto.listingId } })
    if (!listing) {
      throw new NotFoundException("Listing not found")
    }

    const listingPublisherId = listing.publisherId
    if (!listingPublisherId) {
      throw new BadRequestException("Listing has no publisher")
    }

    // Prevent self-review: publisher cannot review own listing
    const publisherMembership = await this.prisma.publisherMembership.findFirst({
      where: { userId, publisherId: listingPublisherId },
    })
    if (publisherMembership) {
      throw new ForbiddenException("You cannot review your own listing")
    }

    // Verify customer completed an order with this publisher
    const completedOrder = await this.prisma.order.findFirst({
      where: {
        customerId: userId,
        website: { publisherId: listingPublisherId },
        status: "COMPLETED",
      },
    })
    if (!completedOrder) {
      throw new ForbiddenException("You must complete an order before reviewing")
    }

    // Prevent duplicate review
    const existing = await this.prisma.marketplaceReview.findFirst({
      where: { listingId: dto.listingId, userId },
    })
    if (existing) {
      throw new BadRequestException("You have already reviewed this listing")
    }

    const review = await this.prisma.marketplaceReview.create({
      data: {
        listingId: dto.listingId,
        userId,
        rating: dto.rating,
        title: dto.title,
        content: dto.content,
      },
      include: { user: { select: { id: true, name: true, image: true } } },
    })

    return review
  }

  // =============================================================================
  // FAVORITES
  // =============================================================================

  async getFavorites(userId: string) {
    return this.prisma.marketplaceFavorite.findMany({
      where: { userId },
      include: {
        listing: {
          include: {
            category: true,
            images: { where: { isPrimary: true }, take: 1 },
            tags: { include: { tag: true } },
          },
        },
      },
    })
  }

  async addFavorite(userId: string, listingId: string) {
    const listing = await this.prisma.marketplaceListing.findUnique({ where: { id: listingId } })
    if (!listing) {
      throw new NotFoundException("Listing not found")
    }

    const favorite = await this.prisma.marketplaceFavorite.upsert({
      where: { userId_listingId: { userId, listingId } },
      create: { userId, listingId },
      update: {},
    })

    // Track click
    await this.prisma.marketplaceListingClick.create({
      data: { listingId, userId, action: "favorite" },
    })

    return favorite
  }

  async removeFavorite(userId: string, listingId: string) {
    await this.prisma.marketplaceFavorite.deleteMany({
      where: { userId, listingId },
    })
  }

  // =============================================================================
  // SAVED LISTS
  // =============================================================================

  async getSavedLists(userId: string) {
    return this.prisma.marketplaceSavedList.findMany({
      where: { userId },
      include: {
        items: {
          include: {
            listing: {
              include: {
                category: true,
                images: { where: { isPrimary: true }, take: 1 },
              },
            },
          },
          orderBy: { addedAt: "desc" },
        },
      },
    })
  }

  async createSavedList(userId: string, dto: CreateSavedListDto) {
    const slug = dto.slug || slugify(dto.name)

    const list = await this.prisma.marketplaceSavedList.create({
      data: {
        userId,
        name: dto.name,
        slug,
        isPublic: dto.isPublic || false,
      },
    })

    return list
  }

  async addToSavedList(userId: string, listId: string, dto: AddToSavedListDto) {
    const list = await this.prisma.marketplaceSavedList.findUnique({ where: { id: listId } })
    if (!list || list.userId !== userId) {
      throw new NotFoundException("List not found")
    }

    const listing = await this.prisma.marketplaceListing.findUnique({ where: { id: dto.listingId } })
    if (!listing) {
      throw new NotFoundException("Listing not found")
    }

    const item = await this.prisma.marketplaceSavedListItem.upsert({
      where: { listId_listingId: { listId, listingId: dto.listingId } },
      create: {
        listId,
        listingId: dto.listingId,
        note: dto.note,
      },
      update: { note: dto.note },
    })

    return item
  }

  async removeFromSavedList(userId: string, listId: string, listingId: string) {
    const list = await this.prisma.marketplaceSavedList.findUnique({ where: { id: listId } })
    if (!list || list.userId !== userId) {
      throw new NotFoundException("List not found")
    }

    await this.prisma.marketplaceSavedListItem.deleteMany({
      where: { listId, listingId },
    })
  }

  // =============================================================================
  // INTERNAL SERVICES
  // =============================================================================

  async getServices() {
    return this.prisma.marketplaceListing.findMany({
      where: {
        type: { in: [ListingType.INTERNAL_SERVICE, ListingType.GUEST_POST] },
        status: ListingStatus.APPROVED,
        fulfillmentType: "INTERNAL",
      },
      include: {
        category: true,
        images: { where: { isPrimary: true }, take: 1 },
        pricingTiers: { orderBy: { sortOrder: "asc" } },
      },
      orderBy: { featured: "desc" },
    })
  }

  // =============================================================================
  // PUBLISHER LISTINGS
  // =============================================================================

  async getPublisherListings(publisherId: string, userId?: string) {
    const hasAccess = userId ? await this.verifyPublisherAccess(userId, publisherId) : false

    return this.prisma.marketplaceListing.findMany({
      where: {
        publisherId,
        status: hasAccess ? undefined : ListingStatus.APPROVED,
      },
      include: {
        category: true,
        images: { where: { isPrimary: true }, take: 1 },
        tags: { include: { tag: true } },
        reviews: { where: { status: "APPROVED" }, select: { rating: true } },
      },
      orderBy: { createdAt: "desc" },
    })
  }

  // =============================================================================
  // RECOMMENDATIONS (AI Layer Abstraction)
  // =============================================================================

  async getRecommendations(userId: string, dto: GetRecommendationsDto) {
    const { listingId, type = "recommended", limit = 10 } = dto

    // Try to get AI recommendations first
    const recommendations = await this.prisma.marketplaceRecommendation.findMany({
      where: { userId, type },
      orderBy: { score: "desc" },
      take: limit,
    })

    if (recommendations.length > 0) {
      // Fetch listings separately since relation isn't defined in schema
      const listingIds = recommendations.map(r => r.listingId)
      const listings = await this.prisma.marketplaceListing.findMany({
        where: { id: { in: listingIds } },
        include: {
          category: true,
          images: { where: { isPrimary: true }, take: 1 },
          tags: { include: { tag: true } },
        },
      })

      const listingMap = new Map(listings.map(l => [l.id, l]))

      return recommendations.map(r => {
        const listing = listingMap.get(r.listingId)
        if (!listing) return null
        return {
          ...listing,
          tags: listing.tags.map((t: any) => t.tag),
          image: listing.images[0]?.url || null,
          recommendationScore: r.score,
          recommendationReason: r.reason,
        }
      }).filter(Boolean)
    }

    // Fallback to rule-based recommendations
    return this.getRuleBasedRecommendations(listingId, type, limit)
  }

  private async getRuleBasedRecommendations(listingId?: string, type?: string, limit = 10) {
    if (listingId) {
      const listing = await this.prisma.marketplaceListing.findUnique({ where: { id: listingId } })
      if (!listing) return []

      return this.prisma.marketplaceListing.findMany({
        where: {
          id: { not: listingId },
          status: ListingStatus.APPROVED,
          OR: [
            { categoryId: listing.categoryId },
            { type: listing.type },
            { publisherId: listing.publisherId },
          ],
        },
        include: {
          category: true,
          images: { where: { isPrimary: true }, take: 1 },
          tags: { include: { tag: true } },
        },
        take: limit,
        orderBy: { domainRating: "desc" },
      })
    }

    // Trending - get most viewed in last 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    
    const trendingIds = await this.prisma.marketplaceListingView.groupBy({
      by: ["listingId"],
      where: { createdAt: { gte: sevenDaysAgo } },
      _count: { listingId: true },
      orderBy: { _count: { listingId: "desc" } },
      take: limit,
    })

    const listings = await this.prisma.marketplaceListing.findMany({
      where: {
        id: { in: trendingIds.map(t => t.listingId) },
        status: ListingStatus.APPROVED,
      },
      include: {
        category: true,
        images: { where: { isPrimary: true }, take: 1 },
        tags: { include: { tag: true } },
      },
    })

    // Maintain trending order
    return trendingIds.map(t => {
      const listing = listings.find(l => l.id === t.listingId)
      if (!listing) return null
      return {
        ...listing,
        tags: listing.tags.map(tag => tag.tag),
        image: listing.images[0]?.url || null,
      }
    }).filter(Boolean)
  }

  // =============================================================================
  // ANALYTICS
  // =============================================================================

  async getMarketplaceStats() {
    const [totalListings, activeListings, totalReviews, avgRating] = await Promise.all([
      this.prisma.marketplaceListing.count(),
      this.prisma.marketplaceListing.count({ where: { status: ListingStatus.APPROVED } }),
      this.prisma.marketplaceReview.count({ where: { status: "APPROVED" } }),
      this.prisma.marketplaceReview.aggregate({
        _avg: { rating: true },
        where: { status: "APPROVED" },
      }),
    ])

    const topCategories = await this.prisma.marketplaceListing.groupBy({
      by: ["categoryId"],
      where: { status: ListingStatus.APPROVED, categoryId: { not: null } },
      _count: { id: true },
      orderBy: { _count: { id: "desc" } },
      take: 5,
    })

    const categoryData = await Promise.all(
      topCategories.map(async (c) => {
        if (!c.categoryId) return null
        const category = await this.prisma.marketplaceCategory.findUnique({ where: { id: c.categoryId } })
        return { category, count: c._count.id }
      })
    )

    return {
      totalListings,
      activeListings,
      totalReviews,
      avgRating: avgRating._avg.rating || 0,
      topCategories: categoryData,
    }
  }

  // =============================================================================
  // HELPER METHODS
  // =============================================================================

  private async verifyPublisherAccess(userId: string, publisherId: string): Promise<boolean> {
    const membership = await this.prisma.publisherMembership.findFirst({
      where: { userId, publisherId },
    })
    return !!membership
  }

  private async createAuditLog(
    userId: string,
    organizationId: string | null,
    action: string, 
    entityId?: string, 
    metadata?: any
  ) {
    await this.prisma.auditLog.create({
      data: {
        action,
        entityType: "MARKETPLACE_LISTING",
        entityId,
        metadata,
        userId,
        organizationId: organizationId ?? "SYSTEM",
      },
    })
  }
}