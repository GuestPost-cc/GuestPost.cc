import type { Prisma } from "@guestpost/database"
import { ACTIVE_CANCELLATION_REQUEST_STATUSES } from "@guestpost/shared"
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { PrismaService } from "../../../common/prisma.service"
import { AuditService } from "../../audit/audit.service"
import { projectOperationsOrder } from "../order-visibility"
import { OrderCancellationService } from "./order-cancellation.service"

const ACTIVE_ASSIGNMENT_STATUSES = ["ASSIGNED", "IN_PROGRESS"] as const
const ACTIVE_FULFILLMENT_STATUSES = [
  "SUBMITTED",
  "ACCEPTED",
  "CONTENT_REQUESTED",
  "CONTENT_CREATION",
  "CONTENT_READY",
  "CUSTOMER_REVIEW",
  "APPROVED",
] as const
const VERIFICATION_ORDER_STATUSES = [
  "PUBLISHED",
  "VERIFIED",
  "DELIVERED",
] as const

export type OperationsInboxView =
  | "active"
  | "available"
  | "waiting"
  | "ready"
  | "verification"
  | "history"

function nextOperationsAction(order: any, claimable: boolean) {
  if (claimable) return "CLAIM"
  if (order.cancellationRequests?.length) return "CANCELLATION"
  switch (order.status) {
    case "SUBMITTED":
      return "ACCEPT"
    case "ACCEPTED":
    case "CONTENT_REQUESTED":
    case "CONTENT_CREATION":
    case "CONTENT_READY":
      return "CONTENT"
    case "CUSTOMER_REVIEW":
      return "WAITING_CUSTOMER"
    case "APPROVED":
      return "PUBLISH"
    case "PUBLISHED":
    case "VERIFIED":
    case "DELIVERED":
      return "VERIFICATION"
    default:
      return "VIEW"
  }
}

// Platform fulfillment assignment. Platform-owned orders enter the Operations
// queue; Operations users claim / assign / reassign before delivering. Finance
// can never fulfill (enforced at the controller via @StaffRoles).
@Injectable()
export class OrderFulfillmentAssignmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cancellation: OrderCancellationService,
  ) {}

  private async assertPlatformOrder(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { website: { select: { ownershipType: true } } },
    })
    if (!order) throw new NotFoundException("Order not found")
    const channel =
      order.fulfillmentChannel ??
      (order.website?.ownershipType === "PLATFORM" ? "PLATFORM" : "PUBLISHER")
    if (channel !== "PLATFORM") {
      throw new BadRequestException(
        "Only platform-owned orders use fulfillment assignment",
      )
    }
    if (
      ![
        "SUBMITTED",
        "ACCEPTED",
        "CONTENT_REQUESTED",
        "CONTENT_CREATION",
        "CONTENT_READY",
        "CUSTOMER_REVIEW",
        "APPROVED",
      ].includes(order.status)
    ) {
      throw new BadRequestException(
        `Order cannot be assigned in ${order.status} status`,
      )
    }
    await this.cancellation.assertNoActiveCancellation(orderId)
    return order
  }

  private async assertAssignableOperationsUser(userId: string) {
    const membership = await this.prisma.staffMembership.findUnique({
      where: { userId },
      select: { role: true, user: { select: { banned: true } } },
    })
    if (membership?.role !== "OPERATIONS" || membership.user.banned) {
      throw new BadRequestException(
        "assignedToUserId must reference an active Operations staff member",
      )
    }
  }

  // Operations queue: platform orders awaiting fulfillment, grouped by their
  // current assignment state. Reads order.fulfillmentChannel first, with the
  // website.ownershipType clause as a Phase 2 fallback for legacy orders.
  async operationsQueue(user?: any) {
    const activeAssignment = {
      status: { in: [...ACTIVE_ASSIGNMENT_STATUSES] },
    }
    const where: any = {
      OR: [
        { fulfillmentChannel: "PLATFORM" },
        { fulfillmentChannel: null, website: { ownershipType: "PLATFORM" } },
      ],
      status: {
        in: [...ACTIVE_FULFILLMENT_STATUSES],
      },
      cancellationRequests: {
        none: { status: { in: [...ACTIVE_CANCELLATION_REQUEST_STATUSES] } },
      },
    }

    if (user?.staffRole === "OPERATIONS") {
      where.AND = [
        {
          OR: [
            {
              fulfillmentAssignments: {
                some: { ...activeAssignment, assignedToUserId: user.id },
              },
            },
            { fulfillmentAssignments: { none: activeAssignment } },
          ],
        },
      ]
    }

    const orders = await this.prisma.order.findMany({
      where,
      include: {
        website: { select: { url: true, domain: true } },
        fulfillmentAssignments: { orderBy: { createdAt: "desc" }, take: 1 },
        deliveryVersions: { orderBy: { version: "desc" }, take: 1 },
      },
      orderBy: { createdAt: "asc" },
    })
    return orders
  }

  private channelWhere(): Prisma.OrderWhereInput {
    return {
      OR: [
        { fulfillmentChannel: "PLATFORM" },
        {
          fulfillmentChannel: null,
          website: { ownershipType: "PLATFORM" },
        },
      ],
    }
  }

  private activeAssignmentWhere(
    user?: any,
  ): Prisma.FulfillmentAssignmentWhereInput {
    return {
      status: { in: [...ACTIVE_ASSIGNMENT_STATUSES] },
      ...(user?.staffRole === "OPERATIONS"
        ? { assignedToUserId: user.id }
        : {}),
    }
  }

  private noActiveCancellationWhere(): Prisma.OrderWhereInput {
    return {
      cancellationRequests: {
        none: { status: { in: [...ACTIVE_CANCELLATION_REQUEST_STATUSES] } },
      },
    }
  }

  private inboxViewWhere(
    view: OperationsInboxView,
    user?: any,
  ): Prisma.OrderWhereInput {
    const ownActive = this.activeAssignmentWhere(user)
    const isOperations = user?.staffRole === "OPERATIONS"
    const activeScope = isOperations
      ? { fulfillmentAssignments: { some: ownActive } }
      : {
          fulfillmentAssignments: {
            some: { status: { in: [...ACTIVE_ASSIGNMENT_STATUSES] } },
          },
        }

    if (view === "available") {
      return {
        status: { in: [...ACTIVE_FULFILLMENT_STATUSES] },
        ...this.noActiveCancellationWhere(),
        fulfillmentAssignments: {
          none: { status: { in: [...ACTIVE_ASSIGNMENT_STATUSES] } },
        },
      }
    }
    if (view === "waiting") {
      return { status: "CUSTOMER_REVIEW", ...activeScope }
    }
    if (view === "ready") {
      return { status: "APPROVED", ...activeScope }
    }
    if (view === "verification") {
      return {
        status: { in: [...VERIFICATION_ORDER_STATUSES] },
        fulfillmentAssignments: {
          some: {
            status: "DELIVERED",
            ...(isOperations ? { assignedToUserId: user.id } : {}),
          },
        },
      }
    }
    if (view === "history") {
      return {
        status: { in: ["SETTLED", "COMPLETED"] },
        fulfillmentAssignments: {
          some: {
            status: "DELIVERED",
            ...(isOperations ? { assignedToUserId: user.id } : {}),
          },
        },
      }
    }
    return {
      status: { in: [...ACTIVE_FULFILLMENT_STATUSES] },
      ...activeScope,
    }
  }

  private async performanceSummary(user?: any) {
    const isOperations = user?.staffRole === "OPERATIONS"
    const assignments = await this.prisma.fulfillmentAssignment.findMany({
      where: isOperations ? { assignedToUserId: user.id } : {},
      select: {
        orderId: true,
        assignedToUserId: true,
        status: true,
        order: {
          select: {
            amount: true,
            currency: true,
            status: true,
          },
        },
      },
    })

    const assignmentByOrder = new Map<string, any>()
    for (const assignment of assignments) {
      const existing = assignmentByOrder.get(assignment.orderId)
      if (!existing || assignment.status === "DELIVERED") {
        assignmentByOrder.set(assignment.orderId, assignment)
      }
    }

    const delivered = [...assignmentByOrder.values()].filter(
      (assignment) =>
        assignment.status === "DELIVERED" &&
        ["DELIVERED", "SETTLED", "COMPLETED"].includes(assignment.order.status),
    )
    const salesByCurrency: Record<string, number> = {}
    for (const assignment of delivered) {
      const currency = assignment.order.currency ?? "USD"
      salesByCurrency[currency] =
        (salesByCurrency[currency] ?? 0) + Number(assignment.order.amount ?? 0)
    }

    const claimAudits = await this.prisma.auditLog.findMany({
      where: {
        action: "ORDER_DELIVERY_ASSIGNED",
        ...(isOperations ? { userId: user.id } : {}),
      },
      select: { metadata: true },
    })
    const claimed = new Set(
      claimAudits.flatMap((entry: any) => {
        const metadata = entry.metadata as Record<string, unknown> | null
        if (
          !metadata ||
          metadata.assignedToUserId !== metadata.assignedByUserId ||
          typeof metadata.orderId !== "string"
        ) {
          return []
        }
        return [`${metadata.assignedToUserId}:${metadata.orderId}`]
      }),
    ).size

    return {
      totalAssigned: assignmentByOrder.size,
      claimed,
      completed: delivered.length,
      salesByCurrency,
    }
  }

  async operationsInbox(
    user: any,
    options: {
      view?: OperationsInboxView
      take?: number
      skip?: number
      search?: string
      includeSummary?: boolean
    } = {},
  ) {
    const view = options.view ?? "active"
    const take = Math.min(Math.max(options.take ?? 50, 1), 100)
    const skip = Math.max(options.skip ?? 0, 0)
    const search = options.search?.trim()
    const includeSummary = options.includeSummary !== false
    const channel = this.channelWhere()
    const activeAssignment = this.activeAssignmentWhere(user)
    const ownActive: Prisma.OrderWhereInput = {
      fulfillmentAssignments: { some: activeAssignment },
    }
    const unassigned: Prisma.OrderWhereInput = {
      ...this.noActiveCancellationWhere(),
      fulfillmentAssignments: {
        none: { status: { in: [...ACTIVE_ASSIGNMENT_STATUSES] } },
      },
    }
    const searchWhere: Prisma.OrderWhereInput | undefined = search
      ? {
          OR: [
            { id: { contains: search, mode: "insensitive" } },
            { title: { contains: search, mode: "insensitive" } },
            { website: { domain: { contains: search, mode: "insensitive" } } },
            { website: { url: { contains: search, mode: "insensitive" } } },
          ],
        }
      : undefined
    const where: Prisma.OrderWhereInput = {
      AND: [
        channel,
        this.inboxViewWhere(view, user),
        ...(searchWhere ? [searchWhere] : []),
      ],
    }

    const activeStatus: Prisma.OrderWhereInput = {
      status: { in: [...ACTIVE_FULFILLMENT_STATUSES] },
    }
    const verificationIssue: Prisma.OrderWhereInput = {
      activeDeliveryVersion: {
        is: { verificationStatus: { in: ["FAILED", "MANUAL_REVIEW"] } },
      },
    }
    const ownDelivered: Prisma.OrderWhereInput = {
      fulfillmentAssignments: {
        some: {
          status: "DELIVERED",
          ...(user.staffRole === "OPERATIONS"
            ? { assignedToUserId: user.id }
            : {}),
        },
      },
    }

    const [items, total, summaryCounts, performance] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: [{ fulfillmentDueAt: "asc" }, { createdAt: "asc" }],
        take,
        skip,
        include: {
          website: {
            select: { id: true, name: true, url: true, domain: true },
          },
          customer: { select: { id: true, name: true } },
          organization: { select: { id: true, name: true } },
          contentOrder: { select: { status: true } },
          fulfillmentAssignments: {
            orderBy: { createdAt: "desc" },
            take: 1,
          },
          activeDeliveryVersion: {
            select: {
              id: true,
              verificationStatus: true,
              verificationFailureReason: true,
              publishedUrl: true,
            },
          },
          cancellationRequests: {
            where: {
              status: {
                in: [...ACTIVE_CANCELLATION_REQUEST_STATUSES],
              },
            },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
      }),
      this.prisma.order.count({ where }),
      includeSummary
        ? Promise.all([
            this.prisma.order.count({
              where: { AND: [channel, activeStatus, ownActive] },
            }),
            this.prisma.order.count({
              where: { AND: [channel, activeStatus, unassigned] },
            }),
            this.prisma.order.count({
              where: {
                AND: [channel, { status: "CUSTOMER_REVIEW" }, ownActive],
              },
            }),
            this.prisma.order.count({
              where: { AND: [channel, { status: "APPROVED" }, ownActive] },
            }),
            this.prisma.order.count({
              where: {
                AND: [
                  channel,
                  activeStatus,
                  ownActive,
                  { fulfillmentDueAt: { lt: new Date() } },
                ],
              },
            }),
            this.prisma.order.count({
              where: {
                AND: [
                  channel,
                  ownDelivered,
                  { status: { in: [...VERIFICATION_ORDER_STATUSES] } },
                ],
              },
            }),
            this.prisma.order.count({
              where: { AND: [channel, ownDelivered, verificationIssue] },
            }),
          ])
        : Promise.resolve([0, 0, 0, 0, 0, 0, 0]),
      includeSummary
        ? this.performanceSummary(user)
        : Promise.resolve({
            totalAssigned: 0,
            claimed: 0,
            completed: 0,
            salesByCurrency: {},
          }),
    ])

    return {
      items: items.map((order: any) => {
        const assignment = order.fulfillmentAssignments?.[0] ?? null
        const claimable =
          !assignment &&
          order.cancellationRequests?.length === 0 &&
          ACTIVE_FULFILLMENT_STATUSES.includes(order.status as any)
        return {
          ...order,
          claimable,
          canProgress:
            user.staffRole === "SUPER_ADMIN" ||
            assignment?.assignedToUserId === user.id,
          nextAction: nextOperationsAction(order, claimable),
        }
      }),
      total,
      take,
      skip,
      summary: includeSummary
        ? {
            myActive: summaryCounts[0],
            available: summaryCounts[1],
            waitingCustomer: summaryCounts[2],
            readyToPublish: summaryCounts[3],
            overdue: summaryCounts[4],
            verificationTotal: summaryCounts[5],
            verificationIssues: summaryCounts[6],
            ...performance,
          }
        : null,
    }
  }

  async getOperationsOrder(orderId: string, user: any) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        website: {
          select: {
            id: true,
            name: true,
            url: true,
            domain: true,
            ownershipType: true,
          },
        },
        organization: { select: { id: true, name: true } },
        customer: { select: { id: true, name: true } },
        items: {
          select: {
            id: true,
            targetUrl: true,
            anchorText: true,
            website: { select: { id: true, url: true, domain: true } },
          },
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
        revisions: { orderBy: { createdAt: "desc" } },
        events: { orderBy: { createdAt: "desc" } },
        fulfillmentAssignments: { orderBy: { createdAt: "desc" } },
        activeDeliveryVersion: {
          include: {
            evidence: { orderBy: { createdAt: "desc" } },
            fraudFlags: true,
          },
        },
        cancellationRequests: {
          orderBy: { createdAt: "desc" },
        },
      },
    })
    if (!order) throw new NotFoundException("Order not found")

    const channel =
      order.fulfillmentChannel ??
      (order.website?.ownershipType === "PLATFORM" ? "PLATFORM" : "PUBLISHER")
    if (channel !== "PLATFORM") throw new NotFoundException("Order not found")
    if (order.status === "DRAFT" || order.status === "PENDING_PAYMENT") {
      throw new NotFoundException("Order not found")
    }

    const activeAssignment = order.fulfillmentAssignments.find((assignment) =>
      ACTIVE_ASSIGNMENT_STATUSES.includes(assignment.status as any),
    )
    const hasActiveCancellation = order.cancellationRequests.some((request) =>
      ACTIVE_CANCELLATION_REQUEST_STATUSES.includes(request.status as any),
    )
    const latestAssignment = order.fulfillmentAssignments[0] ?? null
    const claimable =
      !activeAssignment &&
      !hasActiveCancellation &&
      ACTIVE_FULFILLMENT_STATUSES.includes(order.status as any)
    const ownsActiveAssignment = activeAssignment?.assignedToUserId === user.id
    const ownsHistory =
      !activeAssignment &&
      latestAssignment?.assignedToUserId === user.id &&
      latestAssignment.status === "DELIVERED"

    if (
      user.staffRole !== "SUPER_ADMIN" &&
      !ownsActiveAssignment &&
      !ownsHistory &&
      !claimable
    ) {
      throw new NotFoundException("Order not found")
    }

    return {
      ...projectOperationsOrder(order),
      access: {
        claimable,
        canProgress: user.staffRole === "SUPER_ADMIN" || ownsActiveAssignment,
        readOnly: user.staffRole !== "SUPER_ADMIN" && !ownsActiveAssignment,
      },
      nextAction: nextOperationsAction(order, claimable),
    }
  }

  private async upsertAssignment(
    orderId: string,
    assignedToUserId: string,
    assignedByUserId: string,
    organizationId: string,
    expectedVersion: number,
    expectedStatus: string,
    action: "ORDER_DELIVERY_ASSIGNED" | "ORDER_DELIVERY_REASSIGNED",
  ) {
    return this.prisma.$transaction(async (tx: any) => {
      // Cancel any existing open assignment (reassignment)
      await tx.fulfillmentAssignment.updateMany({
        where: { orderId, status: { in: ["ASSIGNED", "IN_PROGRESS"] } },
        data: { status: "CANCELLED" },
      })
      const assignment = await tx.fulfillmentAssignment.create({
        data: {
          orderId,
          assignedToUserId,
          assignedByUserId,
          status: "ASSIGNED",
        },
      })
      const updatedOrder = await tx.order.updateMany({
        where: {
          id: orderId,
          version: expectedVersion,
          status: expectedStatus,
        },
        data: {
          assigneeId: assignedToUserId,
          version: { increment: 1 },
        },
      })
      if (updatedOrder.count === 0) {
        throw new ConflictException(
          "Order changed while it was being assigned. Refresh and retry.",
        )
      }
      await this.audit.log(
        {
          action,
          entityType: "FulfillmentAssignment",
          entityId: assignment.id,
          metadata: { orderId, assignedToUserId, assignedByUserId },
          userId: assignedByUserId,
          organizationId,
        },
        tx,
      )
      return assignment
    })
  }

  private async createClaimAssignment(
    orderId: string,
    userId: string,
    organizationId: string,
    expectedVersion: number,
    expectedStatus: string,
  ) {
    return this.prisma.$transaction(async (tx: any) => {
      // Do not cancel an existing assignment when claiming. The partial
      // unique index on active assignments makes concurrent claims fail with
      // P2002 and prevents an operator from taking another operator's order.
      const assignment = await tx.fulfillmentAssignment.create({
        data: {
          orderId,
          assignedToUserId: userId,
          assignedByUserId: userId,
          status: "ASSIGNED",
        },
      })
      const updatedOrder = await tx.order.updateMany({
        where: {
          id: orderId,
          version: expectedVersion,
          status: expectedStatus,
        },
        data: { assigneeId: userId, version: { increment: 1 } },
      })
      if (updatedOrder.count === 0) {
        throw new ConflictException(
          "Order changed while it was being claimed. Refresh and retry.",
        )
      }
      await this.audit.log(
        {
          action: "ORDER_DELIVERY_ASSIGNED",
          entityType: "FulfillmentAssignment",
          entityId: assignment.id,
          metadata: {
            orderId,
            assignedToUserId: userId,
            assignedByUserId: userId,
          },
          userId,
          organizationId,
        },
        tx,
      )
      return assignment
    })
  }

  // Operations user claims an unassigned order for themselves. Phase 7.14
  // replaced the prior findFirst pre-check with a partial unique index on
  // (orderId) WHERE status IN ('ASSIGNED','IN_PROGRESS') — the constraint
  // is the only authoritative answer to "is this order already claimed?",
  // since the pre-check was outside the tx and two concurrent claims could
  // both pass it. P2002 from upsertAssignment's create step maps to the
  // same user-facing message the pre-check used to return.
  async claim(orderId: string, userId: string, staffRole?: string) {
    const order = await this.assertPlatformOrder(orderId)
    if (staffRole !== "SUPER_ADMIN") {
      await this.assertAssignableOperationsUser(userId)
    }
    try {
      return await this.createClaimAssignment(
        orderId,
        userId,
        order.organizationId,
        order.version,
        order.status,
      )
    } catch (e: any) {
      if (e?.code === "P2002") {
        throw new ConflictException("Order is already assigned")
      }
      throw e
    }
  }

  // Assign to another Operations user. P2002 here means a concurrent claim
  // / assign / reassign committed first — admin intent was "transfer to X"
  // but the order's assignment state changed mid-flight. Different message
  // from claim() because the user (admin) wasn't trying to "take" an
  // unowned order; they were trying to redirect ownership.
  async assign(
    orderId: string,
    assignedToUserId: string,
    assignedByUserId: string,
  ) {
    const order = await this.assertPlatformOrder(orderId)
    await this.assertAssignableOperationsUser(assignedToUserId)
    try {
      return await this.upsertAssignment(
        orderId,
        assignedToUserId,
        assignedByUserId,
        order.organizationId,
        order.version,
        order.status,
        "ORDER_DELIVERY_ASSIGNED",
      )
    } catch (e: any) {
      if (e?.code === "P2002") {
        throw new ConflictException(
          "Order assignment changed concurrently — refresh and try again",
        )
      }
      throw e
    }
  }

  // Reassign (cancels prior, creates new). Same concurrent-change semantic
  // as assign(); the cancel-then-create in upsertAssignment runs in a single
  // tx, so P2002 only fires when another tx committed an active row between
  // this tx's cancel and its create — i.e. a true concurrent collision.
  async reassign(
    orderId: string,
    assignedToUserId: string,
    assignedByUserId: string,
  ) {
    const order = await this.assertPlatformOrder(orderId)
    await this.assertAssignableOperationsUser(assignedToUserId)
    try {
      return await this.upsertAssignment(
        orderId,
        assignedToUserId,
        assignedByUserId,
        order.organizationId,
        order.version,
        order.status,
        "ORDER_DELIVERY_REASSIGNED",
      )
    } catch (e: any) {
      if (e?.code === "P2002") {
        throw new ConflictException(
          "Order assignment changed concurrently — refresh and try again",
        )
      }
      throw e
    }
  }
}
