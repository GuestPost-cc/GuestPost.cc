import { Controller, Get, Post, Body, Param, UseGuards, Headers, Req, RawBodyRequest } from "@nestjs/common"
import { BillingService } from "./billing.service"
import { CurrentUser } from "../../common/decorators/current-user.decorator"
import { DepositDto } from "./dto/deposit.dto"
import { WithdrawDto } from "./dto/withdraw.dto"
import { MemberRoles } from "../../common/decorators/member-roles.decorator"
import { MemberRolesGuard } from "../../common/guards/member-roles.guard"
import { Request } from "express"

@Controller("billing")
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get("wallet")
  getWallet(@CurrentUser() user: any) {
    return this.billing.getWallet(user.organizationId ?? null, user.id)
  }

  @Post("wallet/:id/deposit")
  @UseGuards(MemberRolesGuard)
  @MemberRoles("OWNER")
  deposit(@Param("id") walletId: string, @Body() body: DepositDto, @CurrentUser() user: any) {
    return this.billing.deposit(walletId, body.amount, user, body.reference)
  }

  @Post("wallet/:id/checkout")
  @UseGuards(MemberRolesGuard)
  @MemberRoles("OWNER")
  createCheckoutSession(@Param("id") walletId: string, @Body() body: DepositDto, @CurrentUser() user: any) {
    return this.billing.createCheckoutSession(walletId, body.amount, user)
  }

  @Post("webhook/stripe")
  async stripeWebhook(@Headers("stripe-signature") signature: string, @Req() req: RawBodyRequest<Request>) {
    // In dummy mode, we can accept any payload, but NestJS needs raw body for real Stripe
    const payload = req.rawBody || Buffer.from(JSON.stringify(req.body))
    return this.billing.handleWebhook(signature || "dummy", payload)
  }

  @Post("wallet/:id/withdraw")
  @UseGuards(MemberRolesGuard)
  @MemberRoles("OWNER")
  withdraw(@Param("id") walletId: string, @Body() body: WithdrawDto, @CurrentUser() user: any) {
    return this.billing.withdraw(walletId, body.amount, user)
  }

  @Get("transactions")
  listTransactions(@CurrentUser() user: any) {
    return this.billing.listTransactions(user.organizationId ?? null, user.id)
  }
}
