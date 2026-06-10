import { Controller, Get, Post, Param, Body, Query, UseGuards } from "@nestjs/common"
import { PublisherPayoutsService } from "./publisher-payouts.service"
import { CurrentUser } from "../../common/decorators/current-user.decorator"
import { MemberRoles } from "../../common/decorators/member-roles.decorator"
import { StaffRoles } from "../../common/decorators/staff-roles.decorator"
import { MemberRolesGuard } from "../../common/guards/member-roles.guard"
import { StaffRolesGuard } from "../../common/guards/staff-roles.guard"

@Controller("publisher-payouts")
export class PublisherPayoutsController {
  constructor(private readonly payouts: PublisherPayoutsService) {}

  @UseGuards(MemberRolesGuard)
  @MemberRoles("PUBLISHER_OWNER")
  @Get("balance")
  getBalance(@CurrentUser() user: any) {
    return this.payouts.getBalance(user.publisherId)
  }

  @UseGuards(MemberRolesGuard)
  @MemberRoles("PUBLISHER_OWNER")
  @Post("withdrawals")
  requestWithdrawal(
    @Body() body: { amount: number; method: string; idempotencyKey?: string },
    @CurrentUser() user: any,
  ) {
    return this.payouts.requestWithdrawal(user.publisherId, body.amount, body.method, user.id, body.idempotencyKey)
  }

  @UseGuards(MemberRolesGuard)
  @MemberRoles("PUBLISHER_OWNER")
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
