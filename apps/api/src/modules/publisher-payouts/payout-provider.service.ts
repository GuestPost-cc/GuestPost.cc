import { Injectable, Logger, type OnModuleInit } from "@nestjs/common"
import { ModuleRef } from "@nestjs/core"
import { PrismaService } from "../../common/prisma.service"
import { PayoutEncryptionService } from "./payout-encryption.service"
import { ManualPayoutAdapter } from "./providers/manual-payout.adapter"
import { PayoutProviderAdapter } from "./providers/payout-provider.interface"
import { StripeConnectPayoutAdapter } from "./providers/stripe-connect-payout.adapter"
import { WisePayoutAdapter } from "./providers/wise-payout.adapter"

@Injectable()
export class PayoutProviderService implements OnModuleInit {
  private readonly logger = new Logger(PayoutProviderService.name)
  private adapters = new Map<string, PayoutProviderAdapter>()

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: PayoutEncryptionService,
    readonly _moduleRef: ModuleRef,
  ) {}

  async onModuleInit() {
    this.register(new ManualPayoutAdapter())
    this.register(new WisePayoutAdapter())
    this.register(new StripeConnectPayoutAdapter())
    this.logger.log(
      "Registered built-in provider adapters: manual, wise, stripe_connect",
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
    // Providers without secrets (manual) store an empty/plain JSON config —
    // only string payloads are encrypted ciphertext.
    const rawConfig = provider.config as unknown
    let config: Record<string, unknown>
    if (typeof rawConfig === "string" && rawConfig.length > 0) {
      const configVersion = (provider as any).configEncryptionKeyVersion ?? 0
      config = this.encryption.decrypt(rawConfig, configVersion as number)
    } else if (rawConfig && typeof rawConfig === "object") {
      config = rawConfig as Record<string, unknown>
    } else {
      config = {}
    }
    return { ...provider, decryptedConfig: config }
  }
}
