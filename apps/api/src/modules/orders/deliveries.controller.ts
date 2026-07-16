import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common"
import { CurrentUser } from "../../common/decorators/current-user.decorator"
import { StaffRoles } from "../../common/decorators/staff-roles.decorator"
import { StaffRolesGuard } from "../../common/guards/staff-roles.guard"
import { PrismaService } from "../../common/prisma.service"
import { DeliveryInterventionService } from "./services/delivery-intervention.service"
import { OrderDeliveryService } from "./services/order-delivery.service"
import { OrderFulfillmentAssignmentService } from "./services/order-fulfillment-assignment.service"
import { OrderOperationsService } from "./services/order-operations.service"

// Staff-facing delivery operations: read (versions/evidence/snapshots/audit),
// platform fulfillment assignment, intervention, and dispute evidence package.
// Finance is included for read + intervention but excluded from fulfillment
// (assignment/claim) — separation of duties.
@Controller()
@UseGuards(StaffRolesGuard)
export class DeliveriesController {
  constructor(
    private readonly delivery: OrderDeliveryService,
    private readonly intervention: DeliveryInterventionService,
    private readonly assignment: OrderFulfillmentAssignmentService,
    private readonly operations: OrderOperationsService,
    private readonly prisma: PrismaService,
  ) {}

  private role(user: any) {
    return user.staffRole ?? user.role
  }

  // ── Reads ──────────────────────────────────────────────────────────────
  @Get("orders/:id/deliveries")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS", "FINANCE")
  listDeliveries(@Param("id") id: string) {
    return this.delivery.listDeliveries(id)
  }

  @Get("deliveries/:id")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS", "FINANCE")
  getDelivery(@Param("id") id: string) {
    return this.delivery.getDelivery(id)
  }

  @Get("orders/:id/evidence")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS", "FINANCE")
  evidence(@Param("id") id: string) {
    return this.intervention.orderEvidence(id)
  }

  @Get("orders/:id/snapshots")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS", "FINANCE")
  snapshots(@Param("id") id: string) {
    return this.intervention.orderSnapshots(id)
  }

  @Get("orders/:id/audit")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS", "FINANCE")
  audit(@Param("id") id: string) {
    return this.intervention.orderAudit(id)
  }

  @Get("disputes/:disputeId/evidence")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS", "FINANCE")
  async disputeEvidence(@Param("disputeId") disputeId: string) {
    const dispute = await this.prisma.orderDispute.findUnique({
      where: { id: disputeId },
    })
    if (!dispute) throw new BadRequestException("Dispute not found")
    return this.intervention.disputeEvidencePackage(dispute.orderId)
  }

  // ── Platform fulfillment (Operations) — Finance excluded ─────────────────
  @Get("operations/fulfillment-queue")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  fulfillmentQueue(@CurrentUser() user: any) {
    return this.assignment.operationsQueue(user)
  }

  @Get("operations/fulfillment")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  operationsInbox(
    @CurrentUser() user: any,
    @Query("view") rawView?: string,
    @Query("take") rawTake?: string,
    @Query("skip") rawSkip?: string,
    @Query("search") search?: string,
    @Query("includeSummary") rawIncludeSummary?: string,
  ) {
    const views = new Set([
      "active",
      "available",
      "waiting",
      "ready",
      "verification",
      "history",
    ])
    if (rawView && !views.has(rawView)) {
      throw new BadRequestException("Invalid fulfillment inbox view")
    }
    return this.assignment.operationsInbox(user, {
      view: rawView as any,
      take: rawTake ? Number.parseInt(rawTake, 10) || 50 : 50,
      skip: rawSkip ? Number.parseInt(rawSkip, 10) || 0 : 0,
      search,
      includeSummary: rawIncludeSummary !== "false",
    })
  }

  @Get("operations/fulfillment/:id")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  operationsOrder(@Param("id") id: string, @CurrentUser() user: any) {
    return this.assignment.getOperationsOrder(id, user)
  }

  @Post("orders/:id/claim")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  claim(@Param("id") id: string, @CurrentUser() user: any) {
    return this.assignment.claim(id, user.id, user.staffRole)
  }

  @Post("orders/:id/assign")
  @StaffRoles("SUPER_ADMIN")
  assign(
    @Param("id") id: string,
    @Body("assignedToUserId") to: string,
    @CurrentUser() user: any,
  ) {
    return this.assignment.assign(id, to, user.id)
  }

  @Post("orders/:id/reassign")
  @StaffRoles("SUPER_ADMIN")
  reassign(
    @Param("id") id: string,
    @Body("assignedToUserId") to: string,
    @CurrentUser() user: any,
  ) {
    return this.assignment.reassign(id, to, user.id)
  }

  // Operations submits a platform delivery (requires active assignment).
  @Post("orders/:id/deliveries")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  submitPlatformDelivery(
    @Param("id") id: string,
    @Body() body: {
      publishedUrl: string
      articleTitle?: string
      notes?: string
      screenshotUrl?: string
    },
    @CurrentUser() user: any,
  ) {
    return this.operations.markPublished(
      id,
      user.id,
      user.staffRole,
      body.publishedUrl,
      {
        articleTitle: body.articleTitle,
        notes: body.notes,
        screenshotUrl: body.screenshotUrl,
      },
    )
  }

  // ── Intervention ─────────────────────────────────────────────────────────
  @Post("deliveries/:id/reverify")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  reverify(@Param("id") id: string, @CurrentUser() user: any) {
    return this.intervention.reverify(id, user.id)
  }

  @Post("deliveries/:id/manual-approve")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  manualApprove(
    @Param("id") id: string,
    @Body("reason") reason: string,
    @CurrentUser() user: any,
  ) {
    return this.intervention.manualApprove(id, user.id, this.role(user), reason)
  }

  @Post("deliveries/:id/manual-reject")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  manualReject(
    @Param("id") id: string,
    @Body("reason") reason: string,
    @CurrentUser() user: any,
  ) {
    return this.intervention.manualReject(id, user.id, this.role(user), reason)
  }

  @Post("deliveries/:id/override")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  override(
    @Param("id") id: string,
    @Body() body: { targetStatus: "VERIFIED" | "FAILED"; reason: string },
    @CurrentUser() user: any,
  ) {
    return this.intervention.override(
      id,
      user.id,
      this.role(user),
      body.targetStatus,
      body.reason,
    )
  }
}
