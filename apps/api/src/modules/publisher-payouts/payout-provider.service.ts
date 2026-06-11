import { Injectable, Logger, OnModuleInit } from "@nestjs/common"
import { ModuleRef } from "@nestjs/core"
import { PrismaService } from "../../common/prisma.service"
import { PayoutEncryptionService } from "./payout-encryption.service"
import type { PayoutProviderAdapter } from "./providers/payout-provider.interface"
import { ManualPayoutAdapter } from "./providers/manual-payout.adapter"

@Injectable()
export class PayoutProviderService implements OnModuleInit {
  private readonly logger = new Logger(PayoutProviderService.name)
  private adapters = new Map<string, PayoutProviderAdapter>()

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: PayoutEncryptionService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async onModuleInit() {
    this.register(new ManualPayoutAdapter())
    this.logger.log("Registered 1 built-in provider adapter (manual)")
  }

  register(adapter: PayoutProviderAdapter) {
    if (this.adapters.has(adapter.providerName)) {
      this.logger.warn(`Provider adapter "${adapter.providerName}" already registered — skipping`)
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
    if (!provider || !provider.isActive) {
      throw new Error(`Payout provider "${providerName}" is not active or not found`)
    }
    const configVersion = (provider as any).configEncryptionKeyVersion ?? 0
    const config = this.encryption.decrypt(provider.config as unknown as string, configVersion as number)
    return { ...provider, decryptedConfig: config }
  }
}
