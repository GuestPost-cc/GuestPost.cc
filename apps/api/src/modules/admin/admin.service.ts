import { hashPassword } from "@better-auth/utils/password"
import {
  FulfillmentChannel,
  ListingStatus,
  ModerationAction,
  ModerationAuthority,
  ModerationReasonCode,
  OrderStatus,
  type Prisma,
  WebsiteMetricKey,
  WebsiteMetricProvider,
  WebsiteMetricSource,
  WebsiteOwnershipType,
  WebsiteVerificationStatus,
} from "@guestpost/database"
import {
  buildModerationProjection,
  evaluateSettlementReleaseEvidence,
  getOrderLifecycleStage,
  getOrderLifecycleStageIndex,
  getStaffListingModerationActions,
  getStaffWebsiteModerationActions,
  isOrderLifecycleException,
  isPostPublicationPublisherOrder,
  platformFeePercentToBasisPoints,
  QUEUES,
  runSerializableTransactionWithRetry,
  StaffRole,
  validateWebsiteEnlistmentInput,
} from "@guestpost/shared"
import {
  isPrismaUniqueConstraintError,
  isRetryablePrismaTransactionError,
} from "@guestpost/shared/dist/prisma-transaction-retry"
import { lockPublisherTierMutation } from "@guestpost/shared/dist/publisher-trust-core"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
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
import { CommunicationsService } from "../communications/communications.service"
import { buildOrderStakeholderTimeline } from "../orders/order-stakeholder-timeline"
import { QueueService } from "../queues/queue.service"
import { operationsPlatformSupportWhere } from "../support/support-routing"
import {
  assertManualMetricValues,
  assertMeasurementDate,
  manualMetricExpiry,
  serializeMarketplaceDomainMetrics,
  upsertWebsiteMetric,
} from "../websites/website-metrics.service"

const VALID_STAFF_ROLES: StaffRole[] = ["SUPER_ADMIN", "OPERATIONS", "FINANCE"]

type SuspensionReason =
  | "SECURITY_RISK"
  | "FRAUD_OR_ABUSE"
  | "TERMS_VIOLATION"
  | "PAYMENT_RISK"
  | "COMPLIANCE"
  | "STAFF_ACCESS_REMOVAL"
  | "OTHER"

interface SuspendUserInput {
  reasonCode: SuspensionReason
  internalNote: string
  expiresAt?: string
}

interface ListingModerationCommand {
  action: ModerationAction
  reasonCode: ModerationReasonCode
  publisherMessage?: string
  internalNote?: string
  expectedVersion: number
  force?: boolean
}

interface WebsiteModerationCommand {
  action: ModerationAction
  reasonCode: ModerationReasonCode
  publisherMessage?: string
  internalNote?: string
  expectedVersion: number
}

type AdminOrderFocus = "all" | "attention" | "active" | "completed"

interface AdminOrderListParams {
  take?: number
  skip?: number
  search?: string
  status?: OrderStatus
  channel?: FulfillmentChannel
  focus?: AdminOrderFocus
  user?: { id: string; staffRole: StaffRole }
}

type IntegrityCheckStatus = "PASS" | "WARN" | "FAIL" | "NOT_APPLICABLE"

function financialUnits(value: unknown): bigint | null {
  const text = String(value ?? "")
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null
  const negative = text.startsWith("-")
  const [whole, fraction = ""] = (negative ? text.slice(1) : text).split(".")
  const units =
    BigInt(whole) * 1_000_000_000_000n +
    BigInt(`${fraction}000000000000`.slice(0, 12))
  return negative ? -units : units
}

function buildOrderIntegrityReport(
  order: any,
  activeAssignment: any,
  platformChannel: boolean,
) {
  const checks: Array<{
    key: string
    label: string
    status: IntegrityCheckStatus
    message: string
  }> = []
  const exception = isOrderLifecycleException(order.status)
  const expectedChannel = order.website?.ownershipType ?? null
  const actualChannel =
    order.fulfillmentChannel ?? order.website?.ownershipType ?? null

  checks.push(
    !order.website
      ? {
          key: "ROUTING",
          label: "Fulfillment routing",
          status: "WARN",
          message: "The order has no website context to verify its route.",
        }
      : expectedChannel && actualChannel !== expectedChannel
        ? {
            key: "ROUTING",
            label: "Fulfillment routing",
            status: "FAIL",
            message:
              "The stored fulfillment channel conflicts with website ownership.",
          }
        : {
            key: "ROUTING",
            label: "Fulfillment routing",
            status: "PASS",
            message: "Fulfillment channel and website ownership agree.",
          },
  )

  const claimableStatuses: string[] = [
    "SUBMITTED",
    "ACCEPTED",
    "CONTENT_REQUESTED",
    "CONTENT_CREATION",
    "CONTENT_READY",
    "CUSTOMER_REVIEW",
    "APPROVED",
  ]
  checks.push(
    !platformChannel
      ? {
          key: "ASSIGNMENT",
          label: "Operations assignment",
          status: "NOT_APPLICABLE",
          message: "Publisher fulfillment does not require an Ops assignment.",
        }
      : exception || !claimableStatuses.includes(order.status)
        ? {
            key: "ASSIGNMENT",
            label: "Operations assignment",
            status: "NOT_APPLICABLE",
            message:
              "No active Operations assignment is required at this stage.",
          }
        : activeAssignment
          ? {
              key: "ASSIGNMENT",
              label: "Operations assignment",
              status: "PASS",
              message: "An active fulfillment assignment is recorded.",
            }
          : {
              key: "ASSIGNMENT",
              label: "Operations assignment",
              status: "WARN",
              message:
                "This platform order is still available in the shared queue.",
            },
  )

  const deliveryRequired = [
    "PUBLISHED",
    "VERIFIED",
    "DELIVERED",
    "COMPLETED",
  ].includes(order.status)
  checks.push(
    exception || !deliveryRequired
      ? {
          key: "DELIVERY",
          label: "Delivery evidence",
          status: "NOT_APPLICABLE",
          message: "Delivery evidence is not required at this lifecycle stage.",
        }
      : !order.activeDeliveryVersion?.publishedUrl
        ? {
            key: "DELIVERY",
            label: "Delivery evidence",
            status: "FAIL",
            message: "The order stage requires an active published URL.",
          }
        : ["FAILED", "MANUAL_REVIEW"].includes(
              order.activeDeliveryVersion.verificationStatus,
            )
          ? {
              key: "DELIVERY",
              label: "Delivery evidence",
              status: "WARN",
              message:
                "Delivery evidence exists but verification needs review.",
            }
          : {
              key: "DELIVERY",
              label: "Delivery evidence",
              status: "PASS",
              message:
                "The active delivery has a published URL and evidence state.",
            },
  )

  const financiallyFinal = ["DELIVERED", "COMPLETED"].includes(order.status)
  const activeSettlements = (order.settlements ?? []).filter(
    (settlement: any) => settlement.status !== "CANCELLED",
  )
  const latestSettlement = activeSettlements[0]
  const completedPublisherRelease =
    !platformChannel &&
    order.status === "COMPLETED" &&
    activeSettlements.length === 1
      ? evaluateSettlementReleaseEvidence({
          settlement: latestSettlement,
          transactions: latestSettlement.transactions ?? [],
          events: order.events ?? [],
        })
      : null
  const platformGross = financialUnits(order.platformRevenue?.amount)
  const platformSplit =
    financialUnits(order.platformRevenue?.platformFee) != null &&
    financialUnits(order.platformRevenue?.netRevenue) != null
      ? financialUnits(order.platformRevenue.platformFee)! +
        financialUnits(order.platformRevenue.netRevenue)!
      : null
  const orderGross = financialUnits(order.amount)
  const platformRevenueBalanced =
    platformGross != null &&
    platformSplit != null &&
    orderGross != null &&
    platformGross === platformSplit &&
    platformGross === orderGross
  checks.push(
    exception || !financiallyFinal
      ? {
          key: "FINANCIAL_RECORD",
          label: "Financial record",
          status: "NOT_APPLICABLE",
          message: "A final financial record is not required at this stage.",
        }
      : platformChannel
        ? latestSettlement
          ? {
              key: "FINANCIAL_RECORD",
              label: "Financial record",
              status: "FAIL",
              message:
                "A platform route has an unexpected publisher settlement.",
            }
          : !order.platformRevenue
            ? {
                key: "FINANCIAL_RECORD",
                label: "Financial record",
                status: "FAIL",
                message:
                  "The final platform route is missing its revenue record.",
              }
            : order.platformRevenue.reversedAt
              ? {
                  key: "FINANCIAL_RECORD",
                  label: "Financial record",
                  status: "FAIL",
                  message:
                    "The final platform route has a reversed revenue record.",
                }
              : !platformRevenueBalanced
                ? {
                    key: "FINANCIAL_RECORD",
                    label: "Financial record",
                    status: "FAIL",
                    message:
                      "Platform revenue does not equal the order gross and fee plus net-revenue split.",
                  }
                : {
                    key: "FINANCIAL_RECORD",
                    label: "Financial record",
                    status: "PASS",
                    message:
                      "Platform revenue reconciles to the order gross and revenue split.",
                  }
        : activeSettlements.length > 1
          ? {
              key: "FINANCIAL_RECORD",
              label: "Financial record",
              status: "FAIL",
              message:
                "The publisher route has multiple active settlement records.",
            }
          : latestSettlement &&
              (order.status !== "COMPLETED" ||
                completedPublisherRelease?.stateValid)
            ? {
                key: "FINANCIAL_RECORD",
                label: "Financial record",
                status: "PASS",
                message:
                  order.status === "COMPLETED"
                    ? "The publisher settlement is released with a release timestamp."
                    : "A publisher settlement record is linked to this delivered order.",
              }
            : {
                key: "FINANCIAL_RECORD",
                label: "Financial record",
                status: "FAIL",
                message:
                  order.status === "COMPLETED" && latestSettlement
                    ? "The completed publisher order does not have a released settlement with a release timestamp."
                    : "The final publisher route is missing its settlement record.",
              },
  )

  const releaseCheckNotApplicable =
    platformChannel || order.status !== "COMPLETED"
  checks.push(
    releaseCheckNotApplicable
      ? {
          key: "SETTLEMENT_RELEASE_LEDGER",
          label: "Settlement release ledger",
          status: "NOT_APPLICABLE",
          message:
            "Exact publisher release-ledger evidence is required only for completed publisher orders.",
        }
      : completedPublisherRelease?.ledgerValid
        ? {
            key: "SETTLEMENT_RELEASE_LEDGER",
            label: "Settlement release ledger",
            status: "PASS",
            message:
              "Exactly one release ledger row matches the settlement identity and amount.",
          }
        : {
            key: "SETTLEMENT_RELEASE_LEDGER",
            label: "Settlement release ledger",
            status: "FAIL",
            message:
              completedPublisherRelease?.issues.find((issue) =>
                issue.code.startsWith("SETTLEMENT_RELEASE_LEDGER_"),
              )?.message ??
              "The completed publisher order lacks one exact release ledger row.",
          },
  )
  checks.push(
    releaseCheckNotApplicable
      ? {
          key: "SETTLEMENT_RELEASE_EVENT",
          label: "Settlement release event",
          status: "NOT_APPLICABLE",
          message:
            "Exact publisher release-event evidence is required only for completed publisher orders.",
        }
      : completedPublisherRelease?.eventValid
        ? {
            key: "SETTLEMENT_RELEASE_EVENT",
            label: "Settlement release event",
            status: "PASS",
            message:
              "Exactly one release event is bound to the settlement and order.",
          }
        : {
            key: "SETTLEMENT_RELEASE_EVENT",
            label: "Settlement release event",
            status: "FAIL",
            message:
              completedPublisherRelease?.issues.find((issue) =>
                issue.code.startsWith("SETTLEMENT_RELEASE_EVENT_"),
              )?.message ??
              "The completed publisher order lacks one exact release event.",
          },
  )

  const latestEvent = order.events?.[0]
  const expectedMilestoneEvent: Record<string, string> = {
    PAID: "PAYMENT_CAPTURED",
    SUBMITTED: "ORDER_SUBMITTED",
    ACCEPTED: "ORDER_ACCEPTED",
    CUSTOMER_REVIEW: "CONTENT_SUBMITTED_FOR_REVIEW",
    APPROVED: "CONTENT_APPROVED",
    PUBLISHED: "PUBLICATION_MARKED",
    VERIFIED: "VERIFIED_AUTO",
    DELIVERED: "DELIVERY_CONFIRMED",
    COMPLETED: platformChannel ? "AUTO_ACCEPTED" : "SETTLEMENT_RELEASED",
    CANCELLED: "ORDER_CANCELLED",
    REFUNDED: "REFUNDED",
    DISPUTED: "DISPUTE_OPENED",
  }
  const expectedEvent = expectedMilestoneEvent[order.status]
  const acceptedMilestoneEvents =
    order.status === "COMPLETED"
      ? platformChannel
        ? ["DELIVERY_CONFIRMED", "AUTO_ACCEPTED"]
        : ["SETTLEMENT_RELEASED"]
      : order.status === "VERIFIED"
        ? ["VERIFIED_AUTO", "VERIFIED_MANUAL"]
        : order.status === "REFUNDED"
          ? ["REFUNDED", "REFUND_ISSUED"]
          : expectedEvent
            ? [expectedEvent]
            : []
  const hasExpectedEvent =
    acceptedMilestoneEvents.length === 0 ||
    order.events?.some((event: any) =>
      acceptedMilestoneEvents.includes(event.eventType),
    )
  const eventPredatesOrder =
    latestEvent &&
    new Date(latestEvent.createdAt).getTime() <
      new Date(order.createdAt).getTime()
  checks.push(
    !latestEvent
      ? {
          key: "EVENT_CHAIN",
          label: "Lifecycle audit trail",
          status: "FAIL",
          message: "No lifecycle event is recorded for this order.",
        }
      : !hasExpectedEvent
        ? {
            key: "EVENT_CHAIN",
            label: "Lifecycle audit trail",
            status: "FAIL",
            message: `The ${order.status} state is missing its canonical lifecycle event.`,
          }
        : eventPredatesOrder
          ? {
              key: "EVENT_CHAIN",
              label: "Lifecycle audit trail",
              status: "WARN",
              message: "The latest event timestamp predates the order record.",
            }
          : {
              key: "EVENT_CHAIN",
              label: "Lifecycle audit trail",
              status: "PASS",
              message: `${order.events.length} lifecycle event${order.events.length === 1 ? "" : "s"} recorded.`,
            },
  )

  const activeDispute =
    order.dispute && ["OPEN", "UNDER_REVIEW"].includes(order.dispute.status)
  const activeCancellation = order.cancellationRequests?.find((request: any) =>
    ["REQUESTED", "CONTESTED", "ESCALATED"].includes(request.status),
  )
  const activeHold = activeDispute
    ? "An active dispute pauses normal progression."
    : activeCancellation
      ? "An active cancellation request pauses normal progression."
      : null
  checks.push(
    activeHold
      ? {
          key: "ACTIVE_HOLD",
          label: "Exception hold",
          status: "WARN",
          message: activeHold,
        }
      : {
          key: "ACTIVE_HOLD",
          label: "Exception hold",
          status: "PASS",
          message: "No active dispute or cancellation hold is recorded.",
        },
  )

  const state = checks.some((check) => check.status === "FAIL")
    ? "BLOCKED"
    : checks.some((check) => check.status === "WARN")
      ? "ATTENTION"
      : "HEALTHY"
  const stage = getOrderLifecycleStage(order.status)

  return {
    state,
    checks,
    lifecycle: {
      stageKey: stage?.key ?? null,
      stageLabel: stage?.label ?? null,
      stageIndex: getOrderLifecycleStageIndex(order.status),
      isException: exception,
    },
  }
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
    @Optional() private readonly communications?: CommunicationsService,
  ) {}

  /**
   * Global lock order for commands that can remove staff authority:
   *
   *   every Staff User (id ASC), then the target User
   *
   * The first query is an intentionally small staff-access aggregate lock.
   * It makes demotion-vs-demotion and demotion-vs-suspension use the same
   * coordination rows. Keep this order identical in every caller: taking the
   * target lock first would allow two commands for different Super Admins to
   * deadlock while they subsequently try to lock the aggregate.
   */
  private async lockStaffAccessMutationScope(tx: any, userId: string) {
    await tx.$queryRaw`
      SELECT "id"
      FROM "User"
      WHERE "userType" = 'STAFF'
      ORDER BY "id" ASC
      FOR UPDATE
    `

    const lockedTarget = (await tx.$queryRaw`
      SELECT "id"
      FROM "User"
      WHERE "id" = ${userId}
      FOR UPDATE
    `) as Array<{ id: string }>

    if (lockedTarget.length !== 1) {
      throw new NotFoundException("User not found")
    }
  }

  private invalidPlatformWebsiteOwner() {
    return new BadRequestException({
      code: "INVALID_OWNER",
      message:
        "managedByUserId must reference an active OPERATIONS staff member",
    })
  }

  /**
   * Platform-site ownership participates in the staff offboarding lock order.
   * Re-reading eligibility only after this lock means exactly one side of a
   * concurrent assignment vs. demotion/suspension can commit:
   *
   *   every Staff User (id ASC), target User, then Website
   */
  private async lockAndAssertActiveOperationsOwner(tx: any, userId: string) {
    try {
      await this.lockStaffAccessMutationScope(tx, userId)
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw this.invalidPlatformWebsiteOwner()
      }
      throw error
    }

    const target = await tx.staffMembership.findUnique({
      where: { userId },
      select: {
        role: true,
        user: { select: { banned: true, userType: true } },
      },
    })
    if (
      target?.role !== "OPERATIONS" ||
      target.user.banned ||
      target.user.userType !== "STAFF"
    ) {
      throw this.invalidPlatformWebsiteOwner()
    }
  }

  /**
   * Operations authority cannot be removed while work is still routed to the
   * actor. These predicates run after the shared staff/target locks and inside
   * the same SERIALIZABLE transaction as the role or suspension write, so a
   * concurrent assignment cannot pass the check and commit an orphaned owner.
   *
   * RESOLVED support remains active ownership because an external participant
   * can reopen it. CLOSED is the only excluded state under the current staff
   * offboarding policy.
   */
  private async releaseClosedOperationsSupportOrThrow(
    tx: any,
    userId: string,
    action: "changing this Operations role" | "suspending this Operations user",
  ): Promise<number> {
    const activeAssignments = await tx.fulfillmentAssignment.count({
      where: {
        assignedToUserId: userId,
        status: { in: ["ASSIGNED", "IN_PROGRESS"] },
      },
    })
    if (activeAssignments > 0) {
      throw new ConflictException(
        `Reassign active fulfillment orders before ${action}`,
      )
    }

    const managedPlatformWebsites = await tx.website.count({
      where: {
        managedByUserId: userId,
        ownershipType: WebsiteOwnershipType.PLATFORM,
      },
    })
    if (managedPlatformWebsites > 0) {
      throw new ConflictException(
        `Reassign managed platform websites before ${action}`,
      )
    }

    const activeSupportTickets = await tx.ticket.count({
      where: {
        assignedToUserId: userId,
        status: { not: "CLOSED" },
      },
    })
    if (activeSupportTickets > 0) {
      throw new ConflictException(
        `Reassign non-closed support tickets before ${action}`,
      )
    }

    // Historical CLOSED tickets must not permanently pin a staff identity.
    // Clearing them in this same serializable transaction makes a later reopen
    // enter the unassigned support queue. A concurrent reopen/reply/reassign
    // locks or writes the same Ticket predicate and forces one transaction to
    // retry; Support mutations never take a conflicting Staff/User write lock
    // after their Ticket lock, so this does not introduce a lock-order cycle.
    const released = await tx.ticket.updateMany({
      where: {
        assignedToUserId: userId,
        status: "CLOSED",
      },
      data: { assignedToUserId: null },
    })
    return released.count
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
        banReasonCode: u.banReasonCode,
        banExpires: u.banExpires,
        suspendedAt: u.suspendedAt,
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
        suspendedBy: { select: { id: true, name: true, email: true } },
      },
    })
    if (!u) throw new NotFoundException("User not found")
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      userType: u.userType,
      banned: u.banned,
      banReasonCode: u.banReasonCode,
      banReason: u.banReason,
      banExpires: u.banExpires,
      suspendedAt: u.suspendedAt,
      suspendedBy: u.suspendedBy,
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
        banReasonCode: true,
        banExpires: true,
        suspendedAt: true,
        createdAt: true,
        staffMemberships: { select: { role: true, permissions: true } },
      },
    })
    const staffIds = staff.map((member) => member.id)
    if (staffIds.length === 0) {
      return {
        summary: {
          totalStaff: 0,
          activeStaff: 0,
          suspendedStaff: 0,
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
          ["DELIVERED", "COMPLETED"].includes(assignment.order.status),
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
        banReasonCode: member.banReasonCode,
        banExpires: member.banExpires,
        suspendedAt: member.suspendedAt,
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
        activeStaff: items.filter((item) => !item.banned).length,
        suspendedStaff: items.filter((item) => item.banned).length,
        superAdmins: items.filter(
          (item) => !item.banned && item.staffRole === "SUPER_ADMIN",
        ).length,
        operations: items.filter(
          (item) => !item.banned && item.staffRole === "OPERATIONS",
        ).length,
        finance: items.filter(
          (item) => !item.banned && item.staffRole === "FINANCE",
        ).length,
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
    const CUSTOMER_ROLES = ["OWNER", "MEMBER"] as const
    const PUBLISHER_ROLES = ["PUBLISHER_OWNER"] as const
    const customerRole = (CUSTOMER_ROLES as readonly string[]).includes(role)
    const publisherRole = (PUBLISHER_ROLES as readonly string[]).includes(role)

    if (!customerRole && !publisherRole) {
      const target = await this.prisma.user.findUnique({
        where: { id: userId },
      })
      if (!target) throw new NotFoundException("User not found")
      if (target.userType === "STAFF") {
        throw new BadRequestException(
          "Use /staff-role endpoint for staff users",
        )
      }
      throw new BadRequestException(`Invalid role: ${role}`)
    }

    try {
      const result = await runSerializableTransactionWithRetry(
        this.prisma,
        async (tx: any) => {
          // User is the first aggregate lock for every customer/publisher role
          // command. It serializes first-time provisioning and is also the
          // global lock order used by member removal: User(s), then Org.
          const lockedUsers = (await tx.$queryRaw`
            SELECT "id"
            FROM "User"
            WHERE "id" = ${userId}
            FOR UPDATE
          `) as Array<{ id: string }>
          if (lockedUsers.length !== 1) {
            throw new NotFoundException("User not found")
          }

          const target = await tx.user.findUnique({ where: { id: userId } })
          if (!target) throw new NotFoundException("User not found")

          if (customerRole) {
            if (target.userType !== "CUSTOMER") {
              throw new BadRequestException(
                "ACCOUNT_TYPE_IMMUTABLE: publisher and staff accounts cannot be converted to customers",
              )
            }

            let membership = await tx.membership.findFirst({
              where: { userId },
              orderBy: { createdAt: "asc" },
            })
            if (!membership) {
              // A freshly created personal org's sole member is its OWNER —
              // never the requested MEMBER role. MEMBER is meaningful only
              // when joining an existing organization through an invitation.
              const organization = await tx.organization.create({
                data: {
                  name: `Org for ${target.email}`,
                  slug: `org-${userId.slice(0, 8)}`,
                  memberships: { create: { userId, role: "OWNER" } },
                  wallets: {
                    create: {
                      userId,
                      currency: "USD",
                    },
                  },
                },
              })
              membership = await tx.membership.findFirstOrThrow({
                where: { userId, organizationId: organization.id },
              })
            } else {
              const membershipId = membership.id
              const organizationId = membership.organizationId
              // All existing-organization role changes take this aggregate
              // lock after the User lock so they serialize with member removal.
              await tx.$queryRaw`
                SELECT "id"
                FROM "Organization"
                WHERE "id" = ${organizationId}
                FOR UPDATE
              `

              const currentMembership = await tx.membership.findUnique({
                where: { id: membershipId },
              })
              if (
                !currentMembership ||
                currentMembership.userId !== userId ||
                currentMembership.organizationId !== organizationId
              ) {
                throw new ConflictException(
                  "Organization membership changed concurrently. Review the latest state and try again.",
                )
              }

              if (
                role === "MEMBER" &&
                currentMembership.role === "OWNER" &&
                currentMembership.status === "ACTIVE"
              ) {
                const activeOwnerCount = await tx.membership.count({
                  where: {
                    organizationId,
                    role: "OWNER",
                    status: "ACTIVE",
                  },
                })
                if (activeOwnerCount <= 1) {
                  throw new ConflictException(
                    "Promote another active organization owner before demoting this owner",
                  )
                }
              }

              membership = await tx.membership.update({
                where: { id: membershipId },
                data: { role: role as any },
              })
            }

            await this.audit.log(
              {
                action: "CUSTOMER_ROLE_UPDATE",
                entityType: "CustomerMembership",
                entityId: membership.id,
                metadata: {
                  newRole: membership.role,
                  requestedRole: role,
                  userId,
                },
                userId: user.id,
                organizationId: membership.organizationId,
              },
              tx,
            )
            return membership
          }

          if (target.userType !== "PUBLISHER") {
            throw new BadRequestException(
              "ACCOUNT_TYPE_IMMUTABLE: customer and staff accounts cannot be converted to publishers",
            )
          }

          let publisherMembership = await tx.publisherMembership.findFirst({
            where: { userId },
            orderBy: { createdAt: "asc" },
          })
          if (!publisherMembership) {
            // A user with no publisher membership gets a fresh publisher.
            // The User lock prevents concurrent role commands from creating
            // multiple publisher identities for the same account.
            let organizationId = (
              await tx.membership.findFirst({
                where: { userId },
                orderBy: { createdAt: "asc" },
                select: { organizationId: true },
              })
            )?.organizationId
            if (organizationId) {
              await tx.$queryRaw`
                SELECT "id"
                FROM "Organization"
                WHERE "id" = ${organizationId}
                FOR UPDATE
              `
            } else {
              const organization = await tx.organization.create({
                data: {
                  name: `Org for ${target.email}`,
                  slug: `org-${userId.slice(0, 8)}`,
                  wallets: {
                    create: {
                      userId,
                      currency: "USD",
                    },
                  },
                },
              })
              organizationId = organization.id
            }
            const publisher = await tx.publisher.create({
              data: {
                name: target.name ?? `${target.email}'s Publisher`,
                email: target.email,
                organizationId,
                balance: { create: {} },
              },
            })
            publisherMembership = await tx.publisherMembership.create({
              data: {
                userId,
                publisherId: publisher.id,
                role: "PUBLISHER_OWNER",
              },
            })
          } else {
            publisherMembership = await tx.publisherMembership.update({
              where: { id: publisherMembership.id },
              data: { role: "PUBLISHER_OWNER" },
            })
          }

          await this.audit.log(
            {
              action: "PUBLISHER_ROLE_UPDATE",
              entityType: "PublisherMembership",
              entityId: publisherMembership.id,
              metadata: { newRole: publisherMembership.role, userId },
              userId: user.id,
              organizationId: null,
            },
            tx,
          )
          return publisherMembership
        },
      )

      // Role changes must take effect immediately, but only after both the
      // mutation and its audit evidence commit.
      invalidateAuthContext(userId)
      return result
    } catch (error: any) {
      if (isRetryablePrismaTransactionError(error)) {
        throw new ConflictException(
          "User role changed concurrently. Review the latest state and try again.",
        )
      }
      if (isPrismaUniqueConstraintError(error)) {
        throw new ConflictException(
          "User role provisioning conflicted with existing identity data. Review the account and try again.",
        )
      }
      throw error
    }
  }

  async updateStaffRole(userId: string, role: string, user?: any) {
    if (!VALID_STAFF_ROLES.includes(role as StaffRole)) {
      throw new BadRequestException(`Invalid staff role: ${role}`)
    }
    if (!user?.id) throw new ForbiddenException("Administrator required")

    try {
      const result = await runSerializableTransactionWithRetry(
        this.prisma,
        async (tx: any) => {
          await this.lockStaffAccessMutationScope(tx, userId)

          // Re-read every decision input after acquiring the coordination and
          // target locks. Cached/request identity is never authoritative here.
          const target = await tx.user.findUnique({
            where: { id: userId },
            include: { staffMemberships: true },
          })
          if (!target) throw new NotFoundException("User not found")
          if (target.userType !== "STAFF") {
            throw new BadRequestException(
              "Customer and publisher accounts cannot be converted to staff",
            )
          }

          const existing = target.staffMemberships[0]
          if (!existing) {
            throw new NotFoundException("Staff membership not found")
          }
          if (user.id === userId && existing.role !== role) {
            throw new ForbiddenException(
              "A different Super Admin must change your staff role",
            )
          }
          if (
            !target.banned &&
            existing.role === "SUPER_ADMIN" &&
            role !== "SUPER_ADMIN"
          ) {
            const activeSuperAdmins = await tx.user.count({
              where: {
                userType: "STAFF",
                banned: false,
                staffMemberships: { some: { role: "SUPER_ADMIN" } },
              },
            })
            if (activeSuperAdmins <= 1) {
              throw new ConflictException(
                "At least one active Super Admin is required",
              )
            }
          }
          let releasedClosedSupportTickets = 0
          if (existing.role === "OPERATIONS" && role !== "OPERATIONS") {
            releasedClosedSupportTickets =
              await this.releaseClosedOperationsSupportOrThrow(
                tx,
                userId,
                "changing this Operations role",
              )
          }

          const updated = await tx.staffMembership.update({
            where: { id: existing.id },
            data: { role: role as StaffRole },
          })
          await this.audit.log(
            {
              action: "STAFF_ROLE_UPDATE",
              entityType: "StaffMembership",
              entityId: updated.id,
              metadata: {
                newRole: role,
                userId,
                releasedClosedSupportTickets,
              },
              userId: user.id,
              organizationId: null,
            },
            tx,
          )
          return updated
        },
      )

      // Cached authority changes only after mutation and audit both commit.
      invalidateAuthContext(userId)
      return result
    } catch (error: any) {
      if (isRetryablePrismaTransactionError(error)) {
        throw new ConflictException(
          "Staff role changed concurrently. Review the latest state and try again.",
        )
      }
      throw error
    }
  }

  async suspendUser(userId: string, input: SuspendUserInput, actor: any) {
    if (!actor?.id) throw new ForbiddenException("Administrator required")
    if (actor.id === userId) {
      throw new ForbiddenException("You cannot suspend your own account")
    }
    const note = input.internalNote.trim()
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null
    if (expiresAt && expiresAt.getTime() <= Date.now() + 60_000) {
      throw new BadRequestException(
        "Temporary suspension expiry must be at least one minute in the future",
      )
    }

    try {
      const result = await runSerializableTransactionWithRetry(
        this.prisma,
        async (tx: any) => {
          await this.lockStaffAccessMutationScope(tx, userId)

          const target = await tx.user.findUnique({
            where: { id: userId },
            include: { staffMemberships: true },
          })
          if (!target) throw new NotFoundException("User not found")
          if (target.banned) {
            throw new ConflictException("Account is already suspended")
          }

          let releasedClosedSupportTickets = 0
          if (target.userType === "STAFF") {
            const membership = target.staffMemberships[0]
            if (membership?.role === "SUPER_ADMIN") {
              const activeSuperAdmins = await tx.user.count({
                where: {
                  userType: "STAFF",
                  banned: false,
                  staffMemberships: { some: { role: "SUPER_ADMIN" } },
                },
              })
              if (activeSuperAdmins <= 1) {
                throw new ConflictException(
                  "At least one active Super Admin is required",
                )
              }
            }
            if (membership?.role === "OPERATIONS") {
              releasedClosedSupportTickets =
                await this.releaseClosedOperationsSupportOrThrow(
                  tx,
                  userId,
                  "suspending this Operations user",
                )
            }
          }

          const suspended = await tx.user.update({
            where: { id: userId },
            data: {
              banned: true,
              banReasonCode: input.reasonCode,
              banReason: note,
              banExpires: expiresAt,
              suspendedAt: new Date(),
              suspendedByUserId: actor.id,
            },
            select: {
              id: true,
              banned: true,
              banReasonCode: true,
              banExpires: true,
              suspendedAt: true,
            },
          })
          const revoked = await tx.session.deleteMany({ where: { userId } })
          await this.audit.log(
            {
              action: "USER_SUSPENDED",
              entityType: "User",
              entityId: userId,
              metadata: {
                userId,
                reasonCode: input.reasonCode,
                internalNote: note,
                expiresAt: expiresAt?.toISOString() ?? null,
                sessionsRevoked: revoked.count,
                releasedClosedSupportTickets,
              },
              userId: actor.id,
              organizationId: null,
            },
            tx,
          )
          return { ...suspended, sessionsRevoked: revoked.count }
        },
      )
      invalidateAuthContext(userId)
      return result
    } catch (error: any) {
      if (isRetryablePrismaTransactionError(error)) {
        throw new ConflictException(
          "Account access changed concurrently. Review the latest status and try again.",
        )
      }
      throw error
    }
  }

  async restoreUser(
    userId: string,
    input: { internalNote: string },
    actor: any,
  ) {
    if (!actor?.id) throw new ForbiddenException("Administrator required")
    const note = input.internalNote.trim()
    try {
      const result = await this.prisma.$transaction(
        async (tx: any) => {
          const target = await tx.user.findUnique({ where: { id: userId } })
          if (!target) throw new NotFoundException("User not found")
          if (!target.banned) {
            throw new ConflictException("Account is already active")
          }
          const restored = await tx.user.update({
            where: { id: userId },
            data: {
              banned: false,
              banReasonCode: null,
              banReason: null,
              banExpires: null,
              suspendedAt: null,
              suspendedByUserId: null,
            },
            select: { id: true, banned: true },
          })
          // Sessions were revoked at suspension time and are deliberately not
          // recreated. Restoration always requires a fresh authenticated login.
          await this.audit.log(
            {
              action: "USER_RESTORED",
              entityType: "User",
              entityId: userId,
              metadata: {
                userId,
                internalNote: note,
                previousReasonCode: target.banReasonCode,
                previousExpiresAt: target.banExpires?.toISOString() ?? null,
              },
              userId: actor.id,
              organizationId: null,
            },
            tx,
          )
          return restored
        },
        { isolationLevel: "Serializable" },
      )
      invalidateAuthContext(userId)
      return result
    } catch (error: any) {
      if (error?.code === "P2034") {
        throw new ConflictException(
          "Account access changed concurrently. Review the latest status and try again.",
        )
      }
      throw error
    }
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
        {
          tickets: {
            some: {
              assignedToUserId: userId,
              ...operationsPlatformSupportWhere(),
            },
          },
        },
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

  private adminOrderAttentionScope(
    role: StaffRole = "SUPER_ADMIN",
  ): Prisma.OrderWhereInput {
    const operational: Prisma.OrderWhereInput[] = [
      {
        dispute: {
          is: { status: { in: ["OPEN", "UNDER_REVIEW"] } },
        },
      },
      {
        cancellationRequests: {
          some: {
            status: {
              in: ["REQUESTED", "UNDER_REVIEW", "ESCALATED", "DISPUTED"],
            },
          },
        },
      },
      {
        activeDeliveryVersion: {
          is: { verificationStatus: { in: ["FAILED", "MANUAL_REVIEW"] } },
        },
      },
      {
        fulfillmentDueAt: { lt: new Date() },
        status: {
          notIn: ["COMPLETED", "CANCELLED", "REFUNDED"],
        },
      },
    ]
    const financial: Prisma.OrderWhereInput[] = [
      {
        settlements: {
          some: {
            status: {
              in: ["PENDING", "UNDER_REVIEW", "CUSTOMER_APPROVED"],
            },
          },
        },
      },
      {
        cancellationRequests: {
          some: { status: { in: ["PENDING_FINANCE", "ESCALATED"] } },
        },
      },
      {
        dispute: {
          is: { status: { in: ["OPEN", "UNDER_REVIEW"] } },
        },
      },
    ]

    return {
      OR:
        role === "OPERATIONS"
          ? operational
          : role === "FINANCE"
            ? financial
            : [...operational, ...financial],
    }
  }

  private adminOrderFocusScope(
    focus: AdminOrderFocus,
    role: StaffRole,
  ): Prisma.OrderWhereInput | null {
    if (focus === "attention") return this.adminOrderAttentionScope(role)
    if (focus === "active") {
      return {
        status: {
          notIn: ["COMPLETED", "CANCELLED", "REFUNDED"],
        },
      }
    }
    if (focus === "completed") {
      return {
        status: { in: ["COMPLETED", "CANCELLED", "REFUNDED"] },
      }
    }
    return null
  }

  async listOrders(params: AdminOrderListParams = {}) {
    // Phase 6.7 — explicit projection. The previous `include: { website: true }`
    // leaked Website.verificationToken (the DNS-TXT verification secret) to
    // every Finance/Ops staffer. Customer is also narrowed (no banReason,
    // no emailVerified internal field). Org excludes the opaque `settings`
    // JSON. None of these are required for refund / dispute / fulfillment
    // investigations — they exist on the Order row directly via FKs.
    const {
      take = 20,
      skip = 0,
      search,
      status,
      channel,
      focus = "all",
      user,
    } = params
    const role = user?.staffRole ?? "SUPER_ADMIN"
    const isSuperAdmin = role === "SUPER_ADMIN"
    const canViewFinancials = role !== "OPERATIONS"
    const baseScope: Prisma.OrderWhereInput =
      role === "OPERATIONS" ? this.operationsOrderScope(user!.id) : {}
    const filters: Prisma.OrderWhereInput[] = [baseScope]
    const normalizedSearch = search?.trim()

    if (normalizedSearch) {
      const visibleSearchFields: Prisma.OrderWhereInput[] = [
        { id: { contains: normalizedSearch, mode: "insensitive" } },
        { title: { contains: normalizedSearch, mode: "insensitive" } },
        {
          customer: {
            is: {
              name: { contains: normalizedSearch, mode: "insensitive" },
            },
          },
        },
        {
          organization: {
            is: {
              name: { contains: normalizedSearch, mode: "insensitive" },
            },
          },
        },
        {
          website: {
            is: {
              OR: [
                { url: { contains: normalizedSearch, mode: "insensitive" } },
                { name: { contains: normalizedSearch, mode: "insensitive" } },
              ],
            },
          },
        },
      ]
      if (isSuperAdmin) {
        visibleSearchFields.push({
          customer: {
            is: {
              email: { contains: normalizedSearch, mode: "insensitive" },
            },
          },
        })
      }
      filters.push({ OR: visibleSearchFields })
    }

    if (status) filters.push({ status })
    if (channel) {
      filters.push({
        OR: [
          { fulfillmentChannel: channel },
          {
            fulfillmentChannel: null,
            website: {
              is: {
                ownershipType:
                  channel === "PLATFORM" ? "PLATFORM" : "PUBLISHER",
              },
            },
          },
        ],
      })
    }
    const focusScope = this.adminOrderFocusScope(focus, role)
    if (focusScope) filters.push(focusScope)

    const where: Prisma.OrderWhereInput = { AND: filters }
    const activeScope = this.adminOrderFocusScope("active", role)!
    const completedScope = this.adminOrderFocusScope("completed", role)!
    const attentionScope = this.adminOrderAttentionScope(role)

    const [orders, total, scopedTotal, attention, active, completed] =
      await Promise.all([
        this.prisma.order.findMany({
          where,
          orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
          take,
          skip,
          select: {
            id: true,
            version: true,
            type: true,
            title: true,
            status: true,
            paymentStatus: true,
            amount: true,
            currency: true,
            fulfillmentChannel: true,
            fulfillmentDueAt: true,
            autoAcceptAt: true,
            createdAt: true,
            updatedAt: true,
            organization: { select: { id: true, name: true } },
            customer: {
              select: {
                id: true,
                name: true,
                ...(isSuperAdmin && { email: true }),
              },
            },
            website: {
              select: {
                id: true,
                url: true,
                name: true,
                ownershipType: true,
                verificationStatus: true,
                publisher: { select: { id: true, name: true } },
                managedBy: { select: { id: true, name: true } },
              },
            },
            activeDeliveryVersion: {
              select: { verificationStatus: true },
            },
            fulfillmentAssignments: {
              where: { status: { in: ["ASSIGNED", "IN_PROGRESS"] } },
              orderBy: { assignedAt: "desc" },
              take: 1,
              select: { assignedToUserId: true, status: true },
            },
            dispute: { select: { id: true, status: true } },
            cancellationRequests: {
              where: {
                status: {
                  in: [
                    "REQUESTED",
                    "UNDER_REVIEW",
                    "PENDING_FINANCE",
                    "ESCALATED",
                    "DISPUTED",
                  ],
                },
              },
              orderBy: { createdAt: "desc" },
              take: 1,
              select: { id: true, status: true },
            },
            settlements: {
              orderBy: { createdAt: "desc" },
              take: 1,
              select: { id: true, status: true, reviewEndsAt: true },
            },
          },
        }),
        this.prisma.order.count({ where }),
        this.prisma.order.count({ where: baseScope }),
        this.prisma.order.count({
          where: { AND: [baseScope, attentionScope] },
        }),
        this.prisma.order.count({ where: { AND: [baseScope, activeScope] } }),
        this.prisma.order.count({
          where: { AND: [baseScope, completedScope] },
        }),
      ])

    return {
      items: orders.map((order) => {
        const assignment = order.fulfillmentAssignments[0]
        return {
          id: order.id,
          version: order.version,
          type: order.type,
          title: order.title,
          status: order.status,
          paymentStatus: order.paymentStatus,
          amount: order.amount,
          currency: order.currency,
          fulfillmentChannel: order.fulfillmentChannel,
          fulfillmentDueAt: order.fulfillmentDueAt,
          autoAcceptAt: order.autoAcceptAt,
          createdAt: order.createdAt,
          updatedAt: order.updatedAt,
          organization: order.organization
            ? { id: order.organization.id, name: order.organization.name }
            : null,
          customer: order.customer
            ? {
                id: order.customer.id,
                name: order.customer.name,
                ...(isSuperAdmin && { email: order.customer.email }),
              }
            : null,
          website: order.website
            ? {
                id: order.website.id,
                url: order.website.url,
                name: order.website.name,
                ownershipType: order.website.ownershipType,
                verificationStatus: order.website.verificationStatus,
                publisher: order.website.publisher,
                managedBy: order.website.managedBy,
              }
            : null,
          activeDelivery: order.activeDeliveryVersion,
          activeAssignment: assignment
            ? {
                status: assignment.status,
                assignedToCurrentUser: assignment.assignedToUserId === user?.id,
              }
            : null,
          dispute: order.dispute,
          cancellation: order.cancellationRequests[0] ?? null,
          settlement: canViewFinancials ? (order.settlements[0] ?? null) : null,
        }
      }),
      total,
      take,
      skip,
      summary: { total: scopedTotal, attention, active, completed },
    }
  }

  async getOrder(id: string, user?: any) {
    if (user && !VALID_STAFF_ROLES.includes(user.staffRole as StaffRole)) {
      throw new ForbiddenException("A current staff role is required")
    }
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
            fraudFlags: { include: { resolution: true, finding: true } },
            snapshots: true,
            adminVerifiedBy: { select: { id: true, name: true, email: true } },
          },
        },
        settlements: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          include: {
            approvals: true,
            publisher: { select: { id: true, name: true, tier: true } },
            transactions: {
              where: { type: "SETTLEMENT_RELEASE" },
              select: {
                type: true,
                settlementId: true,
                orderId: true,
                publisherId: true,
                amount: true,
                currency: true,
                walletId: true,
                provider: true,
                providerRef: true,
              },
            },
          },
        },
        dispute: true,
        cancellationRequests: {
          where: {
            status: {
              in: [
                "REQUESTED",
                "UNDER_REVIEW",
                "PENDING_FINANCE",
                "ESCALATED",
                "DISPUTED",
              ],
            },
          },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true, status: true },
        },
        contentOrder: true,
        articleVersions: {
          orderBy: [{ purpose: "asc" }, { version: "desc" }],
          select: {
            id: true,
            version: true,
            source: true,
            purpose: true,
            title: true,
            body: true,
            format: true,
            wordCount: true,
            supersedesId: true,
            createdAt: true,
          },
        },
        revisions: true,
        platformRevenue: true,
        fraudFlags: {
          orderBy: { createdAt: "asc" },
          include: { resolution: true, finding: true, hold: true },
        },
        transactions: {
          where: { type: "REFUND" },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            type: true,
            amount: true,
            currency: true,
            createdAt: true,
          },
        },
        publisherCompensation: {
          include: {
            debtRepaymentTransaction: {
              select: { id: true, amount: true, currency: true },
            },
          },
        },
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
    // Internal callers that deliberately omit an actor retain the historical
    // system projection. Request-bound callers above fail closed instead.
    const role: StaffRole = user?.staffRole ?? "SUPER_ADMIN"
    const isSuperAdmin = role === "SUPER_ADMIN"
    const canViewFinancials = role !== "OPERATIONS"
    const canViewOrderContent = role === "OPERATIONS" || isSuperAdmin
    const canViewInvestigatorDetails =
      role === "FINANCE" || role === "SUPER_ADMIN"

    const approverIds = [
      ...new Set(
        (order.settlements ?? []).flatMap((settlement) =>
          settlement.approvals
            .map((approval) => approval.approvedBy)
            .filter((approvedBy) => !approvedBy.startsWith("SYSTEM_")),
        ),
      ),
    ]
    const approvers =
      canViewFinancials && approverIds.length
        ? await this.prisma.user.findMany({
            where: { id: { in: approverIds } },
            select: {
              id: true,
              name: true,
              ...(isSuperAdmin && { email: true }),
            },
          })
        : []
    const approverById = new Map(approvers.map((user) => [user.id, user]))
    const activeAssignment = (order.fulfillmentAssignments ?? []).find(
      (assignment) =>
        assignment.status === "ASSIGNED" || assignment.status === "IN_PROGRESS",
    )
    const platformChannel =
      order.fulfillmentChannel === "PLATFORM" ||
      (order.fulfillmentChannel == null &&
        order.website?.ownershipType === "PLATFORM")
    const claimableStatuses = [
      "SUBMITTED",
      "ACCEPTED",
      "CONTENT_REQUESTED",
      "CONTENT_CREATION",
      "CONTENT_READY",
      "CUSTOMER_REVIEW",
      "APPROVED",
    ]
    const operationsCanWork =
      role === "OPERATIONS" &&
      platformChannel &&
      (activeAssignment?.assignedToUserId === user?.id ||
        (!activeAssignment && claimableStatuses.includes(order.status)))
    const integrity = buildOrderIntegrityReport(
      order,
      activeAssignment,
      platformChannel,
    )
    const activeSettlement = (order.settlements ?? []).find(
      (settlement) => settlement.status !== "CANCELLED",
    )
    const effectiveRefundStatus =
      order.status === "DISPUTED"
        ? (order.dispute?.previousStatus ?? order.status)
        : order.status
    const publisherCompensationRequired = isPostPublicationPublisherOrder({
      fulfillmentChannel: order.fulfillmentChannel,
      websiteOwnershipType: order.website?.ownershipType,
      effectiveOrderStatus: effectiveRefundStatus,
      hasSettlement: Boolean(activeSettlement),
    })

    return {
      id: order.id,
      type: order.type,
      title: order.title,
      instructions: order.instructions,
      status: order.status,
      paymentStatus: order.paymentStatus,
      fulfillmentChannel: order.fulfillmentChannel,
      ...(canViewFinancials && {
        amount: order.amount,
        currency: order.currency,
      }),
      fulfillmentDueAt: order.fulfillmentDueAt,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      version: order.version,
      autoAcceptAt: order.autoAcceptAt,
      verifyMethod: order.verifyMethod,
      deliveryAcceptedMethod: order.deliveryAcceptedMethod,
      lifecycle: integrity.lifecycle,
      integrity: { state: integrity.state, checks: integrity.checks },
      ...(canViewFinancials && {
        publisherCompensationPolicy: {
          required: publisherCompensationRequired,
          maximumAmount: publisherCompensationRequired
            ? String(activeSettlement?.publisherAmount ?? order.amount ?? 0)
            : "0",
          currency: activeSettlement?.currency ?? order.currency,
          effectiveOrderStatus: effectiveRefundStatus,
        },
      }),
      organization: order.organization
        ? {
            id: order.organization.id,
            name: order.organization.name,
            ...(isSuperAdmin && { slug: order.organization.slug }),
          }
        : null,
      customer: order.customer
        ? {
            id: order.customer.id,
            name: order.customer.name,
            ...(isSuperAdmin && {
              email: order.customer.email,
              userType: order.customer.userType,
            }),
          }
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
                  ...(role !== "OPERATIONS" && {
                    email: order.website.publisher.email,
                    tier: order.website.publisher.tier,
                    profile: order.website.publisher.profile,
                  }),
                }
              : null,
            managedBy: order.website.managedBy
              ? {
                  id: order.website.managedBy.id,
                  name: order.website.managedBy.name,
                  ...(isSuperAdmin && {
                    email: order.website.managedBy.email,
                  }),
                }
              : null,
          }
        : null,
      items: (order.items ?? []).map((item) => ({
        id: item.id,
        targetUrl: item.targetUrl,
        anchorText: item.anchorText,
        website: item.website
          ? { id: item.website.id, url: item.website.url }
          : null,
      })),
      content: order.contentOrder
        ? {
            id: order.contentOrder.id,
            title: order.contentOrder.title,
            status: order.contentOrder.status,
            hasBrief: Boolean(order.contentOrder.brief),
            hasDeliverable: Boolean(order.contentOrder.deliverable),
            updatedAt: order.contentOrder.updatedAt,
          }
        : null,
      ...(canViewOrderContent && {
        articleVersions: order.articleVersions,
      }),
      revisions: (order.revisions ?? []).map((revision) => ({
        id: revision.id,
        status: revision.status,
        createdAt: revision.createdAt,
        updatedAt: revision.updatedAt,
      })),
      events: (order.events ?? []).map((event) => ({
        id: event.id,
        eventType: event.eventType,
        message:
          role === "OPERATIONS" &&
          [
            "PAYMENT_SUBMITTED",
            "PAYMENT_CAPTURED",
            "SETTLEMENT_CREATED",
            "PLATFORM_REVENUE_RECOGNIZED",
            "SETTLEMENT_CUSTOMER_APPROVED",
            "SETTLEMENT_RETURNED_TO_REVIEW",
            "SETTLEMENT_RELEASED",
            "REFUND_ISSUED",
            "REFUNDED",
            "PUBLISHER_COMPENSATION_RECORDED",
          ].includes(event.eventType)
            ? "Financial lifecycle event recorded"
            : event.message,
        ...(isSuperAdmin && { metadata: event.metadata }),
        createdAt: event.createdAt,
      })),
      activeDeliveryVersion: order.activeDeliveryVersion
        ? {
            id: order.activeDeliveryVersion.id,
            publishedUrl: order.activeDeliveryVersion.publishedUrl,
            verificationStatus: order.activeDeliveryVersion.verificationStatus,
            verificationFailureReason:
              order.activeDeliveryVersion.verificationFailureReason,
            adminVerifiedBy: order.activeDeliveryVersion.adminVerifiedBy
              ? {
                  id: order.activeDeliveryVersion.adminVerifiedBy.id,
                  name: order.activeDeliveryVersion.adminVerifiedBy.name,
                }
              : null,
            adminOverrideReason:
              order.activeDeliveryVersion.adminOverrideReason,
            adminVerifiedNotes: order.activeDeliveryVersion.adminVerifiedNotes,
            fraudFlags: order.activeDeliveryVersion.fraudFlags.map((flag) => ({
              id: flag.id,
              type: flag.type,
              details: flag.details,
              createdAt: flag.createdAt,
              resolution: flag.resolution
                ? {
                    id: flag.resolution.id,
                    kind: flag.resolution.kind,
                    reason: flag.resolution.reason,
                    disposition:
                      flag.resolution.evidence &&
                      typeof flag.resolution.evidence === "object" &&
                      !Array.isArray(flag.resolution.evidence)
                        ? ((flag.resolution.evidence as Record<string, unknown>)
                            .disposition ?? null)
                        : null,
                    resolvedByUserId: flag.resolution.resolvedByUserId,
                    resolvedByRole: flag.resolution.resolvedByRole,
                    createdAt: flag.resolution.createdAt,
                  }
                : null,
              finding: flag.finding
                ? {
                    id: flag.finding.id,
                    outcome: flag.finding.outcome,
                    ...(canViewInvestigatorDetails && {
                      reason: flag.finding.internalReason,
                    }),
                    decidedByRole: flag.finding.decidedByRole,
                    ...(isSuperAdmin && {
                      decidedByUserId: flag.finding.decidedByUserId,
                    }),
                    createdAt: flag.finding.createdAt,
                  }
                : null,
            })),
            screenshotUrl: order.activeDeliveryVersion.screenshotUrl,
            evidence: order.activeDeliveryVersion.evidence.map((evidence) => ({
              id: evidence.id,
              httpStatus: evidence.httpStatus,
              anchorFound: evidence.anchorFound,
              linkFound: evidence.linkFound,
              targetUrlMatched: evidence.targetUrlMatched,
              checkedAt: evidence.checkedAt,
            })),
          }
        : null,
      settlements: canViewFinancials
        ? (order.settlements ?? []).map((settlement) => ({
            id: settlement.id,
            status: settlement.status,
            grossAmount: settlement.grossAmount,
            platformFee: settlement.platformFee,
            publisherAmount: settlement.publisherAmount,
            releasePolicy: settlement.releasePolicy,
            reviewEndsAt: settlement.reviewEndsAt,
            approvals: settlement.approvals.map((approval) => ({
              id: approval.id,
              type: approval.type,
              approvedBy: approval.approvedBy,
              roleAtTime: approval.roleAtTime,
              approvedAt: approval.approvedAt,
              approvedByUser: approverById.get(approval.approvedBy) ?? null,
            })),
          }))
        : [],
      dispute: order.dispute
        ? {
            id: order.dispute.id,
            status: order.dispute.status,
            previousStatus: order.dispute.previousStatus,
          }
        : null,
      cancellation: order.cancellationRequests?.[0] ?? null,
      stakeholderTimeline: buildOrderStakeholderTimeline(order, role),
      activeAssignment: activeAssignment
        ? {
            id: activeAssignment.id,
            status: activeAssignment.status,
            assignedAt: activeAssignment.assignedAt,
            completedAt: activeAssignment.completedAt,
            ...(isSuperAdmin && {
              assignedToUserId: activeAssignment.assignedToUserId,
            }),
            assignedToCurrentUser:
              activeAssignment.assignedToUserId === user?.id,
          }
        : null,
      access: {
        role,
        canForceCancel: isSuperAdmin,
        canManageDispute: true,
        canReviewDelivery: role !== "FINANCE",
        canViewFinancials,
        canWorkFulfillment:
          platformChannel && (isSuperAdmin || operationsCanWork),
      },
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

    const visibleOrders =
      user?.staffRole === "OPERATIONS"
        ? orders.map(({ amount: _amount, currency: _currency, ...order }) => ({
            ...order,
            customer: order.customer
              ? {
                  id: order.customer.id,
                  name: order.customer.name,
                }
              : null,
          }))
        : orders
    return { orders: visibleOrders, pagination: { take, skip, total } }
  }

  async listMarketplaceListings(params: {
    status?: string
    type?: string
    search?: string
    ownerType?: string
    page?: number
    limit?: number
    user?: { id: string; staffRole: StaffRole }
  }) {
    const page = Number.isFinite(params.page) ? Math.max(1, params.page!) : 1
    const limit = Number.isFinite(params.limit)
      ? Math.min(100, Math.max(1, params.limit!))
      : 20
    const where: any = {}
    if (params.user?.staffRole === "OPERATIONS") {
      where.AND = [
        {
          OR: [
            { ownerType: WebsiteOwnershipType.PUBLISHER },
            {
              ownerType: WebsiteOwnershipType.PLATFORM,
              website: { managedByUserId: params.user.id },
            },
          ],
        },
      ]
    }
    if (
      params.status &&
      !Object.values(ListingStatus).includes(params.status as ListingStatus)
    ) {
      throw new BadRequestException("Invalid marketplace status filter")
    }
    const serviceTypes = [
      "GUEST_POST",
      "NICHE_EDIT",
      "EDITORIAL_LINK",
      "OUTREACH_LINK",
      "LOCAL_CITATION",
      "FOUNDATION_LINK",
      "BLOG_ARTICLE",
      "SEO_CONTENT",
    ]
    if (params.type && !serviceTypes.includes(params.type)) {
      throw new BadRequestException("Invalid marketplace service filter")
    }
    if (
      params.ownerType &&
      !Object.values(WebsiteOwnershipType).includes(
        params.ownerType as WebsiteOwnershipType,
      )
    ) {
      throw new BadRequestException("Invalid marketplace owner filter")
    }
    if (params.status) where.status = params.status
    if (params.type)
      where.services = {
        some: { availability: "AVAILABLE", serviceType: params.type as any },
      }
    if (params.ownerType) where.ownerType = params.ownerType

    if (params.search) {
      const search = {
        OR: [
          { title: { contains: params.search, mode: "insensitive" } },
          { description: { contains: params.search, mode: "insensitive" } },
          {
            website: {
              domain: { contains: params.search, mode: "insensitive" },
            },
          },
        ],
      }
      where.AND = [...(where.AND ?? []), search]
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
          publisher: {
            select: {
              id: true,
              name: true,
              tier: true,
              email: true,
              profile: {
                select: {
                  rating: true,
                  totalReviews: true,
                  responseTime: true,
                  completionRate: true,
                  trustScore: true,
                },
              },
            },
          },
          website: {
            select: {
              id: true,
              url: true,
              domain: true,
              verificationStatus: true,
              verifiedAt: true,
              isActive: true,
              ownershipType: true,
              activeModerationAction: true,
              activeModerationAuthority: true,
              activeModerationReasonCode: true,
              activeModerationMessage: true,
              activeModerationPreviousActive: true,
              moderationVersion: true,
              metricsHistory: true,
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
        const isSuperAdmin = params.user?.staffRole === "SUPER_ADMIN"
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
          publisher: l.publisher
            ? {
                id: l.publisher.id,
                name: l.publisher.name,
                tier: l.publisher.tier,
                ...(isSuperAdmin && { email: l.publisher.email }),
                profile: l.publisher.profile,
              }
            : null,
          websiteVerificationStatus: l.website?.verificationStatus ?? null,
          websiteVerifiedAt: l.website?.verifiedAt?.toISOString() ?? null,
          websiteDomain: l.website?.domain ?? null,
          websiteUrl: l.website?.url ?? null,
          websiteManagedBy: l.website?.managedBy
            ? {
                id: l.website.managedBy.id,
                name: l.website.managedBy.name,
                ...(isSuperAdmin && { email: l.website.managedBy.email }),
              }
            : null,
          websiteActive: l.website?.isActive ?? false,
          moderation: buildModerationProjection(
            l,
            getStaffListingModerationActions(
              {
                ...l,
                managedByUserId: l.website?.managedByUserId ?? null,
              },
              {
                id: params.user?.id ?? "",
                staffRole: params.user?.staffRole ?? null,
              },
            ),
          ),
          websiteModeration: l.website
            ? buildModerationProjection(
                l.website,
                getStaffWebsiteModerationActions(l.website, {
                  id: params.user?.id ?? "",
                  staffRole: params.user?.staffRole ?? null,
                }),
              )
            : null,
          domainMetrics: serializeMarketplaceDomainMetrics(
            l.website?.metricsHistory ?? [],
          ),
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
    const [
      totalListings,
      activeListings,
      pendingListings,
      draftListings,
      pausedListings,
      platformListings,
      publisherListings,
      totalReviews,
      avgRating,
    ] = await Promise.all([
      this.prisma.marketplaceListing.count(),
      this.prisma.marketplaceListing.count({
        where: { status: ListingStatus.APPROVED },
      }),
      this.prisma.marketplaceListing.count({
        where: { status: ListingStatus.PENDING_REVIEW },
      }),
      this.prisma.marketplaceListing.count({
        where: { status: ListingStatus.DRAFT },
      }),
      this.prisma.marketplaceListing.count({
        where: { status: ListingStatus.PAUSED },
      }),
      this.prisma.marketplaceListing.count({
        where: { ownerType: WebsiteOwnershipType.PLATFORM },
      }),
      this.prisma.marketplaceListing.count({
        where: { ownerType: WebsiteOwnershipType.PUBLISHER },
      }),
      this.prisma.marketplaceReview.count(),
      this.prisma.marketplaceReview.aggregate({ _avg: { rating: true } }),
    ])
    return {
      totalListings,
      activeListings,
      pendingListings,
      draftListings,
      pausedListings,
      needsAttention: pendingListings + pausedListings,
      platformListings,
      publisherListings,
      totalReviews,
      avgRating: avgRating._avg.rating ?? 0,
    }
  }

  async updateListingStatus(
    id: string,
    status: string,
    user: any,
    force = false,
    details: {
      reasonCode?: ModerationReasonCode
      publisherMessage?: string
      internalNote?: string
      expectedVersion?: number
    } = {},
  ) {
    if (!Object.values(ListingStatus).includes(status as ListingStatus)) {
      throw new BadRequestException(`Invalid listing status: ${status}`)
    }
    if (user?.staffRole === "OPERATIONS" && status === ListingStatus.ARCHIVED) {
      throw new ForbiddenException(
        "Only Super Admin can archive marketplace inventory",
      )
    }

    const current = await this.prisma.marketplaceListing.findUnique({
      where: { id },
      select: { status: true, moderationVersion: true },
    })
    if (!current) throw new NotFoundException("Listing not found")
    if (current.status === status) return current

    const action =
      status === ListingStatus.APPROVED
        ? current.status === ListingStatus.PAUSED
          ? ModerationAction.RESTORE
          : ModerationAction.APPROVE
        : status === ListingStatus.REJECTED
          ? ModerationAction.REQUEST_CHANGES
          : status === ListingStatus.PAUSED
            ? ModerationAction.PAUSE
            : status === ListingStatus.ARCHIVED
              ? ModerationAction.ARCHIVE
              : null
    if (!action) {
      throw new BadRequestException(
        "Direct lifecycle writes are disabled; use an explicit moderation action",
      )
    }

    const defaultReason =
      force && action === ModerationAction.APPROVE
        ? ModerationReasonCode.EMERGENCY_OVERRIDE
        : action === ModerationAction.APPROVE
          ? ModerationReasonCode.APPROVED_AFTER_REVIEW
          : action === ModerationAction.RESTORE
            ? ModerationReasonCode.ISSUE_RESOLVED
            : action === ModerationAction.REQUEST_CHANGES
              ? ModerationReasonCode.INCOMPLETE_LISTING
              : action === ModerationAction.PAUSE
                ? ModerationReasonCode.OPERATIONAL_HOLD
                : ModerationReasonCode.DUPLICATE_OR_INVALID

    return this.moderateListing(
      id,
      {
        action,
        reasonCode: details.reasonCode ?? defaultReason,
        publisherMessage:
          details.publisherMessage ??
          (action === ModerationAction.REQUEST_CHANGES
            ? "Changes are required before this listing can be reviewed again."
            : action === ModerationAction.PAUSE
              ? "This listing is temporarily paused while GuestPost Operations reviews it."
              : action === ModerationAction.ARCHIVE
                ? "This listing has been archived by GuestPost Operations."
                : undefined),
        internalNote:
          details.internalNote ??
          "Compatibility status endpoint mapped to an explicit moderation action.",
        expectedVersion:
          details.expectedVersion ?? current.moderationVersion ?? 0,
        force,
      },
      user,
    )
  }

  async moderateListing(
    id: string,
    command: ListingModerationCommand,
    user: any,
  ) {
    if (!user?.id || !["SUPER_ADMIN", "OPERATIONS"].includes(user.staffRole)) {
      throw new ForbiddenException("Staff moderation access is required")
    }

    const result = await this.prisma.$transaction(async (tx: any) => {
      const observedListing = await tx.marketplaceListing.findUnique({
        where: { id },
        select: {
          websiteId: true,
          status: true,
          moderationVersion: true,
        },
      })
      if (!observedListing) throw new NotFoundException("Listing not found")
      if (observedListing.websiteId) {
        await tx.$queryRaw`
          SELECT "id"
          FROM "Website"
          WHERE "id" = ${observedListing.websiteId}
          FOR UPDATE
        `
      }
      await tx.$queryRaw`
        SELECT "id"
        FROM "MarketplaceListing"
        WHERE "id" = ${id}
        FOR UPDATE
      `
      const listing = await tx.marketplaceListing.findUnique({
        where: { id },
        include: {
          publisher: { select: { email: true } },
          website: {
            select: {
              verificationStatus: true,
              domain: true,
              isActive: true,
              managedByUserId: true,
            },
          },
          categories: { select: { categoryId: true } },
          services: {
            where: { availability: "AVAILABLE" },
            take: 1,
            select: { id: true },
          },
        },
      })
      if (!listing) throw new NotFoundException("Listing not found")
      if (
        listing.status !== observedListing.status ||
        listing.moderationVersion !== observedListing.moderationVersion ||
        listing.websiteId !== observedListing.websiteId
      ) {
        throw new ConflictException(
          "Listing moderation changed concurrently; refresh and retry",
        )
      }
      if (listing.moderationVersion !== command.expectedVersion) {
        throw new ConflictException({
          code: "MODERATION_VERSION_CONFLICT",
          message: "Listing moderation changed; refresh and retry.",
          currentVersion: listing.moderationVersion,
        })
      }

      if (
        user.staffRole === "OPERATIONS" &&
        listing.ownerType === WebsiteOwnershipType.PLATFORM &&
        listing.website?.managedByUserId !== user.id
      ) {
        throw new ForbiddenException(
          "Operations can only moderate assigned platform inventory",
        )
      }

      const allowedActions = getStaffListingModerationActions(
        {
          status: listing.status,
          ownerType: listing.ownerType,
          managedByUserId: listing.website?.managedByUserId ?? null,
          activeModerationAction: listing.activeModerationAction,
          activeModerationAuthority: listing.activeModerationAuthority,
          activeModerationReasonCode: listing.activeModerationReasonCode,
          activeModerationMessage: listing.activeModerationMessage,
          activeModerationPreviousStatus:
            listing.activeModerationPreviousStatus,
          moderationResubmissionAllowed: listing.moderationResubmissionAllowed,
          moderationVersion: listing.moderationVersion,
        },
        { id: user.id, staffRole: user.staffRole },
      )
      if (!allowedActions.includes(command.action)) {
        throw new BadRequestException({
          code: "INVALID_MODERATION_TRANSITION",
          message: `${command.action} is not allowed from the current listing moderation state.`,
          allowedActions,
        })
      }

      const publisherFacingAction = (
        [
          ModerationAction.REQUEST_CHANGES,
          ModerationAction.PAUSE,
          ModerationAction.ARCHIVE,
          ModerationAction.ALLOW_RESUBMISSION,
          ModerationAction.DENY_RESUBMISSION,
        ] as ModerationAction[]
      ).includes(command.action)
      if (
        listing.ownerType === WebsiteOwnershipType.PUBLISHER &&
        publisherFacingAction &&
        (!command.publisherMessage ||
          command.publisherMessage.trim().length < 10)
      ) {
        throw new BadRequestException({
          code: "PUBLISHER_MESSAGE_REQUIRED",
          message:
            "A clear publisher-facing message is required for this moderation action.",
        })
      }

      if (
        command.action === ModerationAction.APPROVE &&
        listing.services.length === 0
      ) {
        throw new BadRequestException({
          code: "NO_AVAILABLE_SERVICES",
          message:
            "Cannot approve: add at least one available service to the listing first.",
        })
      }
      if (
        command.action === ModerationAction.APPROVE &&
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
        command.action === ModerationAction.APPROVE &&
        listing.website &&
        listing.website.verificationStatus !== "VERIFIED"
      ) {
        if (!(command.force && user.staffRole === "SUPER_ADMIN")) {
          throw new BadRequestException({
            code: "WEBSITE_NOT_VERIFIED",
            message: `Cannot approve: website ${listing.website.domain ?? ""} is ${listing.website.verificationStatus}, not VERIFIED.`,
          })
        }
        if (command.reasonCode !== ModerationReasonCode.EMERGENCY_OVERRIDE) {
          throw new BadRequestException({
            code: "EMERGENCY_OVERRIDE_REASON_REQUIRED",
            message:
              "Emergency verification approval must use the EMERGENCY_OVERRIDE reason.",
          })
        }
      }

      const authority =
        user.staffRole === "SUPER_ADMIN"
          ? ModerationAuthority.SUPER_ADMIN
          : ModerationAuthority.OPERATIONS
      let resultingStatus = listing.status
      let resultingAction = listing.activeModerationAction
      let resultingAuthority = listing.activeModerationAuthority
      let resultingReason = listing.activeModerationReasonCode
      let resultingMessage = listing.activeModerationMessage
      let resultingPreviousStatus = listing.activeModerationPreviousStatus
      let resultingResubmission = listing.moderationResubmissionAllowed

      switch (command.action) {
        case ModerationAction.APPROVE:
          resultingStatus = ListingStatus.APPROVED
          resultingAction = null
          resultingAuthority = null
          resultingReason = null
          resultingMessage = null
          resultingPreviousStatus = null
          resultingResubmission = false
          break
        case ModerationAction.REQUEST_CHANGES:
          resultingStatus = ListingStatus.REJECTED
          resultingAction = ModerationAction.REQUEST_CHANGES
          resultingAuthority = authority
          resultingReason = command.reasonCode
          resultingMessage = command.publisherMessage?.trim() ?? null
          resultingPreviousStatus = listing.status
          resultingResubmission = true
          break
        case ModerationAction.PAUSE:
          resultingStatus = ListingStatus.PAUSED
          resultingAction = ModerationAction.PAUSE
          resultingAuthority = authority
          resultingReason = command.reasonCode
          resultingMessage = command.publisherMessage?.trim() ?? null
          resultingPreviousStatus = listing.status
          resultingResubmission = false
          break
        case ModerationAction.RESTORE:
          resultingStatus = listing.activeModerationPreviousStatus!
          resultingAction = null
          resultingAuthority = null
          resultingReason = null
          resultingMessage = null
          resultingPreviousStatus = null
          resultingResubmission = false
          break
        case ModerationAction.ARCHIVE:
          resultingStatus = ListingStatus.ARCHIVED
          resultingAction = ModerationAction.ARCHIVE
          resultingAuthority = authority
          resultingReason = command.reasonCode
          resultingMessage = command.publisherMessage?.trim() ?? null
          resultingPreviousStatus = listing.status
          resultingResubmission = false
          break
        case ModerationAction.REOPEN:
          resultingStatus = ListingStatus.DRAFT
          resultingAction = null
          resultingAuthority = null
          resultingReason = null
          resultingMessage = null
          resultingPreviousStatus = null
          resultingResubmission = false
          break
        case ModerationAction.ALLOW_RESUBMISSION:
          resultingResubmission = true
          break
        case ModerationAction.DENY_RESUBMISSION:
          resultingResubmission = false
          break
        default:
          throw new BadRequestException("Unsupported listing moderation action")
      }

      const transition = await tx.marketplaceListing.updateMany({
        where: {
          id,
          status: listing.status,
          moderationVersion: listing.moderationVersion,
        },
        data: {
          status: resultingStatus,
          activeModerationAction: resultingAction,
          activeModerationAuthority: resultingAuthority,
          activeModerationReasonCode: resultingReason,
          activeModerationMessage: resultingMessage,
          activeModerationPreviousStatus: resultingPreviousStatus,
          moderationResubmissionAllowed: resultingResubmission,
          moderationVersion: { increment: 1 },
        },
      })
      if (transition.count !== 1) {
        throw new ConflictException(
          "Listing moderation changed concurrently; refresh and retry",
        )
      }

      const moderationEvent = await tx.moderationEvent.create({
        data: {
          scope: "LISTING",
          listingId: id,
          action: command.action,
          reasonCode: command.reasonCode,
          publisherMessage: command.publisherMessage?.trim() ?? null,
          internalNote: command.internalNote?.trim() ?? null,
          actorUserId: user.id,
          actorStaffRole: user.staffRole,
          authority,
          previousStatus: listing.status,
          resultingStatus,
          previousModerationAction: listing.activeModerationAction,
          resultingModerationAction: resultingAction,
          resubmissionAllowed: resultingResubmission,
        },
      })

      const updatedListing = await tx.marketplaceListing.findUniqueOrThrow({
        where: { id },
      })

      if (
        command.action === ModerationAction.APPROVE &&
        listing.website &&
        listing.website.verificationStatus !== "VERIFIED"
      ) {
        await this.audit.log(
          {
            action: "WEBSITE_VERIFICATION_OVERRIDE",
            entityType: "MarketplaceListing",
            entityId: id,
            metadata: {
              domain: listing.website.domain,
              websiteStatus: listing.website.verificationStatus,
              reasonCode: command.reasonCode,
              internalNote: command.internalNote ?? null,
              moderationEventId: moderationEvent.id,
            },
            userId: user.id,
            organizationId: listing.organizationId ?? null,
          },
          tx,
        )
      }

      await this.audit.log(
        {
          action: `LISTING_MODERATION_${command.action}`,
          entityType: "MarketplaceListing",
          entityId: id,
          metadata: {
            previousStatus: listing.status,
            newStatus: resultingStatus,
            listingTitle: listing.title,
            reasonCode: command.reasonCode,
            publisherMessage: command.publisherMessage ?? null,
            internalNote: command.internalNote ?? null,
            previousModerationAction: listing.activeModerationAction,
            resultingModerationAction: resultingAction,
            resubmissionAllowed: resultingResubmission,
            previousVersion: listing.moderationVersion,
            resultingVersion: listing.moderationVersion + 1,
            moderationEventId: moderationEvent.id,
          },
          userId: user.id,
          organizationId: listing.organizationId ?? null,
        },
        tx,
      )

      const communicationEventIds: string[] = []
      if (this.communications && listing.publisherId) {
        const notification = this.listingModerationNotification(
          command.action,
          listing.title,
          command.publisherMessage,
          resultingResubmission,
        )
        if (notification) {
          const recipients = await this.communications.publisherRecipients(
            listing.publisherId,
            false,
            tx,
          )
          const event = await this.communications.record(
            {
              type: notification.type,
              aggregateType: "MarketplaceListing",
              aggregateId: id,
              organizationId: listing.organizationId,
              title: notification.title,
              message: notification.message,
              actionPath: "/dashboard/listings",
              payload: {
                from: listing.status,
                to: resultingStatus,
                action: command.action,
                reasonCode: command.reasonCode,
                moderationEventId: moderationEvent.id,
                resubmissionAllowed: resultingResubmission,
              },
              dedupKey: `listing:${id}:moderation:${moderationEvent.id}`,
              recipientUserIds: recipients,
              actorUserId: user.id,
            },
            tx,
          )
          communicationEventIds.push(event.eventId)
        }
      }
      return {
        updatedListing: {
          ...updatedListing,
          moderation: buildModerationProjection(
            updatedListing,
            getStaffListingModerationActions(
              {
                ...updatedListing,
                managedByUserId: listing.website?.managedByUserId ?? null,
              },
              { id: user.id, staffRole: user.staffRole },
            ),
          ),
        },
        communicationEventIds,
      }
    })

    this.communications?.dispatchManyBestEffort(result.communicationEventIds)
    return result.updatedListing
  }

  private listingModerationNotification(
    action: ModerationAction,
    title: string,
    publisherMessage: string | undefined,
    resubmissionAllowed: boolean,
  ): {
    type:
      | "MARKETPLACE_LISTING_APPROVED"
      | "MARKETPLACE_LISTING_REJECTED"
      | "MARKETPLACE_LISTING_PAUSED"
      | "MARKETPLACE_LISTING_RESTORED"
      | "MARKETPLACE_LISTING_ARCHIVED"
    title: string
    message: string
  } | null {
    switch (action) {
      case ModerationAction.APPROVE:
        return {
          type: "MARKETPLACE_LISTING_APPROVED",
          title: "Marketplace listing approved",
          message: `Your listing "${title}" has been approved and is now live in the marketplace.`,
        }
      case ModerationAction.REQUEST_CHANGES:
        return {
          type: "MARKETPLACE_LISTING_REJECTED",
          title: "Marketplace listing needs changes",
          message: publisherMessage!,
        }
      case ModerationAction.PAUSE:
        return {
          type: "MARKETPLACE_LISTING_PAUSED",
          title: "Marketplace listing paused",
          message: publisherMessage!,
        }
      case ModerationAction.RESTORE:
        return {
          type: "MARKETPLACE_LISTING_RESTORED",
          title: "Marketplace listing restored",
          message: `Your listing "${title}" has been restored.`,
        }
      case ModerationAction.ARCHIVE:
        return {
          type: "MARKETPLACE_LISTING_ARCHIVED",
          title: "Marketplace listing archived",
          message: publisherMessage!,
        }
      case ModerationAction.REOPEN:
        return {
          type: "MARKETPLACE_LISTING_RESTORED",
          title: "Marketplace listing reopened",
          message: `Your listing "${title}" has been reopened as a draft. Review it before submitting again.`,
        }
      case ModerationAction.ALLOW_RESUBMISSION:
      case ModerationAction.DENY_RESUBMISSION:
        return {
          type: "MARKETPLACE_LISTING_REJECTED",
          title: "Marketplace resubmission access updated",
          message:
            publisherMessage ??
            (resubmissionAllowed
              ? "You may update this listing and submit it for review again."
              : "This listing cannot currently be resubmitted."),
        }
      default:
        return null
    }
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
    // Compatibility alias only. Archiving must retain the same authority,
    // optimistic-lock, append-only history, audit, and outbox guarantees as
    // the explicit moderation command used by current clients.
    return this.updateListingStatus(id, ListingStatus.ARCHIVED, user, false, {
      reasonCode: ModerationReasonCode.DUPLICATE_OR_INVALID,
      publisherMessage:
        "This listing has been archived by GuestPost Operations.",
      internalNote:
        "Legacy delete endpoint mapped to the explicit archive moderation action.",
    })
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

    if (!dto.manualMetrics) {
      throw new BadRequestException({
        code: "MANUAL_METRICS_REQUIRED",
        message: "Ahrefs organic traffic and Moz Domain Authority are required",
      })
    }
    assertManualMetricValues(dto.manualMetrics)
    const ahrefsTrafficAsOf = assertMeasurementDate(
      dto.manualMetrics.ahrefsTrafficAsOf,
      "manualMetrics.ahrefsTrafficAsOf",
      { requireFresh: true },
    )
    const mozDomainAuthorityAsOf = assertMeasurementDate(
      dto.manualMetrics.mozDomainAuthorityAsOf,
      "manualMetrics.mozDomainAuthorityAsOf",
      { requireFresh: true },
    )

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
    const managedByUserId: string | null = isOperations
      ? user.id
      : (dto.managedByUserId ?? null)

    let website: any
    try {
      website = await runSerializableTransactionWithRetry(
        this.prisma,
        async (tx: any) => {
          if (managedByUserId) {
            await this.lockAndAssertActiveOperationsOwner(tx, managedByUserId)
          }

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
              traffic: dto.manualMetrics.ahrefsOrganicTraffic,
              domainAuthority: dto.manualMetrics.mozDomainAuthority,
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

          await upsertWebsiteMetric(tx, {
            websiteId: createdWebsite.id,
            key: WebsiteMetricKey.AHREFS_ORGANIC_TRAFFIC,
            provider: WebsiteMetricProvider.AHREFS,
            source: WebsiteMetricSource.STAFF_MANUAL,
            value: dto.manualMetrics.ahrefsOrganicTraffic,
            measuredAt: ahrefsTrafficAsOf,
            expiresAt: manualMetricExpiry(ahrefsTrafficAsOf),
            enteredByUserId: user.id,
          })
          await upsertWebsiteMetric(tx, {
            websiteId: createdWebsite.id,
            key: WebsiteMetricKey.MOZ_DOMAIN_AUTHORITY,
            provider: WebsiteMetricProvider.MOZ,
            source: WebsiteMetricSource.STAFF_MANUAL,
            value: dto.manualMetrics.mozDomainAuthority,
            measuredAt: mozDomainAuthorityAsOf,
            expiresAt: manualMetricExpiry(mozDomainAuthorityAsOf),
            enteredByUserId: user.id,
          })
          await this.audit.log(
            {
              action: "WEBSITE_MANUAL_METRICS_CREATED",
              entityType: "Website",
              entityId: createdWebsite.id,
              metadata: {
                ahrefsOrganicTraffic: dto.manualMetrics.ahrefsOrganicTraffic,
                ahrefsTrafficAsOf: ahrefsTrafficAsOf.toISOString(),
                mozDomainAuthority: dto.manualMetrics.mozDomainAuthority,
                mozDomainAuthorityAsOf: mozDomainAuthorityAsOf.toISOString(),
                source: "STAFF_MANUAL",
              },
              userId: user.id,
              organizationId: null,
            },
            tx,
          )

          return { ...createdWebsite, listing }
        },
      )
    } catch (error: any) {
      if (error?.code === "P2002") {
        throw new BadRequestException({
          code: "DOMAIN_ALREADY_REGISTERED",
          message: `Domain ${canonicalDomain} is already registered`,
        })
      }
      if (isRetryablePrismaTransactionError(error)) {
        throw new ConflictException(
          "Platform website creation changed concurrently. Review the latest staff and inventory state and try again.",
        )
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

    try {
      await this.queue.addJob(
        QUEUES.DOMAIN_METRICS,
        "domain-metrics-sync",
        { websiteIds: [website.id], trigger: "PLATFORM_WEBSITE_CREATED" },
        { jobId: `domain-metrics-${website.id}` },
      )
    } catch {
      // Provider availability must not roll back the durable website aggregate.
      // Scheduled/backfill collection will retry Ahrefs DR and OpenPageRank.
    }

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
    const newOwnerId = body.managedByUserId ?? null

    try {
      return await runSerializableTransactionWithRetry(
        this.prisma,
        async (tx: any) => {
          // Acquire the staff aggregate/target locks before touching Website so
          // this command has the same lock order as demotion and suspension.
          if (newOwnerId) {
            await this.lockAndAssertActiveOperationsOwner(tx, newOwnerId)
          }

          const website = await tx.website.findUnique({
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

          await tx.website.update({
            where: { id: websiteId },
            data: { managedByUserId: newOwnerId },
          })

          await this.audit.log(
            {
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
            },
            tx,
          )

          return { id: websiteId, managedByUserId: newOwnerId }
        },
      )
    } catch (error) {
      if (isRetryablePrismaTransactionError(error)) {
        throw new ConflictException(
          "Platform website ownership changed concurrently. Review the latest assignment and try again.",
        )
      }
      throw error
    }
  }

  // List OPERATIONS staff for the admin reassignment picker.
  async listOperationsStaff() {
    const memberships = await this.prisma.staffMembership.findMany({
      where: {
        role: "OPERATIONS",
        user: { banned: false, userType: "STAFF" },
      },
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

    // Operations reviews publisher inventory plus platform inventory assigned
    // to them. This same boundary is re-checked by every command.
    if (user?.staffRole === "OPERATIONS") {
      where.OR = [
        { ownershipType: WebsiteOwnershipType.PUBLISHER },
        {
          ownershipType: WebsiteOwnershipType.PLATFORM,
          managedByUserId: user.id,
        },
      ]
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
        moderation: buildModerationProjection(
          w,
          getStaffWebsiteModerationActions(w, {
            id: user?.id ?? "",
            staffRole: user?.staffRole ?? null,
          }),
        ),
        listing: w.marketplaceListings[0]
          ? {
              ...w.marketplaceListings[0],
              categories: w.marketplaceListings[0].categories.map(
                (item) => item.category,
              ),
              category:
                w.marketplaceListings[0].categories[0]?.category ?? null,
              moderation: buildModerationProjection(
                w.marketplaceListings[0],
                getStaffListingModerationActions(
                  {
                    ...w.marketplaceListings[0],
                    managedByUserId: w.managedByUserId,
                  },
                  {
                    id: user?.id ?? "",
                    staffRole: user?.staffRole ?? null,
                  },
                ),
              ),
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
          ? {
              OR: [
                { ownershipType: WebsiteOwnershipType.PUBLISHER },
                {
                  ownershipType: WebsiteOwnershipType.PLATFORM,
                  managedByUserId: user.id,
                },
              ],
            }
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
        moderationEvents: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 50,
          include: {
            actor: { select: { id: true, name: true, email: true } },
          },
        },
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
      moderation: {
        ...buildModerationProjection(
          website,
          getStaffWebsiteModerationActions(website, {
            id: user?.id ?? "",
            staffRole: user?.staffRole ?? null,
          }),
        ),
        history: website.moderationEvents,
      },
      listing: listing
        ? {
            ...listing,
            categories: listing.categories.map((item) => item.category),
            category: listing.categories[0]?.category ?? null,
            moderation: buildModerationProjection(
              listing,
              getStaffListingModerationActions(
                {
                  ...listing,
                  managedByUserId: website.managedByUserId,
                },
                {
                  id: user?.id ?? "",
                  staffRole: user?.staffRole ?? null,
                },
              ),
            ),
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

  async pauseWebsite(
    id: string,
    paused: boolean,
    user: any,
    details: {
      reasonCode?: ModerationReasonCode
      publisherMessage?: string
      internalNote?: string
      expectedVersion?: number
    } = {},
  ) {
    const website = await this.prisma.website.findUnique({
      where: { id },
      select: { moderationVersion: true },
    })
    if (!website) throw new NotFoundException("Website not found")
    return this.moderateWebsite(
      id,
      {
        action: paused ? ModerationAction.PAUSE : ModerationAction.RESTORE,
        reasonCode:
          details.reasonCode ??
          (paused
            ? ModerationReasonCode.OPERATIONAL_HOLD
            : ModerationReasonCode.ISSUE_RESOLVED),
        publisherMessage:
          details.publisherMessage ??
          (paused
            ? "This website is temporarily unavailable while GuestPost Operations reviews it."
            : undefined),
        internalNote:
          details.internalNote ??
          "Compatibility website pause endpoint mapped to an explicit moderation action.",
        expectedVersion:
          details.expectedVersion ?? website.moderationVersion ?? 0,
      },
      user,
    )
  }

  async moderateWebsite(
    id: string,
    command: WebsiteModerationCommand,
    user: any,
  ) {
    if (!user?.id || !["SUPER_ADMIN", "OPERATIONS"].includes(user.staffRole)) {
      throw new ForbiddenException("Staff moderation access is required")
    }

    const result = await this.prisma.$transaction(async (tx: any) => {
      await tx.$queryRaw`
        SELECT "id"
        FROM "Website"
        WHERE "id" = ${id}
        FOR UPDATE
      `
      const website = await tx.website.findUnique({
        where: { id },
        select: {
          id: true,
          url: true,
          domain: true,
          name: true,
          publisherId: true,
          ownershipType: true,
          managedByUserId: true,
          isActive: true,
          activeModerationAction: true,
          activeModerationAuthority: true,
          activeModerationReasonCode: true,
          activeModerationMessage: true,
          activeModerationPreviousActive: true,
          moderationVersion: true,
        },
      })
      if (!website) throw new NotFoundException("Website not found")
      if (website.moderationVersion !== command.expectedVersion) {
        throw new ConflictException({
          code: "MODERATION_VERSION_CONFLICT",
          message: "Website moderation changed; refresh and retry.",
          currentVersion: website.moderationVersion,
        })
      }
      if (
        user.staffRole === "OPERATIONS" &&
        website.ownershipType === WebsiteOwnershipType.PLATFORM &&
        website.managedByUserId !== user.id
      ) {
        throw new ForbiddenException(
          "Operations can only moderate assigned platform inventory",
        )
      }

      const allowedActions = getStaffWebsiteModerationActions(website, {
        id: user.id,
        staffRole: user.staffRole,
      })
      if (!allowedActions.includes(command.action)) {
        throw new BadRequestException({
          code: "INVALID_MODERATION_TRANSITION",
          message: `${command.action} is not allowed from the current website moderation state.`,
          allowedActions,
        })
      }
      if (
        website.ownershipType === WebsiteOwnershipType.PUBLISHER &&
        (
          [
            ModerationAction.PAUSE,
            ModerationAction.ARCHIVE,
          ] as ModerationAction[]
        ).includes(command.action) &&
        (!command.publisherMessage ||
          command.publisherMessage.trim().length < 10)
      ) {
        throw new BadRequestException({
          code: "PUBLISHER_MESSAGE_REQUIRED",
          message:
            "A clear publisher-facing message is required for this website action.",
        })
      }

      const authority =
        user.staffRole === "SUPER_ADMIN"
          ? ModerationAuthority.SUPER_ADMIN
          : ModerationAuthority.OPERATIONS
      let resultingActive = website.isActive
      let resultingAction = website.activeModerationAction
      let resultingAuthority = website.activeModerationAuthority
      let resultingReason = website.activeModerationReasonCode
      let resultingMessage = website.activeModerationMessage
      let resultingPreviousActive = website.activeModerationPreviousActive

      if (command.action === ModerationAction.PAUSE) {
        resultingActive = false
        resultingAction = ModerationAction.PAUSE
        resultingAuthority = authority
        resultingReason = command.reasonCode
        resultingMessage = command.publisherMessage?.trim() ?? null
        resultingPreviousActive = website.isActive
      } else if (command.action === ModerationAction.ARCHIVE) {
        resultingActive = false
        resultingAction = ModerationAction.ARCHIVE
        resultingAuthority = authority
        resultingReason = command.reasonCode
        resultingMessage = command.publisherMessage?.trim() ?? null
        resultingPreviousActive = website.isActive
      } else if (
        command.action === ModerationAction.RESTORE ||
        command.action === ModerationAction.REOPEN
      ) {
        resultingActive = true
        resultingAction = null
        resultingAuthority = null
        resultingReason = null
        resultingMessage = null
        resultingPreviousActive = null
      } else {
        throw new BadRequestException("Unsupported website moderation action")
      }

      const transition = await tx.website.updateMany({
        where: { id, moderationVersion: website.moderationVersion },
        data: {
          isActive: resultingActive,
          activeModerationAction: resultingAction,
          activeModerationAuthority: resultingAuthority,
          activeModerationReasonCode: resultingReason,
          activeModerationMessage: resultingMessage,
          activeModerationPreviousActive: resultingPreviousActive,
          moderationVersion: { increment: 1 },
        },
      })
      if (transition.count !== 1) {
        throw new ConflictException(
          "Website moderation changed concurrently; refresh and retry",
        )
      }

      const moderationEvent = await tx.moderationEvent.create({
        data: {
          scope: "WEBSITE",
          websiteId: id,
          action: command.action,
          reasonCode: command.reasonCode,
          publisherMessage: command.publisherMessage?.trim() ?? null,
          internalNote: command.internalNote?.trim() ?? null,
          actorUserId: user.id,
          actorStaffRole: user.staffRole,
          authority,
          previousWebsiteActive: website.isActive,
          resultingWebsiteActive: resultingActive,
          previousModerationAction: website.activeModerationAction,
          resultingModerationAction: resultingAction,
          resubmissionAllowed: false,
        },
      })

      await this.audit.log(
        {
          action: `WEBSITE_MODERATION_${command.action}`,
          entityType: "Website",
          entityId: id,
          metadata: {
            domain: website.domain,
            previousActive: website.isActive,
            resultingActive,
            reasonCode: command.reasonCode,
            publisherMessage: command.publisherMessage ?? null,
            internalNote: command.internalNote ?? null,
            previousModerationAction: website.activeModerationAction,
            resultingModerationAction: resultingAction,
            previousVersion: website.moderationVersion,
            resultingVersion: website.moderationVersion + 1,
            moderationEventId: moderationEvent.id,
            listingLifecyclePreserved: true,
          },
          userId: user.id,
          organizationId: null,
        },
        tx,
      )

      const communicationEventIds: string[] = []
      if (this.communications && website.publisherId) {
        const type =
          command.action === ModerationAction.PAUSE
            ? "MARKETPLACE_WEBSITE_PAUSED"
            : command.action === ModerationAction.ARCHIVE
              ? "MARKETPLACE_WEBSITE_ARCHIVED"
              : "MARKETPLACE_WEBSITE_RESTORED"
        const message =
          command.publisherMessage ??
          (resultingActive
            ? `Your website ${website.domain} is available in the marketplace again.`
            : `Your website ${website.domain} is unavailable in the marketplace.`)
        const recipients = await this.communications.publisherRecipients(
          website.publisherId,
          false,
          tx,
        )
        const event = await this.communications.record(
          {
            type,
            aggregateType: "Website",
            aggregateId: id,
            organizationId: null,
            title: resultingActive
              ? "Marketplace website restored"
              : command.action === ModerationAction.ARCHIVE
                ? "Marketplace website archived"
                : "Marketplace website paused",
            message,
            actionPath: `/dashboard/websites/${id}`,
            payload: {
              action: command.action,
              reasonCode: command.reasonCode,
              moderationEventId: moderationEvent.id,
            },
            dedupKey: `website:${id}:moderation:${moderationEvent.id}`,
            recipientUserIds: recipients,
            actorUserId: user.id,
          },
          tx,
        )
        communicationEventIds.push(event.eventId)
      }

      const updatedWebsite = await tx.website.findUniqueOrThrow({
        where: { id },
      })
      return {
        updatedWebsite: {
          ...updatedWebsite,
          moderation: buildModerationProjection(
            updatedWebsite,
            getStaffWebsiteModerationActions(updatedWebsite, {
              id: user.id,
              staffRole: user.staffRole,
            }),
          ),
        },
        communicationEventIds,
      }
    })

    this.communications?.dispatchManyBestEffort(result.communicationEventIds)
    return result.updatedWebsite
  }

  async deleteWebsite(id: string, user: any) {
    const website = await this.prisma.website.findUnique({
      where: { id },
      select: { ownershipType: true, moderationVersion: true },
    })
    if (!website) throw new NotFoundException("Website not found")
    if (website.ownershipType !== WebsiteOwnershipType.PLATFORM) {
      throw new BadRequestException(
        "Only platform websites can be archived via this compatibility endpoint",
      )
    }
    return this.moderateWebsite(
      id,
      {
        action: ModerationAction.ARCHIVE,
        reasonCode: ModerationReasonCode.DUPLICATE_OR_INVALID,
        internalNote:
          "Compatibility delete endpoint mapped to a recoverable website archive.",
        expectedVersion: website.moderationVersion,
      },
      user,
    )
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
    const result = await this.prisma.$transaction(async (tx: any) => {
      const observedPublisher = await tx.publisher.findUnique({
        where: { id: publisherId },
        select: { tier: true },
      })
      if (!observedPublisher) throw new NotFoundException("Publisher not found")
      if (!(await lockPublisherTierMutation(tx, publisherId))) {
        throw new NotFoundException("Publisher not found")
      }
      const publisher = await tx.publisher.findUnique({
        where: { id: publisherId },
      })
      if (!publisher) throw new NotFoundException("Publisher not found")
      if (publisher.tier === tier) {
        return { updatedPublisher: publisher, communicationDedupKeys: [] }
      }
      if (publisher.tier !== observedPublisher.tier) {
        throw new ConflictException(
          "Publisher tier changed concurrently; refresh and retry",
        )
      }
      const transition = await tx.publisher.updateMany({
        where: { id: publisherId, tier: publisher.tier },
        data: { tier: tier as any },
      })
      if (transition.count !== 1) {
        throw new ConflictException(
          "Publisher tier changed concurrently; refresh and retry",
        )
      }
      const updatedPublisher = await tx.publisher.findUniqueOrThrow({
        where: { id: publisherId },
      })

      const transitionAudit = await this.audit.log(
        {
          action: "PUBLISHER_TIER_CHANGED",
          entityType: "Publisher",
          entityId: publisherId,
          metadata: { from: publisher.tier, to: tier },
          userId: actor.id,
          organizationId: publisher.organizationId,
        },
        tx,
      )
      if (!transitionAudit?.id) {
        throw new Error("Publisher tier audit identity was not persisted")
      }
      if (this.communications) {
        const publisherRecipients =
          await this.communications.publisherRecipients(publisherId, false, tx)
        await this.communications.record(
          {
            type: "PUBLISHER_TIER_CHANGED",
            aggregateType: "Publisher",
            aggregateId: publisherId,
            organizationId: publisher.organizationId,
            title: "Publisher tier changed",
            message: `Your publisher tier changed from ${publisher.tier} to ${tier}.`,
            actionPath: "/dashboard/settings",
            payload: {
              from: publisher.tier,
              to: tier,
              transitionId: transitionAudit.id,
            },
            dedupKey: `publisher:${publisherId}:tier-change:${transitionAudit.id}`,
            recipientUserIds: publisherRecipients,
          },
          tx,
        )
        const staffRecipients = await this.communications.staffRecipients(
          ["SUPER_ADMIN", "OPERATIONS", "FINANCE"],
          tx,
        )
        await this.communications.record(
          {
            type: "STAFF_PUBLISHER_TIER_CHANGED",
            aggregateType: "Publisher",
            aggregateId: publisherId,
            organizationId: publisher.organizationId,
            title: "Publisher tier changed",
            message: `Publisher ${publisher.name ?? publisherId} changed from ${publisher.tier} to ${tier}.`,
            actionPath: "/dashboard/publishers",
            payload: {
              from: publisher.tier,
              to: tier,
              transitionId: transitionAudit.id,
            },
            dedupKey: `staff:publisher:${publisherId}:tier-change:${transitionAudit.id}`,
            recipientUserIds: staffRecipients,
            actorUserId: actor.id,
          },
          tx,
        )
      }

      return {
        updatedPublisher,
        communicationDedupKeys: this.communications
          ? [
              `publisher:${publisherId}:tier-change:${transitionAudit.id}`,
              `staff:publisher:${publisherId}:tier-change:${transitionAudit.id}`,
            ]
          : [],
      }
    })
    this.communications?.dispatchManyByDedupKeyBestEffort(
      result.communicationDedupKeys,
    )
    return result.updatedPublisher
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
    // Internal callers can bypass DTO validation, so financial policy inputs
    // are parsed again here and rejected rather than silently rounded/clamped.
    let canonicalFeePct: number
    try {
      canonicalFeePct = platformFeePercentToBasisPoints(platformFeePct) / 100
    } catch {
      throw new BadRequestException(
        "platformFeePct must be between 0 and 100 with at most two decimal places",
      )
    }

    return this.prisma.$transaction(async (tx: any) => {
      const settings = await tx.platformSettings.findFirst()
      if (!settings) {
        throw new NotFoundException("PlatformSettings row not initialized")
      }

      const oldValue = Number(settings.platformFeePct)
      if (oldValue === canonicalFeePct) {
        throw new BadRequestException(
          `platformFeePct is already ${canonicalFeePct} — no change`,
        )
      }

      // Optimistic-lock via version — concurrent fee changes resolve to one
      // winner; the loser retries. `updateMany` returns count 0 → conflict.
      const updated = await tx.platformSettings.updateMany({
        where: { id: settings.id, version: settings.version },
        data: {
          platformFeePct: canonicalFeePct,
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
            newValue: canonicalFeePct,
            reason,
          },
          userId: actor.id,
          organizationId: null,
        },
        tx,
      )

      return {
        id: settings.id,
        platformFeePct: canonicalFeePct,
      }
    })
  }
}
