import { Injectable, Logger, type OnModuleInit } from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import {
  PayoutEncryptionService,
  payoutProviderEncryptionContext,
} from "./payout-encryption.service"
import { decodePayoutProviderConfig } from "./payout-provider-config"
import { ManualPayoutAdapter } from "./providers/manual-payout.adapter"
import { PayoutProviderAdapter } from "./providers/payout-provider.interface"
import { StripeConnectPayoutAdapter } from "./providers/stripe-connect-payout.adapter"

@Injectable()
export class PayoutProviderService implements OnModuleInit {
  private readonly logger = new Logger(PayoutProviderService.name)
  private adapters = new Map<string, PayoutProviderAdapter>()

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: PayoutEncryptionService,
    private readonly manualAdapter: ManualPayoutAdapter,
    private readonly stripeAdapter: StripeConnectPayoutAdapter,
  ) {}

  async onModuleInit() {
    this.register(this.manualAdapter)
    this.register(this.stripeAdapter)
    this.logger.log(
      "Registered certified provider adapters: manual, stripe_connect (Wise remains quarantined)",
    )
  }

  register(adapter: PayoutProviderAdapter) {
    if (this.adapters.has(adapter.providerName)) {
      this.logger.warn(
        `Provider adapter "${adapter.providerName}" already registered — skipping`,
      )
      return
    }
    this.adapters.set(adapter.providerName, adapter)
    this.logger.log(`Registered provider adapter: ${adapter.providerName}`)
  }

  getAdapter(providerName: string): PayoutProviderAdapter {
    const adapter = this.adapters.get(providerName)
    if (!adapter) {
      throw new Error(`No adapter registered for provider: ${providerName}`)
    }
    return adapter
  }

  async getActiveProvider(providerName: string) {
    const provider = await this.prisma.payoutProvider.findUnique({
      where: { name: providerName },
    })
    if (!provider?.isActive) {
      throw new Error(
        `Payout provider "${providerName}" is not active or not found`,
      )
    }
    const config = decodePayoutProviderConfig(
      provider.config,
      provider.configEncryptionKeyVersion,
      (ciphertext, version) =>
        this.encryption.decrypt(
          ciphertext,
          version,
          payoutProviderEncryptionContext(provider),
        ),
    )
    return { ...provider, decryptedConfig: config }
  }
}
