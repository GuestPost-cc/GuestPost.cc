import { Controller, Get, Post, Param, Query, UseGuards } from "@nestjs/common"
import { ReportingService } from "./reporting.service"
import { CurrentUser } from "../../common/decorators/current-user.decorator"
import { MemberRoles } from "../../common/decorators/member-roles.decorator"
import { MemberRolesGuard } from "../../common/guards/member-roles.guard"
import { ActorType } from "../../common/decorators/actor-type.decorator"
import { ActorTypeGuard } from "../../common/guards/actor-type.guard"

@Controller("reports")
@UseGuards(ActorTypeGuard, MemberRolesGuard)
@ActorType("CUSTOMER")
@MemberRoles("OWNER", "MEMBER")
export class ReportingController {
  constructor(private readonly reporting: ReportingService) {}

  @Get("orders/:id")
  getOrderReport(@Param("id") orderId: string, @CurrentUser() user: any) {
    return this.reporting.getOrderReport(orderId, user.organizationId)
  }

  @Get("campaigns/:id")
  getCampaignReport(@Param("id") campaignId: string, @CurrentUser() user: any) {
    return this.reporting.getCampaignReport(campaignId, user.organizationId)
  }

  @Post("orders/:id/generate")
  generateOrderReport(@Param("id") orderId: string, @CurrentUser() user: any) {
    return this.reporting.generateOrderReport(orderId, user.organizationId, "pdf")
  }

  @Get()
  listReports(
    @CurrentUser() user: any,
    @Query("take") take?: string,
    @Query("skip") skip?: string,
  ) {
    const t = Math.min(Math.max(parseInt(take ?? "50", 10) || 50, 1), 100)
    const s = Math.max(0, parseInt(skip ?? "0", 10) || 0)
    return this.reporting.listReports(user.organizationId, t, s)
  }
}