import { hashPassword } from "@better-auth/utils/password"
import {
  ListingStatus,
  type Prisma,
  WebsiteOwnershipType,
  WebsiteVerificationStatus,
} from "@guestpost/database"
import { StaffRole, validateWebsiteEnlistmentInput } from "@guestpost/shared"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { invalidateAuthContext } from "../../common/auth-context-cache"
import { normalizeDomain } from "../../common/domain"
import { PrismaService } from "../../common/prisma.service"
import {
  hasCompleteListingPolicy,
  isMarketplaceLanguage,
  requireActiveMarketplaceCategories,
} from "../../common/utils/marketplace-categories"
import { AuditService } from "../audit/audit.service"
import { QueueService } from "../queues/queue.service"

const VALID_STAFF_ROLES: StaffRole[] = ["SUPER_ADMIN", "OPERATIONS", "FINANCE"]

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  private async activeSuperAdminCount() {
    return this.prisma.user.count({
      where: {
        userType: "STAFF",
        banned: false,
        staffMemberships: { some: { role: "SUPER_ADMIN" } },
      },
    })
  }

  async listUsers(params: {
    take?: number
    skip?: number
    search?: string
    userType?: string
    role?: string
    status?: string
    _user?: any
  }) {
    const { take = 50, skip = 0, search, userType, role, status } = params
    const where: any = {}

    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { id: search.length >= 8 ? search : undefined },
      ].filter(Boolean)
    }

    if (userType) {
      where.userType = userType
    }

    if (role) {
      const staffRoles = ["SUPER_ADMIN", "OPERATIONS", "FINANCE"]
      if (staffRoles.includes(role)) {
        where.staffMemberships = { some: { role } }
      } else if (role === "PUBLISHER_OWNER") {
        where.publisherMemberships = { some: { role } }
      } else {
        where.memberships = { some: { role } }
      }
    }

    if (status === "active") {
      where.banned = false
    } else if (status === "suspended") {
      where.banned = true
    }

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take,
        skip,
        include: {
          memberships: true,
          publisherMemberships: true,
          staffMemberships: true,
        },
      }),
      this.prisma.user.count({ where }),
    ])

    return {
      items: users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        userType: u.userType,
        customerRole: u.memberships[0]?.role ?? null,
        publisherRole: u.publisherMemberships[0]?.role ?? null,
        staffRole: u.staffMemberships?.[0]?.role ?? null,
        banned: u.banned,
        createdAt: u.createdAt,
      })),
      total,
      take,
      skip,
    }
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

  async createStaff(
    data: {
      email: string
      name: string
      role: StaffRole
      password: string
    },
    actor: any,
  ) {
    const email = data.email.trim().toLowerCase()
    const name = data.name.trim()
    if (!name) throw new BadRequestException("Staff name is required")
    if (!VALID_STAFF_ROLES.includes(data.role)) {
      throw new BadRequestException(`Invalid staff role: ${data.role}`)
    }

    const password = await hashPassword(data.password)
    try {
      const created = await this.prisma.$transaction(async (tx: any) => {
        const user = await tx.user.create({
          data: {
            email,
            name,
            emailVerified: true,
            userType: "STAFF",
          },
        })
        await tx.account.create({
          data: {
            accountId: user.id,
            providerId: "credential",
            userId: user.id,
            password,
          },
        })
        const membership = await tx.staffMembership.create({
          data: { userId: user.id, role: data.role },
        })
        await this.audit.log(
          {
            action: "STAFF_CREATED",
            entityType: "StaffMembership",
            entityId: membership.id,
            metadata: { userId: user.id, role: data.role },
            userId: actor.id,
            organizationId: null,
          },
          tx,
        )
        return { user, membership }
      })
      invalidateAuthContext(created.user.id)
      return {
        id: created.user.id,
        email: created.user.email,
        name: created.user.name,
        userType: created.user.userType,
        staffRole: created.membership.role,
        banned: created.user.banned,
        createdAt: created.user.createdAt,
      }
    } catch (error: any) {
      if (error?.code === "P2002") {
        throw new ConflictException("A user with this email already exists")
      }
      throw error
    }
  }

  async staffPerformance() {
    const staff = await this.prisma.user.findMany({
      where: { userType: "STAFF" },
      orderBy: [{ banned: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        email: true,
        name: true,
        banned: true,
        createdAt: true,
        staffMemberships: { select: { role: true, permissions: true } },
      },
    })
    const staffIds = staff.map((member) => member.id)
    if (staffIds.length === 0) {
      return {
        summary: {
          totalStaff: 0,
          superAdmins: 0,
          operations: 0,
          finance: 0,
          activeAssignments: 0,
          totalClaimed: 0,
          salesByCurrency: {},
        },
        items: [],
      }
    }

    const [assignments, claimAudits, activity, approvals, withdrawals] =
      await Promise.all([
        this.prisma.fulfillmentAssignment.findMany({
          where: { assignedToUserId: { in: staffIds } },
          select: {
            orderId: true,
            assignedToUserId: true,
            status: true,
            order: {
              select: { amount: true, currency: true, status: true },
            },
          },
        }),
        this.prisma.auditLog.findMany({
          where: {
            action: "ORDER_DELIVERY_ASSIGNED",
            userId: { in: staffIds },
          },
          select: { userId: true, metadata: true },
        }),
        this.prisma.auditLog.groupBy({
          by: ["userId"],
          where: { userId: { in: staffIds } },
          _count: { _all: true },
          _max: { createdAt: true },
        }),
        this.prisma.settlementApproval.findMany({
          where: { type: "ADMIN", approvedBy: { in: staffIds } },
          select: {
            approvedBy: true,
            settlement: {
              select: {
                grossAmount: true,
                order: { select: { currency: true } },
              },
            },
          },
        }),
        this.prisma.withdrawal.findMany({
          where: { approvedBy: { in: staffIds } },
          select: { approvedBy: true },
        }),
      ])

    const metricsByUser = new Map<string, any>()
    const metricsFor = (userId: string) => {
      let value = metricsByUser.get(userId)
      if (!value) {
        value = {
          assignments: new Map<string, any>(),
          claimed: 0,
          financeApprovals: 0,
          financeVolumeByCurrency: {} as Record<string, number>,
          withdrawalsApproved: 0,
          auditActions: 0,
          lastActivityAt: null as Date | null,
        }
        metricsByUser.set(userId, value)
      }
      return value
    }

    for (const assignment of assignments) {
      const metrics = metricsFor(assignment.assignedToUserId)
      const existing = metrics.assignments.get(assignment.orderId)
      if (!existing || assignment.status === "DELIVERED") {
        metrics.assignments.set(assignment.orderId, assignment)
      }
    }
    const claimedOrdersByUser = new Map<string, Set<string>>()
    for (const entry of claimAudits) {
      if (!entry.userId) continue
      const metadata = entry.metadata as Record<string, unknown> | null
      if (
        metadata?.assignedToUserId === entry.userId &&
        metadata.assignedByUserId === entry.userId &&
        typeof metadata.orderId === "string"
      ) {
        const claimedOrders = claimedOrdersByUser.get(entry.userId) ?? new Set()
        claimedOrders.add(metadata.orderId)
        claimedOrdersByUser.set(entry.userId, claimedOrders)
      }
    }
    for (const [userId, orderIds] of claimedOrdersByUser) {
      metricsFor(userId).claimed = orderIds.size
    }
    for (const entry of activity) {
      if (!entry.userId) continue
      const metrics = metricsFor(entry.userId)
      metrics.auditActions = entry._count._all
      metrics.lastActivityAt = entry._max.createdAt
    }
    for (const approval of approvals) {
      const metrics = metricsFor(approval.approvedBy)
      const currency = approval.settlement.order.currency ?? "USD"
      metrics.financeApprovals += 1
      metrics.financeVolumeByCurrency[currency] =
        (metrics.financeVolumeByCurrency[currency] ?? 0) +
        Number(approval.settlement.grossAmount)
    }
    for (const withdrawal of withdrawals) {
      if (!withdrawal.approvedBy) continue
      metricsFor(withdrawal.approvedBy).withdrawalsApproved += 1
    }

    const items = staff.map((member) => {
      const metrics = metricsFor(member.id)
      const uniqueAssignments = [...metrics.assignments.values()] as any[]
      const delivered = uniqueAssignments.filter(
        (assignment) =>
          assignment.status === "DELIVERED" &&
          ["DELIVERED", "SETTLED", "COMPLETED"].includes(
            assignment.order.status,
          ),
      )
      const salesByCurrency: Record<string, number> = {}
      for (const assignment of delivered) {
        const currency = assignment.order.currency ?? "USD"
        salesByCurrency[currency] =
          (salesByCurrency[currency] ?? 0) +
          Number(assignment.order.amount ?? 0)
      }
      return {
        id: member.id,
        email: member.email,
        name: member.name,
        banned: member.banned,
        createdAt: member.createdAt,
        staffRole: member.staffMemberships[0]?.role ?? null,
        permissions: member.staffMemberships[0]?.permissions ?? [],
        metrics: {
          activeAssigned: uniqueAssignments.filter((assignment) =>
            ["ASSIGNED", "IN_PROGRESS"].includes(assignment.status),
          ).length,
          totalAssigned: uniqueAssignments.length,
          claimed: metrics.claimed,
          completed: delivered.length,
          salesByCurrency,
          financeApprovals: metrics.financeApprovals,
          financeVolumeByCurrency: metrics.financeVolumeByCurrency,
          withdrawalsApproved: metrics.withdrawalsApproved,
          auditActions: metrics.auditActions,
          lastActivityAt: metrics.lastActivityAt,
        },
      }
    })

    const salesByCurrency: Record<string, number> = {}
    for (const item of items) {
      for (const [currency, amount] of Object.entries(
        item.metrics.salesByCurrency,
      )) {
        salesByCurrency[currency] =
          (salesByCurrency[currency] ?? 0) + Number(amount)
      }
    }

    return {
      summary: {
        totalStaff: items.length,
        superAdmins: items.filter((item) => item.staffRole === "SUPER_ADMIN")
          .length,
        operations: items.filter((item) => item.staffRole === "OPERATIONS")
          .length,
        finance: items.filter((item) => item.staffRole === "FINANCE").length,
        activeAssignments: items.reduce(
          (total, item) => total + item.metrics.activeAssigned,
          0,
        ),
        totalClaimed: items.reduce(
          (total, item) => total + item.metrics.claimed,
          0,
        ),
        salesByCurrency,
      },
      items,
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
      if (u.userType !== "CUSTOMER") {
        throw new BadRequestException(
          "ACCOUNT_TYPE_IMMUTABLE: publisher and staff accounts cannot be converted to customers",
        )
      }
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
      if (u.userType !== "PUBLISHER") {
        throw new BadRequestException(
          "ACCOUNT_TYPE_IMMUTABLE: customer and staff accounts cannot be converted to publishers",
        )
      }
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
    if (target.userType !== "STAFF") {
      throw new BadRequestException(
        "Customer and publisher accounts cannot be converted to staff",
      )
    }

    if (!VALID_STAFF_ROLES.includes(role as StaffRole)) {
      throw new BadRequestException(`Invalid staff role: ${role}`)
    }

    const existing = await this.prisma.staffMembership.findUnique({
      where: { userId },
    })
    if (!existing) throw new NotFoundException("Staff membership not found")
    if (user?.id === userId && existing.role !== role) {
      throw new ForbiddenException(
        "A different Super Admin must change your staff role",
      )
    }
    if (
      existing.role === "SUPER_ADMIN" &&
      role !== "SUPER_ADMIN" &&
      (await this.activeSuperAdminCount()) <= 1
    ) {
      throw new ConflictException("At least one active Super Admin is required")
    }
    if (existing.role === "OPERATIONS" && role !== "OPERATIONS") {
      const activeAssignments = await this.prisma.fulfillmentAssignment.count({
        where: {
          assignedToUserId: userId,
          status: { in: ["ASSIGNED", "IN_PROGRESS"] },
        },
      })
      if (activeAssignments > 0) {
        throw new ConflictException(
          "Reassign active fulfillment orders before changing this Operations role",
        )
      }
    }

    const result = await this.prisma.staffMembership.update({
      where: { id: existing.id },
      data: { role: role as StaffRole },
    })
    invalidateAuthContext(userId)

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

  async banUser(userId: string, banned: boolean, user?: any) {
    const target = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!target) throw new NotFoundException("User not found")
    if (banned && user?.id === userId) {
      throw new ForbiddenException("You cannot suspend your own account")
    }
    if (banned && target.userType === "STAFF") {
      const membership = await this.prisma.staffMembership.findUnique({
        where: { userId },
      })
      if (
        membership?.role === "SUPER_ADMIN" &&
        (await this.activeSuperAdminCount()) <= 1
      ) {
        throw new ConflictException(
          "At least one active Super Admin is required",
        )
      }
      if (membership?.role === "OPERATIONS") {
        const activeAssignments = await this.prisma.fulfillmentAssignment.count(
          {
            where: {
              assignedToUserId: userId,
              status: { in: ["ASSIGNED", "IN_PROGRESS"] },
            },
          },
        )
        if (activeAssignments > 0) {
          throw new ConflictException(
            "Reassign active fulfillment orders before suspending this Operations user",
          )
        }
      }
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { banned },
    })
    invalidateAuthContext(userId)

    await this.audit.log({
      action: banned ? "USER_SUSPENDED" : "USER_RESTORED",
      entityType: "User",
      entityId: userId,
      metadata: { userId, byUserId: user?.id },
      userId: user?.id,
      organizationId: null,
    })
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

  private operationsOrderScope(userId: string): Prisma.OrderWhereInput {
    const platformChannel: Prisma.OrderWhereInput = {
      OR: [
        { fulfillmentChannel: "PLATFORM" },
        {
          fulfillmentChannel: null,
          website: { ownershipType: "PLATFORM" },
        },
      ],
    }
    const activeAssignment = { status: { in: ["ASSIGNED", "IN_PROGRESS"] } }
    const claimableStatuses = [
      "SUBMITTED",
      "ACCEPTED",
      "CONTENT_REQUESTED",
      "CONTENT_CREATION",
      "CONTENT_READY",
      "CUSTOMER_REVIEW",
      "APPROVED",
    ]

    return {
      OR: [
        {
          AND: [
            platformChannel,
            {
              OR: [
                {
                  fulfillmentAssignments: {
                    some: { assignedToUserId: userId },
                  },
                },
                {
                  AND: [
                    { status: { in: claimableStatuses as any } },
                    {
                      fulfillmentAssignments: { none: activeAssignment as any },
                    },
                  ],
                },
              ],
            },
          ],
        },
        { tickets: { some: { assignedToUserId: userId } } },
        {
          dispute: {
            is: { status: { in: ["OPEN", "UNDER_REVIEW"] } },
          },
        },
        {
          cancellationRequests: {
            some: {
              status: { in: ["REQUESTED", "UNDER_REVIEW", "ESCALATED"] },
            },
          },
        },
        {
          activeDeliveryVersion: {
            is: { verificationStatus: { in: ["FAILED", "MANUAL_REVIEW"] } },
          },
        },
      ],
    }
  }

  async listOrders(take = 50, skip = 0, user?: any) {
    // Phase 6.7 — explicit projection. The previous `include: { website: true }`
    // leaked Website.verificationToken (the DNS-TXT verification secret) to
    // every Finance/Ops staffer. Customer is also narrowed (no banReason,
    // no emailVerified internal field). Org excludes the opaque `settings`
    // JSON. None of these are required for refund / dispute / fulfillment
    // investigations — they exist on the Order row directly via FKs.
    const isOperations = user?.staffRole === "OPERATIONS"

    return this.prisma.order.findMany({
      where: isOperations ? this.operationsOrderScope(user.id) : undefined,
      orderBy: { createdAt: "desc" },
      take,
      skip,
      include: {
        organization: {
          select: {
            id: true,
            name: true,
            ...(!isOperations && { slug: true }),
          },
        },
        customer: {
          select: {
            id: true,
            name: true,
            ...(!isOperations && { email: true, userType: true }),
          },
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

  async getOrder(id: string, user?: any) {
    const order = await this.prisma.order.findFirst({
      where: {
        id,
        ...(user?.staffRole === "OPERATIONS"
          ? { AND: [this.operationsOrderScope(user.id)] }
          : {}),
      },
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
            publisher: {
              select: {
                id: true,
                name: true,
                email: true,
                tier: true,
                profile: { select: { trustScore: true } },
              },
            },
            managedBy: { select: { id: true, name: true, email: true } },
          },
        },
        items: {
          include: {
            website: { select: { id: true, url: true, publisherId: true } },
          },
        },
        events: { orderBy: { createdAt: "desc" } },
        activeDeliveryVersion: {
          include: {
            evidence: { orderBy: { createdAt: "desc" } },
            fraudFlags: true,
            snapshots: true,
            adminVerifiedBy: { select: { id: true, name: true, email: true } },
          },
        },
        settlements: {
          include: {
            approvals: true,
            publisher: { select: { id: true, name: true, tier: true } },
          },
        },
        dispute: true,
        contentOrder: true,
        revisions: true,
        platformRevenue: true,
        fulfillmentAssignments: {
          select: {
            id: true,
            assignedToUserId: true,
            status: true,
            assignedAt: true,
            completedAt: true,
          },
        },
      },
    })
    if (!order) throw new NotFoundException(`Order ${id} not found`)

    if (user?.staffRole === "OPERATIONS") {
      return {
        ...order,
        organization: order.organization
          ? { id: order.organization.id, name: order.organization.name }
          : null,
        customer: order.customer
          ? { id: order.customer.id, name: order.customer.name }
          : null,
        website: order.website
          ? {
              id: order.website.id,
              url: order.website.url,
              name: order.website.name,
              ownershipType: order.website.ownershipType,
              verificationStatus: order.website.verificationStatus,
              publisher: order.website.publisher
                ? {
                    id: order.website.publisher.id,
                    name: order.website.publisher.name,
                  }
                : null,
              managedBy: order.website.managedBy
                ? {
                    id: order.website.managedBy.id,
                    name: order.website.managedBy.name,
                  }
                : null,
            }
          : null,
        items: order.items.map((item) => ({
          ...item,
          website: item.website
            ? { id: item.website.id, url: item.website.url }
            : null,
        })),
        events: order.events.map((event) => ({
          id: event.id,
          eventType: event.eventType,
          actorId: event.actorId,
          message: event.message,
          createdAt: event.createdAt,
        })),
        activeDeliveryVersion: order.activeDeliveryVersion
          ? {
              ...order.activeDeliveryVersion,
              adminVerifiedBy: order.activeDeliveryVersion.adminVerifiedBy
                ? {
                    id: order.activeDeliveryVersion.adminVerifiedBy.id,
                    name: order.activeDeliveryVersion.adminVerifiedBy.name,
                  }
                : null,
            }
          : null,
        settlements: [],
        platformRevenue: null,
      }
    }

    const approverIds = [
      ...new Set(
        order.settlements.flatMap((settlement) =>
          settlement.approvals
            .map((approval) => approval.approvedBy)
            .filter((approvedBy) => !approvedBy.startsWith("SYSTEM_")),
        ),
      ),
    ]
    const approvers = approverIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: approverIds } },
          select: { id: true, name: true, email: true },
        })
      : []
    const approverById = new Map(approvers.map((user) => [user.id, user]))

    return {
      ...order,
      settlements: order.settlements.map((settlement) => ({
        ...settlement,
        approvals: settlement.approvals.map((approval) => ({
          ...approval,
          approvedByUser: approverById.get(approval.approvedBy) ?? null,
        })),
      })),
    }
  }

  async listPlatformOrders(status?: string, take = 50, skip = 0, user?: any) {
    const activeAssignment = { status: { in: ["ASSIGNED", "IN_PROGRESS"] } }
    const claimableStatuses = [
      "SUBMITTED",
      "ACCEPTED",
      "CONTENT_REQUESTED",
      "CONTENT_CREATION",
      "CONTENT_READY",
      "CUSTOMER_REVIEW",
      "APPROVED",
    ]
    const where: any = {
      OR: [
        { fulfillmentChannel: "PLATFORM" },
        { fulfillmentChannel: null, website: { ownershipType: "PLATFORM" } },
      ],
    }

    if (status) where.status = status
    if (user?.staffRole === "OPERATIONS") {
      where.AND = [
        {
          OR: [
            {
              fulfillmentAssignments: {
                some: { ...activeAssignment, assignedToUserId: user.id },
              },
            },
            {
              AND: [
                { status: { in: claimableStatuses } },
                { fulfillmentAssignments: { none: activeAssignment } },
              ],
            },
          ],
        },
      ]
    }

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

  async listMarketplaceListings(params: {
    status?: string
    type?: string
    search?: string
    ownerType?: string
    page?: number
    limit?: number
  }) {
    const page = Number.isFinite(params.page) ? Math.max(1, params.page!) : 1
    const limit = Number.isFinite(params.limit)
      ? Math.min(100, Math.max(1, params.limit!))
      : 20
    const where: any = {}
    if (params.status) where.status = params.status
    if (params.type)
      where.services = {
        some: { availability: "AVAILABLE", serviceType: params.type as any },
      }
    if (params.ownerType) where.ownerType = params.ownerType

    if (params.search) {
      where.OR = [
        { title: { contains: params.search, mode: "insensitive" } },
        { description: { contains: params.search, mode: "insensitive" } },
        {
          website: {
            domain: { contains: params.search, mode: "insensitive" },
          },
        },
      ]
    }

    const [listings, total] = await Promise.all([
      this.prisma.marketplaceListing.findMany({
        where,
        orderBy: [{ createdAt: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          categories: {
            include: {
              category: { select: { id: true, name: true, slug: true } },
            },
          },
          organization: { select: { name: true } },
          publisher: { select: { name: true } },
          website: {
            select: {
              id: true,
              url: true,
              domain: true,
              verificationStatus: true,
              verifiedAt: true,
              managedByUserId: true,
              managedBy: {
                select: { id: true, name: true, email: true },
              },
            },
          },
          // Phase 7: ALL service rows (not just AVAILABLE) so the Manage
          // Services dialog shows PAUSED/WAITLIST rows too. priceFrom +
          // serviceTypes are computed from only AVAILABLE rows below.
          services: {
            orderBy: [{ availability: "asc" }, { price: "asc" }],
          },
        },
      }),
      this.prisma.marketplaceListing.count({ where }),
    ])

    return {
      listings: listings.map((l) => {
        // Compute display fields from only AVAILABLE services (PAUSED/WAITLIST
        // rows still appear in the raw services[] for the Manage dialog).
        const available = l.services.filter(
          (s) => s.availability === "AVAILABLE",
        )
        return {
          id: l.id,
          title: l.title,
          slug: l.slug,
          type: available[0]?.serviceType ?? null,
          serviceTypes: Array.from(
            new Set(available.map((s) => s.serviceType)),
          ),
          priceFrom:
            available[0]?.price != null ? Number(available[0].price) : null,
          status: l.status,
          price: available[0]?.price != null ? Number(available[0].price) : 0,
          currency: l.currency,
          domainRating: l.domainRating,
          traffic: l.traffic,
          ownerType: l.ownerType,
          fulfillmentType: l.fulfillmentType,
          featured: l.featured,
          verified: l.verified,
          categories: l.categories.map((item) => item.category),
          category: l.categories[0]?.category ?? null,
          organization: l.organization,
          publisher: l.publisher,
          websiteVerificationStatus: l.website?.verificationStatus ?? null,
          websiteVerifiedAt: l.website?.verifiedAt?.toISOString() ?? null,
          websiteDomain: l.website?.domain ?? null,
          websiteUrl: l.website?.url ?? null,
          websiteManagedBy: l.website?.managedBy ?? null,
          createdAt: l.createdAt.toISOString(),
          // Phase 7: ALL service rows for the Manage Services dialog
          services: l.services.map((s) => ({
            id: s.id,
            serviceType: s.serviceType,
            price: Number(s.price),
            turnaroundDays: s.turnaroundDays,
            revisionRounds: s.revisionRounds,
            warrantyDays: s.warrantyDays,
            availability: s.availability,
            currency: s.currency,
            version: s.version,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
          })),
        }
      }),
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
    const operationsModerationStatuses: ListingStatus[] = [
      ListingStatus.APPROVED,
      ListingStatus.REJECTED,
      ListingStatus.PAUSED,
    ]
    if (
      user?.staffRole === "OPERATIONS" &&
      !operationsModerationStatuses.includes(status as ListingStatus)
    ) {
      throw new ForbiddenException(
        "Operations can approve, reject, or pause listings but cannot edit their lifecycle history",
      )
    }
    const listing = await this.prisma.marketplaceListing.findUnique({
      where: { id },
      include: {
        publisher: { select: { email: true } },
        website: { select: { verificationStatus: true, domain: true } },
        categories: { select: { categoryId: true } },
        services: {
          where: { availability: "AVAILABLE" },
          take: 1,
          select: { id: true },
        },
      },
    })
    if (!listing) throw new NotFoundException("Listing not found")

    if (status === ListingStatus.APPROVED && listing.services.length === 0) {
      throw new BadRequestException({
        code: "NO_AVAILABLE_SERVICES",
        message:
          "Cannot approve: add at least one available service to the listing first.",
      })
    }
    if (
      status === ListingStatus.APPROVED &&
      (listing.categories.length < 1 ||
        listing.categories.length > 7 ||
        !isMarketplaceLanguage(listing.language) ||
        !hasCompleteListingPolicy(listing))
    ) {
      throw new BadRequestException({
        code: "LISTING_METADATA_INCOMPLETE",
        message:
          "Cannot approve: choose 1-7 categories, one primary language, and every listing policy value first.",
      })
    }

    // Domain ownership gate: a publisher listing cannot be APPROVED until its
    // website is VERIFIED. Platform listings have no website (or a VERIFIED one)
    // and pass through. Only SUPER_ADMIN may emergency-override, and the bypass
    // is audited.
    if (
      status === ListingStatus.APPROVED &&
      listing.website &&
      listing.website.verificationStatus !== "VERIFIED"
    ) {
      if (!(force && user.staffRole === "SUPER_ADMIN")) {
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
    const isOperations = user?.staffRole === "OPERATIONS"
    if (!isOperations) this.assertWebsiteInventoryWriteAccess(user)

    const inputIssue = validateWebsiteEnlistmentInput({
      url: dto.url,
      name: dto.name,
      country: dto.country,
      listingTitle: dto.listingTitle,
      description: dto.description,
    })[0]
    if (inputIssue) {
      throw new BadRequestException(inputIssue)
    }

    const domain = normalizeDomain(dto.url)
    const canonicalDomain = domain
    const existing = await this.prisma.website.findFirst({
      where: { OR: [{ url: dto.url }, { domain }, { canonicalDomain }] },
    })
    if (existing)
      throw new BadRequestException(
        `Website with this domain already exists (${existing.url})`,
      )

    const marketplaceCategories = await requireActiveMarketplaceCategories(
      this.prisma,
      dto.categoryIds,
    )

    // An Operations-created site is always assigned to its creator. A crafted
    // managedByUserId cannot transfer inventory; only Super Admin can select a
    // different owner or use the separate reassignment workflow.
    let managedByUserId: string | null = null
    if (isOperations) {
      managedByUserId = user.id
    } else if (dto.managedByUserId) {
      const target = await this.prisma.staffMembership.findUnique({
        where: { userId: dto.managedByUserId },
        select: { role: true, user: { select: { banned: true } } },
      })
      if (target?.role !== "OPERATIONS" || target.user.banned) {
        throw new BadRequestException({
          code: "INVALID_OWNER",
          message:
            "managedByUserId must reference an active OPERATIONS staff member",
        })
      }
      managedByUserId = dto.managedByUserId
    }

    let website: any
    try {
      website = await this.prisma.$transaction(async (tx: any) => {
        const createdWebsite = await tx.website.create({
          data: {
            url: dto.url,
            domain,
            canonicalDomain,
            name: dto.name ?? null,
            country: dto.country ?? null,
            language: dto.language,
            category: marketplaceCategories
              .map((category) => category.name)
              .join(", "),
            ownershipType: WebsiteOwnershipType.PLATFORM,
            isActive: true,
            managedByUserId,
            // Platform inventory intentionally bypasses DNS ownership checks.
            // GSC/GA4 links are performance-data integrations, not ownership
            // gates, and are managed separately from the listing lifecycle.
            verificationStatus: WebsiteVerificationStatus.VERIFIED,
          },
        })

        // A platform website and its single draft marketplace listing are one
        // aggregate. Creating them transactionally prevents orphan sites and
        // removes the old second listing-creation path from Marketplace.
        const listing = await tx.marketplaceListing.create({
          data: {
            title: dto.listingTitle.trim(),
            slug: `platform-${createdWebsite.id}`,
            description: dto.description.trim(),
            status: ListingStatus.DRAFT,
            fulfillmentType: "INTERNAL",
            currency: "USD",
            country: dto.country ?? null,
            language: dto.language,
            websiteUrl: dto.url,
            websiteId: createdWebsite.id,
            organizationId: null,
            publisherId: null,
            ownerType: "PLATFORM",
            sportsGamingAllowed: dto.sportsGamingAllowed,
            pharmacyAllowed: dto.pharmacyAllowed,
            cryptoAllowed: dto.cryptoAllowed,
            backlinkCount: dto.backlinkCount,
            linkType: dto.linkType,
            linkValidity: dto.linkValidity,
            googleNews: dto.googleNews,
            markedSponsored: dto.markedSponsored,
            foreignLanguageAllowed: dto.foreignLanguageAllowed,
            categories: {
              create: marketplaceCategories.map((category) => ({
                category: { connect: { id: category.id } },
              })),
            },
          },
        })

        return { ...createdWebsite, listing }
      })
    } catch (error: any) {
      if (error?.code === "P2002") {
        throw new BadRequestException({
          code: "DOMAIN_ALREADY_REGISTERED",
          message: `Domain ${canonicalDomain} is already registered`,
        })
      }
      throw error
    }

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
        select: { role: true, user: { select: { banned: true } } },
      })
      if (target?.role !== "OPERATIONS" || target.user.banned) {
        throw new BadRequestException({
          code: "INVALID_OWNER",
          message:
            "managedByUserId must reference an active OPERATIONS staff member",
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
      where: { role: "OPERATIONS", user: { banned: false } },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    })
    return memberships.map((m) => ({
      id: m.user.id,
      name: m.user.name,
      email: m.user.email,
    }))
  }

  private assertWebsiteInventoryWriteAccess(user: any) {
    if (user?.staffRole !== "SUPER_ADMIN") {
      throw new ForbiddenException(
        "Only Super Admin can edit platform website inventory",
      )
    }
  }

  async updatePlatformWebsite(id: string, dto: any, user: any) {
    const website = await this.prisma.website.findUnique({ where: { id } })
    if (!website) throw new NotFoundException("Website not found")
    if (website.ownershipType !== "PLATFORM")
      throw new BadRequestException(
        "Only platform websites can be updated via admin",
      )
    this.assertWebsiteInventoryWriteAccess(user)

    const marketplaceCategories = dto.categoryIds
      ? await requireActiveMarketplaceCategories(this.prisma, dto.categoryIds)
      : null

    const updated = await this.prisma.website.update({
      where: { id },
      data: {
        name: dto.name ?? website.name,
        country: dto.country ?? website.country,
        language: dto.language ?? website.language,
        category:
          marketplaceCategories?.map((category) => category.name).join(", ") ??
          website.category,
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
          title: dto.listingTitle ?? dto.name ?? listing.title,
          description: dto.description ?? listing.description,
          country: dto.country ?? listing.country,
          language: dto.language ?? listing.language,
          ...(dto.sportsGamingAllowed !== undefined
            ? { sportsGamingAllowed: dto.sportsGamingAllowed }
            : {}),
          ...(dto.pharmacyAllowed !== undefined
            ? { pharmacyAllowed: dto.pharmacyAllowed }
            : {}),
          ...(dto.cryptoAllowed !== undefined
            ? { cryptoAllowed: dto.cryptoAllowed }
            : {}),
          ...(dto.backlinkCount !== undefined
            ? { backlinkCount: dto.backlinkCount }
            : {}),
          ...(dto.linkType !== undefined ? { linkType: dto.linkType } : {}),
          ...(dto.linkValidity !== undefined
            ? { linkValidity: dto.linkValidity }
            : {}),
          ...(dto.googleNews !== undefined
            ? { googleNews: dto.googleNews }
            : {}),
          ...(dto.markedSponsored !== undefined
            ? { markedSponsored: dto.markedSponsored }
            : {}),
          ...(dto.foreignLanguageAllowed !== undefined
            ? { foreignLanguageAllowed: dto.foreignLanguageAllowed }
            : {}),
          ...(marketplaceCategories
            ? {
                categories: {
                  deleteMany: {},
                  create: marketplaceCategories.map((category) => ({
                    category: { connect: { id: category.id } },
                  })),
                },
              }
            : {}),
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

  async listWebsites(ownershipType?: string, take = 50, skip = 0, user?: any) {
    const where: any = {}
    if (ownershipType) where.ownershipType = ownershipType

    // Scope: OPS staff only sees websites assigned to them.
    if (user?.staffRole === "OPERATIONS") {
      where.managedByUserId = user.id
    }

    const [websites, total] = await Promise.all([
      this.prisma.website.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take,
        skip,
        include: {
          marketplaceListings: {
            take: 1,
            orderBy: { createdAt: "desc" },
            include: {
              categories: { include: { category: true } },
              services: {
                orderBy: [{ availability: "asc" }, { price: "asc" }],
              },
            },
          },
          publisher: { select: { id: true, name: true } },
          // Phase 6.5: surface the platform-site owner so the admin
          // websites page can render the "Managed by" column without a
          // second round-trip per row.
          managedBy: { select: { id: true, name: true, email: true } },
          websiteIntegrations: {
            where: { status: { not: "REMOVED" } },
            include: {
              integration: {
                select: { id: true, provider: true, status: true },
              },
            },
          },
        },
      }),
      this.prisma.website.count({ where }),
    ])

    return {
      websites: websites.map((w) => ({
        id: w.id,
        url: w.url,
        name: w.name,
        domain: w.domain,
        category: w.category,
        language: w.language,
        country: w.country,
        isActive: w.isActive,
        ownershipType: w.ownershipType,
        managedByUserId: w.managedByUserId,
        managedBy: w.managedBy,
        metrics: w.metrics,
        publisher: w.publisher,
        listing: w.marketplaceListings[0]
          ? {
              ...w.marketplaceListings[0],
              categories: w.marketplaceListings[0].categories.map(
                (item) => item.category,
              ),
              category:
                w.marketplaceListings[0].categories[0]?.category ?? null,
              services: w.marketplaceListings[0].services.map((service) => ({
                ...service,
                price: Number(service.price),
              })),
            }
          : null,
        integrations: w.websiteIntegrations.map((linked) => ({
          id: linked.id,
          integrationId: linked.integrationId,
          provider: linked.integration.provider,
          integrationStatus: linked.integration.status,
          status: linked.status,
          externalResourceId: linked.externalResourceId,
          externalResourceName: linked.externalResourceName,
          syncedAt: linked.syncedAt?.toISOString() ?? null,
        })),
        createdAt: w.createdAt.toISOString(),
      })),
      pagination: { take, skip, total },
    }
  }

  async getWebsite(id: string, user?: any) {
    const website = await this.prisma.website.findFirst({
      where: {
        id,
        ...(user?.staffRole === "OPERATIONS"
          ? { ownershipType: "PLATFORM", managedByUserId: user.id }
          : {}),
      },
      include: {
        marketplaceListings: {
          take: 1,
          orderBy: { createdAt: "desc" },
          include: {
            categories: { include: { category: true } },
            services: {
              orderBy: [{ availability: "asc" }, { price: "asc" }],
            },
          },
        },
        publisher: true,
        managedBy: { select: { id: true, name: true, email: true } },
        websiteIntegrations: {
          where: { status: { not: "REMOVED" } },
          include: {
            integration: {
              select: { id: true, provider: true, status: true },
            },
          },
        },
        orders: {
          take: 10,
          orderBy: { createdAt: "desc" },
          include: { organization: { select: { name: true } } },
        },
      },
    })
    if (!website) throw new NotFoundException("Website not found")
    const listing = website.marketplaceListings[0] ?? null
    return {
      id: website.id,
      url: website.url,
      name: website.name,
      domain: website.domain,
      category: website.category,
      language: website.language,
      country: website.country,
      isActive: website.isActive,
      ownershipType: website.ownershipType,
      managedByUserId: website.managedByUserId,
      managedBy: website.managedBy,
      metrics: website.metrics,
      publisher: website.publisher,
      listing: listing
        ? {
            ...listing,
            categories: listing.categories.map((item) => item.category),
            category: listing.categories[0]?.category ?? null,
            services: listing.services.map((service) => ({
              ...service,
              price: Number(service.price),
            })),
          }
        : null,
      integrations: website.websiteIntegrations.map((linked) => ({
        id: linked.id,
        integrationId: linked.integrationId,
        provider: linked.integration.provider,
        integrationStatus: linked.integration.status,
        status: linked.status,
        externalResourceId: linked.externalResourceId,
        externalResourceName: linked.externalResourceName,
        syncedAt: linked.syncedAt?.toISOString() ?? null,
      })),
      orders: website.orders,
      createdAt: website.createdAt.toISOString(),
      updatedAt: website.updatedAt.toISOString(),
    }
  }

  async pauseWebsite(id: string, paused: boolean, user: any) {
    const website = await this.prisma.website.findUnique({ where: { id } })
    if (!website) throw new NotFoundException("Website not found")
    if (website.ownershipType !== "PLATFORM") {
      throw new BadRequestException("Only platform websites can be paused")
    }
    this.assertWebsiteInventoryWriteAccess(user)

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
    this.assertWebsiteInventoryWriteAccess(user)

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

  // ── Support tickets ─────────────────────────────────────────────────
  // Phase 6.6: the four legacy bypass methods (listTicketsAdmin /
  // getTicketAdmin / updateTicketStatusAdmin / addTicketMessageAdmin) were
  // removed. The admin support routes now delegate to SupportService with
  // the staff actor, so the channel-aware visibility matrix is the single
  // code path used by customer/publisher/admin frontends.

  // ── Platform configuration (FIN-08) ────────────────────────────────
  // PlatformSettings is a singleton (one row). `updatePlatformFee` reads
  // the row, bounds-checks the new value, swaps it with an optimistic-lock
  // `updateMany({ where: { version } })` and writes a structured audit
  // event (`PLATFORM_SETTINGS_UPDATED`) capturing `{ field, oldValue,
  // newValue, reason }`. The generic action name means future settings
  // (tax rate, payout threshold) flow through the same audit shape
  // automatically — only the `field` discriminator changes.
  async getPlatformSettings() {
    let settings = await this.prisma.platformSettings.findFirst()
    if (!settings) {
      settings = await this.prisma.platformSettings.create({ data: {} })
    }
    return settings
  }

  async updatePlatformFee(
    platformFeePct: number,
    reason: string,
    actor: { id: string },
  ) {
    // Clamp defensively — the DTO already bounds 0–100, but a future
    // internal callsite might bypass the pipe.
    const clamped = Math.min(Math.max(platformFeePct, 0), 100)

    return this.prisma.$transaction(async (tx: any) => {
      const settings = await tx.platformSettings.findFirst()
      if (!settings) {
        throw new NotFoundException("PlatformSettings row not initialized")
      }

      const oldValue = Number(settings.platformFeePct)
      if (oldValue === clamped) {
        throw new BadRequestException(
          `platformFeePct is already ${clamped} — no change`,
        )
      }

      // Optimistic-lock via version — concurrent fee changes resolve to one
      // winner; the loser retries. `updateMany` returns count 0 → conflict.
      const updated = await tx.platformSettings.updateMany({
        where: { id: settings.id, version: settings.version },
        data: {
          platformFeePct: clamped,
          version: { increment: 1 },
        },
      })
      if (updated.count === 0) {
        throw new ConflictException(
          "PlatformSettings was modified by another request. Retry.",
        )
      }

      await this.audit.log(
        {
          action: "PLATFORM_SETTINGS_UPDATED",
          entityType: "PlatformSettings",
          entityId: settings.id,
          metadata: {
            field: "platformFeePct",
            oldValue,
            newValue: clamped,
            reason,
          },
          userId: actor.id,
          organizationId: null,
        },
        tx,
      )

      return {
        id: settings.id,
        platformFeePct: clamped,
      }
    })
  }
}
