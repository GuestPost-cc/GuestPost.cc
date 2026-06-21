import { Injectable, BadRequestException, NotFoundException, ConflictException } from "@nestjs/common"
import { PrismaService } from "../../../common/prisma.service"
import { AuditService } from "../../audit/audit.service"

// Platform fulfillment assignment. Platform-owned orders enter the Operations
// queue; Operations users claim / assign / reassign before delivering. Finance
// can never fulfill (enforced at the controller via @StaffRoles).
@Injectable()
export class OrderFulfillmentAssignmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async assertPlatformOrder(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { website: { select: { ownershipType: true } } },
    })
    if (!order) throw new NotFoundException("Order not found")
    const channel = order.fulfillmentChannel ?? (order.website?.ownershipType === "PLATFORM" ? "PLATFORM" : "PUBLISHER")
    if (channel !== "PLATFORM") {
      throw new BadRequestException("Only platform-owned orders use fulfillment assignment")
    }
    return order
  }

  // Operations queue: platform orders awaiting fulfillment, grouped by their
  // current assignment state. Reads order.fulfillmentChannel first, with the
  // website.ownershipType clause as a Phase 2 fallback for legacy orders.
  async operationsQueue() {
    const orders = await this.prisma.order.findMany({
      where: {
        OR: [
          { fulfillmentChannel: "PLATFORM" },
          { fulfillmentChannel: null, website: { ownershipType: "PLATFORM" } },
        ],
        status: { in: ["PAID", "SUBMITTED", "ACCEPTED", "CONTENT_REQUESTED", "CONTENT_CREATION", "CONTENT_READY", "CUSTOMER_REVIEW", "APPROVED", "PUBLISHED"] },
      },
      include: {
        website: { select: { url: true, domain: true } },
        fulfillmentAssignments: { orderBy: { createdAt: "desc" }, take: 1 },
        deliveryVersions: { orderBy: { version: "desc" }, take: 1 },
      },
      orderBy: { createdAt: "asc" },
    })
    return orders
  }

  private async upsertAssignment(orderId: string, assignedToUserId: string, assignedByUserId: string, organizationId: string, action: "ORDER_DELIVERY_ASSIGNED" | "ORDER_DELIVERY_REASSIGNED") {
    return this.prisma.$transaction(async (tx: any) => {
      // Cancel any existing open assignment (reassignment)
      await tx.fulfillmentAssignment.updateMany({
        where: { orderId, status: { in: ["ASSIGNED", "IN_PROGRESS"] } },
        data: { status: "CANCELLED" },
      })
      const assignment = await tx.fulfillmentAssignment.create({
        data: { orderId, assignedToUserId, assignedByUserId, status: "ASSIGNED" },
      })
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

  // Operations user claims an unassigned order for themselves. Phase 7.14
  // replaced the prior findFirst pre-check with a partial unique index on
  // (orderId) WHERE status IN ('ASSIGNED','IN_PROGRESS') — the constraint
  // is the only authoritative answer to "is this order already claimed?",
  // since the pre-check was outside the tx and two concurrent claims could
  // both pass it. P2002 from upsertAssignment's create step maps to the
  // same user-facing message the pre-check used to return.
  async claim(orderId: string, userId: string) {
    const order = await this.assertPlatformOrder(orderId)
    try {
      return await this.upsertAssignment(orderId, userId, userId, order.organizationId, "ORDER_DELIVERY_ASSIGNED")
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
  async assign(orderId: string, assignedToUserId: string, assignedByUserId: string) {
    const order = await this.assertPlatformOrder(orderId)
    try {
      return await this.upsertAssignment(orderId, assignedToUserId, assignedByUserId, order.organizationId, "ORDER_DELIVERY_ASSIGNED")
    } catch (e: any) {
      if (e?.code === "P2002") {
        throw new ConflictException("Order assignment changed concurrently — refresh and try again")
      }
      throw e
    }
  }

  // Reassign (cancels prior, creates new). Same concurrent-change semantic
  // as assign(); the cancel-then-create in upsertAssignment runs in a single
  // tx, so P2002 only fires when another tx committed an active row between
  // this tx's cancel and its create — i.e. a true concurrent collision.
  async reassign(orderId: string, assignedToUserId: string, assignedByUserId: string) {
    const order = await this.assertPlatformOrder(orderId)
    try {
      return await this.upsertAssignment(orderId, assignedToUserId, assignedByUserId, order.organizationId, "ORDER_DELIVERY_REASSIGNED")
    } catch (e: any) {
      if (e?.code === "P2002") {
        throw new ConflictException("Order assignment changed concurrently — refresh and try again")
      }
      throw e
    }
  }
}
