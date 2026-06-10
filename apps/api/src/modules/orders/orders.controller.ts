import { Controller, Get, Post, Delete, Body, Param, Query, UseGuards } from "@nestjs/common"
import { OrdersService } from "./orders.service"
import { OrderPaymentService } from "./services/order-payment.service"
import { OrderFulfillmentService } from "./services/order-fulfillment.service"
import { OrderReviewService } from "./services/order-review.service"
import { OrderDisputeService } from "./services/order-dispute.service"
import { CurrentUser } from "../../common/decorators/current-user.decorator"
import { CreateOrderDto } from "./dto/create-order.dto"
import { AddOrderItemDto } from "./dto/add-order-item.dto"
import { MemberRoles } from "../../common/decorators/member-roles.decorator"
import { MemberRolesGuard } from "../../common/guards/member-roles.guard"
import { ActorType } from "../../common/decorators/actor-type.decorator"
import { ActorTypeGuard } from "../../common/guards/actor-type.guard"
import { RequireOrderOwnership } from "../../common/decorators/order-ownership.decorator"
import { OrderOwnershipGuard } from "../../common/guards/order-ownership.guard"
import { AuthGuard } from "../auth/auth.guard"

@Controller("orders")
@UseGuards(AuthGuard, ActorTypeGuard)
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly payment: OrderPaymentService,
    private readonly fulfillment: OrderFulfillmentService,
    private readonly review: OrderReviewService,
    private readonly dispute: OrderDisputeService,
  ) {}

  // ─── CRUD ─────────────────────────────────────────────────

  @Post()
  @UseGuards(MemberRolesGuard)
  @MemberRoles("OWNER", "MEMBER")
  @ActorType("CUSTOMER")
  create(@Body() body: CreateOrderDto, @CurrentUser() user: any) {
    return this.orders.createOrder({ ...body, customerId: user.id, organizationId: user.organizationId }, user.id)
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
    if (user.userType === "PUBLISHER") return this.orders.listPublisherOrders(user.publisherId, t, s)
    return this.orders.listOrders(user.organizationId, campaignId, t, s)
  }

  @Get(":id")
  @UseGuards(OrderOwnershipGuard)
  @RequireOrderOwnership()
  get(@Param("id") id: string, @CurrentUser() user: any) {
    return this.orders.getOrder(id, user.organizationId)
  }

  @Post(":id/items")
  @UseGuards(MemberRolesGuard, OrderOwnershipGuard)
  @MemberRoles("OWNER", "MEMBER")
  @ActorType("CUSTOMER")
  @RequireOrderOwnership()
  addItem(@Param("id") id: string, @Body() body: AddOrderItemDto, @CurrentUser() user: any) {
    return this.orders.addOrderItem(id, user.organizationId, body, user.id)
  }

  @Delete(":id/items/:itemId")
  @UseGuards(MemberRolesGuard, OrderOwnershipGuard)
  @MemberRoles("OWNER", "MEMBER")
  @ActorType("CUSTOMER")
  @RequireOrderOwnership()
  removeItem(@Param("id") id: string, @Param("itemId") itemId: string, @CurrentUser() user: any) {
    return this.orders.removeOrderItem(id, itemId, user.organizationId)
  }

  // ─── CUSTOMER ACTIONS ─────────────────────────────────────

  @Post(":id/submit-payment")
  @UseGuards(MemberRolesGuard, OrderOwnershipGuard)
  @MemberRoles("OWNER", "MEMBER")
  @ActorType("CUSTOMER")
  @RequireOrderOwnership()
  submitPayment(@Param("id") id: string, @CurrentUser() user: any) {
    return this.payment.submitPayment(id, user.id, user.organizationId)
  }

  @Post(":id/cancel")
  @UseGuards(MemberRolesGuard, OrderOwnershipGuard)
  @MemberRoles("OWNER")
  @ActorType("CUSTOMER")
  @RequireOrderOwnership()
  cancelOrder(@Param("id") id: string, @CurrentUser() user: any) {
    return this.orders.cancelOrder(id, user.organizationId, user.id)
  }

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
  requestRevision(@Param("id") id: string, @Body("notes") notes: string, @CurrentUser() user: any) {
    return this.review.requestRevision(id, user.organizationId, user.id, notes)
  }

  @Post(":id/confirm-delivery")
  @UseGuards(MemberRolesGuard, OrderOwnershipGuard)
  @MemberRoles("OWNER", "MEMBER")
  @ActorType("CUSTOMER")
  @RequireOrderOwnership()
  confirmDelivery(@Param("id") id: string, @CurrentUser() user: any) {
    return this.review.confirmDelivery(id, user.organizationId, user.id)
  }

  @Post(":id/dispute")
  @UseGuards(MemberRolesGuard, OrderOwnershipGuard)
  @MemberRoles("OWNER", "MEMBER")
  @ActorType("CUSTOMER")
  @RequireOrderOwnership()
  openDispute(@Param("id") id: string, @Body("reason") reason: string, @CurrentUser() user: any) {
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
  submitContent(@Param("id") id: string, @Body("content") content: string, @CurrentUser() user: any) {
    return this.fulfillment.submitContent(id, user.publisherId, user.id, content)
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
  markPublished(@Param("id") id: string, @Body("url") url: string, @CurrentUser() user: any) {
    return this.fulfillment.markPublished(id, user.publisherId, user.id, url)
  }
}
