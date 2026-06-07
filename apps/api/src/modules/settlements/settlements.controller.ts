import { Controller, Get, Post, Param, UseGuards } from "@nestjs/common"
import { SettlementsService } from "./settlements.service"
import { CurrentUser } from "../../common/decorators/current-user.decorator"
import { StaffRoles } from "../../common/decorators/staff-roles.decorator"
import { StaffRolesGuard } from "../../common/guards/staff-roles.guard"

@Controller("settlements")
@UseGuards(StaffRolesGuard)
@StaffRoles("SUPER_ADMIN", "OPERATIONS", "FINANCE")
export class SettlementsController {
  constructor(private readonly settlements: SettlementsService) {}

  @Post("orders/:orderId")
  create(@Param("orderId") orderId: string, @CurrentUser() user: any) {
    return this.settlements.createSettlement(orderId, user.organizationId, user.id)
  }

  @Get()
  list(@CurrentUser() user: any) {
    return this.settlements.listSettlements(user.organizationId)
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.settlements.getSettlement(id)
  }

  @Post(":id/approve")
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  approve(@Param("id") id: string, @CurrentUser() user: any) {
    return this.settlements.approveSettlement(id, user.id)
  }
}
