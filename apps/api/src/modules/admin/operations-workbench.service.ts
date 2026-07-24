import type { Prisma } from "@guestpost/database"
import { ForbiddenException, Injectable } from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { OrderFulfillmentAssignmentService } from "../orders/services/order-fulfillment-assignment.service"

const ACTIVE_SUPPORT_STATUSES = ["OPEN", "IN_PROGRESS"] as const
const OPERATIONS_CANCELLATION_STATUSES = [
  "REQUESTED",
  "UNDER_REVIEW",
  "ESCALATED",
] as const
const ACTIVE_DISPUTE_STATUSES = ["OPEN", "UNDER_REVIEW"] as const
const DELIVERY_ISSUE_STATUSES = ["FAILED", "MANUAL_REVIEW"] as const
const DOMAIN_ISSUE_STATUSES = [
  "PENDING_VERIFICATION",
  "VERIFICATION_FAILED",
  "REVOKED",
] as const

export type OperationsWorkbenchPriority = "CRITICAL" | "HIGH" | "MEDIUM"
export type OperationsWorkbenchActionType =
  | "SUPPORT"
  | "FULFILLMENT"
  | "CANCELLATION"
  | "DISPUTE"
  | "DELIVERY_VERIFICATION"
  | "DOMAIN_VERIFICATION"
  | "MODERATION"
  | "INVENTORY"

export interface OperationsWorkbenchAction {
  id: string
  type: OperationsWorkbenchActionType
  priority: OperationsWorkbenchPriority
  title: string
  description: string
  href: string
  createdAt: Date | string
  deadlineAt: Date | string | null
  claimable: boolean
}

const priorityRank: Record<OperationsWorkbenchPriority, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
}

// Support leads within an equal severity band. Critical integrity failures and
// expired contractual deadlines still retain the higher severity.
const actionTypeRank: Record<OperationsWorkbenchActionType, number> = {
  SUPPORT: 0,
  CANCELLATION: 1,
  DELIVERY_VERIFICATION: 2,
  FULFILLMENT: 3,
  DISPUTE: 4,
  DOMAIN_VERIFICATION: 5,
  MODERATION: 6,
  INVENTORY: 7,
}

export function sortOperationsWorkbenchActions(
  left: OperationsWorkbenchAction,
  right: OperationsWorkbenchAction,
) {
  const priorityDifference =
    priorityRank[left.priority] - priorityRank[right.priority]
  if (priorityDifference !== 0) return priorityDifference

  const typeDifference = actionTypeRank[left.type] - actionTypeRank[right.type]
  if (typeDifference !== 0) return typeDifference

  const deadline = (value: Date | string | null) =>
    value ? new Date(value).getTime() : Number.POSITIVE_INFINITY
  const deadlineDifference =
    deadline(left.deadlineAt) - deadline(right.deadlineAt)
  if (deadlineDifference !== 0) return deadlineDifference

  return (
    new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
  )
}

function olderThan(value: Date | string, hours: number, now: Date) {
  return now.getTime() - new Date(value).getTime() >= hours * 60 * 60 * 1000
}

function isPast(value: Date | string | null | undefined, now: Date) {
  return Boolean(value && new Date(value).getTime() < now.getTime())
}

function supportDeadline(value: Date | string) {
  return new Date(new Date(value).getTime() + 24 * 60 * 60 * 1000)
}

@Injectable()
export class OperationsWorkbenchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fulfillment: OrderFulfillmentAssignmentService,
  ) {}

  async getWorkbench(user: { id: string; staffRole: string }) {
    if (user.staffRole !== "OPERATIONS" && user.staffRole !== "SUPER_ADMIN") {
      throw new ForbiddenException("Operations workbench access required")
    }

    const now = new Date()
    const supportTarget = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    const isOperations = user.staffRole === "OPERATIONS"
    const supportWhere: Prisma.TicketWhereInput = {
      status: { in: [...ACTIVE_SUPPORT_STATUSES] },
      fulfillmentChannel: "PLATFORM",
      ...(isOperations ? { assignedToUserId: user.id } : {}),
    }
    const assignedPlatformWebsite: Prisma.WebsiteWhereInput = {
      ownershipType: "PLATFORM",
      ...(isOperations ? { managedByUserId: user.id } : {}),
    }
    const inventoryWhere: Prisma.MarketplaceListingWhereInput = {
      ownerType: "PLATFORM",
      website: assignedPlatformWebsite,
      OR: [
        { status: { in: ["DRAFT", "REJECTED", "PAUSED"] } },
        { services: { none: { availability: "AVAILABLE" } } },
      ],
    }

    const [
      activeFulfillment,
      availableFulfillment,
      assignedSupportCount,
      overdueSupportCount,
      supportTickets,
      cancellationCount,
      cancellations,
      disputeCount,
      disputes,
      deliveryIssueCount,
      deliveryIssues,
      domainIssueCount,
      domainIssues,
      moderationCount,
      moderationItems,
      inventoryIssueCount,
      inventoryItems,
      integrationIssueCount,
    ] = await Promise.all([
      this.fulfillment.operationsInbox(user, {
        view: "active",
        take: 8,
        includeSummary: true,
      }),
      this.fulfillment.operationsInbox(user, {
        view: "available",
        take: 5,
        includeSummary: false,
      }),
      this.prisma.ticket.count({ where: supportWhere }),
      this.prisma.ticket.count({
        where: { ...supportWhere, updatedAt: { lt: supportTarget } },
      }),
      this.prisma.ticket.findMany({
        where: supportWhere,
        orderBy: { updatedAt: "asc" },
        take: 8,
        select: {
          id: true,
          subject: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          order: {
            select: {
              id: true,
              title: true,
              status: true,
              website: { select: { domain: true, name: true } },
            },
          },
        },
      }),
      this.prisma.orderCancellationRequest.count({
        where: { status: { in: [...OPERATIONS_CANCELLATION_STATUSES] } },
      }),
      this.prisma.orderCancellationRequest.findMany({
        where: { status: { in: [...OPERATIONS_CANCELLATION_STATUSES] } },
        orderBy: [{ responseDeadlineAt: "asc" }, { createdAt: "asc" }],
        take: 5,
        select: {
          id: true,
          status: true,
          reasonCode: true,
          responseDeadlineAt: true,
          createdAt: true,
          order: {
            select: { id: true, title: true, fulfillmentChannel: true },
          },
        },
      }),
      this.prisma.orderDispute.count({
        where: { status: { in: [...ACTIVE_DISPUTE_STATUSES] } },
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
          order: { select: { id: true, title: true } },
        },
      }),
      this.prisma.order.count({
        where: {
          activeDeliveryVersion: {
            is: { verificationStatus: { in: [...DELIVERY_ISSUE_STATUSES] } },
          },
        },
      }),
      this.prisma.order.findMany({
        where: {
          activeDeliveryVersion: {
            is: { verificationStatus: { in: [...DELIVERY_ISSUE_STATUSES] } },
          },
        },
        orderBy: { updatedAt: "asc" },
        take: 5,
        select: {
          id: true,
          title: true,
          status: true,
          updatedAt: true,
          website: { select: { domain: true, name: true } },
          activeDeliveryVersion: {
            select: { verificationStatus: true, createdAt: true },
          },
        },
      }),
      this.prisma.website.count({
        where: {
          ownershipType: "PUBLISHER",
          verificationStatus: { in: [...DOMAIN_ISSUE_STATUSES] },
        },
      }),
      this.prisma.website.findMany({
        where: {
          ownershipType: "PUBLISHER",
          verificationStatus: { in: [...DOMAIN_ISSUE_STATUSES] },
        },
        orderBy: { updatedAt: "asc" },
        take: 5,
        select: {
          id: true,
          domain: true,
          canonicalDomain: true,
          verificationStatus: true,
          consecutiveFailures: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.marketplaceListing.count({
        where: { status: "PENDING_REVIEW" },
      }),
      this.prisma.marketplaceListing.findMany({
        where: { status: "PENDING_REVIEW" },
        orderBy: { createdAt: "asc" },
        take: 5,
        select: {
          id: true,
          slug: true,
          title: true,
          ownerType: true,
          createdAt: true,
          website: { select: { domain: true } },
        },
      }),
      this.prisma.marketplaceListing.count({ where: inventoryWhere }),
      this.prisma.marketplaceListing.findMany({
        where: inventoryWhere,
        orderBy: { updatedAt: "asc" },
        take: 5,
        select: {
          id: true,
          title: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          website: { select: { id: true, domain: true, name: true } },
          _count: {
            select: { services: { where: { availability: "AVAILABLE" } } },
          },
        },
      }),
      this.prisma.website.count({
        where: {
          ...assignedPlatformWebsite,
          websiteIntegrations: {
            some: {
              integration: {
                status: { in: ["TOKEN_EXPIRED", "REAUTH_REQUIRED", "ERROR"] },
              },
            },
          },
        },
      }),
    ])

    const summary = activeFulfillment.summary ?? {
      myActive: 0,
      available: availableFulfillment.total,
      waitingCustomer: 0,
      readyToPublish: 0,
      overdue: 0,
      verificationTotal: 0,
      verificationIssues: 0,
      totalAssigned: 0,
      claimed: 0,
      completed: 0,
      salesByCurrency: {},
    }
    const actions: OperationsWorkbenchAction[] = []

    for (const ticket of supportTickets) {
      const isOverdue = olderThan(ticket.updatedAt, 24, now)
      actions.push({
        id: ticket.id,
        type: "SUPPORT",
        priority: isOverdue ? "HIGH" : "MEDIUM",
        title: ticket.subject,
        description: ticket.order
          ? `${ticket.order.website?.domain ?? ticket.order.website?.name ?? "Assigned order"} · ${ticket.order.status.replaceAll("_", " ")}`
          : "Assigned platform or listing support",
        href: `/dashboard/support/${ticket.id}`,
        createdAt: ticket.createdAt,
        deadlineAt: supportDeadline(ticket.updatedAt),
        claimable: false,
      })
    }

    for (const order of activeFulfillment.items) {
      const overdue = isPast(order.fulfillmentDueAt, now)
      const verificationFailed =
        order.activeDeliveryVersion?.verificationStatus === "FAILED"
      actions.push({
        id: order.id,
        type: "FULFILLMENT",
        priority: overdue || verificationFailed ? "CRITICAL" : "HIGH",
        title:
          order.title ??
          order.website?.domain ??
          `Order #${order.id.slice(0, 8)}`,
        description: `${order.nextAction.replaceAll("_", " ")} · ${order.status.replaceAll("_", " ")}`,
        href: `/dashboard/fulfillment/${order.id}`,
        createdAt: order.createdAt,
        deadlineAt: order.fulfillmentDueAt,
        claimable: false,
      })
    }

    for (const order of availableFulfillment.items) {
      actions.push({
        id: order.id,
        type: "FULFILLMENT",
        priority: "MEDIUM",
        title:
          order.title ??
          order.website?.domain ??
          `Order #${order.id.slice(0, 8)}`,
        description: "Available platform order",
        href: `/dashboard/fulfillment/${order.id}`,
        createdAt: order.createdAt,
        deadlineAt: order.fulfillmentDueAt,
        claimable: true,
      })
    }

    for (const item of cancellations) {
      const expired = isPast(item.responseDeadlineAt, now)
      actions.push({
        id: item.id,
        type: "CANCELLATION",
        priority: expired ? "CRITICAL" : "HIGH",
        title: item.order.title ?? `Order #${item.order.id.slice(0, 8)}`,
        description: `${item.status.replaceAll("_", " ")} · ${item.reasonCode.replaceAll("_", " ")}`,
        href: "/dashboard/cancellations",
        createdAt: item.createdAt,
        deadlineAt: item.responseDeadlineAt,
        claimable: false,
      })
    }

    for (const item of disputes) {
      actions.push({
        id: item.id,
        type: "DISPUTE",
        priority: olderThan(item.createdAt, 48, now) ? "HIGH" : "MEDIUM",
        title: item.order.title ?? `Order #${item.order.id.slice(0, 8)}`,
        description: `${item.status.replaceAll("_", " ")} · Operational review`,
        href: "/dashboard/disputes",
        createdAt: item.createdAt,
        deadlineAt: null,
        claimable: false,
      })
    }

    for (const item of deliveryIssues) {
      const status =
        item.activeDeliveryVersion?.verificationStatus ?? "MANUAL_REVIEW"
      actions.push({
        id: item.id,
        type: "DELIVERY_VERIFICATION",
        priority: status === "FAILED" ? "CRITICAL" : "HIGH",
        title:
          item.title ?? item.website?.domain ?? `Order #${item.id.slice(0, 8)}`,
        description: `${status.replaceAll("_", " ")} delivery evidence`,
        href: "/dashboard/verification/delivery",
        createdAt: item.activeDeliveryVersion?.createdAt ?? item.updatedAt,
        deadlineAt: null,
        claimable: false,
      })
    }

    for (const item of domainIssues) {
      actions.push({
        id: item.id,
        type: "DOMAIN_VERIFICATION",
        priority:
          item.verificationStatus === "REVOKED"
            ? "CRITICAL"
            : item.verificationStatus === "VERIFICATION_FAILED"
              ? "HIGH"
              : "MEDIUM",
        title:
          item.canonicalDomain ??
          item.domain ??
          `Website #${item.id.slice(0, 8)}`,
        description: `${item.verificationStatus.replaceAll("_", " ")} · ${item.consecutiveFailures} consecutive failure${item.consecutiveFailures === 1 ? "" : "s"}`,
        href: "/dashboard/verification",
        createdAt: item.createdAt,
        deadlineAt: null,
        claimable: false,
      })
    }

    for (const item of moderationItems) {
      actions.push({
        id: item.id,
        type: "MODERATION",
        priority: "HIGH",
        title: item.title,
        description: `${item.ownerType.replaceAll("_", " ")} listing · ${item.website?.domain ?? "Review metadata"}`,
        href: `/dashboard/marketplace/${item.slug}`,
        createdAt: item.createdAt,
        deadlineAt: null,
        claimable: false,
      })
    }

    for (const item of inventoryItems) {
      actions.push({
        id: item.id,
        type: "INVENTORY",
        priority: "MEDIUM",
        title: item.title,
        description:
          item._count.services === 0
            ? "Assigned listing has no available service"
            : `Assigned listing is ${item.status.replaceAll("_", " ")}`,
        href: item.website
          ? `/dashboard/websites/${item.website.id}`
          : "/dashboard/websites",
        createdAt: item.createdAt,
        deadlineAt: null,
        claimable: false,
      })
    }

    const sortedActions = actions.sort(sortOperationsWorkbenchActions)
    const actionQueue = sortedActions.slice(0, 14)
    const firstSupport = sortedActions.find((item) => item.type === "SUPPORT")
    if (
      firstSupport &&
      !actionQueue.some((item) => item.type === "SUPPORT") &&
      actionQueue.length === 14
    ) {
      actionQueue[actionQueue.length - 1] = firstSupport
      actionQueue.sort(sortOperationsWorkbenchActions)
    }

    return {
      generatedAt: now.toISOString(),
      overview: {
        needsAttention:
          summary.overdue +
          assignedSupportCount +
          cancellationCount +
          disputeCount +
          deliveryIssueCount +
          domainIssueCount +
          moderationCount +
          inventoryIssueCount +
          integrationIssueCount,
        myActive: summary.myActive,
        available: summary.available,
        readyToPublish: summary.readyToPublish,
        verificationIssues: deliveryIssueCount,
        assignedSupport: assignedSupportCount,
      },
      actionQueue,
      support: {
        assigned: assignedSupportCount,
        overdue: overdueSupportCount,
        items: supportTickets.map((ticket) => ({
          id: ticket.id,
          subject: ticket.subject,
          status: ticket.status,
          order: ticket.order
            ? {
                id: ticket.order.id,
                title: ticket.order.title,
                status: ticket.order.status,
                websiteName:
                  ticket.order.website?.domain ??
                  ticket.order.website?.name ??
                  null,
              }
            : null,
          createdAt: ticket.createdAt,
          updatedAt: ticket.updatedAt,
          overdue: olderThan(ticket.updatedAt, 24, now),
        })),
      },
      fulfillment: {
        myActive: summary.myActive,
        available: summary.available,
        waitingCustomer: summary.waitingCustomer,
        readyToPublish: summary.readyToPublish,
        overdue: summary.overdue,
        verificationTotal: summary.verificationTotal,
        totalAssigned: summary.totalAssigned,
        claimed: summary.claimed,
        completed: summary.completed,
      },
      resolution: {
        cancellations: cancellationCount,
        disputes: disputeCount,
        deliveryVerification: deliveryIssueCount,
        domainVerification: domainIssueCount,
      },
      inventory: {
        pendingModeration: moderationCount,
        assignedListingIssues: inventoryIssueCount,
        integrationIssues: integrationIssueCount,
      },
    }
  }
}
