import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common"
import { CurrentAuthority } from "../../common/decorators/current-authority.decorator"
import { MemberRoles } from "../../common/decorators/member-roles.decorator"
import { StaffRoles } from "../../common/decorators/staff-roles.decorator"
import { MemberRolesGuard } from "../../common/guards/member-roles.guard"
import { StaffRolesGuard } from "../../common/guards/staff-roles.guard"
import { CompleteManualWithdrawalDto } from "./dto/complete-manual-withdrawal.dto"
import { CreatePayoutMethodDto } from "./dto/create-payout-method.dto"
import { RejectWithdrawalDto } from "./dto/reject-withdrawal.dto"
import { RequestWithdrawalDto } from "./dto/request-withdrawal.dto"
import { PublisherPayoutsService } from "./publisher-payouts.service"
import { StripeConnectService } from "./stripe-connect.service"

@Controller("publisher-payouts")
export class PublisherPayoutsController {
  constructor(
    private readonly payouts: PublisherPayoutsService,
    private readonly stripeConnect: StripeConnectService,
  ) {}

  @UseGuards(MemberRolesGuard)
  @MemberRoles("PUBLISHER_OWNER")
  @Get("stripe-connect/status")
  getStripeConnectStatus(@CurrentAuthority() user: any) {
    return this.stripeConnect.getStatus(user.publisherId, user.id)
  }

  @UseGuards(MemberRolesGuard)
  @MemberRoles("PUBLISHER_OWNER")
  @Post("stripe-connect/onboarding-link")
  createStripeConnectOnboardingLink(@CurrentAuthority() user: any) {
    return this.stripeConnect.createOnboardingLink(user.publisherId, user.id)
  }

  @UseGuards(MemberRolesGuard)
  @MemberRoles("PUBLISHER_OWNER")
  @Post("stripe-connect/refresh")
  refreshStripeConnectStatus(@CurrentAuthority() user: any) {
    return this.stripeConnect.refreshStatus(user.publisherId, user.id)
  }

  @UseGuards(MemberRolesGuard)
  @MemberRoles("PUBLISHER_OWNER")
  @Get("balance")
  getBalance(@CurrentAuthority() user: any) {
    return this.payouts.getBalance(user.publisherId, user.id)
  }

  @UseGuards(MemberRolesGuard)
  @MemberRoles("PUBLISHER_OWNER")
  @Post("withdrawals")
  requestWithdrawal(
    @Body() body: RequestWithdrawalDto,
    @CurrentAuthority() user: any,
  ) {
    return this.payouts.requestWithdrawal(
      user.publisherId,
      body.amount,
      body.method,
      user.id,
      body.idempotencyKey,
      body.payoutMethodId,
    )
  }

  @UseGuards(MemberRolesGuard)
  @MemberRoles("PUBLISHER_OWNER")
  @Get("payout-methods")
  listPayoutMethods(
    @CurrentAuthority() user: any,
    @Query("includeInactive") includeInactive?: string,
  ) {
    return this.payouts.listPayoutMethods(
      user.publisherId,
      user.id,
      includeInactive === "true",
    )
  }

  @UseGuards(MemberRolesGuard)
  @MemberRoles("PUBLISHER_OWNER")
  @Post("payout-methods")
  createPayoutMethod(
    @Body() body: CreatePayoutMethodDto,
    @CurrentAuthority() user: any,
  ) {
    return this.payouts.createPayoutMethod(user.publisherId, user.id, body)
  }

  @UseGuards(MemberRolesGuard)
  @MemberRoles("PUBLISHER_OWNER")
  @Post("payout-methods/:id/deactivate")
  deactivatePayoutMethod(
    @Param("id") id: string,
    @CurrentAuthority() user: any,
  ) {
    return this.payouts.deactivatePayoutMethod(user.publisherId, user.id, id)
  }

  @UseGuards(MemberRolesGuard)
  @MemberRoles("PUBLISHER_OWNER")
  @Post("payout-methods/:id/reactivate")
  reactivatePayoutMethod(
    @Param("id") id: string,
    @CurrentAuthority() user: any,
  ) {
    return this.payouts.reactivatePayoutMethod(user.publisherId, user.id, id)
  }

  @UseGuards(MemberRolesGuard)
  @MemberRoles("PUBLISHER_OWNER")
  @Get("withdrawals")
  listWithdrawals(
    @CurrentAuthority() user: any,
    @Query("take") take?: string,
    @Query("skip") skip?: string,
  ) {
    const t = Math.min(Math.max(parseInt(take ?? "50", 10) || 50, 1), 100)
    const s = Math.max(0, parseInt(skip ?? "0", 10) || 0)
    return this.payouts.listWithdrawals(
      user.publisherId,
      t,
      s,
      undefined,
      user.id,
    )
  }

  @UseGuards(StaffRolesGuard)
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  @Post("withdrawals/:id/approve")
  approveWithdrawal(@Param("id") id: string, @CurrentAuthority() user: any) {
    return this.payouts.approveWithdrawal(id, user.id)
  }

  @UseGuards(StaffRolesGuard)
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  @Post("withdrawals/:id/manual-complete")
  completeManualWithdrawal(
    @Param("id") id: string,
    @Body() body: CompleteManualWithdrawalDto,
    @CurrentAuthority() user: any,
  ) {
    return this.payouts.completeManualWithdrawal(id, user.id, body)
  }

  @UseGuards(StaffRolesGuard)
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  @Post("withdrawals/:id/reject")
  rejectWithdrawal(
    @Param("id") id: string,
    @Body() body: RejectWithdrawalDto,
    @CurrentAuthority() user: any,
  ) {
    return this.payouts.rejectWithdrawal(id, user.id, body.reason)
  }
}
