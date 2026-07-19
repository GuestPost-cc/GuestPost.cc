import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const repoRoot = resolve(__dirname, "../../../..")
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8")

describe("hybrid worker runtime contract", () => {
  it("keeps the safe legacy mode as the rollout default", () => {
    const source = read("apps/worker/src/index.ts")
    expect(source).toContain('process.env.WORKER_MODE ?? "all"')
  })

  it("runs only latency-sensitive queues in the realtime lane", () => {
    const source = read("apps/worker/src/index.ts")
    const realtime = source.slice(
      source.indexOf("const REALTIME_WORKERS"),
      source.indexOf("const ON_DEMAND_WORKERS"),
    )
    expect(realtime).toContain("createEmailWorker")
    expect(realtime).toContain("createNotificationWorker")
    expect(realtime).toContain("createWebsiteVerificationWorker")
    expect(realtime).toContain("createDeliveryVerificationWorker")
    expect(realtime).not.toContain("createPayoutWorker")
    expect(realtime).not.toContain("createReconciliationWorker")
    expect(realtime).not.toContain("createSettlementReleaseWorker")
  })

  it("uses Upstash-oriented idle maintenance defaults", () => {
    const source = read("apps/worker/src/lib/queue-observability.ts")
    expect(source).toMatch(/WORKER_DRAIN_DELAY_SECONDS[\s\S]*300/)
    expect(source).toMatch(/WORKER_STALLED_INTERVAL_MS[\s\S]*300_000/)
  })

  it("supports a dedicated queue Redis URL without breaking fallback", () => {
    for (const file of [
      "apps/api/src/common/redis-client.ts",
      "apps/worker/src/redis.ts",
      "packages/integrations/src/redis.ts",
    ]) {
      const source = read(file)
      expect(source).toContain("QUEUE_REDIS_URL")
      expect(source).toContain("REDIS_URL")
    }
  })

  it("keeps payout webhook acknowledgement on Postgres, not BullMQ", () => {
    const source = read(
      "apps/api/src/modules/publisher-payouts/payout-webhook.controller.ts",
    )
    expect(source).toContain("payoutWebhookEvent.create")
    expect(source).not.toContain("queue.addJob")
    expect(source).not.toContain("data: rawBody")
  })

  it("scopes provider transfer reconciliation by provider", () => {
    const source = read("apps/worker/src/processors/payout.processor.ts")
    expect(source).toContain("provider: { is: { name: event.provider } }")
    expect(source).toContain(
      "const INBOX_MAX_RETRY_AGE_MS = 72 * 60 * 60 * 1000",
    )
    expect(source).toContain("const INBOX_MAX_ATTEMPTS = 432")
    expect(source).toContain("PAYOUT_WEBHOOK_STATE_CONFLICT")
    const schema = read("packages/database/prisma/schema.prisma")
    expect(schema).toContain("@@unique([providerId, providerExecutionId])")
  })

  it("removes only hybrid-owned legacy repeatable schedules", () => {
    const source = read("apps/worker/src/index.ts")
    const removal = source.slice(
      source.indexOf("async function removeHybridRepeatables"),
      source.indexOf("async function runScheduledTask"),
    )
    expect(removal).toContain("ownedSchedules")
    expect(removal).toContain(".filter((job) => names.has(job.name))")
    expect(removal).not.toContain("repeatables.map(")
  })

  it("does not keep a burst worker alive for delayed retries", () => {
    const source = read("apps/worker/src/index.ts")
    const drain = source.slice(
      source.indexOf("async function drainOnDemandQueues"),
      source.indexOf("const workers:"),
    )
    expect(drain).toContain(
      'queue.getJobCounts("waiting", "active", "prioritized")',
    )
    expect(drain).not.toContain('getJobCounts("waiting", "active", "delayed"')
    expect(drain).not.toContain("count.delayed")
  })

  it("signs and verifies integration queue payloads", () => {
    const syncProducer = read(
      "packages/integrations/src/services/sync.service.ts",
    )
    const discoveryProducer = read(
      "packages/integrations/src/services/discovery.service.ts",
    )
    const consumers = read("packages/integrations/src/workers/index.ts")
    expect(syncProducer).toContain("signJobPayload")
    expect(discoveryProducer).toContain("signJobPayload")
    expect(consumers).toContain("verifyJobPayload")
    expect(consumers).toContain("Invalid integration sync job signature")
    expect(consumers).toContain("Invalid integration discovery job signature")
  })
})
