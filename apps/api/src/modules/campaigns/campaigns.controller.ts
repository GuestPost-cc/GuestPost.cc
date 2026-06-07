import { Controller, Get, Post, Body, Param, Patch, Delete, UseGuards } from "@nestjs/common"
import { CampaignsService } from "./campaigns.service"
import { CurrentUser } from "../../common/decorators/current-user.decorator"
import { CreateOrderDto } from "./dto/create-order.dto"
import { CreateCampaignDto } from "./dto/create-campaign.dto"
import { UpdateOrderStatusDto } from "./dto/update-order-status.dto"
import { MemberRoles } from "../../common/decorators/member-roles.decorator"
import { MemberRolesGuard } from "../../common/guards/member-roles.guard"

@Controller("campaigns")
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Post("orders")
  @UseGuards(MemberRolesGuard)
  @MemberRoles("OWNER", "MEMBER")
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
      customerId: user.id,
      organizationId: user.organizationId,
    }, user.id)
  }

  @Get("orders")
  listOrders(@CurrentUser() user: any) {
    if (user.userType === "PUBLISHER") {
      return this.campaigns.listPublisherOrders(user.publisherId)
    }
    return this.campaigns.listOrders(user.organizationId)
  }

  @Get("orders/:id")
  getOrder(@Param("id") id: string, @CurrentUser() user: any) {
    return this.campaigns.getOrder(id, user.organizationId)
  }

  @Patch("orders/:id/status")
  @UseGuards(MemberRolesGuard)
  @MemberRoles("OWNER", "MEMBER")
  updateStatus(
    @Param("id") id: string,
    @Body() body: UpdateOrderStatusDto,
    @CurrentUser() user: any,
  ) {
    return this.campaigns.updateOrderStatus(id, user.organizationId, body.status, user.id)
  }

  @Post("orders/:id/revisions")
  @UseGuards(MemberRolesGuard)
  @MemberRoles("OWNER", "MEMBER")
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
  listCampaigns(@CurrentUser() user: any) {
    return this.campaigns.listCampaigns(user.organizationId)
  }

  @Get(":id")
  getCampaign(@Param("id") id: string, @CurrentUser() user: any) {
    return this.campaigns.getCampaign(id, user.organizationId)
  }

  @Get(":id/orders")
  listCampaignOrders(@Param("id") id: string, @CurrentUser() user: any) {
    return this.campaigns.listCampaignOrders(id, user.organizationId)
  }

  @Delete(":id")
  @UseGuards(MemberRolesGuard)
  @MemberRoles("OWNER")
  deleteCampaign(@Param("id") id: string, @CurrentUser() user: any) {
    return this.campaigns.deleteCampaign(id, user.organizationId, user.id)
  }
}
