import { prisma } from "@guestpost/database"
import { QUEUES } from "@guestpost/shared"
import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"
import { getQueue } from "../queues"
import { dispatchCommittedCommunicationEvents } from "./communication-outbox-dispatch-core"

export { dispatchCommittedCommunicationEvents } from "./communication-outbox-dispatch-core"

const logger = createLogger("worker.communication-outbox-dispatch")

/**
 * Wake committed email deliveries without making Redis part of the domain
 * transaction. Failure is deliberately non-fatal: the scheduled database
 * sweep remains the durable recovery mechanism.
 */
export async function dispatchCommunicationEventsBestEffort(
  eventIds: Iterable<string>,
): Promise<void> {
  const uniqueEventIds = [...new Set(eventIds)]
  if (uniqueEventIds.length === 0) return

  try {
    await dispatchCommittedCommunicationEvents(
      prisma,
      getQueue(QUEUES.EMAIL),
      uniqueEventIds,
    )
  } catch (error) {
    logger.warn("communication events remain pending for catch-up", {
      eventIds: uniqueEventIds,
      err: error instanceof Error ? error.message : String(error),
    })
  }
}

export async function dispatchCommunicationDedupKeysBestEffort(
  dedupKeys: Iterable<string>,
): Promise<void> {
  const uniqueDedupKeys = [...new Set(dedupKeys)]
  if (uniqueDedupKeys.length === 0) return
  try {
    const events = await prisma.communicationEvent.findMany({
      where: { dedupKey: { in: uniqueDedupKeys } },
      select: { id: true },
    })
    await dispatchCommunicationEventsBestEffort(events.map((event) => event.id))
  } catch (error) {
    logger.warn("communication dedup keys remain pending for catch-up", {
      dedupKeys: uniqueDedupKeys,
      err: error instanceof Error ? error.message : String(error),
    })
  }
}
