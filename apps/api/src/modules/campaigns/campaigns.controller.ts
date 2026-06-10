import { Controller, Get, Post, Body, Param, Query, Delete, UseGuards } from "@nestjs/common"

const parsePagination = (take?: string, skip?: string) => ({
  take: Math.min(Math.max(take ? parseInt(take, 10) || 50 : 50, 1), 100),
  skip: Math.max(0, skip ? parseInt(skip, 10) || 0 : 0),
})
import { CampaignsService } from "./campaigns.service"
import { CurrentUser } from "../../common/decorators/current-user.decorator"
import { CreateOrderDto } from "./dto/create-order.dto"
import { CreateCampaignDto } from "./dto/create-campaign.dto"
import { MemberRoles } from "../../common/decorators/member-roles.decorator"
import { MemberRolesGuard } from "../../common/guards/member-roles.guard"
import { ActorType } from "../../common/decorators/actor-type.decorator"
import { ActorTypeGuard } from "../../common/guards/actor-type.guard"

@Controller("campaigns")
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @UseGuards(ActorTypeGuard, MemberRolesGuard)
  @ActorType("CUSTOMER")
  @MemberRoles("OWNER", "MEMBER")
  @Post("orders")
  createOrder(
    @Body() body: CreateOrderDto,
    @CurrentUser() user: any,
  ) {
    return this.campaigns.createOrder({
      type: body.type,
      title: body.title,
      instructions: body.instructions,
      targetUrl: body.targetUrl,
      anchorText: body.anchorText,
      websiteId: body.websiteId,
      campaignId: body.campaignId,
      idempotencyKey: body.idempotencyKey,
      customerId: user.id,
      organizationId: user.organizationId,
    }, user.id)
  }

  @UseGuards(ActorTypeGuard)
  @ActorType("CUSTOMER", "PUBLISHER")
  @Get("orders")
  listOrders(@CurrentUser() user: any, @Query("take") take?: string, @Query("skip") skip?: string) {
    const { take: t, skip: s } = parsePagination(take, skip)
    if (user.userType === "PUBLISHER") {
      return this.campaigns.listPublisherOrders(user.publisherId, t, s)
    }
    return this.campaigns.listOrders(user.organizationId, t, s)
  }

  @UseGuards(ActorTypeGuard)
  @ActorType("CUSTOMER")
  @Get("orders/:id")
  getOrder(@Param("id") id: string, @CurrentUser() user: any) {
    return this.campaigns.getOrder(id, user.organizationId)
  }

  @UseGuards(ActorTypeGuard, MemberRolesGuard)
  @ActorType("CUSTOMER")
  @MemberRoles("OWNER", "MEMBER")
  @Post("orders/:id/revisions")
  requestRevision(
    @Param("id") id: string,
    @Body() body: { notes: string },
    @CurrentUser() user: any,
  ) {
    return this.campaigns.requestRevision(id, user.organizationId, body.notes, user.id)
  }

  @Post()
  @UseGuards(MemberRolesGuard)
  @MemberRoles("OWNER", "MEMBER")
  createCampaign(
    @Body() body: CreateCampaignDto,
    @CurrentUser() user: any,
  ) {
    return this.campaigns.createCampaign({
      name: body.name,
      description: body.description,
      organizationId: user.organizationId,
    }, user.id)
  }

  @Get()
  listCampaigns(@CurrentUser() user: any, @Query("take") take?: string, @Query("skip") skip?: string) {
    const { take: t, skip: s } = parsePagination(take, skip)
    return this.campaigns.listCampaigns(user.organizationId, t, s)
  }

  @Get(":id")
  getCampaign(@Param("id") id: string, @CurrentUser() user: any) {
    return this.campaigns.getCampaign(id, user.organizationId)
  }

  @Get(":id/orders")
  listCampaignOrders(@Param("id") id: string, @CurrentUser() user: any, @Query("take") take?: string, @Query("skip") skip?: string) {
    const { take: t, skip: s } = parsePagination(take, skip)
    return this.campaigns.listCampaignOrders(id, user.organizationId, t, s)
  }

  @Delete(":id")
  @UseGuards(MemberRolesGuard)
  @MemberRoles("OWNER")
  deleteCampaign(@Param("id") id: string, @CurrentUser() user: any) {
    return this.campaigns.deleteCampaign(id, user.organizationId, user.id)
  }
}
