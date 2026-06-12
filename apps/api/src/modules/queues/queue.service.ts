import { Injectable, Logger } from "@nestjs/common"
import { Queue, QueueOptions, JobsOptions } from "bullmq"
import IORedis from "ioredis"
import { QUEUES, signJobPayload } from "@guestpost/shared"

let connection: IORedis | null = null

function getConnection() {
  if (!connection) {
    connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      maxRetriesPerRequest: null,
    })
  }
  return connection as IORedis
}

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

  async pushNotification(jobName: string, data: { userId: string; organizationId: string; type: string; message: string }) {
    const job = await this.addJob(QUEUES.NOTIFICATION, jobName, data)
    this.logger.log(`Notification queued: ${jobName} (job ${job.id})`)
    return job
  }

  async addJob<T = any>(queueName: string, jobName: string, data: T, overrides?: JobsOptions) {
    const base = (QUEUE_CONFIGS[queueName]?.defaultJobOptions ?? DEFAULT_JOB_OPTIONS) as JobsOptions
    // Per-call overrides (e.g. jobId for dedupe) merge over the queue defaults.
    const opts = { ...base, ...(overrides ?? {}) }
    // Every job is HMAC-signed — workers reject anything not enqueued by the
    // API (anyone with Redis network access could otherwise inject jobs)
    const payload = signJobPayload(data as Record<string, unknown>)
    const job = await this.getQueue(queueName).add(jobName, payload, opts)
    this.logger.log(`Job queued: ${queueName}/${jobName} (job ${job.id})`)
    return job
  }
}
