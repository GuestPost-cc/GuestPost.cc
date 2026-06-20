import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common"
import { PrismaClient } from "@guestpost/database"
import { PrismaPg } from "@prisma/adapter-pg"

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({
      adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL,
        // Burst capacity for concurrent money operations (payment capture,
        // settlement release, payout). The default ~num_cpus*2+1 starves the
        // pool under bursts of interactive transactions.
        max: 25,
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
