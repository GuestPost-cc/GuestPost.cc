import {
  ListingStatus,
  Prisma,
  ServiceAvailability,
  type ServiceType,
} from "@guestpost/database"
import { computeListingPhase, QUEUES } from "@guestpost/shared"
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import {
  hasCompleteListingPolicy,
  isMarketplaceLanguage,
  requireActiveMarketplaceCategories,
} from "../../common/utils/marketplace-categories"
import { slugify } from "../../common/utils/slugify"
import { QueueService } from "../queues/queue.service"
import {
  AddToSavedListDto,
  CreateListingDto,
  CreateReviewDto,
  CreateSavedListDto,
  GetRecommendationsDto,
  ListingServiceInput,
  SearchListingsDto,
  UpdateListingDto,
  UpdateListingServiceInput,
} from "./dto/marketplace.dto"

type ListingWriteActor = {
  userId: string
  activePublisherId?: string | null
  isStaff?: boolean
  staffRole?: string | null
}

// Phase 7: the LISTING_TYPE_TO_SERVICE_TYPE bridge map was removed. Clients
// now send `services[]` directly; the legacy single-service shape is gone.

@Injectable()
export class MarketplaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  // Strips internal/sensitive fields before a listing leaves a PUBLIC route.
  // The raw row leaked publisher email/tier/org, internal ids, and raw
  // provider metric dumps (semrush/traffic) to anyone scraping the public
  // marketplace. Whitelist what a buyer legitimately needs to see.
  private toPublicListing(listing: any) {
    const {
      organizationId,
      publisherId,
      semrushData,
      metricsData,
      trafficData,
      publisher,
      ownerType,
      services,
      website,
      status,
      categories: categoryLinks,
      ...rest
    } = listing

    const categories = Array.isArray(categoryLinks)
      ? categoryLinks.map((link: any) => link.category ?? link)
      : []

    // Phase 6 derived UI phase. Computed from (status, ownerType, website
    // verification, count of AVAILABLE services) — single source of truth
    // for "what state is this listing in" across all three apps.
    const availableServices = Array.isArray(services)
      ? services.filter((s: any) => s.availability === "AVAILABLE")
      : []
    const lifecyclePhase = computeListingPhase({
      status: status as any,
      ownerType: (ownerType ?? "PUBLISHER") as any,
      websiteVerificationStatus: website?.verificationStatus ?? null,
      availableServiceCount: availableServices.length,
    })

    // Phase 6 card summary fields: priceFrom + the deduped serviceTypes
    // offered. Driven entirely off AVAILABLE rows so a buyer never sees a
    // chip for a paused/waitlisted service.
    const priceFrom =
      availableServices.length > 0
        ? Math.min(...availableServices.map((s: any) => Number(s.price)))
        : null
    const serviceTypes = Array.from(
      new Set(availableServices.map((s: any) => s.serviceType)),
    )
    const gscMetrics =
      metricsData &&
      typeof metricsData === "object" &&
      (metricsData as any).source === "GSC"
        ? {
            clicks: Number((metricsData as any).clicks ?? 0),
            impressions: Number((metricsData as any).impressions ?? 0),
          }
        : undefined
    const ga4Metrics =
      trafficData &&
      typeof trafficData === "object" &&
      (trafficData as any).source === "GA4"
        ? {
            sessions: Number((trafficData as any).sessions ?? 0),
            users: Number((trafficData as any).users ?? 0),
            pageviews: Number((trafficData as any).pageviews ?? 0),
          }
        : undefined

    return {
      ...rest,
      status,
      lifecyclePhase,
      priceFrom,
      serviceTypes,
      categories,
      // Temporary compatibility projection for older card/detail consumers.
      // New writes and filters use categories[] exclusively.
      category: categories[0] ?? null,
      siteMetrics:
        gscMetrics || ga4Metrics
          ? { periodDays: 30, gsc: gscMetrics, ga4: ga4Metrics }
          : undefined,
      // Listing-level attribution: PLATFORM-owned listings render as
      // "Listed by GuestPost.cc"; PUBLISHER-owned expose the publisher card.
      ownerType,
      attribution:
        ownerType === "PLATFORM"
          ? { kind: "PLATFORM", label: "Listed by GuestPost.cc" }
          : { kind: "PUBLISHER", label: publisher?.name ?? "Publisher" },
      // Service menu — N service rows per listing, each its own price / TAT
      // / requirements / availability. fulfillmentSettings is internal and
      // never exposed publicly.
      services: Array.isArray(services)
        ? services.map((s: any) => this.toPublicListingService(s))
        : undefined,
      // Publisher reduced to display-safe fields; email/tier/org never exposed.
      // Platform-owned listings return null to avoid leaking the internal org.
      publisher:
        ownerType === "PLATFORM"
          ? null
          : publisher
            ? {
                id: publisher.id,
                name: publisher.name,
                tier: publisher.tier ?? null,
                profile: publisher.profile
                  ? {
                      bio: publisher.profile.bio ?? null,
                      rating: publisher.profile.rating ?? null,
                      totalReviews: publisher.profile.totalReviews ?? null,
                      responseTime: publisher.profile.responseTime ?? null,
                      completionRate: publisher.profile.completionRate ?? null,
                      trustScore: publisher.profile.trustScore ?? null,
                    }
                  : null,
              }
            : null,
    }
  }

  // Public projection of a ListingService row. fulfillmentSettings is internal
  // (autoAccept, internalSlaHours, …) and must never leave the API surface.
  private toPublicListingService(service: any) {
    const { fulfillmentSettings, ...rest } = service
    return rest
  }

  private withCategoryProjection(listing: any) {
    const categories = Array.isArray(listing?.categories)
      ? listing.categories.map((link: any) => link.category ?? link)
      : []
    return { ...listing, categories, category: categories[0] ?? null }
  }

  // Lightweight read used by the order-creation UI to power the service
  // picker on the listing detail page. Returns AVAILABLE + WAITLIST rows
  // only; PAUSED is hidden from buyers. Listing must be APPROVED — drafts
  // and rejected listings 404 even if their parent has services.
  async getListingServices(slug: string) {
    const listing = await this.prisma.marketplaceListing.findUnique({
      where: { slug },
      select: {
        id: true,
        status: true,
        ownerType: true,
        services: {
          where: { availability: { in: ["AVAILABLE", "WAITLIST"] } },
          orderBy: [{ availability: "asc" }, { price: "asc" }],
        },
      },
    })
    if (!listing || listing.status !== ListingStatus.APPROVED) {
      throw new NotFoundException("Listing not found")
    }
    return {
      ownerType: listing.ownerType,
      services: listing.services.map((s) => this.toPublicListingService(s)),
    }
  }

  // =============================================================================
  // LISTING CRUD
  // =============================================================================

  async searchListings(dto: SearchListingsDto) {
    const {
      query,
      category,
      categories,
      type,
      tags,
      country,
      language,
      languages,
      sportsGamingAllowed,
      pharmacyAllowed,
      cryptoAllowed,
      backlinkCounts,
      linkTypes,
      linkValidities,
      googleNews,
      markedSponsored,
      foreignLanguageAllowed,
      minPrice,
      maxPrice,
      minDR,
      maxDR,
      minTraffic,
      maxTurnaroundDays,
      sortBy,
      page = 1,
      limit = 20,
      ownershipType,
    } = dto

    const where: any = {
      status: ListingStatus.APPROVED,
    }

    const categorySlugs = categories?.length
      ? categories
      : category
        ? [category]
        : []
    if (categorySlugs.length > 0) {
      where.categories = {
        some: { category: { slug: { in: categorySlugs } } },
      }
    }

    if (ownershipType) {
      where.website = { ownershipType: ownershipType as any }
    }

    if (country) {
      where.country = { equals: country, mode: "insensitive" }
    }

    const languageValues = languages?.length
      ? languages
      : language
        ? [language]
        : []
    if (languageValues.length > 0) {
      where.language = { in: languageValues, mode: "insensitive" }
    }

    if (sportsGamingAllowed !== undefined)
      where.sportsGamingAllowed = sportsGamingAllowed
    if (pharmacyAllowed !== undefined) where.pharmacyAllowed = pharmacyAllowed
    if (cryptoAllowed !== undefined) where.cryptoAllowed = cryptoAllowed
    if (backlinkCounts?.length) where.backlinkCount = { in: backlinkCounts }
    if (linkTypes?.length) where.linkType = { in: linkTypes }
    if (linkValidities?.length) where.linkValidity = { in: linkValidities }
    if (googleNews !== undefined) where.googleNews = googleNews
    if (markedSponsored !== undefined) where.markedSponsored = markedSponsored
    if (foreignLanguageAllowed !== undefined)
      where.foreignLanguageAllowed = foreignLanguageAllowed

    // ── Phase 6 service-level filtering ──────────────────────────────────
    // The customer's price / TAT / serviceType picker keys off
    // ListingService rows, not the listing-level legacy columns. We require
    // at least ONE matching AVAILABLE service per returned listing — that
    // also excludes listings whose services are entirely paused/waitlisted.
    const serviceFilter: any = { availability: "AVAILABLE" }
    if (type) serviceFilter.serviceType = type
    if (minPrice !== undefined || maxPrice !== undefined) {
      serviceFilter.price = {}
      if (minPrice !== undefined) serviceFilter.price.gte = minPrice
      if (maxPrice !== undefined) serviceFilter.price.lte = maxPrice
    }
    if (maxTurnaroundDays !== undefined)
      serviceFilter.turnaroundDays = { lte: maxTurnaroundDays }
    where.services = { some: serviceFilter }

    // DR / traffic remain listing-level (they're properties of the website,
    // not of a service).
    if (minDR !== undefined || maxDR !== undefined) {
      where.domainRating = {}
      if (minDR !== undefined) where.domainRating.gte = minDR
      if (maxDR !== undefined) where.domainRating.lte = maxDR
    }

    if (minTraffic !== undefined) {
      where.traffic = { gte: minTraffic }
    }

    if (tags && tags.length > 0) {
      where.tags = {
        some: {
          tag: { slug: { in: tags } },
        },
      }
    }

    if (query) {
      where.OR = [
        { title: { contains: query, mode: "insensitive" } },
        { description: { contains: query, mode: "insensitive" } },
        { slug: { contains: query, mode: "insensitive" } },
        {
          categories: {
            some: {
              category: { name: { contains: query, mode: "insensitive" } },
            },
          },
        },
        {
          tags: {
            some: { tag: { name: { contains: query, mode: "insensitive" } } },
          },
        },
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
      case "price_desc":
        // Handled below with a parameterized ListingService MIN(price)
        // query. MarketplaceListing has no price column after Phase 7.
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
        orderBy = [{ featured: "desc" }, { traffic: "desc" }]
    }

    const include = {
      categories: { include: { category: true } },
      tags: { include: { tag: true } },
      images: { where: { isPrimary: true }, take: 1 },
      reviews: { where: { status: "APPROVED" }, select: { rating: true } },
      publisher: { include: { profile: true } },
      website: true,
      // Card view: surface only AVAILABLE services so listing cards can
      // show "from $X" / service chips without leaking paused/waitlist.
      services: {
        where: { availability: ServiceAvailability.AVAILABLE },
        orderBy: { price: "asc" as const },
      },
    } satisfies Prisma.MarketplaceListingInclude

    type SearchListingRow = Prisma.MarketplaceListingGetPayload<{
      include: typeof include
    }>
    let listings: SearchListingRow[]
    let total: number
    if (sortBy === "price_asc" || sortBy === "price_desc") {
      const [orderedIds, listingCount] = await Promise.all([
        this.findPriceSortedListingIds(dto, page, limit, sortBy),
        this.prisma.marketplaceListing.count({ where }),
      ])
      total = listingCount
      const rows = await this.prisma.marketplaceListing.findMany({
        where: { id: { in: orderedIds } },
        include,
      })
      const rowsById = new Map(rows.map((row) => [row.id, row]))
      listings = orderedIds.flatMap((id) => {
        const row = rowsById.get(id)
        return row ? [row] : []
      })
    } else {
      ;[listings, total] = await Promise.all([
        this.prisma.marketplaceListing.findMany({
          where,
          orderBy,
          skip: (page - 1) * limit,
          take: limit,
          include,
        }),
        this.prisma.marketplaceListing.count({ where }),
      ])
    }

    const listingsWithStats = listings.map((listing) => {
      const avgRating =
        listing.reviews.length > 0
          ? listing.reviews.reduce((sum, r) => sum + r.rating, 0) /
            listing.reviews.length
          : null
      return this.toPublicListing({
        ...listing,
        tags: listing.tags.map((t) => t.tag),
        image: listing.images[0]?.url || null,
        reviewCount: listing.reviews.length,
        avgRating,
      })
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

  private async findPriceSortedListingIds(
    dto: SearchListingsDto,
    page: number,
    limit: number,
    sortBy: "price_asc" | "price_desc",
  ): Promise<string[]> {
    const listingConditions: Prisma.Sql[] = [
      Prisma.sql`listing."status" = ${ListingStatus.APPROVED}::"ListingStatus"`,
    ]
    const serviceConditions: Prisma.Sql[] = [
      Prisma.sql`service."availability" = ${ServiceAvailability.AVAILABLE}::"ServiceAvailability"`,
    ]

    const categorySlugs = dto.categories?.length
      ? dto.categories
      : dto.category
        ? [dto.category]
        : []
    if (categorySlugs.length > 0) {
      listingConditions.push(
        Prisma.sql`EXISTS (
          SELECT 1
          FROM "MarketplaceListingCategory" listing_category
          JOIN "MarketplaceCategory" category
            ON category."id" = listing_category."categoryId"
          WHERE listing_category."listingId" = listing."id"
            AND category."slug" IN (${Prisma.join(categorySlugs)})
        )`,
      )
    }
    if (dto.ownershipType) {
      listingConditions.push(
        Prisma.sql`EXISTS (
          SELECT 1 FROM "Website" website
          WHERE website."id" = listing."websiteId"
            AND website."ownershipType" = ${dto.ownershipType}::"WebsiteOwnershipType"
        )`,
      )
    }
    if (dto.country) {
      listingConditions.push(Prisma.sql`listing."country" ILIKE ${dto.country}`)
    }
    const languages = dto.languages?.length
      ? dto.languages
      : dto.language
        ? [dto.language]
        : []
    if (languages.length > 0) {
      listingConditions.push(
        Prisma.sql`lower(listing."language") IN (${Prisma.join(
          languages.map((value) => value.toLowerCase()),
        )})`,
      )
    }
    if (dto.sportsGamingAllowed !== undefined) {
      listingConditions.push(
        Prisma.sql`listing."sportsGamingAllowed" = ${dto.sportsGamingAllowed}`,
      )
    }
    if (dto.pharmacyAllowed !== undefined) {
      listingConditions.push(
        Prisma.sql`listing."pharmacyAllowed" = ${dto.pharmacyAllowed}`,
      )
    }
    if (dto.cryptoAllowed !== undefined) {
      listingConditions.push(
        Prisma.sql`listing."cryptoAllowed" = ${dto.cryptoAllowed}`,
      )
    }
    if (dto.backlinkCounts?.length) {
      listingConditions.push(
        Prisma.sql`listing."backlinkCount" IN (${Prisma.join(dto.backlinkCounts)})`,
      )
    }
    if (dto.linkTypes?.length) {
      listingConditions.push(
        Prisma.sql`listing."linkType"::text IN (${Prisma.join(dto.linkTypes)})`,
      )
    }
    if (dto.linkValidities?.length) {
      listingConditions.push(
        Prisma.sql`listing."linkValidity"::text IN (${Prisma.join(dto.linkValidities)})`,
      )
    }
    if (dto.googleNews !== undefined) {
      listingConditions.push(
        Prisma.sql`listing."googleNews" = ${dto.googleNews}`,
      )
    }
    if (dto.markedSponsored !== undefined) {
      listingConditions.push(
        Prisma.sql`listing."markedSponsored" = ${dto.markedSponsored}`,
      )
    }
    if (dto.foreignLanguageAllowed !== undefined) {
      listingConditions.push(
        Prisma.sql`listing."foreignLanguageAllowed" = ${dto.foreignLanguageAllowed}`,
      )
    }
    if (dto.minDR !== undefined) {
      listingConditions.push(Prisma.sql`listing."domainRating" >= ${dto.minDR}`)
    }
    if (dto.maxDR !== undefined) {
      listingConditions.push(Prisma.sql`listing."domainRating" <= ${dto.maxDR}`)
    }
    if (dto.minTraffic !== undefined) {
      listingConditions.push(Prisma.sql`listing."traffic" >= ${dto.minTraffic}`)
    }
    if (dto.tags?.length) {
      listingConditions.push(
        Prisma.sql`EXISTS (
          SELECT 1
          FROM "MarketplaceListingTag" listing_tag
          JOIN "MarketplaceTag" tag ON tag."id" = listing_tag."tagId"
          WHERE listing_tag."listingId" = listing."id"
            AND tag."slug" IN (${Prisma.join(dto.tags)})
        )`,
      )
    }
    if (dto.query) {
      const pattern = `%${dto.query}%`
      listingConditions.push(
        Prisma.sql`(
          listing."title" ILIKE ${pattern}
          OR listing."description" ILIKE ${pattern}
          OR listing."slug" ILIKE ${pattern}
          OR EXISTS (
            SELECT 1
            FROM "MarketplaceListingCategory" listing_category
            JOIN "MarketplaceCategory" category
              ON category."id" = listing_category."categoryId"
            WHERE listing_category."listingId" = listing."id"
              AND category."name" ILIKE ${pattern}
          )
          OR EXISTS (
            SELECT 1
            FROM "MarketplaceListingTag" listing_tag
            JOIN "MarketplaceTag" tag ON tag."id" = listing_tag."tagId"
            WHERE listing_tag."listingId" = listing."id"
              AND tag."name" ILIKE ${pattern}
          )
        )`,
      )
    }

    if (dto.type) {
      serviceConditions.push(
        Prisma.sql`service."serviceType" = ${dto.type}::"ServiceType"`,
      )
    }
    if (dto.minPrice !== undefined) {
      serviceConditions.push(Prisma.sql`service."price" >= ${dto.minPrice}`)
    }
    if (dto.maxPrice !== undefined) {
      serviceConditions.push(Prisma.sql`service."price" <= ${dto.maxPrice}`)
    }
    if (dto.maxTurnaroundDays !== undefined) {
      serviceConditions.push(
        Prisma.sql`service."turnaroundDays" <= ${dto.maxTurnaroundDays}`,
      )
    }

    const matchingService = Prisma.sql`
      SELECT MIN(service."price")
      FROM "ListingService" service
      WHERE service."listingId" = listing."id"
        AND ${Prisma.join(serviceConditions, " AND ")}
    `
    listingConditions.push(
      Prisma.sql`EXISTS (
        SELECT 1 FROM "ListingService" service
        WHERE service."listingId" = listing."id"
          AND ${Prisma.join(serviceConditions, " AND ")}
      )`,
    )

    const direction =
      sortBy === "price_asc" ? Prisma.raw("ASC") : Prisma.raw("DESC")
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT listing."id"
      FROM "MarketplaceListing" listing
      WHERE ${Prisma.join(listingConditions, " AND ")}
      ORDER BY (${matchingService}) ${direction}, listing."createdAt" DESC, listing."id" ASC
      LIMIT ${limit}
      OFFSET ${(page - 1) * limit}
    `)
    return rows.map((row) => row.id)
  }

  // Staff preview — fetch a listing by slug in ANY status (pending/draft/
  // rejected/paused/archived) for moderation. No public status gate, no view
  // tracking. Authorization is enforced by the StaffRoles guard on the route.
  async getListingForStaff(slug: string) {
    const listing = await this.prisma.marketplaceListing.findUnique({
      where: { slug },
      include: {
        categories: { include: { category: true } },
        tags: { include: { tag: true } },
        images: { orderBy: { sortOrder: "asc" } },
        reviews: {
          include: { user: { select: { id: true, name: true, image: true } } },
          orderBy: { createdAt: "desc" },
          take: 10,
        },
        publisher: { include: { profile: true } },
        website: true,
        // Staff sees ALL services regardless of availability, so reviewers
        // can spot paused/waitlist rows and judge the listing holistically.
        services: { orderBy: [{ availability: "asc" }, { price: "asc" }] },
      },
    })
    if (!listing) throw new NotFoundException("Listing not found")
    return { ...this.withCategoryProjection(listing), relatedListings: [] }
  }

  async getListing(slug: string, userId?: string) {
    const listing = await this.prisma.marketplaceListing.findUnique({
      where: { slug },
      include: {
        categories: { include: { category: true } },
        tags: { include: { tag: true } },
        images: { orderBy: { sortOrder: "asc" } },
        reviews: {
          where: { status: "APPROVED" },
          include: { user: { select: { id: true, name: true, image: true } } },
          orderBy: { createdAt: "desc" },
          take: 10,
        },
        publisher: { include: { profile: true } },
        website: true,
        // Detail page surfaces AVAILABLE + WAITLIST (so buyers can register
        // interest via the favorite-with-serviceType waitlist path) but never
        // PAUSED (publisher temporarily took it offline).
        services: {
          where: { availability: { in: ["AVAILABLE", "WAITLIST"] } },
          orderBy: [{ availability: "asc" }, { price: "asc" }],
        },
      },
    })

    if (!listing) {
      throw new NotFoundException("Listing not found")
    }

    // Non-APPROVED listings are visible only to a member of the owning publisher.
    // Everyone else gets 404 — do not reveal existence of draft/rejected/paused/archived.
    if (listing.status !== ListingStatus.APPROVED) {
      const isOwner =
        userId && listing.publisherId
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

    // Phase 7: "related" used to match on the deprecated listing-level
    // `type` column. Match on service overlap instead — any listing that
    // offers at least one of THIS listing's AVAILABLE serviceTypes counts.
    const ownServiceTypes = (listing.services ?? [])
      .filter((s: any) => s.availability === "AVAILABLE")
      .map((s: any) => s.serviceType)
    const ownCategoryIds = listing.categories.map((link) => link.categoryId)
    const relatedListings = await this.prisma.marketplaceListing.findMany({
      where: {
        id: { not: listing.id },
        status: ListingStatus.APPROVED,
        OR: [
          ...(ownCategoryIds.length > 0
            ? [
                {
                  categories: {
                    some: { categoryId: { in: ownCategoryIds } },
                  },
                },
              ]
            : []),
          ...(ownServiceTypes.length > 0
            ? [
                {
                  services: {
                    some: {
                      availability: "AVAILABLE" as const,
                      serviceType: { in: ownServiceTypes },
                    },
                  },
                },
              ]
            : []),
        ],
      },
      take: 4,
      include: {
        categories: { include: { category: true } },
        images: { where: { isPrimary: true }, take: 1 },
        tags: { include: { tag: true } },
        reviews: {
          where: { status: "APPROVED" },
          select: { rating: true },
        },
        publisher: { include: { profile: true } },
        website: true,
        services: {
          where: { availability: "AVAILABLE" },
          orderBy: { price: "asc" },
        },
      },
    })

    const avgRating =
      listing.reviews.length > 0
        ? listing.reviews.reduce((sum, r) => sum + r.rating, 0) /
          listing.reviews.length
        : null

    let isFavorited = false
    if (userId) {
      // Whole-listing favorite = serviceType NULL. Service-scoped favorites
      // (WAITLIST notify-me) live alongside but don't satisfy "isFavorited"
      // at the listing card level.
      const favorite = await this.prisma.marketplaceFavorite.findFirst({
        where: { userId, listingId: listing.id, serviceType: null },
      })
      isFavorited = !!favorite
    }

    return {
      ...this.toPublicListing({
        ...listing,
        tags: listing.tags.map((t) => t.tag),
        avgRating,
        reviewCount: listing.reviews.length,
        isFavorited,
      }),
      relatedListings: relatedListings.map((l) =>
        this.toPublicListing({
          ...l,
          tags: l.tags.map((t) => t.tag),
          image: l.images[0]?.url || null,
          reviewCount: l.reviews.length,
          avgRating:
            l.reviews.length > 0
              ? l.reviews.reduce((sum, review) => sum + review.rating, 0) /
                l.reviews.length
              : null,
        }),
      ),
    }
  }

  // Resolves and authorizes the owning publisher for a listing mutation.
  // Ownership is keyed on PublisherMembership, NOT organizationId (publishers
  // have no active organization context, so an org check is unsound here).
  private async resolveOwnedPublisherId(
    userId: string,
    activePublisherId: string | null,
    dtoPublisherId?: string,
  ): Promise<string> {
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

  async createListing(
    userId: string,
    activePublisherId: string | null,
    dto: CreateListingDto,
  ) {
    const slug = slugify(dto.title)

    // Check for duplicate slug
    const existing = await this.prisma.marketplaceListing.findUnique({
      where: { slug },
    })
    if (existing) {
      throw new BadRequestException("A listing with this title already exists")
    }

    const publisherId = await this.resolveOwnedPublisherId(
      userId,
      activePublisherId,
      dto.publisherId,
    )
    const publisher = await this.prisma.publisher.findUnique({
      where: { id: publisherId },
    })
    if (!publisher) throw new NotFoundException("Publisher not found")

    // ── One listing per verified website ──
    // Every publisher listing must be associated with a website. A website
    // keeps one listing for its lifetime; services are the expandable menu.
    if (!dto.websiteId) {
      throw new BadRequestException(
        "A website is required to create a listing. Select the site this listing will represent.",
      )
    }

    // Verify the website belongs to this publisher.
    const website = await this.prisma.website.findUnique({
      where: { id: dto.websiteId },
      select: { id: true, publisherId: true, verificationStatus: true },
    })
    if (!website) {
      throw new NotFoundException("Website not found")
    }
    if (website.publisherId !== publisherId) {
      throw new ForbiddenException("This website does not belong to you")
    }

    // A website keeps one listing for its lifetime, including after archival.
    // Archived listings can be resubmitted and their services remain linked to
    // historical orders; creating a replacement would split one domain's menu
    // and audit trail across multiple listing ids.
    const existingListing = await this.prisma.marketplaceListing.findFirst({
      where: {
        websiteId: dto.websiteId,
        publisherId,
      },
      select: { id: true, title: true },
    })
    if (existingListing) {
      throw new BadRequestException(
        `A listing already exists for this website: "${existingListing.title}". Restore or add services to the existing listing instead of creating a duplicate.`,
      )
    }

    const data: any = { ...dto }
    delete data.tags
    delete data.services
    delete data.categoryIds

    const categories = await requireActiveMarketplaceCategories(
      this.prisma,
      dto.categoryIds,
    )

    const services = this.resolveServicesInput(dto)

    const listing = await this.prisma.marketplaceListing.create({
      data: {
        ...data,
        slug,
        publisherId,
        organizationId: publisher.organizationId,
        ownerType: "PUBLISHER",
        status: dto.status || ListingStatus.DRAFT,
        tags: dto.tags
          ? {
              create: dto.tags.map((tagId) => ({
                tag: { connect: { id: tagId } },
              })),
            }
          : undefined,
        services: this.listingServicesCreateMany(services),
        categories: {
          create: categories.map((category) => ({
            category: { connect: { id: category.id } },
          })),
        },
      },
      include: {
        categories: { include: { category: true } },
        tags: { include: { tag: true } },
        services: true,
      },
    })

    await this.createAuditLog(
      userId,
      publisher.organizationId,
      "LISTING_CREATED",
      listing.id,
      {
        title: listing.title,
        serviceCount: services?.length ?? 0,
      },
    )

    return this.withCategoryProjection(listing)
  }

  async updateListing(
    userId: string,
    _activePublisherId: string | null,
    listingId: string,
    dto: UpdateListingDto,
  ) {
    const listing = await this.prisma.marketplaceListing.findUnique({
      where: { id: listingId },
    })

    if (!listing) {
      throw new NotFoundException("Listing not found")
    }
    if (!listing.publisherId) {
      throw new ForbiddenException("You don't have access to this listing")
    }
    const hasAccess = await this.verifyPublisherAccess(
      userId,
      listing.publisherId,
    )
    if (!hasAccess) {
      throw new ForbiddenException("You don't have access to this listing")
    }

    // Block edits on a revoked domain — ownership must be re-verified first.
    if (listing.websiteId) {
      const site = await this.prisma.website.findUnique({
        where: { id: listing.websiteId },
        select: { verificationStatus: true, ownershipType: true },
      })
      if (
        site?.ownershipType === "PUBLISHER" &&
        site.verificationStatus === "REVOKED"
      ) {
        throw new BadRequestException({
          code: "WEBSITE_REVOKED",
          message:
            "Cannot edit listing: domain ownership is revoked. Re-verify the domain first.",
        })
      }
    }

    const categories = await requireActiveMarketplaceCategories(
      this.prisma,
      dto.categoryIds,
    )

    // Publisher metadata writes are deliberately allowlisted. Lifecycle,
    // ownership, verification, featured state, website association, metrics,
    // and service rows are controlled by their dedicated workflows and cannot
    // be smuggled through this general update endpoint.
    const updateData: Prisma.MarketplaceListingUpdateInput = {
      title: dto.title.trim(),
      description: dto.description.trim(),
      language: dto.language,
      sportsGamingAllowed: dto.sportsGamingAllowed,
      pharmacyAllowed: dto.pharmacyAllowed,
      cryptoAllowed: dto.cryptoAllowed,
      backlinkCount: dto.backlinkCount,
      linkType: dto.linkType,
      linkValidity: dto.linkValidity,
      googleNews: dto.googleNews,
      markedSponsored: dto.markedSponsored,
      foreignLanguageAllowed: dto.foreignLanguageAllowed,
      ...(dto.shortDescription !== undefined
        ? { shortDescription: dto.shortDescription.trim() || null }
        : {}),
      ...(dto.doFollowOnly !== undefined
        ? { doFollowOnly: dto.doFollowOnly }
        : {}),
      ...(dto.sampleUrl !== undefined ? { sampleUrl: dto.sampleUrl } : {}),
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.marketplaceListing.update({
        where: { id: listingId },
        data: {
          ...updateData,
          categories: {
            deleteMany: {},
            create: categories.map((category) => ({
              category: { connect: { id: category.id } },
            })),
          },
          tags: dto.tags
            ? {
                deleteMany: {},
                create: dto.tags.map((tagId) => ({
                  tag: { connect: { id: tagId } },
                })),
              }
            : undefined,
        },
        include: {
          categories: { include: { category: true } },
          tags: { include: { tag: true } },
        },
      })
      if (listing.websiteId) {
        await tx.website.update({
          where: { id: listing.websiteId },
          data: {
            language: dto.language,
            category: categories.map((category) => category.name).join(", "),
          },
        })
      }
      return row
    })

    await this.createAuditLog(
      userId,
      listing.organizationId,
      "LISTING_UPDATED",
      listingId,
      {
        changes: [
          "title",
          "description",
          "categoryIds",
          "language",
          "listingPolicy",
          ...(dto.shortDescription !== undefined ? ["shortDescription"] : []),
          ...(dto.tags !== undefined ? ["tags"] : []),
          ...(dto.doFollowOnly !== undefined ? ["doFollowOnly"] : []),
          ...(dto.sampleUrl !== undefined ? ["sampleUrl"] : []),
        ],
      },
    )

    return this.withCategoryProjection(updated)
  }

  // ── ListingService helpers (Phase 2 dual-write) ────────────────────────
  //
  // Phase 7: the legacy single-service shape was dropped — `services[]` is
  // now the only accepted input. We keep the deduping + validation step
  // (was inline in the old shim) here so the create call sites stay tidy.
  private resolveServicesInput(dto: {
    services?: ListingServiceInput[]
  }): ListingServiceInput[] | null {
    if (!dto.services || dto.services.length === 0) return null
    const seen = new Set<ServiceType>()
    for (const s of dto.services) {
      if (seen.has(s.serviceType)) {
        throw new BadRequestException(
          `Duplicate service ${s.serviceType} in listing`,
        )
      }
      seen.add(s.serviceType)
    }
    return dto.services
  }

  // Build a Prisma nested-create payload for ListingService rows. Sentinel
  // helper kept tight on purpose: the listing-create call sites use this
  // identically so the schema-level uniqueness (listingId, serviceType) and
  // defaults stay in one place.
  private listingServicesCreateMany(services: ListingServiceInput[] | null) {
    if (!services || services.length === 0) return undefined
    return {
      create: services.map((s) => ({
        serviceType: s.serviceType,
        price: new Prisma.Decimal(s.price),
        currency: s.currency ?? "USD",
        turnaroundDays: s.turnaroundDays,
        revisionRounds: s.revisionRounds ?? 2,
        warrantyDays: s.warrantyDays,
        requirements: s.requirements as Prisma.InputJsonValue | undefined,
        fulfillmentSettings: s.fulfillmentSettings as
          | Prisma.InputJsonValue
          | undefined,
        availability: s.availability ?? "AVAILABLE",
      })),
    }
  }

  // ── ListingService CRUD ────────────────────────────────────────────────
  // Per-service endpoints used by the Publisher + Admin Services tab. The
  // listing's parent ownership check (publisherId membership for publisher,
  // staff guard for platform) is enforced by the controller; this method
  // does the listing-level access check + version-guarded write.

  async addServiceToListing(
    actor: ListingWriteActor,
    listingId: string,
    input: ListingServiceInput,
  ) {
    const listing = await this.prisma.marketplaceListing.findUnique({
      where: { id: listingId },
      select: {
        id: true,
        publisherId: true,
        organizationId: true,
        ownerType: true,
        websiteId: true,
      },
    })
    if (!listing) throw new NotFoundException("Listing not found")
    await this.assertListingWriteAccess(actor, listing)

    try {
      const created = await this.prisma.listingService.create({
        data: {
          listingId,
          serviceType: input.serviceType,
          price: new Prisma.Decimal(input.price),
          currency: input.currency ?? "USD",
          turnaroundDays: input.turnaroundDays,
          revisionRounds: input.revisionRounds ?? 2,
          warrantyDays: input.warrantyDays,
          requirements: input.requirements as Prisma.InputJsonValue | undefined,
          fulfillmentSettings: input.fulfillmentSettings as
            | Prisma.InputJsonValue
            | undefined,
          availability: input.availability ?? "AVAILABLE",
        },
      })
      await this.createAuditLog(
        actor.userId,
        listing.organizationId,
        "LISTING_SERVICE_ADDED",
        created.id,
        {
          listingId,
          serviceType: created.serviceType,
          price: created.price.toString(),
        },
      )
      return created
    } catch (e: any) {
      if (e?.code === "P2002") {
        throw new BadRequestException(
          `Service ${input.serviceType} already exists on this listing`,
        )
      }
      throw e
    }
  }

  async updateServiceOnListing(
    actor: ListingWriteActor,
    listingId: string,
    serviceId: string,
    input: UpdateListingServiceInput,
  ) {
    const service = await this.prisma.listingService.findUnique({
      where: { id: serviceId },
      include: {
        listing: {
          select: {
            id: true,
            publisherId: true,
            organizationId: true,
            ownerType: true,
            websiteId: true,
          },
        },
      },
    })
    if (!service || service.listingId !== listingId) {
      throw new NotFoundException("Service not found on this listing")
    }
    await this.assertListingWriteAccess(actor, service.listing)

    // Version-guarded update — concurrent edits or a stale tab cannot silently
    // overwrite each other. The optimistic lock matches the pattern used
    // throughout orders/settlements.
    const updateData: Prisma.ListingServiceUncheckedUpdateInput = {
      version: { increment: 1 },
    }
    if (input.price !== undefined)
      updateData.price = new Prisma.Decimal(input.price)
    if (input.currency !== undefined) updateData.currency = input.currency
    if (input.turnaroundDays !== undefined)
      updateData.turnaroundDays = input.turnaroundDays
    if (input.revisionRounds !== undefined)
      updateData.revisionRounds = input.revisionRounds
    if (input.warrantyDays !== undefined)
      updateData.warrantyDays = input.warrantyDays
    if (input.requirements !== undefined)
      updateData.requirements = input.requirements as Prisma.InputJsonValue
    if (input.fulfillmentSettings !== undefined)
      updateData.fulfillmentSettings =
        input.fulfillmentSettings as Prisma.InputJsonValue
    if (input.availability !== undefined)
      updateData.availability = input.availability

    const res = await this.prisma.listingService.updateMany({
      where: { id: serviceId, version: input.version },
      data: updateData,
    })
    if (res.count === 0) {
      throw new BadRequestException({
        code: "VERSION_CONFLICT",
        message: "Service was modified by another request — reload and retry",
      })
    }

    const updated = await this.prisma.listingService.findUnique({
      where: { id: serviceId },
    })
    await this.createAuditLog(
      actor.userId,
      service.listing.organizationId,
      "LISTING_SERVICE_UPDATED",
      serviceId,
      {
        listingId,
        changes: Object.keys(input).filter((k) => k !== "version"),
      },
    )

    // ── Phase 6: waitlist → available fan-out ────────────────────────────
    // Notifies every user with a MarketplaceFavorite scoped to this
    // (listingId, serviceType) plus those who favorited the whole listing
    // (serviceType=NULL). Fire-and-forget via the existing notification
    // queue — no new processor needed since the recipient set is small.
    // Sites toggling rapidly aren't a real concern (this is a publisher-
    // initiated edit, not a system-driven flap), so we don't rate-limit.
    if (
      service.availability === "WAITLIST" &&
      input.availability === "AVAILABLE"
    ) {
      const favorites = await this.prisma.marketplaceFavorite.findMany({
        where: {
          listingId,
          OR: [{ serviceType: service.serviceType }, { serviceType: null }],
        },
        select: { userId: true },
      })
      for (const f of favorites) {
        await this.queue.addJob(QUEUES.NOTIFICATION, "push-in-app", {
          userId: f.userId,
          organizationId: null,
          type: "WAITLIST_AVAILABLE",
          message: `A service you favorited is now available`,
        })
      }
      await this.createAuditLog(
        actor.userId,
        service.listing.organizationId,
        "LISTING_SERVICE_WAITLIST_RELEASED",
        serviceId,
        {
          listingId,
          serviceType: service.serviceType,
          notifiedCount: favorites.length,
        },
      )
    }

    return updated
  }

  // Soft-disable rather than hard-delete: a paused row stays linked to any
  // historical Order that snapshotted its id, so order detail can still
  // resolve listingService.* fields. Removing the row would orphan those.
  async pauseServiceOnListing(
    actor: ListingWriteActor,
    listingId: string,
    serviceId: string,
  ) {
    return this.updateServiceOnListing(actor, listingId, serviceId, {
      availability: "PAUSED",
      version:
        (
          await this.prisma.listingService.findUnique({
            where: { id: serviceId },
            select: { version: true },
          })
        )?.version ?? 0,
    })
  }

  // Listing write access: publisher path uses the existing membership check;
  // Super Admin may edit any listing service. Operations is limited to a
  // PLATFORM listing whose website is explicitly assigned to that operator.
  private async assertListingWriteAccess(
    actor: ListingWriteActor,
    listing: {
      publisherId: string | null
      ownerType?: "PUBLISHER" | "PLATFORM" | null
      websiteId?: string | null
    },
  ) {
    if (actor.isStaff) {
      if (actor.staffRole === "SUPER_ADMIN") return
      if (
        actor.staffRole === "OPERATIONS" &&
        listing.ownerType === "PLATFORM" &&
        listing.websiteId
      ) {
        const assignedWebsite = await this.prisma.website.findFirst({
          where: {
            id: listing.websiteId,
            ownershipType: "PLATFORM",
            managedByUserId: actor.userId,
          },
          select: { id: true },
        })
        if (assignedWebsite) return
      }
      throw new ForbiddenException(
        "Operations can only edit services for assigned platform websites",
      )
    }
    if (!listing.publisherId) {
      throw new ForbiddenException(
        "Only platform staff can edit this listing's services",
      )
    }
    const hasAccess = await this.verifyPublisherAccess(
      actor.userId,
      listing.publisherId,
    )
    if (!hasAccess) {
      throw new ForbiddenException("You don't have access to this listing")
    }
  }

  // ── Phase 6 lifecycle transitions ─────────────────────────────────────
  //
  // The source status is the "version" — every transition narrows the
  // updateMany where-clause to (id, currentStatus). If the row already
  // moved, updateMany returns 0 and we throw 409. Cheap optimistic
  // concurrency without a new schema column.
  //
  // Gates layered on top:
  //   - submit: must be the publisher; website must be VERIFIED; ≥1
  //     AVAILABLE ListingService row.
  //   - pause / unpause: must be APPROVED / PAUSED respectively.
  //   - archive: any non-ARCHIVED → ARCHIVED.

  async submitListingForReview(
    userId: string,
    _activePublisherId: string | null,
    listingId: string,
  ) {
    const listing = await this.assertPublisherOwnedListing(userId, listingId)

    if (
      listing.status !== ListingStatus.DRAFT &&
      listing.status !== ListingStatus.REJECTED &&
      listing.status !== ListingStatus.ARCHIVED
    ) {
      throw new BadRequestException(
        "Only draft, rejected, or archived listings can be submitted for review.",
      )
    }
    if (listing.website?.verificationStatus !== "VERIFIED") {
      throw new BadRequestException({
        code: "WEBSITE_NOT_VERIFIED",
        message: "Cannot submit: verify domain ownership first.",
      })
    }
    const availableCount = await this.prisma.listingService.count({
      where: { listingId, availability: "AVAILABLE" },
    })
    if (availableCount === 0) {
      throw new BadRequestException({
        code: "NO_AVAILABLE_SERVICES",
        message:
          "Add at least one available service before submitting for review.",
      })
    }
    if (listing.categories.length < 1 || listing.categories.length > 7) {
      throw new BadRequestException({
        code: "LISTING_CATEGORIES_REQUIRED",
        message:
          "Choose between 1 and 7 marketplace categories before submitting for review.",
      })
    }
    if (
      !isMarketplaceLanguage(listing.language) ||
      !hasCompleteListingPolicy(listing)
    ) {
      throw new BadRequestException({
        code: "LISTING_POLICY_REQUIRED",
        message:
          "Choose a primary language and complete every listing policy before submitting for review.",
      })
    }
    if (!listing.description.trim() || listing.description.length > 500) {
      throw new BadRequestException({
        code: "LISTING_DESCRIPTION_REQUIRED",
        message:
          "Add a buyer-facing listing description of no more than 500 characters before submitting.",
      })
    }

    const res = await this.prisma.marketplaceListing.updateMany({
      where: {
        id: listingId,
        status: {
          in: [
            ListingStatus.DRAFT,
            ListingStatus.REJECTED,
            ListingStatus.ARCHIVED,
          ],
        },
      },
      data: { status: ListingStatus.PENDING_REVIEW },
    })
    if (res.count === 0) {
      throw new BadRequestException({
        code: "STATUS_CONFLICT",
        message: "Listing was modified — reload and retry.",
      })
    }

    await this.createAuditLog(
      userId,
      listing.organizationId,
      "LISTING_SUBMITTED_FOR_REVIEW",
      listingId,
      {
        title: listing.title,
        websiteId: listing.websiteId,
      },
    )

    return this.prisma.marketplaceListing.findUniqueOrThrow({
      where: { id: listingId },
    })
  }

  async pauseListing(
    userId: string,
    _activePublisherId: string | null,
    listingId: string,
  ) {
    const listing = await this.assertPublisherOwnedListing(userId, listingId)
    if (listing.status !== ListingStatus.APPROVED) {
      throw new BadRequestException(
        `Only APPROVED listings can be paused (currently ${listing.status})`,
      )
    }
    const res = await this.prisma.marketplaceListing.updateMany({
      where: { id: listingId, status: ListingStatus.APPROVED },
      data: { status: ListingStatus.PAUSED },
    })
    if (res.count === 0)
      throw new BadRequestException({
        code: "STATUS_CONFLICT",
        message: "Listing was modified — reload and retry.",
      })
    await this.createAuditLog(
      userId,
      listing.organizationId,
      "LISTING_PAUSED",
      listingId,
      { title: listing.title },
    )
    return this.prisma.marketplaceListing.findUniqueOrThrow({
      where: { id: listingId },
    })
  }

  async unpauseListing(
    userId: string,
    _activePublisherId: string | null,
    listingId: string,
  ) {
    const listing = await this.assertPublisherOwnedListing(userId, listingId)
    if (listing.status !== ListingStatus.PAUSED) {
      throw new BadRequestException(
        `Only PAUSED listings can be unpaused (currently ${listing.status})`,
      )
    }
    const res = await this.prisma.marketplaceListing.updateMany({
      where: { id: listingId, status: ListingStatus.PAUSED },
      data: { status: ListingStatus.APPROVED },
    })
    if (res.count === 0)
      throw new BadRequestException({
        code: "STATUS_CONFLICT",
        message: "Listing was modified — reload and retry.",
      })
    await this.createAuditLog(
      userId,
      listing.organizationId,
      "LISTING_UNPAUSED",
      listingId,
      { title: listing.title },
    )
    return this.prisma.marketplaceListing.findUniqueOrThrow({
      where: { id: listingId },
    })
  }

  async archiveListing(
    userId: string,
    _activePublisherId: string | null,
    listingId: string,
  ) {
    const listing = await this.assertPublisherOwnedListing(userId, listingId)
    if (listing.status === ListingStatus.ARCHIVED) {
      throw new BadRequestException("Listing is already archived")
    }
    const res = await this.prisma.marketplaceListing.updateMany({
      where: { id: listingId, status: listing.status },
      data: { status: ListingStatus.ARCHIVED },
    })
    if (res.count === 0)
      throw new BadRequestException({
        code: "STATUS_CONFLICT",
        message: "Listing was modified — reload and retry.",
      })
    await this.createAuditLog(
      userId,
      listing.organizationId,
      "LISTING_ARCHIVED",
      listingId,
      { title: listing.title, fromStatus: listing.status },
    )
    return this.prisma.marketplaceListing.findUniqueOrThrow({
      where: { id: listingId },
    })
  }

  // Shared ownership + load helper for the four transitions above. Loads
  // the website so submit can check VERIFIED without a second query.
  private async assertPublisherOwnedListing(userId: string, listingId: string) {
    const listing = await this.prisma.marketplaceListing.findUnique({
      where: { id: listingId },
      include: {
        website: { select: { verificationStatus: true, ownershipType: true } },
        categories: { select: { categoryId: true } },
      },
    })
    if (!listing) throw new NotFoundException("Listing not found")
    if (!listing.publisherId) {
      throw new ForbiddenException(
        "Platform listings use admin-side transitions, not publisher endpoints",
      )
    }
    const hasAccess = await this.verifyPublisherAccess(
      userId,
      listing.publisherId,
    )
    if (!hasAccess)
      throw new ForbiddenException("You don't have access to this listing")
    return listing
  }

  async deleteListing(
    userId: string,
    _activePublisherId: string | null,
    listingId: string,
  ) {
    const listing = await this.prisma.marketplaceListing.findUnique({
      where: { id: listingId },
    })

    if (!listing) {
      throw new NotFoundException("Listing not found")
    }
    if (!listing.publisherId) {
      throw new ForbiddenException("You don't have access to this listing")
    }
    const hasAccess = await this.verifyPublisherAccess(
      userId,
      listing.publisherId,
    )
    if (!hasAccess) {
      throw new ForbiddenException("You don't have access to this listing")
    }

    await this.prisma.marketplaceListing.update({
      where: { id: listingId },
      data: { status: ListingStatus.ARCHIVED },
    })

    await this.createAuditLog(
      userId,
      listing.organizationId,
      "LISTING_DELETED",
      listingId,
      { title: listing.title },
    )
  }

  // =============================================================================
  // CATEGORIES & TAGS
  // =============================================================================

  async getCategories() {
    return this.prisma.marketplaceCategory.findMany({
      where: { isActive: true, parentId: null },
      include: {
        children: { where: { isActive: true }, orderBy: { sortOrder: "asc" } },
      },
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
    const listing = await this.prisma.marketplaceListing.findUnique({
      where: { id: dto.listingId },
    })
    if (!listing) {
      throw new NotFoundException("Listing not found")
    }

    const listingPublisherId = listing.publisherId
    if (!listingPublisherId) {
      throw new BadRequestException("Listing has no publisher")
    }

    // Prevent self-review: publisher cannot review own listing
    const publisherMembership = await this.prisma.publisherMembership.findFirst(
      {
        where: { userId, publisherId: listingPublisherId },
      },
    )
    if (publisherMembership) {
      throw new ForbiddenException("You cannot review your own listing")
    }

    // Verify customer completed an order with this publisher. SETTLED is the
    // actual terminal status (release keeps the order at SETTLED; nothing
    // sets COMPLETED today) — gating on COMPLETED alone made reviews
    // impossible for everyone.
    const completedOrder = await this.prisma.order.findFirst({
      where: {
        customerId: userId,
        website: { publisherId: listingPublisherId },
        status: { in: ["COMPLETED", "SETTLED", "DELIVERED"] },
      },
    })
    if (!completedOrder) {
      throw new ForbiddenException(
        "You must complete an order before reviewing",
      )
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
    const favorites = await this.prisma.marketplaceFavorite.findMany({
      where: { userId },
      include: {
        listing: {
          include: {
            categories: { include: { category: true } },
            images: { where: { isPrimary: true }, take: 1 },
            tags: { include: { tag: true } },
            // Phase 7.12 (#20): include services so the favorites page can
            // compute price-from-services. The listing-level `price` column
            // was dropped in Phase 7; without `services` the page falls
            // back to $0 for every entry. Filter out PAUSED (soft-disabled
            // by the publisher, kept for historical-order linkage —
            // shouldn't surface as a current price option). Strongly typed
            // via the Prisma enum so a future rename fails tsc instead of
            // silently letting rows through.
            services: {
              where: { availability: { not: ServiceAvailability.PAUSED } },
              orderBy: { price: "asc" },
              select: {
                id: true,
                serviceType: true,
                price: true,
                currency: true,
                availability: true,
                turnaroundDays: true,
              },
            },
          },
        },
      },
    })
    return favorites.map((favorite) => ({
      ...favorite,
      listing: this.withCategoryProjection(favorite.listing),
    }))
  }

  async addFavorite(
    userId: string,
    listingId: string,
    serviceType: ServiceType | null = null,
  ) {
    const listing = await this.prisma.marketplaceListing.findUnique({
      where: { id: listingId },
    })
    if (!listing) {
      throw new NotFoundException("Listing not found")
    }

    // Phase 7.12 (#17): if a non-NULL serviceType is supplied, verify the
    // service exists on the listing AND isn't paused. PAUSED services
    // never transition WAITLIST → AVAILABLE (the publisher took them down,
    // they only stay around for historical-order linkage per
    // pauseServiceOnListing's comment), so a favorite scoped to a paused
    // service is a dead-write — the WAITLIST fan-out would never fire for
    // it. Reject up-front instead of writing a useless row.
    if (serviceType !== null) {
      const service = await this.prisma.listingService.findFirst({
        where: {
          listingId,
          serviceType,
          availability: { not: ServiceAvailability.PAUSED },
        },
      })
      if (!service) {
        throw new NotFoundException(
          `Service ${serviceType} not found on this listing`,
        )
      }
    }

    // Phase 7.13.2A: race-proofed via the NULLS NOT DISTINCT unique
    // (MarketplaceFavorite_uniq_nullsnotdistinct). Try the create; if
    // a concurrent request beat us to the same (userId, listingId,
    // serviceType) row, the DB rejects with P2002 — we re-fetch the
    // winning row and return it (Plan B; Gate 0.5 ruled out Plan A
    // because Prisma 7's WhereUniqueInput validator rejects `null`
    // for nullable composite-key parts before any SQL is emitted).
    let favorite
    try {
      favorite = await this.prisma.marketplaceFavorite.create({
        data: { userId, listingId, serviceType },
      })
    } catch (e: any) {
      if (e?.code === "P2002") {
        const existing = await this.prisma.marketplaceFavorite.findFirst({
          where: { userId, listingId, serviceType },
        })
        if (!existing) throw e
        favorite = existing
      } else {
        throw e
      }
    }

    // Track click
    await this.prisma.marketplaceListingClick.create({
      data: { listingId, userId, action: "favorite" },
    })

    return favorite
  }

  async removeFavorite(userId: string, listingId: string) {
    // Phase 7.12 (#16): scope to the NULL-serviceType row only. The
    // previous unscoped deleteMany silently destroyed any service-scoped
    // WAITLIST notify-me favorites for the same listing — meaning a
    // customer who un-starred the whole listing lost their service-
    // specific subscriptions too. Service-scoped removal goes through
    // removeFavoriteService below.
    await this.prisma.marketplaceFavorite.deleteMany({
      where: { userId, listingId, serviceType: null },
    })
  }

  async removeFavoriteService(
    userId: string,
    listingId: string,
    serviceType: ServiceType,
  ) {
    // Phase 7.12 (#16 sibling): scoped removal for service-specific
    // (WAITLIST notify-me) favorites. Mirrors removeFavorite but for the
    // serviceType-scoped rows that the new addFavorite(serviceType) path
    // creates.
    await this.prisma.marketplaceFavorite.deleteMany({
      where: { userId, listingId, serviceType },
    })
  }

  // =============================================================================
  // SAVED LISTS
  // =============================================================================

  async getSavedLists(userId: string) {
    const lists = await this.prisma.marketplaceSavedList.findMany({
      where: { userId },
      include: {
        items: {
          include: {
            listing: {
              include: {
                categories: { include: { category: true } },
                images: { where: { isPrimary: true }, take: 1 },
              },
            },
          },
          orderBy: { addedAt: "desc" },
        },
      },
    })
    return lists.map((list) => ({
      ...list,
      items: list.items.map((item) => ({
        ...item,
        listing: this.withCategoryProjection(item.listing),
      })),
    }))
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
    const list = await this.prisma.marketplaceSavedList.findUnique({
      where: { id: listId },
    })
    if (!list || list.userId !== userId) {
      throw new NotFoundException("List not found")
    }

    const listing = await this.prisma.marketplaceListing.findUnique({
      where: { id: dto.listingId },
    })
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
    const list = await this.prisma.marketplaceSavedList.findUnique({
      where: { id: listId },
    })
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
    // Phase 7: "internal services" used to filter on the deprecated
    // ListingType column. Now: any APPROVED listing with INTERNAL
    // fulfillment that offers ≥1 AVAILABLE service qualifies — the
    // listing-level `type` is gone.
    const listings = await this.prisma.marketplaceListing.findMany({
      where: {
        status: ListingStatus.APPROVED,
        fulfillmentType: "INTERNAL",
        services: { some: { availability: "AVAILABLE" } },
      },
      include: {
        categories: { include: { category: true } },
        images: { where: { isPrimary: true }, take: 1 },
        services: { where: { availability: "AVAILABLE" } },
      },
      orderBy: { featured: "desc" },
    })
    return listings.map((listing) => this.withCategoryProjection(listing))
  }

  // =============================================================================
  // PUBLISHER LISTINGS
  // =============================================================================

  async getPublisherListings(
    publisherId: string,
    userId?: string,
    search?: string,
  ) {
    const hasAccess = userId
      ? await this.verifyPublisherAccess(userId, publisherId)
      : false

    const where: any = {
      publisherId,
      status: hasAccess ? undefined : ListingStatus.APPROVED,
    }

    // Search across listing title, description, and website domain.
    if (search) {
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
        { website: { domain: { contains: search, mode: "insensitive" } } },
      ]
    }

    const listings = await this.prisma.marketplaceListing.findMany({
      where,
      include: {
        categories: { include: { category: true } },
        images: { where: { isPrimary: true }, take: 1 },
        tags: { include: { tag: true } },
        reviews: { where: { status: "APPROVED" }, select: { rating: true } },
        publisher: { include: { profile: true } },
        website: {
          select: {
            verificationStatus: true,
            verifiedAt: true,
            domain: true,
            url: true,
          },
        },
        services: {
          orderBy: [{ availability: "asc" }, { price: "asc" }],
        },
      },
      orderBy: { createdAt: "desc" },
    })

    // Sort: active (non-ARCHIVED) listings first, ARCHIVED at the bottom.
    listings.sort((a, b) => {
      const aArchived = a.status === ListingStatus.ARCHIVED ? 1 : 0
      const bArchived = b.status === ListingStatus.ARCHIVED ? 1 : 0
      if (aArchived !== bArchived) return aArchived - bArchived
      return b.createdAt.getTime() - a.createdAt.getTime()
    })

    return listings.map((l) =>
      this.toPublicListing({
        ...l,
        tags: l.tags.map((t) => t.tag),
        image: l.images[0]?.url ?? null,
        reviewCount: l.reviews.length,
        avgRating:
          l.reviews.length > 0
            ? l.reviews.reduce((sum, r) => sum + r.rating, 0) / l.reviews.length
            : null,
      }),
    )
  }

  // =============================================================================
  // RECOMMENDATIONS (AI Layer Abstraction)
  // =============================================================================

  async getRecommendations(userId: string, dto: GetRecommendationsDto) {
    const { listingId, type = "recommended", limit = 10 } = dto

    // Try to get AI recommendations first
    const recommendations =
      await this.prisma.marketplaceRecommendation.findMany({
        where: { userId, type },
        orderBy: { score: "desc" },
        take: limit,
      })

    if (recommendations.length > 0) {
      // Fetch listings separately since relation isn't defined in schema
      const listingIds = recommendations.map((r) => r.listingId)
      const listings = await this.prisma.marketplaceListing.findMany({
        where: { id: { in: listingIds } },
        include: {
          categories: { include: { category: true } },
          images: { where: { isPrimary: true }, take: 1 },
          tags: { include: { tag: true } },
        },
      })

      const listingMap = new Map(listings.map((l) => [l.id, l]))

      return recommendations
        .map((r) => {
          const listing = listingMap.get(r.listingId)
          if (!listing) return null
          return {
            ...this.withCategoryProjection(listing),
            tags: listing.tags.map((t: any) => t.tag),
            image: listing.images[0]?.url || null,
            recommendationScore: r.score,
            recommendationReason: r.reason,
          }
        })
        .filter(Boolean)
    }

    // Fallback to rule-based recommendations
    return this.getRuleBasedRecommendations(listingId, type, limit)
  }

  private async getRuleBasedRecommendations(
    listingId?: string,
    _type?: string,
    limit = 10,
  ) {
    if (listingId) {
      // Phase 7: pull the offered serviceTypes off the source listing's
      // child services so we can match recommendations on service overlap
      // instead of the deprecated listing-level `type` column.
      const listing = await this.prisma.marketplaceListing.findUnique({
        where: { id: listingId },
        include: {
          categories: { select: { categoryId: true } },
          services: {
            where: { availability: "AVAILABLE" },
            select: { serviceType: true },
          },
        },
      })
      if (!listing) return []
      const ownServiceTypes = listing.services.map((s) => s.serviceType)
      const ownCategoryIds = listing.categories.map((item) => item.categoryId)

      const recommendations = await this.prisma.marketplaceListing.findMany({
        where: {
          id: { not: listingId },
          status: ListingStatus.APPROVED,
          OR: [
            ...(ownCategoryIds.length > 0
              ? [
                  {
                    categories: {
                      some: { categoryId: { in: ownCategoryIds } },
                    },
                  },
                ]
              : []),
            ...(ownServiceTypes.length > 0
              ? [
                  {
                    services: {
                      some: {
                        availability: "AVAILABLE" as const,
                        serviceType: { in: ownServiceTypes },
                      },
                    },
                  },
                ]
              : []),
            { publisherId: listing.publisherId },
          ],
        },
        include: {
          categories: { include: { category: true } },
          images: { where: { isPrimary: true }, take: 1 },
          tags: { include: { tag: true } },
        },
        take: limit,
        orderBy: { traffic: "desc" },
      })

      return recommendations.map((recommendation) => ({
        ...this.withCategoryProjection(recommendation),
        tags: recommendation.tags.map((tag) => tag.tag),
        image: recommendation.images[0]?.url || null,
      }))
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
        id: { in: trendingIds.map((t) => t.listingId) },
        status: ListingStatus.APPROVED,
      },
      include: {
        categories: { include: { category: true } },
        images: { where: { isPrimary: true }, take: 1 },
        tags: { include: { tag: true } },
      },
    })

    // Maintain trending order
    return trendingIds
      .map((t) => {
        const listing = listings.find((l) => l.id === t.listingId)
        if (!listing) return null
        return {
          ...this.withCategoryProjection(listing),
          tags: listing.tags.map((tag) => tag.tag),
          image: listing.images[0]?.url || null,
        }
      })
      .filter(Boolean)
  }

  // =============================================================================
  // ANALYTICS
  // =============================================================================

  async getMarketplaceStats() {
    const [
      totalListings,
      activeListings,
      totalReviews,
      avgRating,
      totalServices,
      activeServices,
      servicesByTypeRaw,
    ] = await Promise.all([
      this.prisma.marketplaceListing.count(),
      this.prisma.marketplaceListing.count({
        where: { status: ListingStatus.APPROVED },
      }),
      this.prisma.marketplaceReview.count({ where: { status: "APPROVED" } }),
      this.prisma.marketplaceReview.aggregate({
        _avg: { rating: true },
        where: { status: "APPROVED" },
      }),
      // Phase 6: surface service-level cardinality. A listing with 3
      // services counts as 1 above but 3 here, so per-service revenue
      // dashboards have a denominator that matches the buyer-side
      // inventory shape.
      this.prisma.listingService.count(),
      this.prisma.listingService.count({
        where: { availability: "AVAILABLE" },
      }),
      this.prisma.listingService.groupBy({
        by: ["serviceType"],
        where: { availability: "AVAILABLE" },
        _count: { id: true },
        _avg: { price: true },
      }),
    ])

    const topCategories = await this.prisma.marketplaceListingCategory.groupBy({
      by: ["categoryId"],
      where: { listing: { status: ListingStatus.APPROVED } },
      _count: { listingId: true },
      orderBy: { _count: { listingId: "desc" } },
      take: 5,
    })

    const categoryData = await Promise.all(
      topCategories.map(async (c) => {
        const category = await this.prisma.marketplaceCategory.findUnique({
          where: { id: c.categoryId },
        })
        return { category, count: c._count.listingId }
      }),
    )

    return {
      totalListings,
      activeListings,
      totalReviews,
      avgRating: avgRating._avg.rating || 0,
      topCategories: categoryData,
      // Phase 6: per-service breakdown.
      totalServices,
      activeServices,
      servicesByType: servicesByTypeRaw.map((s) => ({
        serviceType: s.serviceType,
        count: s._count.id,
        avgPrice: s._avg.price !== null ? Number(s._avg.price) : null,
      })),
    }
  }

  // =============================================================================
  // HELPER METHODS
  // =============================================================================

  private async verifyPublisherAccess(
    userId: string,
    publisherId: string,
  ): Promise<boolean> {
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
    metadata?: any,
  ) {
    await this.prisma.auditLog.create({
      data: {
        action,
        entityType: "MARKETPLACE_LISTING",
        entityId,
        metadata,
        userId,
        organizationId: organizationId ?? null,
      },
    })
  }
}
