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
import { ListingStatus, ServiceType, Prisma } from "@guestpost/database"
import { slugify } from "../../common/utils/slugify"
import { ListingServiceInput, UpdateListingServiceInput } from "./dto/marketplace.dto"
import { computeListingPhase, QUEUES } from "@guestpost/shared"
import { QueueService } from "../queues/queue.service"

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
      organizationId, publisherId, semrushData, metricsData, trafficData,
      publisher, ownerType, services, website, status, ...rest
    } = listing

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
    const priceFrom = availableServices.length > 0
      ? Math.min(...availableServices.map((s: any) => Number(s.price)))
      : null
    const serviceTypes = Array.from(new Set(availableServices.map((s: any) => s.serviceType)))

    return {
      ...rest,
      status,
      lifecyclePhase,
      priceFrom,
      serviceTypes,
      // Listing-level attribution: PLATFORM-owned listings render as
      // "Listed by GuestPost.cc"; PUBLISHER-owned expose the publisher card.
      ownerType,
      attribution: ownerType === "PLATFORM"
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
      publisher: ownerType === "PLATFORM" ? null : (publisher
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
        : null),
    }
  }

  // Public projection of a ListingService row. fulfillmentSettings is internal
  // (autoAccept, internalSlaHours, …) and must never leave the API surface.
  private toPublicListingService(service: any) {
    const { fulfillmentSettings, ...rest } = service
    return rest
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
      services: listing.services.map(s => this.toPublicListingService(s)),
    }
  }

  // =============================================================================
  // LISTING CRUD
  // =============================================================================

  async searchListings(dto: SearchListingsDto) {
    const { query, category, type, tags, country, language, minPrice, maxPrice, minDR, maxDR, minTraffic, maxTurnaroundDays, sortBy, page = 1, limit = 20, ownershipType } = dto

    const where: any = {
      status: ListingStatus.APPROVED,
    }

    if (category) {
      where.category = { slug: category }
    }

    if (ownershipType) {
      where.website = { ownershipType: ownershipType as any }
    }

    if (country) {
      where.country = country
    }

    if (language) {
      where.language = language
    }

    // ── Phase 6 service-level filtering ──────────────────────────────────
    // The customer's price / TAT / serviceType picker keys off
    // ListingService rows, not the listing-level legacy columns. We require
    // at least ONE matching AVAILABLE service per returned listing — that
    // also excludes listings whose services are entirely paused/waitlisted.
    const serviceFilter: any = { availability: "AVAILABLE" }
    if (type)                                                    serviceFilter.serviceType = type
    if (minPrice !== undefined || maxPrice !== undefined) {
      serviceFilter.price = {}
      if (minPrice !== undefined) serviceFilter.price.gte = minPrice
      if (maxPrice !== undefined) serviceFilter.price.lte = maxPrice
    }
    if (maxTurnaroundDays !== undefined) serviceFilter.turnaroundDays = { lte: maxTurnaroundDays }
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
        // Phase 6: sorts by the (legacy) listing-level price for now —
        // sorting on min(ListingService.price WHERE AVAILABLE) requires a
        // $queryRaw subquery. Tracked as a follow-up; the per-service price
        // is still rendered on the card via `priceFrom` in the projection.
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
          // Card view: surface only AVAILABLE services so listing cards can
          // show "from $X" / service chips without leaking paused/waitlist.
          services: {
            where: { availability: "AVAILABLE" },
            orderBy: { price: "asc" },
          },
        },
      }),
      this.prisma.marketplaceListing.count({ where }),
    ])

    const listingsWithStats = listings.map(listing => {
      const avgRating = listing.reviews.length > 0
        ? listing.reviews.reduce((sum, r) => sum + r.rating, 0) / listing.reviews.length
        : null
      return this.toPublicListing({
        ...listing,
        tags: listing.tags.map(t => t.tag),
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

  // Staff preview — fetch a listing by slug in ANY status (pending/draft/
  // rejected/paused/archived) for moderation. No public status gate, no view
  // tracking. Authorization is enforced by the StaffRoles guard on the route.
  async getListingForStaff(slug: string) {
    const listing = await this.prisma.marketplaceListing.findUnique({
      where: { slug },
      include: {
        category: true,
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
    return { ...listing, relatedListings: [] }
  }

  async getListing(slug: string, userId?: string) {
    const listing = await this.prisma.marketplaceListing.findUnique({
      where: { slug },
      include: {
        category: true,
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

    // Phase 7: "related" used to match on the deprecated listing-level
    // `type` column. Match on service overlap instead — any listing that
    // offers at least one of THIS listing's AVAILABLE serviceTypes counts.
    const ownServiceTypes = (listing.services ?? [])
      .filter((s: any) => s.availability === "AVAILABLE")
      .map((s: any) => s.serviceType)
    const relatedListings = await this.prisma.marketplaceListing.findMany({
      where: {
        id: { not: listing.id },
        status: ListingStatus.APPROVED,
        OR: [
          { categoryId: listing.categoryId },
          ...(ownServiceTypes.length > 0
            ? [{ services: { some: { availability: "AVAILABLE" as const, serviceType: { in: ownServiceTypes } } } }]
            : []),
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
        tags: listing.tags.map(t => t.tag),
        avgRating,
        reviewCount: listing.reviews.length,
        isFavorited,
      }),
      relatedListings: relatedListings.map(l => this.toPublicListing({
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

  // Staff-created platform-owned listing: no publisher, INTERNAL fulfillment,
  // tied to a PLATFORM-owned website (or no website for a pure service). The
  // platform fulfills these directly. Kept strictly separate from publisher
  // listings — a platform listing must never carry a publisherId (settlement
  // routing branches on website.ownershipType), and a publisher must never be
  // able to reach this path (admin-guarded route).
  async createPlatformListing(userId: string, dto: CreateListingDto & { websiteId?: string }) {
    const slug = slugify(dto.title)
    const existing = await this.prisma.marketplaceListing.findUnique({ where: { slug } })
    if (existing) throw new BadRequestException("A listing with this title already exists")

    let websiteId: string | null = null
    if (dto.websiteId) {
      const website = await this.prisma.website.findUnique({ where: { id: dto.websiteId } })
      if (!website) throw new NotFoundException("Website not found")
      // Reject publisher-owned sites — those belong to the publisher's own
      // listing flow; a platform listing on a publisher site would corrupt
      // settlement ownership.
      if (website.ownershipType !== "PLATFORM") {
        throw new BadRequestException("Platform listings can only be attached to platform-owned websites")
      }
      websiteId = website.id
    }

    const data: any = { ...dto }
    delete data.tags
    delete data.websiteId
    delete data.publisherId
    delete data.organizationId
    delete data.services

    // Materialize ListingService rows alongside the listing — either from the
    // new services[] shape or the legacy single-service shim.
    const services = this.resolveServicesInput(dto)

    const listing = await this.prisma.marketplaceListing.create({
      data: {
        ...data,
        slug,
        websiteId,
        publisherId: null,
        organizationId: null,
        ownerType: "PLATFORM",
        fulfillmentType: "INTERNAL",
        status: dto.status || ListingStatus.PENDING_REVIEW,
        tags: dto.tags ? { create: dto.tags.map((tagId) => ({ tag: { connect: { id: tagId } } })) } : undefined,
        services: this.listingServicesCreateMany(services),
      },
      include: { category: true, tags: { include: { tag: true } }, services: true },
    })

    await this.createAuditLog(userId, null, "PLATFORM_LISTING_CREATED", listing.id, {
      title: listing.title,
      websiteId,
      // Phase 7: audit the actual offered serviceTypes (snapshot) rather
      // than the deprecated listing-level `type` column.
      serviceTypes: (services ?? []).map(s => s.serviceType),
      serviceCount: services?.length ?? 0,
    })

    return listing
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
    delete data.services

    const services = this.resolveServicesInput(dto)

    const listing = await this.prisma.marketplaceListing.create({
      data: {
        ...data,
        slug,
        publisherId,
        organizationId: publisher.organizationId,
        ownerType: "PUBLISHER",
        status: dto.status || ListingStatus.DRAFT,
        tags: dto.tags ? {
          create: dto.tags.map(tagId => ({ tag: { connect: { id: tagId } } }))
        } : undefined,
        services: this.listingServicesCreateMany(services),
      },
      include: {
        category: true,
        tags: { include: { tag: true } },
        services: true,
      },
    })

    await this.createAuditLog(userId, publisher.organizationId, "LISTING_CREATED", listing.id, {
      title: listing.title,
      serviceCount: services?.length ?? 0,
    })

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

    // Block edits on a revoked domain — ownership must be re-verified first.
    if (listing.websiteId) {
      const site = await this.prisma.website.findUnique({ where: { id: listing.websiteId }, select: { verificationStatus: true, ownershipType: true } })
      if (site?.ownershipType === "PUBLISHER" && site.verificationStatus === "REVOKED") {
        throw new BadRequestException({ code: "WEBSITE_REVOKED", message: "Cannot edit listing: domain ownership is revoked. Re-verify the domain first." })
      }
    }

    const updateData: any = { ...dto }
    delete updateData.tags
    // Ownership fields cannot be reassigned via update
    delete updateData.publisherId
    delete updateData.organizationId
    // Service-menu changes go through the dedicated per-service endpoints
    // (POST/PATCH/DELETE /listings/:id/services/[:serviceId]) — accepting
    // a bulk replace here would let a stale tab silently delete rows that
    // historical orders still reference.
    delete updateData.services

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
        throw new BadRequestException(`Duplicate service ${s.serviceType} in listing`)
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
      create: services.map(s => ({
        serviceType:    s.serviceType,
        price:          new Prisma.Decimal(s.price),
        currency:       s.currency ?? "USD",
        turnaroundDays: s.turnaroundDays,
        revisionRounds: s.revisionRounds ?? 2,
        warrantyDays:   s.warrantyDays,
        requirements:   s.requirements as Prisma.InputJsonValue | undefined,
        fulfillmentSettings: s.fulfillmentSettings as Prisma.InputJsonValue | undefined,
        availability:   s.availability ?? "AVAILABLE",
      })),
    }
  }

  // ── ListingService CRUD ────────────────────────────────────────────────
  // Per-service endpoints used by the Publisher + Admin Services tab. The
  // listing's parent ownership check (publisherId membership for publisher,
  // staff guard for platform) is enforced by the controller; this method
  // does the listing-level access check + version-guarded write.

  async addServiceToListing(
    actor: { userId: string; activePublisherId?: string | null; isStaff?: boolean },
    listingId: string,
    input: ListingServiceInput,
  ) {
    const listing = await this.prisma.marketplaceListing.findUnique({
      where: { id: listingId },
      select: { id: true, publisherId: true, organizationId: true, ownerType: true, websiteId: true },
    })
    if (!listing) throw new NotFoundException("Listing not found")
    await this.assertListingWriteAccess(actor, listing)

    try {
      const created = await this.prisma.listingService.create({
        data: {
          listingId,
          serviceType:    input.serviceType,
          price:          new Prisma.Decimal(input.price),
          currency:       input.currency ?? "USD",
          turnaroundDays: input.turnaroundDays,
          revisionRounds: input.revisionRounds ?? 2,
          warrantyDays:   input.warrantyDays,
          requirements:   input.requirements as Prisma.InputJsonValue | undefined,
          fulfillmentSettings: input.fulfillmentSettings as Prisma.InputJsonValue | undefined,
          availability:   input.availability ?? "AVAILABLE",
        },
      })
      await this.createAuditLog(actor.userId, listing.organizationId, "LISTING_SERVICE_ADDED", created.id, {
        listingId,
        serviceType: created.serviceType,
        price: created.price.toString(),
      })
      return created
    } catch (e: any) {
      if (e?.code === "P2002") {
        throw new BadRequestException(`Service ${input.serviceType} already exists on this listing`)
      }
      throw e
    }
  }

  async updateServiceOnListing(
    actor: { userId: string; activePublisherId?: string | null; isStaff?: boolean },
    listingId: string,
    serviceId: string,
    input: UpdateListingServiceInput,
  ) {
    const service = await this.prisma.listingService.findUnique({
      where: { id: serviceId },
      include: { listing: { select: { id: true, publisherId: true, organizationId: true, ownerType: true } } },
    })
    if (!service || service.listingId !== listingId) {
      throw new NotFoundException("Service not found on this listing")
    }
    await this.assertListingWriteAccess(actor, service.listing)

    // Version-guarded update — concurrent edits or a stale tab cannot silently
    // overwrite each other. The optimistic lock matches the pattern used
    // throughout orders/settlements.
    const updateData: Prisma.ListingServiceUncheckedUpdateInput = { version: { increment: 1 } }
    if (input.price          !== undefined) updateData.price          = new Prisma.Decimal(input.price)
    if (input.currency       !== undefined) updateData.currency       = input.currency
    if (input.turnaroundDays !== undefined) updateData.turnaroundDays = input.turnaroundDays
    if (input.revisionRounds !== undefined) updateData.revisionRounds = input.revisionRounds
    if (input.warrantyDays   !== undefined) updateData.warrantyDays   = input.warrantyDays
    if (input.requirements   !== undefined) updateData.requirements   = input.requirements as Prisma.InputJsonValue
    if (input.fulfillmentSettings !== undefined) updateData.fulfillmentSettings = input.fulfillmentSettings as Prisma.InputJsonValue
    if (input.availability   !== undefined) updateData.availability   = input.availability

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

    const updated = await this.prisma.listingService.findUnique({ where: { id: serviceId } })
    await this.createAuditLog(actor.userId, service.listing.organizationId, "LISTING_SERVICE_UPDATED", serviceId, {
      listingId,
      changes: Object.keys(input).filter(k => k !== "version"),
    })

    // ── Phase 6: waitlist → available fan-out ────────────────────────────
    // Notifies every user with a MarketplaceFavorite scoped to this
    // (listingId, serviceType) plus those who favorited the whole listing
    // (serviceType=NULL). Fire-and-forget via the existing notification
    // queue — no new processor needed since the recipient set is small.
    // Sites toggling rapidly aren't a real concern (this is a publisher-
    // initiated edit, not a system-driven flap), so we don't rate-limit.
    if (service.availability === "WAITLIST" && input.availability === "AVAILABLE") {
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
      await this.createAuditLog(actor.userId, service.listing.organizationId, "LISTING_SERVICE_WAITLIST_RELEASED", serviceId, {
        listingId,
        serviceType: service.serviceType,
        notifiedCount: favorites.length,
      })
    }

    return updated
  }

  // Soft-disable rather than hard-delete: a paused row stays linked to any
  // historical Order that snapshotted its id, so order detail can still
  // resolve listingService.* fields. Removing the row would orphan those.
  async pauseServiceOnListing(
    actor: { userId: string; activePublisherId?: string | null; isStaff?: boolean },
    listingId: string,
    serviceId: string,
  ) {
    return this.updateServiceOnListing(actor, listingId, serviceId, {
      availability: "PAUSED",
      version: (await this.prisma.listingService.findUnique({ where: { id: serviceId }, select: { version: true } }))?.version ?? 0,
    })
  }

  // Listing write access: publisher path uses the existing membership check,
  // platform path requires a staff actor (route guard already enforces it).
  private async assertListingWriteAccess(
    actor: { userId: string; activePublisherId?: string | null; isStaff?: boolean },
    listing: { publisherId: string | null; ownerType?: "PUBLISHER" | "PLATFORM" | null },
  ) {
    if (actor.isStaff) return
    if (!listing.publisherId) {
      throw new ForbiddenException("Only platform staff can edit this listing's services")
    }
    const hasAccess = await this.verifyPublisherAccess(actor.userId, listing.publisherId)
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

  async submitListingForReview(userId: string, activePublisherId: string | null, listingId: string) {
    const listing = await this.assertPublisherOwnedListing(userId, listingId)

    if (listing.status !== ListingStatus.DRAFT) {
      throw new BadRequestException(`Listing must be DRAFT to submit (currently ${listing.status})`)
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
        message: "Add at least one available service before submitting for review.",
      })
    }

    const res = await this.prisma.marketplaceListing.updateMany({
      where: { id: listingId, status: ListingStatus.DRAFT },
      data:  { status: ListingStatus.PENDING_REVIEW },
    })
    if (res.count === 0) {
      throw new BadRequestException({ code: "STATUS_CONFLICT", message: "Listing was modified — reload and retry." })
    }

    await this.createAuditLog(userId, listing.organizationId, "LISTING_SUBMITTED_FOR_REVIEW", listingId, {
      title: listing.title,
      websiteId: listing.websiteId,
    })

    return this.prisma.marketplaceListing.findUniqueOrThrow({ where: { id: listingId } })
  }

  async pauseListing(userId: string, activePublisherId: string | null, listingId: string) {
    const listing = await this.assertPublisherOwnedListing(userId, listingId)
    if (listing.status !== ListingStatus.APPROVED) {
      throw new BadRequestException(`Only APPROVED listings can be paused (currently ${listing.status})`)
    }
    const res = await this.prisma.marketplaceListing.updateMany({
      where: { id: listingId, status: ListingStatus.APPROVED },
      data:  { status: ListingStatus.PAUSED },
    })
    if (res.count === 0) throw new BadRequestException({ code: "STATUS_CONFLICT", message: "Listing was modified — reload and retry." })
    await this.createAuditLog(userId, listing.organizationId, "LISTING_PAUSED", listingId, { title: listing.title })
    return this.prisma.marketplaceListing.findUniqueOrThrow({ where: { id: listingId } })
  }

  async unpauseListing(userId: string, activePublisherId: string | null, listingId: string) {
    const listing = await this.assertPublisherOwnedListing(userId, listingId)
    if (listing.status !== ListingStatus.PAUSED) {
      throw new BadRequestException(`Only PAUSED listings can be unpaused (currently ${listing.status})`)
    }
    const res = await this.prisma.marketplaceListing.updateMany({
      where: { id: listingId, status: ListingStatus.PAUSED },
      data:  { status: ListingStatus.APPROVED },
    })
    if (res.count === 0) throw new BadRequestException({ code: "STATUS_CONFLICT", message: "Listing was modified — reload and retry." })
    await this.createAuditLog(userId, listing.organizationId, "LISTING_UNPAUSED", listingId, { title: listing.title })
    return this.prisma.marketplaceListing.findUniqueOrThrow({ where: { id: listingId } })
  }

  async archiveListing(userId: string, activePublisherId: string | null, listingId: string) {
    const listing = await this.assertPublisherOwnedListing(userId, listingId)
    if (listing.status === ListingStatus.ARCHIVED) {
      throw new BadRequestException("Listing is already archived")
    }
    const res = await this.prisma.marketplaceListing.updateMany({
      where: { id: listingId, status: listing.status },
      data:  { status: ListingStatus.ARCHIVED },
    })
    if (res.count === 0) throw new BadRequestException({ code: "STATUS_CONFLICT", message: "Listing was modified — reload and retry." })
    await this.createAuditLog(userId, listing.organizationId, "LISTING_ARCHIVED", listingId, { title: listing.title, fromStatus: listing.status })
    return this.prisma.marketplaceListing.findUniqueOrThrow({ where: { id: listingId } })
  }

  // Shared ownership + load helper for the four transitions above. Loads
  // the website so submit can check VERIFIED without a second query.
  private async assertPublisherOwnedListing(userId: string, listingId: string) {
    const listing = await this.prisma.marketplaceListing.findUnique({
      where: { id: listingId },
      include: { website: { select: { verificationStatus: true, ownershipType: true } } },
    })
    if (!listing) throw new NotFoundException("Listing not found")
    if (!listing.publisherId) {
      throw new ForbiddenException("Platform listings use admin-side transitions, not publisher endpoints")
    }
    const hasAccess = await this.verifyPublisherAccess(userId, listing.publisherId)
    if (!hasAccess) throw new ForbiddenException("You don't have access to this listing")
    return listing
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

    // Whole-listing favorite = serviceType NULL. Composite unique
    // (userId, listingId, serviceType) cannot identify NULL-serviceType rows
    // via Prisma's WhereUniqueInput (NULL ≠ NULL in SQL), so emulate upsert
    // with findFirst + conditional create.
    const existing = await this.prisma.marketplaceFavorite.findFirst({
      where: { userId, listingId, serviceType: null },
    })
    const favorite = existing ?? await this.prisma.marketplaceFavorite.create({
      data: { userId, listingId, serviceType: null },
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
    // Phase 7: "internal services" used to filter on the deprecated
    // ListingType column. Now: any APPROVED listing with INTERNAL
    // fulfillment that offers ≥1 AVAILABLE service qualifies — the
    // listing-level `type` is gone.
    return this.prisma.marketplaceListing.findMany({
      where: {
        status: ListingStatus.APPROVED,
        fulfillmentType: "INTERNAL",
        services: { some: { availability: "AVAILABLE" } },
      },
      include: {
        category: true,
        images: { where: { isPrimary: true }, take: 1 },
        services: { where: { availability: "AVAILABLE" } },
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
      // Phase 7: pull the offered serviceTypes off the source listing's
      // child services so we can match recommendations on service overlap
      // instead of the deprecated listing-level `type` column.
      const listing = await this.prisma.marketplaceListing.findUnique({
        where: { id: listingId },
        include: { services: { where: { availability: "AVAILABLE" }, select: { serviceType: true } } },
      })
      if (!listing) return []
      const ownServiceTypes = listing.services.map(s => s.serviceType)

      return this.prisma.marketplaceListing.findMany({
        where: {
          id: { not: listingId },
          status: ListingStatus.APPROVED,
          OR: [
            { categoryId: listing.categoryId },
            ...(ownServiceTypes.length > 0
              ? [{ services: { some: { availability: "AVAILABLE" as const, serviceType: { in: ownServiceTypes } } } }]
              : []),
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
    const [totalListings, activeListings, totalReviews, avgRating,
           totalServices, activeServices, servicesByTypeRaw] = await Promise.all([
      this.prisma.marketplaceListing.count(),
      this.prisma.marketplaceListing.count({ where: { status: ListingStatus.APPROVED } }),
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
      this.prisma.listingService.count({ where: { availability: "AVAILABLE" } }),
      this.prisma.listingService.groupBy({
        by: ["serviceType"],
        where: { availability: "AVAILABLE" },
        _count: { id: true },
        _avg: { price: true },
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
      // Phase 6: per-service breakdown.
      totalServices,
      activeServices,
      servicesByType: servicesByTypeRaw.map(s => ({
        serviceType: s.serviceType,
        count: s._count.id,
        avgPrice: s._avg.price !== null ? Number(s._avg.price) : null,
      })),
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
        organizationId: organizationId ?? null,
      },
    })
  }
}