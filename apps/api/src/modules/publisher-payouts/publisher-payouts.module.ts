import { Global, Module } from "@nestjs/common"
import { AuditModule } from "../audit/audit.module"
import { QueueModule } from "../queues/queue.module"
import { PayoutEncryptionService } from "./payout-encryption.service"
import {
  loadPayoutEncryptionKeyProviderFromEnv,
  PAYOUT_ENCRYPTION_KEY_PROVIDER,
} from "./payout-encryption-key-provider"
import { PayoutExecutionService } from "./payout-execution.service"
import { PayoutProviderService } from "./payout-provider.service"
import { PayoutWebhookController } from "./payout-webhook.controller"
import { ManualPayoutAdapter } from "./providers/manual-payout.adapter"
import { StripeConnectPayoutAdapter } from "./providers/stripe-connect-payout.adapter"
import { PublisherPayoutsController } from "./publisher-payouts.controller"
import { PublisherPayoutsService } from "./publisher-payouts.service"
import { StripeConnectService } from "./stripe-connect.service"

@Global()
@Module({
  imports: [AuditModule, QueueModule],
  controllers: [PublisherPayoutsController, PayoutWebhookController],
  providers: [
    PublisherPayoutsService,
    {
      provide: PAYOUT_ENCRYPTION_KEY_PROVIDER,
      useFactory: () => loadPayoutEncryptionKeyProviderFromEnv(process.env),
    },
    PayoutEncryptionService,
    PayoutExecutionService,
    PayoutProviderService,
    ManualPayoutAdapter,
    StripeConnectPayoutAdapter,
    StripeConnectService,
  ],
  exports: [
    PublisherPayoutsService,
    PayoutEncryptionService,
    PayoutExecutionService,
    PayoutProviderService,
    ManualPayoutAdapter,
    StripeConnectPayoutAdapter,
    StripeConnectService,
  ],
})
export class PublisherPayoutsModule {}
