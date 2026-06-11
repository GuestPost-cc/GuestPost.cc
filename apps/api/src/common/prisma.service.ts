import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common"
import { PrismaClient } from "@guestpost/database"

// Ensure the connection pool is large enough for concurrent interactive
// transactions (payment capture, settlement release, payout). With the Prisma
// default (~num_cpus*2+1) a burst of concurrent money operations starves the
// pool and transactions time out. Honour an explicit connection_limit in
// DATABASE_URL if set, otherwise inject a sane production default.
function buildDatasourceUrl(): string | undefined {
  const url = process.env.DATABASE_URL
  if (!url) return undefined
  if (url.includes("connection_limit")) return url
  const sep = url.includes("?") ? "&" : "?"
  return `${url}${sep}connection_limit=25&pool_timeout=20`
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({
      datasourceUrl: buildDatasourceUrl(),
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
