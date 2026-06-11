import { Module, Global } from "@nestjs/common"
import { PublisherPayoutsController } from "./publisher-payouts.controller"
import { PublisherPayoutsService } from "./publisher-payouts.service"
import { PayoutEncryptionService } from "./payout-encryption.service"
import { PayoutExecutionService } from "./payout-execution.service"
import { PayoutProviderService } from "./payout-provider.service"
import { PayoutWebhookController } from "./payout-webhook.controller"
import { ManualPayoutAdapter } from "./providers/manual-payout.adapter"
import { WisePayoutAdapter } from "./providers/wise-payout.adapter"
import { StripeConnectPayoutAdapter } from "./providers/stripe-connect-payout.adapter"
import { AuditModule } from "../audit/audit.module"
import { QueueModule } from "../queues/queue.module"

@Global()
@Module({
  imports: [AuditModule, QueueModule],
  controllers: [PublisherPayoutsController, PayoutWebhookController],
  providers: [
    PublisherPayoutsService,
    PayoutEncryptionService,
    PayoutExecutionService,
    PayoutProviderService,
    ManualPayoutAdapter,
    WisePayoutAdapter,
    StripeConnectPayoutAdapter,
  ],
  exports: [
    PublisherPayoutsService,
    PayoutEncryptionService,
    PayoutExecutionService,
    PayoutProviderService,
    ManualPayoutAdapter,
    WisePayoutAdapter,
    StripeConnectPayoutAdapter,
  ],
})
export class PublisherPayoutsModule {
  constructor(
    private readonly providerService: PayoutProviderService,
    private readonly manualAdapter: ManualPayoutAdapter,
    private readonly wiseAdapter: WisePayoutAdapter,
    private readonly stripeAdapter: StripeConnectPayoutAdapter,
  ) {
    providerService.register(manualAdapter)
    providerService.register(wiseAdapter)
    providerService.register(stripeAdapter)
  }
}
