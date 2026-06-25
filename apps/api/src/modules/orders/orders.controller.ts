import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common"
import { ActorType } from "../../common/decorators/actor-type.decorator"
import { CurrentUser } from "../../common/decorators/current-user.decorator"
import { MemberRoles } from "../../common/decorators/member-roles.decorator"
import { RequireOrderOwnership } from "../../common/decorators/order-ownership.decorator"
import { ActorTypeGuard } from "../../common/guards/actor-type.guard"
import { MemberRolesGuard } from "../../common/guards/member-roles.guard"
import { OrderOwnershipGuard } from "../../common/guards/order-ownership.guard"
import { AuthGuard } from "../auth/auth.guard"
import type { AddOrderItemDto } from "./dto/add-order-item.dto"
import type { CreateOrderDto } from "./dto/create-order.dto"
import type { OrdersService } from "./orders.service"
import type { OrderDeliveryService } from "./services/order-delivery.service"
import type { OrderDisputeService } from "./services/order-dispute.service"
import type { OrderFulfillmentService } from "./services/order-fulfillment.service"
import type { OrderPaymentService } from "./services/order-payment.service"
import type { OrderReviewService } from "./services/order-review.service"

@Controller("orders")
@UseGuards(AuthGuard, ActorTypeGuard)
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly payment: OrderPaymentService,
    private readonly fulfillment: OrderFulfillmentService,
    private readonly review: OrderReviewService,
    private readonly dispute: OrderDisputeService,
    private readonly delivery: OrderDeliveryService,
  ) {}

  // ─── CRUD ─────────────────────────────────────────────────

  @Post()
  @UseGuards(MemberRolesGuard)
  @MemberRoles("OWNER", "MEMBER")
  @ActorType("CUSTOMER")
  create(@Body() body: CreateOrderDto, @CurrentUser() user: any) {
    return this.orders.createOrder(
      { ...body, customerId: user.id, organizationId: user.organizationId },
      user.id,
    )
  }

  @ActorType("CUSTOMER", "PUBLISHER")
  @Get()
  list(
    @Query("campaignId") campaignId?: string,
    @Query("take") take?: string,
    @Query("skip") skip?: string,
    @CurrentUser() user?: any,
  ) {
    const t = Math.min(Math.max(parseInt(take ?? "50", 10) || 50, 1), 100)
    const s = Math.max(0, parseInt(skip ?? "0", 10) || 0)
    if (user.userType === "PUBLISHER")
      return this.orders.listPublisherOrders(user.publisherId, t, s)
    return this.orders.listOrders(user.organizationId, campaignId, t, s)
  }

  @Get(":id")
  @UseGuards(OrderOwnershipGuard)
  @RequireOrderOwnership()
  get(@Param("id") id: string, @CurrentUser() user: any) {
    // Publishers have no organizationId — the ownership guard above is their
    // access check (order.website.publisherId === user.publisherId)
    return this.orders.getOrder(
      id,
      user.userType === "PUBLISHER" ? null : user.organizationId,
    )
  }

  @Get(":id/events")
  @UseGuards(OrderOwnershipGuard)
  @RequireOrderOwnership()
  async getEvents(@Param("id") id: string, @CurrentUser() user: any) {
    const order = await this.orders.getOrder(
      id,
      user.userType === "PUBLISHER" ? null : user.organizationId,
    )
    return order.events
  }

  @Post(":id/items")
  @UseGuards(MemberRolesGuard, OrderOwnershipGuard)
  @MemberRoles("OWNER", "MEMBER")
  @ActorType("CUSTOMER")
  @RequireOrderOwnership()
  addItem(
    @Param("id") id: string,
    @Body() body: AddOrderItemDto,
    @CurrentUser() user: any,
  ) {
    return this.orders.addOrderItem(id, user.organizationId, body, user.id)
  }

  @Delete(":id/items/:itemId")
  @UseGuards(MemberRolesGuard, OrderOwnershipGuard)
  @MemberRoles("OWNER", "MEMBER")
  @ActorType("CUSTOMER")
  @RequireOrderOwnership()
  removeItem(
    @Param("id") id: string,
    @Param("itemId") itemId: string,
    @CurrentUser() user: any,
  ) {
    return this.orders.removeOrderItem(id, itemId, user.organizationId)
  }

  // ─── CUSTOMER ACTIONS ─────────────────────────────────────

  // Phase 6.9 — Audit finding #3 closure. submit-payment moves money out of
  // the org wallet (reserve + capture in a single tx). MEMBER access used to
  // mean any invited member could drain the wallet by submitting payment on
  // any DRAFT order in their org. The fix is layered: the controller still
  // accepts OWNER+MEMBER (so a MEMBER can submit payment on THEIR OWN draft)
  // but the service enforces OWNER || creator. A non-creator MEMBER acting on
  // a sibling MEMBER's draft is now refused at the service layer.
  @Post(":id/submit-payment")
  @UseGuards(MemberRolesGuard, OrderOwnershipGuard)
  @MemberRoles("OWNER", "MEMBER")
  @ActorType("CUSTOMER")
  @RequireOrderOwnership()
  submitPayment(@Param("id") id: string, @CurrentUser() user: any) {
    return this.payment.submitPayment(
      id,
      user.id,
      user.organizationId,
      user.customerRole,
    )
  }

  @Post(":id/cancel")
  @UseGuards(MemberRolesGuard, OrderOwnershipGuard)
  @MemberRoles("OWNER")
  @ActorType("CUSTOMER")
  @RequireOrderOwnership()
  cancelOrder(@Param("id") id: string, @CurrentUser() user: any) {
    return this.orders.cancelOrder(id, user.organizationId, user.id)
  }

  // Phase 6.9 — Audit finding R-3. approve-content advances an order toward
  // settlement. Service layer enforces OWNER || creator (verified at
  // order-review.service.ts:88); controller stays OWNER+MEMBER so a MEMBER
  // who placed the order can still approve their own content.
  @Post(":id/approve-content")
  @UseGuards(MemberRolesGuard, OrderOwnershipGuard)
  @MemberRoles("OWNER", "MEMBER")
  @ActorType("CUSTOMER")
  @RequireOrderOwnership()
  approveContent(@Param("id") id: string, @CurrentUser() user: any) {
    return this.review.approveContent(id, user.organizationId, user.id)
  }

  @Post(":id/request-revision")
  @UseGuards(MemberRolesGuard, OrderOwnershipGuard)
  @MemberRoles("OWNER", "MEMBER")
  @ActorType("CUSTOMER")
  @RequireOrderOwnership()
  requestRevision(
    @Param("id") id: string,
    @Body("notes") notes: string,
    @CurrentUser() user: any,
  ) {
    return this.review.requestRevision(id, user.organizationId, user.id, notes)
  }

  // Phase 6.9 — Audit finding R-3. confirm-delivery creates the Settlement
  // (or PlatformRevenue) row. Service enforces OWNER || creator at
  // order-review.service.ts:198-205.
  @Post(":id/confirm-delivery")
  @UseGuards(MemberRolesGuard, OrderOwnershipGuard)
  @MemberRoles("OWNER", "MEMBER")
  @ActorType("CUSTOMER")
  @RequireOrderOwnership()
  confirmDelivery(@Param("id") id: string, @CurrentUser() user: any) {
    return this.review.confirmDelivery(id, user.organizationId, user.id)
  }

  // Per-order review (customer, after delivery). Feeds the publisher rating.
  @Post(":id/review")
  @UseGuards(MemberRolesGuard, OrderOwnershipGuard)
  @MemberRoles("OWNER", "MEMBER")
  @ActorType("CUSTOMER")
  @RequireOrderOwnership()
  submitReview(
    @Param("id") id: string,
    @Body() body: { rating: number; comment?: string },
    @CurrentUser() user: any,
  ) {
    return this.review.submitReview(
      id,
      user.organizationId,
      user.id,
      Number(body.rating),
      body.comment,
    )
  }

  @Get(":id/review")
  @UseGuards(OrderOwnershipGuard)
  @ActorType("CUSTOMER", "PUBLISHER")
  @RequireOrderOwnership()
  getReview(@Param("id") id: string, @CurrentUser() user: any) {
    return this.review.getReview(id, user.organizationId)
  }

  // Manual fallback: customer accepts the delivery when the automated check
  // could not verify it (FAILED / MANUAL_REVIEW). System check stays primary.
  @Post(":id/accept-delivery")
  @UseGuards(MemberRolesGuard, OrderOwnershipGuard)
  @MemberRoles("OWNER", "MEMBER")
  @ActorType("CUSTOMER")
  @RequireOrderOwnership()
  acceptDelivery(@Param("id") id: string, @CurrentUser() user: any) {
    return this.delivery.customerAcceptDelivery(
      id,
      user.organizationId,
      user.id,
      user.customerRole,
    )
  }

  // Customer-facing delivery proof (verification checklist, no internal evidence)
  @Get(":id/delivery-proof")
  @UseGuards(OrderOwnershipGuard)
  @ActorType("CUSTOMER", "PUBLISHER")
  @RequireOrderOwnership()
  deliveryProof(@Param("id") id: string, @CurrentUser() user: any) {
    return this.delivery.deliveryProof(id, user.organizationId)
  }

  @Post(":id/dispute")
  @UseGuards(MemberRolesGuard, OrderOwnershipGuard)
  @MemberRoles("OWNER", "MEMBER")
  @ActorType("CUSTOMER")
  @RequireOrderOwnership()
  openDispute(
    @Param("id") id: string,
    @Body("reason") reason: string,
    @CurrentUser() user: any,
  ) {
    return this.dispute.openDispute(id, user.organizationId, user.id, reason)
  }

  // ─── PUBLISHER ACTIONS ────────────────────────────────────

  @Post(":id/accept")
  @UseGuards(MemberRolesGuard, OrderOwnershipGuard)
  @MemberRoles("PUBLISHER_OWNER")
  @ActorType("PUBLISHER")
  @RequireOrderOwnership()
  acceptOrder(@Param("id") id: string, @CurrentUser() user: any) {
    return this.fulfillment.acceptOrder(id, user.publisherId, user.id)
  }

  @Post(":id/submit-content")
  @UseGuards(MemberRolesGuard, OrderOwnershipGuard)
  @MemberRoles("PUBLISHER_OWNER", "PUBLISHER_MEMBER")
  @ActorType("PUBLISHER")
  @RequireOrderOwnership()
  submitContent(
    @Param("id") id: string,
    @Body("content") content: string,
    @CurrentUser() user: any,
  ) {
    return this.fulfillment.submitContent(
      id,
      user.publisherId,
      user.id,
      content,
    )
  }

  @Post(":id/mark-content-ready")
  @UseGuards(MemberRolesGuard, OrderOwnershipGuard)
  @MemberRoles("PUBLISHER_OWNER", "PUBLISHER_MEMBER")
  @ActorType("PUBLISHER")
  @RequireOrderOwnership()
  markContentReady(@Param("id") id: string, @CurrentUser() user: any) {
    return this.fulfillment.markContentReady(id, user.publisherId, user.id)
  }

  @Post(":id/submit-for-review")
  @UseGuards(MemberRolesGuard, OrderOwnershipGuard)
  @MemberRoles("PUBLISHER_OWNER", "PUBLISHER_MEMBER")
  @ActorType("PUBLISHER")
  @RequireOrderOwnership()
  submitForReview(@Param("id") id: string, @CurrentUser() user: any) {
    return this.fulfillment.submitForReview(id, user.publisherId, user.id)
  }

  @Post(":id/mark-published")
  @UseGuards(MemberRolesGuard, OrderOwnershipGuard)
  @MemberRoles("PUBLISHER_OWNER", "PUBLISHER_MEMBER")
  @ActorType("PUBLISHER")
  @RequireOrderOwnership()
  markPublished(
    @Param("id") id: string,
    @Body("url") url: string,
    @CurrentUser() user: any,
  ) {
    return this.fulfillment.markPublished(id, user.publisherId, user.id, url)
  }
}
