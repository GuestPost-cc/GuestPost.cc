import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  type RawBodyRequest,
  Req,
  UseGuards,
} from "@nestjs/common"
import { Request } from "express"
import { ActorType } from "../../common/decorators/actor-type.decorator"
import { CurrentUser } from "../../common/decorators/current-user.decorator"
import { MemberRoles } from "../../common/decorators/member-roles.decorator"
import { Public } from "../../common/decorators/public.decorator"
import { ActorTypeGuard } from "../../common/guards/actor-type.guard"
import { MemberRolesGuard } from "../../common/guards/member-roles.guard"
import { BillingService } from "./billing.service"
import { DepositDto } from "./dto/deposit.dto"
import { WithdrawDto } from "./dto/withdraw.dto"

@Controller("billing")
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get("wallet")
  @UseGuards(ActorTypeGuard)
  @ActorType("CUSTOMER")
  getWallet(@CurrentUser() user: any) {
    return this.billing.getWallet(user.organizationId ?? null, user.id)
  }

  @Post("wallet/:id/checkout")
  @UseGuards(ActorTypeGuard, MemberRolesGuard)
  @ActorType("CUSTOMER")
  @MemberRoles("OWNER")
  createCheckoutSession(
    @Param("id") walletId: string,
    @Body() body: DepositDto,
    @CurrentUser() user: any,
  ) {
    return this.billing.createCheckoutSession(walletId, body.amount, user)
  }

  @Public()
  @Get("wallet/:id/deposit-status")
  checkDepositStatus(
    @Param("id") walletId: string,
    @Query("sessionId") sessionId: string,
  ) {
    return this.billing.checkDepositStatus(walletId, sessionId)
  }

  @Public()
  @Post("webhook/stripe")
  async stripeWebhook(
    @Headers("stripe-signature") signature: string,
    @Req() req: RawBodyRequest<Request>,
  ) {
    const payload = req.rawBody || Buffer.from(JSON.stringify(req.body))
    if (!signature) {
      throw new BadRequestException("Missing stripe-signature header")
    }
    // Placeholder signatures are never accepted — Stripe signature verification
    // in handleWebhook is the single gate in every environment
    if (signature === "dummy") {
      throw new BadRequestException("Invalid webhook signature")
    }
    return this.billing.handleWebhook(signature, payload)
  }

  @Post("wallet/:id/withdraw")
  @UseGuards(ActorTypeGuard, MemberRolesGuard)
  @ActorType("CUSTOMER")
  @MemberRoles("OWNER")
  withdraw(
    @Param("id") walletId: string,
    @Body() body: WithdrawDto,
    @CurrentUser() user: any,
  ) {
    return this.billing.withdraw(
      walletId,
      body.amount,
      user,
      body.idempotencyKey,
    )
  }

  @Get("transactions")
  @UseGuards(ActorTypeGuard)
  @ActorType("CUSTOMER")
  listTransactions(@CurrentUser() user: any) {
    return this.billing.listTransactions(user.organizationId ?? null, user.id)
  }
}
