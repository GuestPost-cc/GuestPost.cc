import { Controller, Get, Post, Param, UseGuards } from "@nestjs/common"
import { ReportingService } from "./reporting.service"
import { CurrentUser } from "../../common/decorators/current-user.decorator"
import { MemberRoles } from "../../common/decorators/member-roles.decorator"
import { MemberRolesGuard } from "../../common/guards/member-roles.guard"

@Controller("reports")
@UseGuards(MemberRolesGuard)
@MemberRoles("OWNER", "MEMBER", "VIEWER")
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
  listReports(@CurrentUser() user: any) {
    return this.reporting.listReports(user.organizationId)
  }
}