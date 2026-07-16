import {
  Body,
  Controller,
  ForbiddenException,
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
import { StaffRoles } from "../../common/decorators/staff-roles.decorator"
import { ActorTypeGuard } from "../../common/guards/actor-type.guard"
import { MemberRolesGuard } from "../../common/guards/member-roles.guard"
import { OrderOwnershipGuard } from "../../common/guards/order-ownership.guard"
import { StaffRolesGuard } from "../../common/guards/staff-roles.guard"
import { SettlementReasonDto } from "./dto/settlement-reason.dto"
import { SettlementsService } from "./settlements.service"

@Controller("settlements")
export class SettlementsController {
  constructor(private readonly settlements: SettlementsService) {}

  // Customer approves settlement
  @Post(":id/customer-approve")
  @UseGuards(ActorTypeGuard, MemberRolesGuard, OrderOwnershipGuard)
  @ActorType("CUSTOMER")
  @MemberRoles("OWNER", "MEMBER")
  @RequireOrderOwnership()
  customerApprove(@Param("id") id: string, @CurrentUser() user: any) {
    return this.settlements.customerApprove(
      id,
      user.id,
      user.organizationId,
      user.role,
      user.customerRole,
    )
  }

  // Staff approves settlement
  @Post(":id/admin-approve")
  @UseGuards(StaffRolesGuard)
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  adminApprove(
    @Param("id") id: string,
    @Body() body: SettlementReasonDto,
    @CurrentUser() user: any,
  ) {
    return this.settlements.adminApprove(id, body.reason, user.id, user.role)
  }

  // SUPER_ADMIN can force-approve both sides
  @Post(":id/force-approve")
  @UseGuards(StaffRolesGuard)
  @StaffRoles("SUPER_ADMIN")
  forceApprove(
    @Param("id") id: string,
    @Body() body: SettlementReasonDto,
    @CurrentUser() user: any,
  ) {
    return this.settlements.forceApprove(id, body.reason, user.id, user.role)
  }

  @Post(":id/cancel")
  @UseGuards(StaffRolesGuard)
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  cancel(
    @Param("id") id: string,
    @Body() body: SettlementReasonDto,
    @CurrentUser() user: any,
  ) {
    return this.settlements.cancelSettlement(id, user.id, body.reason)
  }

  @Post(":id/return-to-review")
  @UseGuards(StaffRolesGuard)
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  returnToReview(
    @Param("id") id: string,
    @Body() body: SettlementReasonDto,
    @CurrentUser() user: any,
  ) {
    return this.settlements.returnToReview(id, user.id, body.reason)
  }

  // Staff listing
  @Get()
  @UseGuards(StaffRolesGuard)
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  list(@Query("take") take?: string, @Query("skip") skip?: string) {
    const t = Math.min(Math.max(parseInt(take ?? "50", 10) || 50, 1), 100)
    const s = Math.max(0, parseInt(skip ?? "0", 10) || 0)
    return this.settlements.listSettlements(undefined, t, s)
  }

  // Staff see any settlement; customers only settlements of their own organization
  @Get(":id")
  @UseGuards(ActorTypeGuard)
  @ActorType("STAFF", "CUSTOMER")
  get(@Param("id") id: string, @CurrentUser() user: any) {
    if (user.userType === "STAFF") {
      const allowed = ["SUPER_ADMIN", "FINANCE"]
      if (!user.staffRole || !allowed.includes(user.staffRole)) {
        throw new ForbiddenException("Insufficient staff permissions")
      }
      return this.settlements.getSettlement(id)
    }
    return this.settlements.getSettlement(id, user.organizationId)
  }
}
