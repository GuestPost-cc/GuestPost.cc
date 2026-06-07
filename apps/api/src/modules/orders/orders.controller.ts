import { Controller, Get, Post, Patch, Body, Param, Query, UseGuards } from "@nestjs/common"
import { OrdersService } from "./orders.service"
import { CurrentUser } from "../../common/decorators/current-user.decorator"
import { CreateOrderDto } from "./dto/create-order.dto"
import { AddOrderItemDto } from "./dto/add-order-item.dto"
import { TransitionOrderDto } from "./dto/transition-order.dto"
import { MemberRoles } from "../../common/decorators/member-roles.decorator"
import { MemberRolesGuard } from "../../common/guards/member-roles.guard"
import { StaffRoles } from "../../common/decorators/staff-roles.decorator"

@Controller("orders")
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @UseGuards(MemberRolesGuard)
  @MemberRoles("OWNER", "MEMBER")
  create(@Body() body: CreateOrderDto, @CurrentUser() user: any) {
    return this.orders.createOrder({ ...body, customerId: user.id, organizationId: user.organizationId }, user.id)
  }

  @Get()
  list(
    @Query("campaignId") campaignId?: string,
    @CurrentUser() user?: any,
  ) {
    if (user.userType === "PUBLISHER") return this.orders.listPublisherOrders(user.publisherId)
    return this.orders.listOrders(user.organizationId, campaignId)
  }

  @Get(":id")
  get(@Param("id") id: string, @CurrentUser() user: any) {
    return this.orders.getOrder(id, user.organizationId)
  }

  @Patch(":id/status")
  @UseGuards(MemberRolesGuard)
  @MemberRoles("OWNER", "MEMBER")
  transition(
    @Param("id") id: string,
    @Body() body: TransitionOrderDto,
    @CurrentUser() user: any,
  ) {
    return this.orders.transitionOrder(id, user.organizationId, body.status, user.id, body.metadata)
  }

  @Post(":id/items")
  @UseGuards(MemberRolesGuard)
  @MemberRoles("OWNER", "MEMBER")
  addItem(@Param("id") id: string, @Body() body: AddOrderItemDto, @CurrentUser() user: any) {
    return this.orders.addOrderItem(id, user.organizationId, body, user.id)
  }

  @Post(":id/submit-payment")
  @UseGuards(MemberRolesGuard)
  @MemberRoles("OWNER", "MEMBER")
  submitPayment(@Param("id") id: string, @CurrentUser() user: any) {
    return this.orders.submitPayment(id, user.organizationId, user.id)
  }
}
