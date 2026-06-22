import { Injectable, Logger } from "@nestjs/common"
import { Queue, QueueOptions, JobsOptions } from "bullmq"
import { QUEUES, QUEUE_JOBS, trustRecomputeJobOptions } from "@guestpost/shared"
import { signJobPayload } from "@guestpost/shared/dist/job-signing"
// Deep import: request-context uses node:async_hooks and is not in the
// shared barrel.
import { getRequestId } from "@guestpost/shared/dist/observability/request-context"
import { getRedisClient } from "../../common/redis-client"

const getConnection = getRedisClient

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5000 },
  removeOnComplete: { count: 100, age: 86400 },
  removeOnFail: { count: 50, age: 604800 },
}

interface QueueConfig extends Omit<QueueOptions, "connection"> {}
const QUEUE_CONFIGS: Record<string, QueueConfig> = {
  [QUEUES.EMAIL]: {
    defaultJobOptions: {
      ...DEFAULT_JOB_OPTIONS,
      attempts: 5,
    },
  },
  [QUEUES.NOTIFICATION]: {
    defaultJobOptions: {
      ...DEFAULT_JOB_OPTIONS,
      attempts: 3,
    },
  },
  [QUEUES.REPORT]: {
    defaultJobOptions: {
      ...DEFAULT_JOB_OPTIONS,
      attempts: 2,
    },
  },
  [QUEUES.PAYOUT]: {
    defaultJobOptions: {
      ...DEFAULT_JOB_OPTIONS,
      attempts: 3,
      backoff: { type: "exponential", delay: 10000 },
    },
  },
}

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name)
  private queues = new Map<string, Queue>()

  private getQueue(name: string): Queue {
    if (!this.queues.has(name)) {
      const config = QUEUE_CONFIGS[name] ?? { defaultJobOptions: DEFAULT_JOB_OPTIONS }
      this.queues.set(name, new Queue(name, { ...config, connection: getConnection() as any }))
      this.logger.log(`Queue initialized: ${name}`)
    }
    return this.queues.get(name)!
  }

  async sendEmail(jobName: string, data: { to: string; subject: string; html?: string }) {
    const job = await this.addJob(QUEUES.EMAIL, jobName, data)
    this.logger.log(`Email queued: ${jobName} -> ${data.to} (job ${job.id})`)
    return job
  }

  async generateReport(jobName: string, data: { orderId: string; format?: string }) {
    const job = await this.addJob(QUEUES.REPORT, jobName, data)
    this.logger.log(`Report queued: ${jobName} for order ${data.orderId} (job ${job.id})`)
    return job
  }

  // Phase 7.4 (audit #12) — `dedupKey` is optional. When supplied (preferred
  // for retry-prone events: reconciliation drift, support fan-out, etc.),
  // the worker's notification processor catches Prisma P2002 unique-violation
  // as success — so a BullMQ retry of the same logical event produces ONE
  // notification, not three. Builders in @guestpost/shared notificationDedupKey.*.
  // Absent dedupKey = legacy NULL path; the partial unique index excludes
  // NULL rows so writes always succeed.
  async pushNotification(
    jobName: string,
    data: { userId: string; organizationId: string | null; type: string; message: string },
    dedupKey?: string,
  ) {
    const payload = dedupKey ? { ...data, dedupKey } : data
    const job = await this.addJob(QUEUES.NOTIFICATION, jobName, payload)
    this.logger.log(`Notification queued: ${jobName}${dedupKey ? ` dedupKey=${dedupKey}` : ""} (job ${job.id})`)
    return job
  }

  async addJob<T = any>(queueName: string, jobName: string, data: T, overrides?: JobsOptions) {
    const base = (QUEUE_CONFIGS[queueName]?.defaultJobOptions ?? DEFAULT_JOB_OPTIONS) as JobsOptions
    // Per-call overrides (e.g. jobId for dedupe) merge over the queue defaults.
    const opts = { ...base, ...(overrides ?? {}) }
    // Every job is HMAC-signed — workers reject anything not enqueued by the
    // API (anyone with Redis network access could otherwise inject jobs).
    // Phase 7.0: requestId from AsyncLocalStorage is included so worker-side
    // logs + Sentry events + audit writes share the originating request's ID.
    const requestId = getRequestId()
    const dataWithRequestId =
      requestId && !((data as Record<string, unknown>).requestId)
        ? { ...(data as Record<string, unknown>), requestId }
        : (data as Record<string, unknown>)
    const payload = signJobPayload(dataWithRequestId)
    const job = await this.getQueue(queueName).add(jobName, payload, opts)
    this.logger.log(`Job queued: ${queueName}/${jobName} (job ${job.id})`)
    return job
  }

  // Event-driven publisher trust recompute. jobId dedup + delay debounce so a
  // burst of trust-affecting events for one publisher collapses into a single
  // recompute. Never throws into the caller's transaction path.
  async enqueueTrustRecompute(publisherId: string | null | undefined, sourceEvent: string, reason?: string) {
    if (!publisherId) return
    try {
      await this.addJob(
        QUEUES.PUBLISHER_TRUST,
        QUEUE_JOBS[QUEUES.PUBLISHER_TRUST].RECOMPUTE,
        { publisherId, sourceEvent, reason: reason ?? sourceEvent },
        trustRecomputeJobOptions(publisherId),
      )
    } catch (err) {
      this.logger.error(`Failed to enqueue trust recompute for ${publisherId}: ${err}`)
    }
  }
}
