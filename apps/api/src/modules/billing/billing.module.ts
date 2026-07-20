import { Module } from "@nestjs/common"
import { BillingController } from "./billing.controller"
import { BillingService } from "./billing.service"
import { DepositProviderService } from "./providers/deposit-provider.service"
import { StripeDepositAdapter } from "./providers/stripe-deposit.adapter"

@Module({
  controllers: [BillingController],
  providers: [BillingService, DepositProviderService, StripeDepositAdapter],
  exports: [BillingService, DepositProviderService],
})
export class BillingModule {}
