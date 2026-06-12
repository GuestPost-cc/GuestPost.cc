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
    if (order.website?.ownershipType !== "PLATFORM") {
      throw new BadRequestException("Only platform-owned orders use fulfillment assignment")
    }
    return order
  }

  // Operations queue: platform orders awaiting fulfillment, grouped by their
  // current assignment state.
  async operationsQueue() {
    const orders = await this.prisma.order.findMany({
      where: {
        website: { ownershipType: "PLATFORM" },
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

  // Operations user claims an unassigned order for themselves.
  async claim(orderId: string, userId: string) {
    const order = await this.assertPlatformOrder(orderId)
    const existing = await this.prisma.fulfillmentAssignment.findFirst({
      where: { orderId, status: { in: ["ASSIGNED", "IN_PROGRESS"] } },
    })
    if (existing) throw new ConflictException("Order is already assigned")
    return this.upsertAssignment(orderId, userId, userId, order.organizationId, "ORDER_DELIVERY_ASSIGNED")
  }

  // Assign to another Operations user.
  async assign(orderId: string, assignedToUserId: string, assignedByUserId: string) {
    const order = await this.assertPlatformOrder(orderId)
    return this.upsertAssignment(orderId, assignedToUserId, assignedByUserId, order.organizationId, "ORDER_DELIVERY_ASSIGNED")
  }

  // Reassign (cancels prior, creates new).
  async reassign(orderId: string, assignedToUserId: string, assignedByUserId: string) {
    const order = await this.assertPlatformOrder(orderId)
    return this.upsertAssignment(orderId, assignedToUserId, assignedByUserId, order.organizationId, "ORDER_DELIVERY_REASSIGNED")
  }
}
