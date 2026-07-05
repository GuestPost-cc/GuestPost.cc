import { createPrismaAdapter, PrismaClient } from "@guestpost/database"
import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common"

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    super({
      adapter: createPrismaAdapter({
        // Pool max is resolved by the factory from PRISMA_POOL_MAX env var
        // (default 10). The env var is the single control point — see
        // create-prisma-client.ts for the precedence chain and sizing formula.
        // keep idle timeout explicit; the 20s ceiling prevents stale
        // connections from lingering during a database restart.
        idleTimeoutMillis: 20_000,
      }),
      // Interactive transactions wait for a pooled connection; give bursts room
      // before declaring failure, but keep a ceiling so a stuck txn can't hang.
      transactionOptions: { maxWait: 10_000, timeout: 20_000 },
    })
  }

  async onModuleInit() {
    await this.$connect()
  }

  async onModuleDestroy() {
    await this.$disconnect()
  }
}
