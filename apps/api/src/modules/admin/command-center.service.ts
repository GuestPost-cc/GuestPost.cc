import { OrderStatus, type Prisma } from "@guestpost/database"
import {
  ACTIVE_CANCELLATION_REQUEST_STATUSES,
  FULFILLMENT_WORK_STATUSES,
  TERMINAL_ORDER_STATUSES,
} from "@guestpost/shared"
import { Injectable, Logger } from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { ReconciliationService } from "./reconciliation.service"

const ACTIVE_ASSIGNMENT_STATUSES = ["ASSIGNED", "IN_PROGRESS"] as const
const ACTIVE_DISPUTE_STATUSES = ["OPEN", "UNDER_REVIEW"] as const
const ACTIVE_SETTLEMENT_STATUSES = [
  "PENDING",
  "UNDER_REVIEW",
  "CUSTOMER_APPROVED",
  "ADMIN_APPROVED",
] as const
const ACTIVE_TICKET_STATUSES = ["OPEN", "IN_PROGRESS"] as const
const VERIFICATION_ISSUE_STATUSES = ["FAILED", "MANUAL_REVIEW"] as const
const TERMINAL_COMMAND_CENTER_STATUSES =
  TERMINAL_ORDER_STATUSES as OrderStatus[]

type CommandCenterPriority = "CRITICAL" | "HIGH" | "MEDIUM"
type CommandCenterActionType =
  | "RECONCILIATION"
  | "CANCELLATION"
  | "DISPUTE"
  | "DELIVERY_VERIFICATION"
  | "FULFILLMENT"
  | "SETTLEMENT"
  | "WITHDRAWAL"
  | "SUPPORT"

interface CommandCenterAction {
  id: string
  type: CommandCenterActionType
  priority: CommandCenterPriority
  title: string
  description: string
  owner: "Operations" | "Finance" | "Resolution" | "Support"
  href: string
  createdAt: Date | string
  deadlineAt: Date | string | null
  amount: string | null
  currency: string | null
}

const priorityRank: Record<CommandCenterPriority, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
}

export function sortCommandCenterActions(
  left: CommandCenterAction,
  right: CommandCenterAction,
) {
  const priorityDifference =
    priorityRank[left.priority] - priorityRank[right.priority]
  if (priorityDifference !== 0) return priorityDifference

  const leftDeadline = left.deadlineAt
    ? new Date(left.deadlineAt).getTime()
    : Number.POSITIVE_INFINITY
  const rightDeadline = right.deadlineAt
    ? new Date(right.deadlineAt).getTime()
    : Number.POSITIVE_INFINITY
  if (leftDeadline !== rightDeadline) return leftDeadline - rightDeadline

  return (
    new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
  )
}

function isOverdue(value: Date | string | null | undefined, now: Date) {
  return Boolean(value && new Date(value).getTime() < now.getTime())
}

function ageExceeds(value: Date | string, hours: number, now: Date): boolean {
  return now.getTime() - new Date(value).getTime() >= hours * 60 * 60 * 1000
}

function money(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return Number(value).toFixed(2)
}

function sumLifecycleCounts(
  counts: Map<string, number>,
  statuses: readonly string[],
) {
  return statuses.reduce(
    (total, status) => total + (counts.get(status) ?? 0),
    0,
  )
}

@Injectable()
export class CommandCenterService {
  private readonly logger = new Logger(CommandCenterService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  async getCommandCenter() {
    const now = new Date()
    const platformChannel: Prisma.OrderWhereInput = {
      OR: [
        { fulfillmentChannel: "PLATFORM" },
        {
          fulfillmentChannel: null,
          website: { ownershipType: "PLATFORM" },
        },
      ],
    }
    const activeFulfillment: Prisma.OrderWhereInput = {
      status: { in: [...FULFILLMENT_WORK_STATUSES] },
      cancellationRequests: {
        none: { status: { in: [...ACTIVE_CANCELLATION_REQUEST_STATUSES] } },
      },
    }
    const unassignedFulfillment: Prisma.OrderWhereInput = {
      AND: [
        platformChannel,
        activeFulfillment,
        {
          fulfillmentAssignments: {
            none: { status: { in: [...ACTIVE_ASSIGNMENT_STATUSES] } },
          },
        },
      ],
    }
    const overdueAssignedFulfillment: Prisma.OrderWhereInput = {
      AND: [
        platformChannel,
        activeFulfillment,
        { fulfillmentDueAt: { lt: now } },
        {
          fulfillmentAssignments: {
            some: { status: { in: [...ACTIVE_ASSIGNMENT_STATUSES] } },
          },
        },
      ],
    }
    const verificationIssues: Prisma.OrderWhereInput = {
      status: "PUBLISHED",
      activeDeliveryVersion: {
        verificationStatus: { in: [...VERIFICATION_ISSUE_STATUSES] },
      },
    }

    const reconciliationPromise = this.reconciliation.run().catch(() => {
      // Keep operational oversight available when the deeper integrity scan
      // is temporarily unavailable. Do not log report data or financial rows.
      this.logger.warn("Command-center reconciliation scan unavailable")
      return null
    })

    const [
      lifecycleRows,
      activeOrderCount,
      cancellationCount,
      disputeCount,
      verificationIssueCount,
      unassignedFulfillmentCount,
      overdueFulfillmentCount,
      settlementReviewCount,
      pendingWithdrawalCount,
      failedWithdrawalCount,
      failedPayoutCount,
      unassignedSupportCount,
      domainVerificationIssueCount,
      pendingListingCount,
      revenue,
      cancellations,
      disputes,
      verificationOrders,
      fulfillmentOrders,
      settlements,
      withdrawals,
      tickets,
      auditRows,
      reconciliation,
    ] = await Promise.all([
      this.prisma.order.groupBy({ by: ["status"], _count: { _all: true } }),
      this.prisma.order.count({
        where: { status: { notIn: TERMINAL_COMMAND_CENTER_STATUSES } },
      }),
      this.prisma.orderCancellationRequest.count({
        where: { status: { in: [...ACTIVE_CANCELLATION_REQUEST_STATUSES] } },
      }),
      this.prisma.orderDispute.count({
        where: { status: { in: [...ACTIVE_DISPUTE_STATUSES] } },
      }),
      this.prisma.order.count({ where: verificationIssues }),
      this.prisma.order.count({ where: unassignedFulfillment }),
      this.prisma.order.count({ where: overdueAssignedFulfillment }),
      this.prisma.settlement.count({
        where: { status: { in: [...ACTIVE_SETTLEMENT_STATUSES] } },
      }),
      this.prisma.withdrawal.count({
        where: { status: { in: ["PENDING", "APPROVED"] } },
      }),
      this.prisma.withdrawal.count({ where: { status: "FAILED" } }),
      this.prisma.payoutExecution.count({ where: { status: "FAILED" } }),
      this.prisma.ticket.count({
        where: {
          fulfillmentChannel: "PLATFORM",
          assignedToUserId: null,
          status: { in: [...ACTIVE_TICKET_STATUSES] },
        },
      }),
      this.prisma.website.count({
        where: {
          isActive: true,
          verificationStatus: {
            in: ["PENDING_VERIFICATION", "VERIFICATION_FAILED", "REVOKED"],
          },
        },
      }),
      this.prisma.marketplaceListing.count({
        where: { status: "PENDING_REVIEW" },
      }),
      this.prisma.platformRevenue.aggregate({
        where: { reversedAt: null },
        _sum: { amount: true, netRevenue: true },
      }),
      this.prisma.orderCancellationRequest.findMany({
        where: { status: { in: [...ACTIVE_CANCELLATION_REQUEST_STATUSES] } },
        orderBy: [{ responseDeadlineAt: "asc" }, { createdAt: "asc" }],
        take: 4,
        select: {
          id: true,
          status: true,
          reasonCode: true,
          responseDeadlineAt: true,
          createdAt: true,
          order: {
            select: {
              id: true,
              title: true,
              amount: true,
              currency: true,
            },
          },
        },
      }),
      this.prisma.orderDispute.findMany({
        where: { status: { in: [...ACTIVE_DISPUTE_STATUSES] } },
        orderBy: { createdAt: "asc" },
        take: 4,
        select: {
          id: true,
          status: true,
          reason: true,
          createdAt: true,
          order: {
            select: {
              id: true,
              title: true,
              amount: true,
              currency: true,
            },
          },
        },
      }),
      this.prisma.order.findMany({
        where: verificationIssues,
        orderBy: { createdAt: "asc" },
        take: 4,
        select: {
          id: true,
          title: true,
          amount: true,
          currency: true,
          createdAt: true,
          website: { select: { domain: true, name: true } },
          activeDeliveryVersion: {
            select: {
              verificationStatus: true,
              verificationFailureReason: true,
              submittedAt: true,
            },
          },
        },
      }),
      this.prisma.order.findMany({
        where: { OR: [unassignedFulfillment, overdueAssignedFulfillment] },
        orderBy: [{ fulfillmentDueAt: "asc" }, { createdAt: "asc" }],
        take: 4,
        select: {
          id: true,
          title: true,
          amount: true,
          currency: true,
          createdAt: true,
          fulfillmentDueAt: true,
          website: { select: { domain: true, name: true } },
          fulfillmentAssignments: {
            where: { status: { in: [...ACTIVE_ASSIGNMENT_STATUSES] } },
            take: 1,
            select: { id: true },
          },
        },
      }),
      this.prisma.settlement.findMany({
        where: { status: { in: [...ACTIVE_SETTLEMENT_STATUSES] } },
        orderBy: [{ reviewEndsAt: "asc" }, { createdAt: "asc" }],
        take: 4,
        select: {
          id: true,
          status: true,
          publisherAmount: true,
          reviewEndsAt: true,
          createdAt: true,
          order: { select: { id: true, title: true, currency: true } },
          publisher: { select: { name: true, email: true } },
        },
      }),
      this.prisma.withdrawal.findMany({
        where: { status: { in: ["PENDING", "FAILED"] } },
        orderBy: [{ status: "asc" }, { createdAt: "asc" }],
        take: 4,
        select: {
          id: true,
          status: true,
          amount: true,
          createdAt: true,
          publisher: { select: { name: true, email: true } },
        },
      }),
      this.prisma.ticket.findMany({
        where: { status: { in: [...ACTIVE_TICKET_STATUSES] } },
        orderBy: { updatedAt: "asc" },
        take: 4,
        select: {
          id: true,
          subject: true,
          status: true,
          fulfillmentChannel: true,
          assignedToUserId: true,
          assignedPublisherId: true,
          createdAt: true,
          updatedAt: true,
          order: { select: { id: true } },
        },
      }),
      this.prisma.auditLog.findMany({
        orderBy: { createdAt: "desc" },
        take: 6,
        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          createdAt: true,
          user: { select: { name: true, email: true } },
        },
      }),
      reconciliationPromise,
    ])

    const actions: CommandCenterAction[] = []

    if (reconciliation && reconciliation.summary.totalIssues > 0) {
      actions.push({
        id: "reconciliation",
        type: "RECONCILIATION",
        priority: reconciliation.summary.critical > 0 ? "CRITICAL" : "HIGH",
        title: "Financial reconciliation needs review",
        description: `${reconciliation.summary.totalIssues} integrity issue${reconciliation.summary.totalIssues === 1 ? "" : "s"} detected`,
        owner: "Finance",
        href: "/dashboard/finance",
        createdAt: reconciliation.ranAt,
        deadlineAt: null,
        amount: null,
        currency: null,
      })
    }

    for (const item of cancellations) {
      actions.push({
        id: item.id,
        type: "CANCELLATION",
        priority: isOverdue(item.responseDeadlineAt, now) ? "CRITICAL" : "HIGH",
        title: item.order.title || `Order #${item.order.id.slice(0, 8)}`,
        description: `${item.status.replaceAll("_", " ")} · ${item.reasonCode.replaceAll("_", " ")}`,
        owner: item.status === "PENDING_FINANCE" ? "Finance" : "Operations",
        href: "/dashboard/cancellations",
        createdAt: item.createdAt,
        deadlineAt: item.responseDeadlineAt,
        amount: money(item.order.amount),
        currency: item.order.currency,
      })
    }

    for (const item of disputes) {
      actions.push({
        id: item.id,
        type: "DISPUTE",
        priority: ageExceeds(item.createdAt, 48, now) ? "CRITICAL" : "HIGH",
        title: item.order.title || `Order #${item.order.id.slice(0, 8)}`,
        description: `${item.status.replaceAll("_", " ")} · ${item.reason}`,
        owner: "Resolution",
        href: `/dashboard/disputes/${item.id}/evidence`,
        createdAt: item.createdAt,
        deadlineAt: null,
        amount: money(item.order.amount),
        currency: item.order.currency,
      })
    }

    for (const item of verificationOrders) {
      const delivery = item.activeDeliveryVersion
      const submittedAt = delivery?.submittedAt ?? item.createdAt
      actions.push({
        id: item.id,
        type: "DELIVERY_VERIFICATION",
        priority:
          delivery?.verificationStatus === "FAILED" ||
          ageExceeds(submittedAt, 48, now)
            ? "HIGH"
            : "MEDIUM",
        title:
          item.title || item.website?.domain || `Order #${item.id.slice(0, 8)}`,
        description:
          delivery?.verificationFailureReason ||
          delivery?.verificationStatus.replaceAll("_", " ") ||
          "Delivery needs manual review",
        owner: "Operations",
        href: "/dashboard/verification/delivery",
        createdAt: submittedAt,
        deadlineAt: null,
        amount: money(item.amount),
        currency: item.currency,
      })
    }

    for (const item of fulfillmentOrders) {
      const unassigned = item.fulfillmentAssignments.length === 0
      actions.push({
        id: item.id,
        type: "FULFILLMENT",
        priority: isOverdue(item.fulfillmentDueAt, now) ? "HIGH" : "MEDIUM",
        title:
          item.title || item.website?.domain || `Order #${item.id.slice(0, 8)}`,
        description: unassigned
          ? "Platform order is waiting for an owner"
          : "Assigned platform order is overdue",
        owner: "Operations",
        href: `/dashboard/fulfillment/${item.id}`,
        createdAt: item.createdAt,
        deadlineAt: item.fulfillmentDueAt,
        amount: money(item.amount),
        currency: item.currency,
      })
    }

    for (const item of settlements) {
      actions.push({
        id: item.id,
        type: "SETTLEMENT",
        priority: isOverdue(item.reviewEndsAt, now) ? "HIGH" : "MEDIUM",
        title:
          item.order.title ||
          `Settlement for order #${item.order.id.slice(0, 8)}`,
        description: `${item.status.replaceAll("_", " ")} · ${item.publisher.name ?? item.publisher.email}`,
        owner: "Finance",
        href: "/dashboard/finance/settlement-review",
        createdAt: item.createdAt,
        deadlineAt: item.reviewEndsAt,
        amount: money(item.publisherAmount),
        currency: item.order.currency,
      })
    }

    for (const item of withdrawals) {
      actions.push({
        id: item.id,
        type: "WITHDRAWAL",
        priority: item.status === "FAILED" ? "CRITICAL" : "MEDIUM",
        title: item.publisher.name ?? item.publisher.email,
        description:
          item.status === "FAILED"
            ? "Withdrawal failed and needs Finance review"
            : "Publisher withdrawal is awaiting review",
        owner: "Finance",
        href: "/dashboard/finance",
        createdAt: item.createdAt,
        deadlineAt: null,
        amount: money(item.amount),
        currency: "USD",
      })
    }

    for (const item of tickets) {
      const unassigned =
        item.fulfillmentChannel === "PLATFORM" && !item.assignedToUserId
      actions.push({
        id: item.id,
        type: "SUPPORT",
        priority:
          unassigned && ageExceeds(item.updatedAt, 24, now) ? "HIGH" : "MEDIUM",
        title: item.subject,
        description: unassigned
          ? "Unassigned platform support ticket"
          : `${item.status.replaceAll("_", " ")} support ticket`,
        owner: "Support",
        href: `/dashboard/support/${item.id}`,
        createdAt: item.createdAt,
        deadlineAt: null,
        amount: null,
        currency: null,
      })
    }

    const lifecycleCounts = new Map(
      lifecycleRows.map((row) => [row.status, row._count._all]),
    )
    const reconciliationSummary = reconciliation
      ? {
          available: true,
          ok: reconciliation.ok,
          critical: reconciliation.summary.critical,
          warning: reconciliation.summary.warning,
          totalIssues: reconciliation.summary.totalIssues,
          ranAt: reconciliation.ranAt,
        }
      : {
          available: false,
          ok: false,
          critical: 0,
          warning: 0,
          totalIssues: 0,
          ranAt: null,
        }

    const financeExceptionCount =
      reconciliationSummary.totalIssues +
      failedWithdrawalCount +
      failedPayoutCount
    const needsAction =
      cancellationCount +
      disputeCount +
      verificationIssueCount +
      unassignedFulfillmentCount +
      overdueFulfillmentCount +
      settlementReviewCount +
      pendingWithdrawalCount +
      failedWithdrawalCount +
      failedPayoutCount +
      unassignedSupportCount +
      reconciliationSummary.totalIssues

    return {
      generatedAt: now.toISOString(),
      overview: {
        needsAction,
        activeOrders: activeOrderCount,
        financeExceptions: financeExceptionCount,
        verificationIssues: verificationIssueCount,
      },
      actionQueue: actions.sort(sortCommandCenterActions).slice(0, 12),
      lifecycle: [
        {
          key: "PAYMENT",
          label: "Payment & intake",
          count: sumLifecycleCounts(lifecycleCounts, [
            "DRAFT",
            "PENDING_PAYMENT",
            "PAID",
          ]),
        },
        {
          key: "PRODUCTION",
          label: "Production",
          count: sumLifecycleCounts(lifecycleCounts, [
            "SUBMITTED",
            "ACCEPTED",
            "CONTENT_REQUESTED",
            "CONTENT_CREATION",
            "CONTENT_READY",
          ]),
        },
        {
          key: "REVIEW",
          label: "Customer review",
          count: sumLifecycleCounts(lifecycleCounts, [
            "CUSTOMER_REVIEW",
            "APPROVED",
          ]),
        },
        {
          key: "VERIFICATION",
          label: "Publishing & verification",
          count: sumLifecycleCounts(lifecycleCounts, [
            "PUBLISHED",
            "VERIFIED",
            "DELIVERED",
          ]),
        },
        {
          key: "COMPLETE",
          label: "Settled & completed",
          count: sumLifecycleCounts(lifecycleCounts, ["SETTLED", "COMPLETED"]),
        },
        {
          key: "EXCEPTION",
          label: "Cancelled, refunded or disputed",
          count: sumLifecycleCounts(lifecycleCounts, [
            "CANCELLED",
            "REFUNDED",
            "DISPUTED",
          ]),
        },
      ],
      health: {
        unassignedFulfillment: unassignedFulfillmentCount,
        overdueFulfillment: overdueFulfillmentCount,
        activeDisputes: disputeCount,
        activeCancellations: cancellationCount,
        unassignedSupport: unassignedSupportCount,
        domainVerificationIssues: domainVerificationIssueCount,
        marketplacePendingReview: pendingListingCount,
      },
      finance: {
        currency: "USD",
        gmv: money(revenue._sum.amount) ?? "0.00",
        netRevenue: money(revenue._sum.netRevenue) ?? "0.00",
        settlementsInReview: settlementReviewCount,
        withdrawalsPending: pendingWithdrawalCount,
        failedWithdrawals: failedWithdrawalCount,
        failedPayouts: failedPayoutCount,
        reconciliation: reconciliationSummary,
      },
      recentActivity: auditRows.map((row) => ({
        id: row.id,
        action: row.action,
        entity: row.entityType,
        entityId: row.entityId,
        actorName: row.user?.name ?? row.user?.email ?? "System",
        createdAt: row.createdAt,
      })),
    }
  }
}
