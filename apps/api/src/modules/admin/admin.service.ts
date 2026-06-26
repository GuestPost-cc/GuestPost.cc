import {
  ListingStatus,
  WebsiteOwnershipType,
  WebsiteVerificationStatus,
} from "@guestpost/database"
import { StaffRole } from "@guestpost/shared"
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { invalidateAuthContext } from "../../common/auth-context-cache"
import { normalizeDomain } from "../../common/domain"
import { PrismaService } from "../../common/prisma.service"
import { AuditService } from "../audit/audit.service"
import { RefundService } from "../orders/services/refund.service"
import { QueueService } from "../queues/queue.service"

const VALID_STAFF_ROLES: StaffRole[] = ["SUPER_ADMIN", "OPERATIONS", "FINANCE"]

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
    private readonly refund: RefundService,
  ) {}

  async listUsers(take = 50, skip = 0, _user?: any) {
    const users = await this.prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      take,
      skip,
      include: {
        memberships: true,
        publisherMemberships: true,
        staffMemberships: true,
      },
    })
    return users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      userType: u.userType,
      customerRole: u.memberships[0]?.role ?? null,
      publisherRole: u.publisherMemberships[0]?.role ?? null,
      staffRole: u.staffMemberships?.[0]?.role ?? null,
      banned: u.banned,
      createdAt: u.createdAt,
    }))
  }

  async getUser(id: string, _user?: any) {
    const u = await this.prisma.user.findUnique({
      where: { id },
      include: {
        memberships: { include: { organization: true } },
        publisherMemberships: { include: { publisher: true } },
        staffMemberships: true,
      },
    })
    if (!u) throw new NotFoundException("User not found")
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      userType: u.userType,
      banned: u.banned,
      createdAt: u.createdAt,
      organizations: u.memberships.map((m) => ({
        id: m.organization.id,
        name: m.organization.name,
        slug: m.organization.slug,
        role: m.role,
      })),
      publisher: u.publisherMemberships[0]
        ? {
            id: u.publisherMemberships[0].publisher.id,
            name: u.publisherMemberships[0].publisher.name,
            role: u.publisherMemberships[0].role,
          }
        : null,
      staffRole: u.staffMemberships?.[0]?.role ?? null,
    }
  }

  async updateUserRole(userId: string, role: string, user?: any) {
    const u = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!u) throw new NotFoundException("User not found")
    // Role/type changes must take effect immediately, not after cache TTL
    invalidateAuthContext(userId)

    const CUSTOMER_ROLES = ["OWNER", "MEMBER"] as const
    const PUBLISHER_ROLES = ["PUBLISHER_OWNER"] as const

    if ((CUSTOMER_ROLES as readonly string[]).includes(role)) {
      let membership = await this.prisma.membership.findFirst({
        where: { userId },
        orderBy: { createdAt: "asc" },
      })
      if (!membership) {
        const orgName = `Org for ${u.email}`
        const orgSlug = `org-${userId.slice(0, 8)}`
        // A freshly created personal org's sole member is its OWNER — never
        // the passed role. An org whose only member is a MEMBER is
        // ownerless and administratively dead (nobody can deposit/invite).
        // MEMBER is only meaningful when joining an EXISTING org via invite.
        const org = await this.prisma.organization.create({
          data: {
            name: orgName,
            slug: orgSlug,
            memberships: { create: { userId, role: "OWNER" } },
          },
        })
        membership = await this.prisma.membership.findFirstOrThrow({
          where: { userId, organizationId: org.id },
        })
      } else {
        membership = await this.prisma.membership.update({
          where: { id: membership.id },
          data: { role: role as any },
        })
      }
      if (u.userType !== "CUSTOMER") {
        await this.prisma.user.update({
          where: { id: userId },
          data: { userType: "CUSTOMER" },
        })
      }
      await this.audit.log({
        action: "CUSTOMER_ROLE_UPDATE",
        entityType: "CustomerMembership",
        entityId: membership.id,
        metadata: { newRole: role, userId },
        userId: user.id,
        organizationId: membership.organizationId,
      })
      return membership
    }

    if ((PUBLISHER_ROLES as readonly string[]).includes(role)) {
      let pubMembership = await this.prisma.publisherMembership.findFirst({
        where: { userId },
        orderBy: { createdAt: "asc" },
      })
      if (!pubMembership) {
        // A user with no publisher membership gets a FRESH publisher entity.
        // Never attach to an existing publisher here — picking one (e.g. the
        // oldest) hands this user control of someone else's listings,
        // balance, and withdrawals.
        let orgId = (
          await this.prisma.membership.findFirst({
            where: { userId },
            orderBy: { createdAt: "asc" },
            select: { organizationId: true },
          })
        )?.organizationId
        if (!orgId) {
          const org = await this.prisma.organization.create({
            data: {
              name: `Org for ${u.email}`,
              slug: `org-${userId.slice(0, 8)}`,
            },
          })
          orgId = org.id
        }
        const publisher = await this.prisma.publisher.create({
          data: {
            name: u.name ?? `${u.email}'s Publisher`,
            email: u.email,
            organizationId: orgId,
          },
        })
        pubMembership = await this.prisma.publisherMembership.create({
          data: { userId, publisherId: publisher.id, role: "PUBLISHER_OWNER" },
        })
      } else {
        pubMembership = await this.prisma.publisherMembership.update({
          where: { id: pubMembership.id },
          data: { role: "PUBLISHER_OWNER" },
        })
      }
      if (u.userType !== "PUBLISHER") {
        await this.prisma.user.update({
          where: { id: userId },
          data: { userType: "PUBLISHER" },
        })
      }
      await this.audit.log({
        action: "PUBLISHER_ROLE_UPDATE",
        entityType: "PublisherMembership",
        entityId: pubMembership.id,
        metadata: { newRole: role, userId },
        userId: user.id,
        organizationId: null,
      })
      return pubMembership
    }

    if (u.userType === "STAFF") {
      throw new BadRequestException("Use /staff-role endpoint for staff users")
    }
    throw new BadRequestException(`Invalid role: ${role}`)
  }

  async updateStaffRole(userId: string, role: string, user?: any) {
    const target = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!target) throw new NotFoundException("User not found")
    invalidateAuthContext(userId)

    if (!VALID_STAFF_ROLES.includes(role as StaffRole)) {
      throw new BadRequestException(`Invalid staff role: ${role}`)
    }

    const existing = await this.prisma.staffMembership.findUnique({
      where: { userId },
    })

    let result: any
    if (existing) {
      result = await this.prisma.staffMembership.update({
        where: { id: existing.id },
        data: { role: role as StaffRole },
      })
    } else {
      result = await this.prisma.staffMembership.create({
        data: { userId, role: role as StaffRole },
      })
      await this.prisma.user.update({
        where: { id: userId },
        data: { userType: "STAFF" },
      })
    }

    await this.audit.log({
      action: "STAFF_ROLE_UPDATE",
      entityType: "StaffMembership",
      entityId: result.id,
      metadata: { newRole: role, userId },
      userId: user.id,
      organizationId: null,
    })

    return result
  }

  async listOrganizations(take = 50, skip = 0, _user?: any) {
    // Phase 6.7 — explicit projection. Drops `settings` JSON (opaque config
    // that might hold OAuth secrets, webhook URLs, etc.) and exposes only
    // the fields a staff investigation needs.
    return this.prisma.organization.findMany({
      take,
      skip,
      select: {
        id: true,
        name: true,
        slug: true,
        plan: true,
        createdAt: true,
        _count: { select: { memberships: true, orders: true } },
      },
    })
  }

  async listOrders(take = 50, skip = 0, _user?: any) {
    // Phase 6.7 — explicit projection. The previous `include: { website: true }`
    // leaked Website.verificationToken (the DNS-TXT verification secret) to
    // every Finance/Ops staffer. Customer is also narrowed (no banReason,
    // no emailVerified internal field). Org excludes the opaque `settings`
    // JSON. None of these are required for refund / dispute / fulfillment
    // investigations — they exist on the Order row directly via FKs.
    return this.prisma.order.findMany({
      orderBy: { createdAt: "desc" },
      take,
      skip,
      include: {
        organization: { select: { id: true, name: true, slug: true } },
        customer: {
          select: { id: true, name: true, email: true, userType: true },
        },
        website: {
          select: {
            id: true,
            url: true,
            name: true,
            ownershipType: true,
            verificationStatus: true,
          },
        },
      },
    })
  }

  async listPlatformOrders(status?: string, take = 50, skip = 0) {
    const where: any = { website: { ownershipType: "PLATFORM" } }
    if (status) where.status = status

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take,
        skip,
        include: {
          organization: { select: { id: true, name: true } },
          customer: { select: { id: true, name: true, email: true } },
          website: { select: { id: true, url: true, name: true } },
          items: { include: { website: { select: { url: true } } } },
          events: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      }),
      this.prisma.order.count({ where }),
    ])

    return { orders, pagination: { take, skip, total } }
  }

  async getStats(_user?: any) {
    const [users, organizations, orders] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.organization.count(),
      this.prisma.order.count(),
    ])
    return { users, organizations, orders }
  }

  async manualVerify(orderId: string, method: string, userId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } })
    if (!order) throw new NotFoundException("Order not found")
    if (order.status !== "PUBLISHED")
      throw new BadRequestException(
        "Order must be in PUBLISHED status to verify",
      )

    return this.prisma.$transaction(async (tx: any) => {
      const verified = await tx.order.updateMany({
        where: { id: orderId, version: order.version },
        data: {
          status: "VERIFIED",
          verifiedAt: new Date(),
          verifiedBy: userId,
          verifyMethod: method,
          version: { increment: 1 },
        },
      })
      if (verified.count === 0) {
        throw new ConflictException(
          "Order was modified by another request. Retry.",
        )
      }
      const updated = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
      })

      await tx.orderEvent.create({
        data: {
          orderId,
          eventType: "VERIFIED_MANUAL",
          actorId: userId,
          message: `Order manually verified by admin via ${method}`,
          metadata: { verifyMethod: method, verifiedBy: userId },
        },
      })

      await this.audit.log({
        action: "ORDER_MANUAL_VERIFY",
        entityType: "Order",
        entityId: orderId,
        metadata: { fromStatus: order.status, verifyMethod: method },
        userId,
        organizationId: order.organizationId,
      })

      return updated
    })
  }

  async refundOrder(orderId: string, reason: string, userId: string) {
    // Delegates to the single consolidated refund path (duplicate check,
    // settlement cancellation + clawback, wallet credit, audit)
    return this.refund.refundOrder(orderId, reason, userId)
  }

  async forceCancelOrder(orderId: string, reason: string, userId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } })
    if (!order) throw new NotFoundException("Order not found")
    if (order.status === "COMPLETED" || order.status === "CANCELLED") {
      throw new BadRequestException(
        `Order cannot be force-cancelled in ${order.status} status`,
      )
    }

    // Captured payments must go through the canonical refund path —
    // cancelling here would keep the customer's money while killing the
    // order, and would skip released-settlement clawback.
    if (order.paymentStatus === "PAID") {
      return this.refund.refundOrder(
        orderId,
        `Force-cancelled by admin: ${reason}`,
        userId,
      )
    }

    return this.prisma.$transaction(async (tx: any) => {
      // Cancel active settlement if any
      const activeSettlement = await tx.settlement.findFirst({
        where: { orderId, status: { not: "CANCELLED" } },
      })
      if (activeSettlement && activeSettlement.status !== "RELEASED") {
        const cancelled = await tx.settlement.updateMany({
          where: { id: activeSettlement.id, version: activeSettlement.version },
          data: { status: "CANCELLED", version: { increment: 1 } },
        })
        if (cancelled.count === 0) {
          throw new ConflictException(
            "Settlement was modified by another request. Retry.",
          )
        }
      }

      const cancelled = await tx.order.updateMany({
        where: { id: orderId, version: order.version },
        data: { status: "CANCELLED", version: { increment: 1 } },
      })
      if (cancelled.count === 0) {
        throw new ConflictException(
          "Order was modified by another request. Retry.",
        )
      }
      const updated = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
      })

      await tx.orderEvent.create({
        data: {
          orderId,
          eventType: "ORDER_CANCELLED",
          actorId: userId,
          message: `Order force-cancelled by admin: ${reason}`,
          metadata: { reason, cancelledBy: userId },
        },
      })

      await this.audit.log({
        action: "ORDER_FORCE_CANCELLED",
        entityType: "Order",
        entityId: orderId,
        metadata: { fromStatus: order.status, reason },
        userId,
        organizationId: order.organizationId,
      })

      return updated
    })
  }

  async listMarketplaceListings(params: {
    status?: string
    type?: string
    page?: number
    limit?: number
  }) {
    const page = Number.isFinite(params.page) ? Math.max(1, params.page!) : 1
    const limit = Number.isFinite(params.limit)
      ? Math.min(100, Math.max(1, params.limit!))
      : 20
    const where: any = {}
    if (params.status) where.status = params.status
    // Phase 7: the listing-level `type` column is gone. The `type` filter
    // now means "listings with at least one AVAILABLE service of this
    // serviceType" — matches the public search semantics.
    if (params.type)
      where.services = {
        some: { availability: "AVAILABLE", serviceType: params.type as any },
      }

    const [listings, total] = await Promise.all([
      this.prisma.marketplaceListing.findMany({
        where,
        orderBy: [{ createdAt: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          category: { select: { name: true } },
          organization: { select: { name: true } },
          publisher: { select: { name: true } },
          website: {
            select: {
              verificationStatus: true,
              verifiedAt: true,
              domain: true,
            },
          },
          // Phase 7: service rows back the priceFrom + serviceTypes the
          // admin browse table renders. Only AVAILABLE rows; sorted asc
          // so services[0] is the cheapest = priceFrom source.
          services: {
            where: { availability: "AVAILABLE" },
            orderBy: { price: "asc" },
          },
        },
      }),
      this.prisma.marketplaceListing.count({ where }),
    ])

    return {
      listings: listings.map((l) => ({
        id: l.id,
        title: l.title,
        slug: l.slug,
        // Phase 7: card-shape fields. Type is now the first AVAILABLE
        // service's serviceType; price is the minimum across AVAILABLE
        // services. Legacy fields removed; consumers should read priceFrom +
        // serviceTypes (also surfaced here for the admin browse table).
        type: l.services[0]?.serviceType ?? null,
        serviceTypes: Array.from(new Set(l.services.map((s) => s.serviceType))),
        priceFrom:
          l.services[0]?.price != null ? Number(l.services[0].price) : null,
        status: l.status,
        price: l.services[0]?.price != null ? Number(l.services[0].price) : 0,
        currency: l.currency,
        domainRating: l.domainRating,
        traffic: l.traffic,
        featured: l.featured,
        verified: l.verified,
        category: l.category,
        organization: l.organization,
        publisher: l.publisher,
        // null for platform/service listings with no attached website
        websiteVerificationStatus: l.website?.verificationStatus ?? null,
        websiteVerifiedAt: l.website?.verifiedAt?.toISOString() ?? null,
        websiteDomain: l.website?.domain ?? null,
        createdAt: l.createdAt.toISOString(),
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    }
  }

  async getMarketplaceStats() {
    const [totalListings, activeListings, totalReviews, avgRating] =
      await Promise.all([
        this.prisma.marketplaceListing.count(),
        this.prisma.marketplaceListing.count({
          where: { status: ListingStatus.APPROVED },
        }),
        this.prisma.marketplaceReview.count(),
        this.prisma.marketplaceReview.aggregate({ _avg: { rating: true } }),
      ])
    return {
      totalListings,
      activeListings,
      totalReviews,
      avgRating: avgRating._avg.rating ?? 0,
    }
  }

  async updateListingStatus(
    id: string,
    status: string,
    user: any,
    force = false,
  ) {
    if (!Object.values(ListingStatus).includes(status as ListingStatus)) {
      throw new BadRequestException(`Invalid listing status: ${status}`)
    }
    const listing = await this.prisma.marketplaceListing.findUnique({
      where: { id },
      include: {
        publisher: { select: { email: true } },
        website: { select: { verificationStatus: true, domain: true } },
      },
    })
    if (!listing) throw new NotFoundException("Listing not found")

    // Domain ownership gate: a publisher listing cannot be APPROVED until its
    // website is VERIFIED. Platform listings have no website (or a VERIFIED one)
    // and pass through. Only SUPER_ADMIN may emergency-override, and the bypass
    // is audited.
    if (
      status === ListingStatus.APPROVED &&
      listing.website &&
      listing.website.verificationStatus !== "VERIFIED"
    ) {
      if (!(force && user.role === "SUPER_ADMIN")) {
        throw new BadRequestException({
          code: "WEBSITE_NOT_VERIFIED",
          message: `Cannot approve: website ${listing.website.domain ?? ""} is ${listing.website.verificationStatus}, not VERIFIED.`,
        })
      }
      await this.audit.log({
        action: "WEBSITE_VERIFICATION_OVERRIDE",
        entityType: "MarketplaceListing",
        entityId: id,
        metadata: {
          domain: listing.website.domain,
          websiteStatus: listing.website.verificationStatus,
          reason: "SUPER_ADMIN emergency approval",
        },
        userId: user.id,
        organizationId: listing.organizationId ?? null,
      })
    }

    const updated = await this.prisma.marketplaceListing.update({
      where: { id },
      data: { status: status as any },
    })

    await this.audit.log({
      action: "LISTING_STATUS_UPDATED",
      entityType: "MarketplaceListing",
      entityId: id,
      metadata: {
        previousStatus: listing.status,
        newStatus: status,
        listingTitle: listing.title,
      },
      userId: user.id,
      organizationId: listing.organizationId ?? null,
    })

    if (
      status === ListingStatus.APPROVED ||
      status === ListingStatus.REJECTED
    ) {
      const notificationType =
        status === ListingStatus.APPROVED
          ? "LISTING_APPROVED"
          : "LISTING_REJECTED"
      const message =
        status === ListingStatus.APPROVED
          ? `Your listing "${listing.title}" has been approved and is now live in the marketplace.`
          : `Your listing "${listing.title}" has been rejected.`

      await this.queue.pushNotification("push-in-app", {
        userId: listing.publisherId ?? "",
        organizationId: listing.organizationId ?? "",
        type: notificationType,
        message,
      })

      if (listing.publisher?.email) {
        await this.queue.sendEmail("listing-status", {
          to: listing.publisher.email,
          subject: `Listing ${status === ListingStatus.APPROVED ? "Approved" : "Rejected"}: ${listing.title}`,
          html: `<p>${message}</p>`,
        })
      }
    }

    return updated
  }

  async toggleListingFeatured(id: string, featured: boolean, user: any) {
    const listing = await this.prisma.marketplaceListing.findUnique({
      where: { id },
    })
    if (!listing) throw new NotFoundException("Listing not found")

    const updated = await this.prisma.marketplaceListing.update({
      where: { id },
      data: { featured },
    })

    await this.audit.log({
      action: "LISTING_FEATURED_TOGGLED",
      entityType: "MarketplaceListing",
      entityId: id,
      metadata: { featured, listingTitle: listing.title },
      userId: user.id,
      organizationId: listing.organizationId ?? null,
    })

    return updated
  }

  async toggleListingVerified(id: string, verified: boolean, user: any) {
    const listing = await this.prisma.marketplaceListing.findUnique({
      where: { id },
    })
    if (!listing) throw new NotFoundException("Listing not found")

    const updated = await this.prisma.marketplaceListing.update({
      where: { id },
      data: { verified },
    })

    await this.audit.log({
      action: "LISTING_VERIFIED_TOGGLED",
      entityType: "MarketplaceListing",
      entityId: id,
      metadata: { verified, listingTitle: listing.title },
      userId: user.id,
      organizationId: listing.organizationId ?? null,
    })

    return updated
  }

  async deleteListing(id: string, user: any) {
    const listing = await this.prisma.marketplaceListing.findUnique({
      where: { id },
    })
    if (!listing) throw new NotFoundException("Listing not found")

    const updated = await this.prisma.marketplaceListing.update({
      where: { id },
      data: { status: ListingStatus.ARCHIVED },
    })

    await this.audit.log({
      action: "LISTING_DELETED",
      entityType: "MarketplaceListing",
      entityId: id,
      metadata: { listingTitle: listing.title },
      userId: user.id,
      organizationId: listing.organizationId ?? null,
    })

    return updated
  }

  // ─── WEBSITE MANAGEMENT ─────────────────────────────

  async createPlatformWebsite(dto: any, user: any) {
    const domain = normalizeDomain(dto.url)
    const existing = await this.prisma.website.findFirst({
      where: { OR: [{ url: dto.url }, { domain }] },
    })
    if (existing)
      throw new BadRequestException(
        `Website with this domain already exists (${existing.url})`,
      )

    // Phase 6.5 default ownership: an OPERATIONS staffer who adds a site is
    // its default manager — auto-assignment + ticket routing flow through
    // them on every order to come. SUPER_ADMIN creates can pass an explicit
    // managedByUserId; if omitted the site stays NULL (shared Ops queue).
    let managedByUserId: string | null = null
    if (dto.managedByUserId) {
      const target = await this.prisma.staffMembership.findUnique({
        where: { userId: dto.managedByUserId },
        select: { role: true },
      })
      if (target?.role !== "OPERATIONS") {
        throw new BadRequestException({
          code: "INVALID_OWNER",
          message: "managedByUserId must reference an OPERATIONS staff member",
        })
      }
      managedByUserId = dto.managedByUserId
    } else {
      // Auto-default when the creator is OPERATIONS themselves.
      const creator = await this.prisma.staffMembership.findUnique({
        where: { userId: user.id },
        select: { role: true },
      })
      if (creator?.role === "OPERATIONS") managedByUserId = user.id
    }

    const website = await this.prisma.website.create({
      data: {
        url: dto.url,
        domain,
        name: dto.name ?? null,
        country: dto.country ?? null,
        language: dto.language ?? null,
        category: dto.category ?? null,
        metrics: {
          dr: dto.domainRating ?? 0,
          traffic: dto.monthlyTraffic ?? 0,
        },
        ownershipType: WebsiteOwnershipType.PLATFORM,
        isActive: true,
        managedByUserId,
        // Phase 7.12 (#24): platform-owned sites bypass DNS verification —
        // the platform inherently owns them (matches the schema comment at
        // schema.prisma:466-467 "Platform sites are created VERIFIED").
        // Previously inherited the default PENDING_VERIFICATION which
        // falsely flagged platform sites as unverified to listing-approval
        // flows. Strongly typed via the Prisma-generated enum.
        verificationStatus: WebsiteVerificationStatus.VERIFIED,
      },
    })

    // Phase 7: the legacy listing-level type/price/turnaroundDays columns
    // are dropped. We still auto-create a listing row so the website appears
    // on the marketplace (admin can edit + add services from the Manage
    // Services dialog), but no longer write the deprecated fields.
    await this.prisma.marketplaceListing.create({
      data: {
        title: dto.url,
        slug: `platform-${website.id.slice(0, 8)}`,
        description: dto.name ?? dto.url,
        // Phase 7.12 (#24): start in DRAFT — admin must explicitly add
        // services + approve before going live on the public marketplace.
        // The previous APPROVED default shipped zero-service listings live,
        // surfacing "no services available" to customers.
        status: ListingStatus.DRAFT,
        fulfillmentType: "INTERNAL",
        currency: "USD",
        domainRating: dto.domainRating ?? 0,
        traffic: dto.monthlyTraffic ?? 0,
        country: dto.country ?? null,
        language: dto.language ?? null,
        websiteUrl: dto.url,
        websiteId: website.id,
        organizationId: user.organizationId ?? null,
        publisherId: null,
        ownerType: "PLATFORM",
      },
    })

    await this.audit.log({
      action: "PLATFORM_WEBSITE_CREATED",
      entityType: "Website",
      entityId: website.id,
      metadata: { url: dto.url, createdBy: user.id, managedByUserId },
      userId: user.id,
      organizationId: null,
    })

    return website
  }

  // Phase 6.5 admin reassign — change which OPERATIONS user manages a
  // platform site. Existing FulfillmentAssignment rows are NOT touched (no
  // surprise hand-off of in-flight work); only new orders route to the new
  // owner. Existing tickets stay with their original assignee for the same
  // reason — admin uses POST /tickets/:id/reassign for per-ticket migration.
  async reassignPlatformWebsite(
    websiteId: string,
    body: { managedByUserId: string | null; reason?: string },
    user: any,
  ) {
    const website = await this.prisma.website.findUnique({
      where: { id: websiteId },
      select: {
        id: true,
        ownershipType: true,
        managedByUserId: true,
        url: true,
      },
    })
    if (!website) throw new NotFoundException("Website not found")
    if (website.ownershipType !== "PLATFORM") {
      throw new BadRequestException(
        "Only platform websites have a managed-by owner",
      )
    }

    let newOwnerId: string | null = null
    if (body.managedByUserId) {
      const target = await this.prisma.staffMembership.findUnique({
        where: { userId: body.managedByUserId },
        select: { role: true },
      })
      if (target?.role !== "OPERATIONS") {
        throw new BadRequestException({
          code: "INVALID_OWNER",
          message: "managedByUserId must reference an OPERATIONS staff member",
        })
      }
      newOwnerId = body.managedByUserId
    }

    await this.prisma.website.update({
      where: { id: websiteId },
      data: { managedByUserId: newOwnerId },
    })

    await this.audit.log({
      action: "WEBSITE_OWNERSHIP_REASSIGNED",
      entityType: "Website",
      entityId: websiteId,
      metadata: {
        url: website.url,
        fromUserId: website.managedByUserId ?? null,
        toUserId: newOwnerId,
        reason: body.reason ?? null,
      },
      userId: user.id,
      organizationId: null,
    })

    return { id: websiteId, managedByUserId: newOwnerId }
  }

  // List OPERATIONS staff for the admin reassignment picker.
  async listOperationsStaff() {
    const memberships = await this.prisma.staffMembership.findMany({
      where: { role: "OPERATIONS" },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    })
    return memberships.map((m) => ({
      id: m.user.id,
      name: m.user.name,
      email: m.user.email,
    }))
  }

  async updatePlatformWebsite(id: string, dto: any, user: any) {
    const website = await this.prisma.website.findUnique({ where: { id } })
    if (!website) throw new NotFoundException("Website not found")
    if (website.ownershipType !== "PLATFORM")
      throw new BadRequestException(
        "Only platform websites can be updated via admin",
      )

    const updated = await this.prisma.website.update({
      where: { id },
      data: {
        name: dto.name ?? website.name,
        country: dto.country ?? website.country,
        language: dto.language ?? website.language,
        category: dto.category ?? website.category,
        metrics: {
          dr: dto.domainRating ?? (website.metrics as any)?.dr ?? 0,
          traffic: dto.monthlyTraffic ?? (website.metrics as any)?.traffic ?? 0,
        },
      },
    })

    const listing = await this.prisma.marketplaceListing.findFirst({
      where: { websiteId: id, status: { not: ListingStatus.ARCHIVED } },
    })
    if (listing) {
      // Phase 7: price + turnaroundDays now live per-service on
      // ListingService rows. The PATCH /admin/websites/:id endpoint no
      // longer attempts to sync those fields onto the listing.
      await this.prisma.marketplaceListing.update({
        where: { id: listing.id },
        data: {
          title: dto.url ?? listing.title,
          domainRating: dto.domainRating ?? listing.domainRating,
          traffic: dto.monthlyTraffic ?? listing.traffic,
          country: dto.country ?? listing.country,
          language: dto.language ?? listing.language,
          websiteUrl: dto.url ?? listing.websiteUrl,
        },
      })
    }

    await this.audit.log({
      action: "PLATFORM_WEBSITE_UPDATED",
      entityType: "Website",
      entityId: id,
      metadata: { updatedBy: user.id },
      userId: user.id,
      organizationId: null,
    })

    return updated
  }

  async listWebsites(ownershipType?: string, take = 50, skip = 0) {
    const where: any = {}
    if (ownershipType) where.ownershipType = ownershipType

    const [websites, total] = await Promise.all([
      this.prisma.website.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take,
        skip,
        include: {
          marketplaceListings: {
            where: { status: { not: ListingStatus.ARCHIVED } },
            take: 1,
          },
          publisher: { select: { id: true, name: true } },
          // Phase 6.5: surface the platform-site owner so the admin
          // websites page can render the "Managed by" column without a
          // second round-trip per row.
          managedBy: { select: { id: true, name: true } },
        },
      }),
      this.prisma.website.count({ where }),
    ])

    return {
      websites: websites.map((w) => ({
        id: w.id,
        url: w.url,
        name: w.name,
        category: w.category,
        language: w.language,
        country: w.country,
        isActive: w.isActive,
        ownershipType: w.ownershipType,
        metrics: w.metrics,
        publisher: w.publisher,
        listing: w.marketplaceListings[0] ?? null,
        createdAt: w.createdAt.toISOString(),
      })),
      pagination: { take, skip, total },
    }
  }

  async getWebsite(id: string) {
    const website = await this.prisma.website.findUnique({
      where: { id },
      include: {
        marketplaceListings: {
          where: { status: { not: ListingStatus.ARCHIVED } },
          include: { category: true },
        },
        publisher: true,
        orders: {
          take: 10,
          orderBy: { createdAt: "desc" },
          include: { organization: { select: { name: true } } },
        },
      },
    })
    if (!website) throw new NotFoundException("Website not found")
    return website
  }

  async pauseWebsite(id: string, paused: boolean, user: any) {
    const website = await this.prisma.website.findUnique({ where: { id } })
    if (!website) throw new NotFoundException("Website not found")

    const updated = await this.prisma.website.update({
      where: { id },
      data: { isActive: !paused },
    })

    const listing = await this.prisma.marketplaceListing.findFirst({
      where: { websiteId: id, status: { not: ListingStatus.ARCHIVED } },
    })
    if (listing) {
      await this.prisma.marketplaceListing.update({
        where: { id: listing.id },
        data: {
          status: paused ? ListingStatus.PAUSED : ListingStatus.APPROVED,
        },
      })
    }

    await this.audit.log({
      action: paused ? "PLATFORM_WEBSITE_PAUSED" : "PLATFORM_WEBSITE_UNPAUSED",
      entityType: "Website",
      entityId: id,
      metadata: { url: website.url, paused, updatedBy: user.id },
      userId: user.id,
      organizationId: null,
    })

    return updated
  }

  async deleteWebsite(id: string, user: any) {
    const website = await this.prisma.website.findUnique({ where: { id } })
    if (!website) throw new NotFoundException("Website not found")
    if (website.ownershipType !== "PLATFORM")
      throw new BadRequestException(
        "Only platform websites can be deleted via admin",
      )

    const updated = await this.prisma.website.update({
      where: { id },
      data: { isActive: false },
    })

    const listing = await this.prisma.marketplaceListing.findFirst({
      where: { websiteId: id, status: { not: ListingStatus.ARCHIVED } },
    })
    if (listing) {
      await this.prisma.marketplaceListing.update({
        where: { id: listing.id },
        data: { status: ListingStatus.ARCHIVED },
      })
    }

    await this.audit.log({
      action: "PLATFORM_WEBSITE_DELETED",
      entityType: "Website",
      entityId: id,
      metadata: { url: website.url, deletedBy: user.id },
      userId: user.id,
      organizationId: null,
    })

    return updated
  }

  // ── Audit log browsing (staff) ──────────────────────────────────────────

  async listAuditLogs(params: {
    action?: string
    entityType?: string
    entityId?: string
    userId?: string
    requestId?: string
    startDate?: string
    endDate?: string
    page?: number
    limit?: number
  }) {
    const page = Number.isFinite(params.page) ? Math.max(params.page!, 1) : 1
    const limit = Number.isFinite(params.limit)
      ? Math.min(Math.max(params.limit!, 1), 100)
      : 50
    const where: any = {}
    if (params.action)
      where.action = { contains: params.action, mode: "insensitive" }
    if (params.entityType) where.entityType = params.entityType
    if (params.entityId) where.entityId = params.entityId
    if (params.userId) where.userId = params.userId
    // Phase 7.7 A2: EXACT-MATCH ONLY on requestId (identifier, not searchable
    // text). Substring search would seq-scan AuditLog_requestId_idx and
    // encourage operators to guess at IDs.
    if (params.requestId) where.requestId = { equals: params.requestId }
    if (params.startDate || params.endDate) {
      where.createdAt = {}
      if (params.startDate) {
        const start = new Date(params.startDate)
        if (Number.isNaN(start.getTime()))
          throw new BadRequestException("Invalid startDate")
        where.createdAt.gte = start
      }
      if (params.endDate) {
        const end = new Date(params.endDate)
        if (Number.isNaN(end.getTime()))
          throw new BadRequestException("Invalid endDate")
        // Set to end of UTC day for inclusive range
        where.createdAt.lte = new Date(
          `${end.toISOString().slice(0, 10)}T23:59:59.999Z`,
        )
      }
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        include: { user: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: (page - 1) * limit,
      }),
      this.prisma.auditLog.count({ where }),
    ])

    return {
      items: rows.map((r: any) => ({
        id: r.id,
        action: r.action,
        entity: r.entityType,
        entityId: r.entityId,
        actorId: r.userId,
        actorName: r.user?.name ?? r.user?.email ?? null,
        metadata: r.metadata,
        // Phase 7.7 A2: surface the indexed column so the FE copy button has
        // a stable field to render. Falls back to metadata.requestId for legacy
        // rows where backfill couldn't fill the column (pre-Phase-7.0).
        requestId:
          r.requestId ?? (r.metadata?.requestId as string | undefined) ?? null,
        ipAddress: r.ipAddress,
        createdAt: r.createdAt,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    }
  }

  // ── Publisher directory (staff) ─────────────────────────────────────────

  async listPublishers(params: {
    search?: string
    page?: number
    limit?: number
  }) {
    const page = Math.max(params.page ?? 1, 1)
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 100)
    const where: any = params.search
      ? {
          OR: [
            { name: { contains: params.search, mode: "insensitive" } },
            { email: { contains: params.search, mode: "insensitive" } },
          ],
        }
      : {}

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.publisher.findMany({
        where,
        include: {
          balance: {
            select: {
              withdrawableBalance: true,
              lifetimeEarnings: true,
              debtBalance: true,
            },
          },
          profile: {
            select: {
              trustScore: true,
              rating: true,
              totalReviews: true,
              completionRate: true,
            },
          },
          _count: {
            select: {
              websites: true,
              marketplaceListings: true,
              settlements: true,
            },
          },
          publisherMemberships: {
            take: 1,
            include: {
              user: { select: { id: true, email: true, banned: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: (page - 1) * limit,
      }),
      this.prisma.publisher.count({ where }),
    ])

    return {
      items: rows.map((p: any) => ({
        id: p.id,
        name: p.name,
        email: p.email ?? p.publisherMemberships[0]?.user?.email ?? null,
        tier: p.tier,
        trustScore: p.profile?.trustScore ?? null,
        rating: p.profile?.rating ?? null,
        totalReviews: p.profile?.totalReviews ?? 0,
        completionRate: p.profile?.completionRate ?? null,
        websiteCount: p._count.websites,
        listingCount: p._count.marketplaceListings,
        settlementCount: p._count.settlements,
        withdrawableBalance: Number(p.balance?.withdrawableBalance ?? 0),
        lifetimeEarnings: Number(p.balance?.lifetimeEarnings ?? 0),
        debtBalance: Number(p.balance?.debtBalance ?? 0),
        ownerBanned: p.publisherMemberships[0]?.user?.banned ?? false,
        createdAt: p.createdAt,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    }
  }

  // Tier is the backend's real trust lever (NEW/TRUSTED/VERIFIED drive
  // withdrawal holds) — there is no separate approve/suspend workflow.
  async updatePublisherTier(
    publisherId: string,
    tier: string,
    actor: { id: string },
  ) {
    const valid = ["NEW", "TRUSTED", "VERIFIED"]
    if (!valid.includes(tier)) {
      throw new BadRequestException(
        `Invalid tier — must be one of ${valid.join(", ")}`,
      )
    }
    const publisher = await this.prisma.publisher.findUnique({
      where: { id: publisherId },
    })
    if (!publisher) throw new NotFoundException("Publisher not found")

    const updated = await this.prisma.publisher.update({
      where: { id: publisherId },
      data: { tier: tier as any },
    })

    await this.audit.log({
      action: "PUBLISHER_TIER_CHANGED",
      entityType: "Publisher",
      entityId: publisherId,
      metadata: { from: publisher.tier, to: tier },
      userId: actor.id,
      organizationId: publisher.organizationId,
    })

    return updated
  }

  // ── Support tickets ─────────────────────────────────────────────────────
  // Phase 6.6: the four legacy bypass methods (listTicketsAdmin /
  // getTicketAdmin / updateTicketStatusAdmin / addTicketMessageAdmin) were
  // removed. The admin support routes now delegate to SupportService with
  // the staff actor, so the channel-aware visibility matrix is the single
  // code path used by customer/publisher/admin frontends.
}
