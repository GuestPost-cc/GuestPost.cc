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
import { IsIn, IsOptional } from "class-validator"
import { ActorType } from "../../common/decorators/actor-type.decorator"
import { ApiKeyPermissions } from "../../common/decorators/api-key-permissions.decorator"
import { CurrentUser } from "../../common/decorators/current-user.decorator"
import { MemberRoles } from "../../common/decorators/member-roles.decorator"
import { ActorTypeGuard } from "../../common/guards/actor-type.guard"
import { MemberRolesGuard } from "../../common/guards/member-roles.guard"
import { ReportingService } from "./reporting.service"

class GenerateReportDto {
  @IsOptional()
  @IsIn(["pdf", "csv"])
  format?: "pdf" | "csv"
}

function boundedPage(take?: string, skip?: string) {
  if (take !== undefined && !/^\d+$/.test(take)) {
    throw new BadRequestException("take must be a positive integer")
  }
  if (skip !== undefined && !/^\d+$/.test(skip)) {
    throw new BadRequestException("skip must be a non-negative integer")
  }
  const parsedTake = Number(take ?? 50)
  const parsedSkip = Number(skip ?? 0)
  if (!Number.isSafeInteger(parsedTake) || parsedTake < 1 || parsedTake > 100) {
    throw new BadRequestException("take must be between 1 and 100")
  }
  if (
    !Number.isSafeInteger(parsedSkip) ||
    parsedSkip < 0 ||
    parsedSkip > 1_000_000
  ) {
    throw new BadRequestException("skip must be between 0 and 1000000")
  }
  return {
    take: parsedTake,
    skip: parsedSkip,
  }
}

@Controller("reports")
@UseGuards(ActorTypeGuard, MemberRolesGuard)
@ActorType("CUSTOMER")
@MemberRoles("OWNER", "MEMBER")
export class ReportingController {
  constructor(private readonly reporting: ReportingService) {}

  @Get("orders/:id")
  @ApiKeyPermissions("reports:read")
  getOrderReport(@Param("id") orderId: string, @CurrentUser() user: any) {
    return this.reporting.getOrderReport(orderId, user.organizationId)
  }

  @Get("campaigns/:id")
  @ApiKeyPermissions("reports:read")
  getCampaignReport(
    @Param("id") campaignId: string,
    @CurrentUser() user: any,
    @Query("take") take?: string,
    @Query("skip") skip?: string,
  ) {
    const page = boundedPage(take, skip)
    return this.reporting.getCampaignReport(
      campaignId,
      user.organizationId,
      page.take,
      page.skip,
    )
  }

  @Post("orders/:id/generate")
  @ApiKeyPermissions("reports:write")
  generateOrderReport(
    @Param("id") orderId: string,
    @CurrentUser() user: any,
    @Body() body: GenerateReportDto,
  ) {
    return this.reporting.generateOrderReport(
      orderId,
      user.organizationId,
      body.format ?? "pdf",
    )
  }

  @Get()
  @ApiKeyPermissions("reports:read")
  listReports(
    @CurrentUser() user: any,
    @Query("take") take?: string,
    @Query("skip") skip?: string,
  ) {
    const page = boundedPage(take, skip)
    return this.reporting.listReports(user.organizationId, page.take, page.skip)
  }

  @Get(":id")
  @ApiKeyPermissions("reports:read")
  getReport(@Param("id") id: string, @CurrentUser() user: any) {
    return this.reporting.getReport(id, user.organizationId)
  }
}
