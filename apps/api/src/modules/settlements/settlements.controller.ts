import { Controller, Get, Post, Param, Query, UseGuards } from "@nestjs/common"
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
  list(
    @CurrentUser() user: any,
    @Query("take") take?: string,
    @Query("skip") skip?: string,
  ) {
    const t = Math.min(Math.max(parseInt(take ?? "50", 10) || 50, 1), 100)
    const s = Math.max(0, parseInt(skip ?? "0", 10) || 0)
    return this.settlements.listSettlements(user.organizationId, t, s)
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
