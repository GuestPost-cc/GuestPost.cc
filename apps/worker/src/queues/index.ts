import type { QueueName } from "@guestpost/shared"
import { Queue } from "bullmq"
import { connection } from "../redis"

const queues = new Map<QueueName, Queue>()

export function getQueue(name: QueueName): Queue {
  if (!queues.has(name)) {
    queues.set(name, new Queue(name, { connection }))
  }
  return queues.get(name)!
}

export async function addJob(queueName: QueueName, jobName: string, data: any) {
  const queue = getQueue(queueName)
  return queue.add(jobName, data)
}
