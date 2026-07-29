import {
  BadRequestException,
  Body,
  Controller,
  Get,
  GoneException,
  Headers,
  Param,
  Post,
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
    return this.billing.createCheckoutSession(
      walletId,
      body.amount,
      user,
      body.idempotencyKey,
    )
  }

  @Get("deposits/:reference/status")
  @UseGuards(ActorTypeGuard, MemberRolesGuard)
  @ActorType("CUSTOMER")
  @MemberRoles("OWNER")
  checkDepositStatus(
    @Param("reference") publicReference: string,
    @CurrentUser() user: any,
  ) {
    return this.billing.checkDepositStatus(publicReference, user)
  }

  @Public()
  @Post("webhook/stripe")
  async stripeWebhook(
    @Headers("stripe-signature") signature: string,
    @Req() req: RawBodyRequest<Request>,
  ) {
    const payload = req.rawBody
    if (!payload) {
      throw new BadRequestException("Missing raw webhook body")
    }
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
  withdraw(): never {
    // Customer wallets are closed-loop spend balances. The retired
    // implementation only removed internal wallet liability and never sent
    // money through Stripe or another provider. Keep a guarded compatibility
    // response so old callers fail explicitly without touching financial state.
    throw new GoneException({
      code: "CUSTOMER_WALLET_CASH_OUT_UNSUPPORTED",
      message:
        "Customer wallet cash-out is not supported. Contact support to request review of an eligible return to the original payment method.",
    })
  }

  @Get("transactions")
  @UseGuards(ActorTypeGuard)
  @ActorType("CUSTOMER")
  listTransactions(@CurrentUser() user: any) {
    return this.billing.listTransactions(user.organizationId ?? null, user.id)
  }
}
