import { QUEUE_JOBS, QUEUES } from "@guestpost/shared"
import { signJobPayload } from "@guestpost/shared/dist/job-signing"

interface CommunicationDispatchPrisma {
  communicationDelivery: {
    findMany: (
      ...args: any[]
    ) => Promise<Array<{ id: string; attempts: number; availableAt: Date }>>
  }
}

interface CommunicationDispatchQueue {
  add(
    name: string,
    data: Record<string, unknown>,
    options: Record<string, unknown>,
  ): Promise<unknown>
}

/**
 * Resolve committed email deliveries and enqueue authenticated wake jobs.
 * Narrow dependencies keep the queue trust boundary independently testable.
 */
export async function dispatchCommittedCommunicationEvents(
  prismaClient: CommunicationDispatchPrisma,
  queue: CommunicationDispatchQueue,
  eventIds: Iterable<string>,
): Promise<number> {
  const uniqueEventIds = [...new Set(eventIds)]
  if (uniqueEventIds.length === 0) return 0

  const deliveries = await prismaClient.communicationDelivery.findMany({
    where: {
      eventId: { in: uniqueEventIds },
      channel: "EMAIL",
      status: { in: ["PENDING", "FAILED"] },
      availableAt: { lte: new Date() },
    },
    select: { id: true, attempts: true, availableAt: true },
  })
  await Promise.all(
    deliveries.map((delivery) =>
      queue.add(
        QUEUE_JOBS[QUEUES.EMAIL].SEND_DELIVERY,
        signJobPayload({ deliveryId: delivery.id }),
        {
          // The database owns delivery retries/backoff. BullMQ is only a wake
          // accelerator, so one queue attempt is sufficient and a failed wake
          // remains bounded forensic evidence rather than a second retry loop.
          attempts: 1,
          jobId: `email-delivery-${delivery.id}-a${delivery.attempts}-at${delivery.availableAt.getTime()}`,
          removeOnComplete: { count: 100, age: 86_400 },
          removeOnFail: { count: 100, age: 604_800 },
        },
      ),
    ),
  )
  return deliveries.length
}
