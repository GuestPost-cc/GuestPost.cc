import { Controller, Get, Post, Body, Param, UseGuards } from "@nestjs/common"
import { ReportingService } from "./reporting.service"
import { CurrentUser } from "../../common/decorators/current-user.decorator"
import { MemberRoles } from "../../common/decorators/member-roles.decorator"
import { MemberRolesGuard } from "../../common/guards/member-roles.guard"

@Controller("reporting")
@UseGuards(MemberRolesGuard)
@MemberRoles("OWNER", "MEMBER")
export class ReportingController {
  constructor(private readonly reporting: ReportingService) {}

  @Post("orders/:id/export")
  exportReport(
    @Param("id") orderId: string,
    @Body() body: { format?: "pdf" | "csv" },
    @CurrentUser() user: any,
  ) {
    return this.reporting.generateOrderReport(orderId, user.organizationId, body.format ?? "pdf")
  }

  @Get()
  listReports(@CurrentUser() user: any) {
    return this.reporting.listReports(user.organizationId)
  }

  @Get(":id")
  getReport(@Param("id") id: string, @CurrentUser() user: any) {
    return this.reporting.getReport(id, user.organizationId)
  }
}
