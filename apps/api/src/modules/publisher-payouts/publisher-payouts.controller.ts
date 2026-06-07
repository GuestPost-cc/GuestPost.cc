import { Controller, Get, Post, Param, Body, Query, UseGuards } from "@nestjs/common"
import { PublisherPayoutsService } from "./publisher-payouts.service"
import { CurrentUser } from "../../common/decorators/current-user.decorator"
import { StaffRoles } from "../../common/decorators/staff-roles.decorator"
import { StaffRolesGuard } from "../../common/guards/staff-roles.guard"

@Controller("publisher-payouts")
export class PublisherPayoutsController {
  constructor(private readonly payouts: PublisherPayoutsService) {}

  @Get("balance/:publisherId")
  getBalance(@Param("publisherId") publisherId: string) {
    return this.payouts.getBalance(publisherId)
  }

  @Post("withdrawals")
  requestWithdrawal(
    @Body() body: { publisherId: string; amount: number; method: string },
    @CurrentUser() user: any,
  ) {
    return this.payouts.requestWithdrawal(body.publisherId, body.amount, body.method, user.id)
  }

  @Get("withdrawals")
  listWithdrawals(
    @CurrentUser() user: any,
    @Query("take") take?: string,
    @Query("skip") skip?: string,
  ) {
    const t = Math.min(Math.max(parseInt(take ?? "50", 10) || 50, 1), 100)
    const s = Math.max(0, parseInt(skip ?? "0", 10) || 0)
    return this.payouts.listWithdrawals(user.publisherId, t, s)
  }

  @UseGuards(StaffRolesGuard)
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  @Post("withdrawals/:id/approve")
  approveWithdrawal(@Param("id") id: string, @CurrentUser() user: any) {
    return this.payouts.approveWithdrawal(id, user.id)
  }

  @UseGuards(StaffRolesGuard)
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  @Post("withdrawals/:id/mark-paid")
  markPaid(@Param("id") id: string, @CurrentUser() user: any) {
    return this.payouts.markWithdrawalPaid(id, user.id)
  }

  @UseGuards(StaffRolesGuard)
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  @Post("withdrawals/:id/reject")
  rejectWithdrawal(@Param("id") id: string, @CurrentUser() user: any) {
    return this.payouts.rejectWithdrawal(id, user.id)
  }
}
