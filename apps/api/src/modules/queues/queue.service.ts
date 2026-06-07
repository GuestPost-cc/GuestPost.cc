import { Injectable } from "@nestjs/common"
import { Queue } from "bullmq"
import IORedis from "ioredis"
import { QUEUES } from "@guestpost/shared"

let connection: IORedis | null = null

function getConnection() {
  if (!connection) {
    connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      maxRetriesPerRequest: null,
    })
  }
  return connection as IORedis
}

@Injectable()
export class QueueService {
  private queues = new Map<string, Queue>()

  private getQueue(name: string): Queue {
    if (!this.queues.has(name)) {
      this.queues.set(name, new Queue(name, { connection: getConnection() as any }))
    }
    return this.queues.get(name)!
  }

  async sendEmail(jobName: string, data: { to: string; subject: string; html?: string }) {
    return this.getQueue(QUEUES.EMAIL).add(jobName, data)
  }

  async generateReport(jobName: string, data: { orderId: string; format?: string }) {
    return this.getQueue(QUEUES.REPORT).add(jobName, data)
  }

  async pushNotification(jobName: string, data: { userId: string; organizationId: string; type: string; message: string }) {
    return this.getQueue(QUEUES.NOTIFICATION).add(jobName, data)
  }

  async addJob<T = any>(queueName: string, jobName: string, data: T) {
    return this.getQueue(queueName).add(jobName, data)
  }
}
