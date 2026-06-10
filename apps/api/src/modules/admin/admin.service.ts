import { Injectable, NotFoundException, BadRequestException, ForbiddenException, ConflictException } from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { AuditService } from "../audit/audit.service"
import { QueueService } from "../queues/queue.service"
import { RefundService } from "../orders/services/refund.service"
import { StaffRole, QUEUES } from "@guestpost/shared"
import { ListingStatus, ListingType } from "@guestpost/database"

const VALID_STAFF_ROLES: StaffRole[] = ["SUPER_ADMIN", "OPERATIONS", "FINANCE"]

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
    private readonly refund: RefundService,
  ) {}

  private isSuperAdmin(user?: any): boolean {
    return user?.staffRole === "SUPER_ADMIN"
  }

  async listUsers(take = 50, skip = 0, user?: any) {
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

  async getUser(id: string, user?: any) {
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

    const CUSTOMER_ROLES = ["OWNER", "MEMBER"] as const
    const PUBLISHER_ROLES = ["PUBLISHER_OWNER"] as const

    if ((CUSTOMER_ROLES as readonly string[]).includes(role)) {
      let membership = await this.prisma.membership.findFirst({ where: { userId }, orderBy: { createdAt: "asc" } })
      if (!membership) {
        const orgName = `Org for ${u.email}`
        const orgSlug = `org-${userId.slice(0, 8)}`
        const org = await this.prisma.organization.create({
          data: {
            name: orgName,
            slug: orgSlug,
            memberships: { create: { userId, role: role as any } },
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
        await this.prisma.user.update({ where: { id: userId }, data: { userType: "CUSTOMER" } })
      }
      await this.audit.log({
        action: "CUSTOMER_ROLE_UPDATE", entityType: "CustomerMembership",
        entityId: membership.id, metadata: { newRole: role, userId },
        userId: user.id, organizationId: membership.organizationId,
      })
      return membership
    }

    if ((PUBLISHER_ROLES as readonly string[]).includes(role)) {
      let pubMembership = await this.prisma.publisherMembership.findFirst({ where: { userId }, orderBy: { createdAt: "asc" } })
      if (!pubMembership) {
        let publisher = await this.prisma.publisher.findFirst({ orderBy: { createdAt: "asc" } })
        if (!publisher) {
          const org = await this.prisma.organization.findFirst()
          if (!org) throw new BadRequestException("No organization exists to associate publisher")
          publisher = await this.prisma.publisher.create({
            data: { name: u.name ?? `${u.email}'s Publisher`, email: u.email, organizationId: org.id },
          })
        }
        pubMembership = await this.prisma.publisherMembership.create({
          data: { userId, publisherId: publisher.id, role: "PUBLISHER_OWNER" },
        })
      } else {
        pubMembership = await this.prisma.publisherMembership.update({
          where: { id: pubMembership.id }, data: { role: "PUBLISHER_OWNER" },
        })
      }
      if (u.userType !== "PUBLISHER") {
        await this.prisma.user.update({ where: { id: userId }, data: { userType: "PUBLISHER" } })
      }
      await this.audit.log({
        action: "PUBLISHER_ROLE_UPDATE", entityType: "PublisherMembership",
        entityId: pubMembership.id, metadata: { newRole: role, userId },
        userId: user.id, organizationId: "SYSTEM",
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
      organizationId: "SYSTEM",
    })

    return result
  }

  async listOrganizations(take = 50, skip = 0, user?: any) {
    return this.prisma.organization.findMany({
      take,
      skip,
      include: { _count: { select: { memberships: true, orders: true } } },
    })
  }

  async listOrders(take = 50, skip = 0, user?: any) {
    return this.prisma.order.findMany({
      orderBy: { createdAt: "desc" },
      take,
      skip,
      include: { organization: true, customer: true, website: true },
    })
  }

  async getStats(user?: any) {
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
    if (order.status !== "PUBLISHED") throw new BadRequestException("Order must be in PUBLISHED status to verify")

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
        throw new ConflictException("Order was modified by another request. Retry.")
      }
      const updated = await tx.order.findUniqueOrThrow({ where: { id: orderId } })

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
      throw new BadRequestException(`Order cannot be force-cancelled in ${order.status} status`)
    }

    return this.prisma.$transaction(async (tx: any) => {
      // Cancel active settlement if any
      const activeSettlement = await tx.settlement.findFirst({
        where: { orderId, status: { not: "CANCELLED" } },
      })
      if (activeSettlement && activeSettlement.status !== "RELEASED") {
        await tx.settlement.update({
          where: { id: activeSettlement.id },
          data: { status: "CANCELLED" },
        })
      }

      const cancelled = await tx.order.updateMany({
        where: { id: orderId, version: order.version },
        data: { status: "CANCELLED", version: { increment: 1 } },
      })
      if (cancelled.count === 0) {
        throw new ConflictException("Order was modified by another request. Retry.")
      }
      const updated = await tx.order.findUniqueOrThrow({ where: { id: orderId } })

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
    const page = Math.max(1, params.page ?? 1)
    const limit = Math.min(100, Math.max(1, params.limit ?? 20))
    const where: any = {}
    if (params.status) where.status = params.status
    if (params.type) where.type = params.type

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
        },
      }),
      this.prisma.marketplaceListing.count({ where }),
    ])

    return {
      listings: listings.map((l) => ({
        id: l.id,
        title: l.title,
        slug: l.slug,
        type: l.type,
        status: l.status,
        price: Number(l.price),
        currency: l.currency,
        domainRating: l.domainRating,
        traffic: l.traffic,
        featured: l.featured,
        verified: l.verified,
        category: l.category,
        organization: l.organization,
        publisher: l.publisher,
        createdAt: l.createdAt.toISOString(),
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    }
  }

  async getMarketplaceStats() {
    const [totalListings, activeListings, totalReviews, avgRating] = await Promise.all([
      this.prisma.marketplaceListing.count(),
      this.prisma.marketplaceListing.count({ where: { status: ListingStatus.APPROVED } }),
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

  async updateListingStatus(id: string, status: string, user: any) {
    const listing = await this.prisma.marketplaceListing.findUnique({
      where: { id },
      include: { publisher: { select: { email: true } } },
    })
    if (!listing) throw new NotFoundException("Listing not found")

    const updated = await this.prisma.marketplaceListing.update({
      where: { id },
      data: { status: status as any },
    })

    await this.audit.log({
      action: "LISTING_STATUS_UPDATED",
      entityType: "MarketplaceListing",
      entityId: id,
      metadata: { previousStatus: listing.status, newStatus: status, listingTitle: listing.title },
      userId: user.id,
      organizationId: listing.organizationId ?? "SYSTEM",
    })

    if (status === ListingStatus.APPROVED || status === ListingStatus.REJECTED) {
      const notificationType = status === ListingStatus.APPROVED ? "LISTING_APPROVED" : "LISTING_REJECTED"
      const message = status === ListingStatus.APPROVED
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
    const listing = await this.prisma.marketplaceListing.findUnique({ where: { id } })
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
      organizationId: listing.organizationId ?? "SYSTEM",
    })

    return updated
  }

  async toggleListingVerified(id: string, verified: boolean, user: any) {
    const listing = await this.prisma.marketplaceListing.findUnique({ where: { id } })
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
      organizationId: listing.organizationId ?? "SYSTEM",
    })

    return updated
  }

  async deleteListing(id: string, user: any) {
    const listing = await this.prisma.marketplaceListing.findUnique({ where: { id } })
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
      organizationId: listing.organizationId ?? "SYSTEM",
    })

    return updated
  }
}
