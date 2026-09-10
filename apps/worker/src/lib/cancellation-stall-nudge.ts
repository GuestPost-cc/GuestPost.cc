import {
  type CommunicationEventInput,
  isCaseStallReminderDue,
  recordCommunicationOutbox,
} from "@guestpost/shared"

export interface CancellationStallCase {
  id: string
  orderId: string
  status: string
  updatedAt: Date
  order: { organizationId: string | null }
}

export interface CancellationStallConfig {
  caseStallFirstReminderDays: number
  caseStallReminderIntervalDays: number
}

export interface CancellationStallNudgeResult {
  staleScanned: number
  nudged: number
  communicationEventIds: string[]
  nextCursor: CancellationStallCursor | null
}

export interface CancellationStallCursor {
  updatedAt: string
  id: string
}

type RecordOutbox = (
  tx: any,
  input: CommunicationEventInput,
) => Promise<{ eventId: string; deliveryIds: string[] }>

const REVIEWER_ROLES: Record<string, readonly string[]> = {
  ESCALATED: ["OPERATIONS", "SUPER_ADMIN"],
  PENDING_FINANCE: ["FINANCE", "SUPER_ADMIN"],
}

const STALL_ACTION_PATH = "/dashboard/cancellations"

function stallMessage(status: string, stalledDays: number): string {
  const stage =
    status === "PENDING_FINANCE" ? "Finance approval" : "Operations review"
  return `${stage} of cancellation case has been pending for ${stalledDays} day(s). Review and resolve to unblock the customer refund.`
}

/**
 * Nudge the accountable staff roles for active cancellation cases that have
 * sat in ESCALATED or PENDING_FINANCE past the reminder cadence. Read-only
 * toward the case itself: nudges write one order-event trail row per day
 * bucket plus a required-channel staff communication; no state transition
 * or financial decision is automated here.
 */
export async function nudgeStaleCancellationCases(
  prisma: any,
  now: Date,
  config: CancellationStallConfig,
  options: {
    take?: number
    maxScan?: number
    startAfter?: CancellationStallCursor
    recordOutbox?: RecordOutbox
    onError?: (requestId: string, error: unknown) => void
  } = {},
): Promise<CancellationStallNudgeResult> {
  const recordOutbox = options.recordOutbox ?? recordCommunicationOutbox
  const batchSize = Math.max(1, Math.min(Math.trunc(options.take ?? 100), 1000))
  const maxScan = Math.max(
    batchSize,
    Math.min(Math.trunc(options.maxScan ?? 1_000), 10_000),
  )
  const cutoff = new Date(
    now.getTime() - config.caseStallFirstReminderDays * 86_400_000,
  )
  const startAfterDate = options.startAfter
    ? new Date(options.startAfter.updatedAt)
    : null
  let cursor =
    options.startAfter &&
    startAfterDate &&
    Number.isFinite(startAfterDate.getTime())
      ? { updatedAt: startAfterDate, id: options.startAfter.id }
      : undefined
  let reachedEnd = false
  let staleScanned = 0
  let nudged = 0
  const communicationEventIds: string[] = []

  while (staleScanned < maxScan) {
    const take = Math.min(batchSize, maxScan - staleScanned)
    const stalled: CancellationStallCase[] =
      await prisma.orderCancellationRequest.findMany({
        where: cursor
          ? {
              AND: [
                {
                  status: { in: Object.keys(REVIEWER_ROLES) },
                  updatedAt: { lte: cutoff },
                },
                {
                  OR: [
                    { updatedAt: { gt: cursor.updatedAt } },
                    { updatedAt: cursor.updatedAt, id: { gt: cursor.id } },
                  ],
                },
              ],
            }
          : {
              status: { in: Object.keys(REVIEWER_ROLES) },
              updatedAt: { lte: cutoff },
            },
        select: {
          id: true,
          orderId: true,
          status: true,
          updatedAt: true,
          order: { select: { organizationId: true } },
        },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take,
      })

    if (stalled.length === 0) {
      reachedEnd = true
      break
    }
    staleScanned += stalled.length
    const existingEvents = await prisma.orderEvent.findMany({
      where: {
        orderId: { in: stalled.map((request) => request.orderId) },
        eventType: "CANCELLATION_STALL_REMINDER",
      },
      select: { orderId: true, metadata: true },
    })
    const existingKeys = new Set(
      existingEvents.map((event: { orderId: string; metadata: unknown }) => {
        const metadata = event.metadata as { stalledDays?: unknown } | null
        return `${event.orderId}:${String(metadata?.stalledDays)}`
      }),
    )

    for (const request of stalled) {
      const stalledDays = Math.floor(
        (now.getTime() - new Date(request.updatedAt).getTime()) / 86_400_000,
      )
      if (
        !isCaseStallReminderDue(
          stalledDays,
          config.caseStallFirstReminderDays,
          config.caseStallReminderIntervalDays,
        )
      ) {
        continue
      }
      if (existingKeys.has(`${request.orderId}:${stalledDays}`)) continue
      try {
        const eventId = await prisma.$transaction(async (tx: any) => {
          const reviewers = await tx.staffMembership.findMany({
            where: {
              role: { in: REVIEWER_ROLES[request.status] ?? [] },
              user: { banned: false },
            },
            select: { userId: true },
          })
          const recipientUserIds = [
            ...new Set<string>(
              reviewers.map((reviewer: { userId: string }) => reviewer.userId),
            ),
          ]
          if (recipientUserIds.length === 0) return null

          await tx.orderEvent.create({
            data: {
              orderId: request.orderId,
              eventType: "CANCELLATION_STALL_REMINDER",
              actorId: null,
              message: stallMessage(request.status, stalledDays),
              metadata: {
                requestId: request.id,
                caseStatus: request.status,
                stalledDays,
                automatic: true,
              },
            },
          })

          const event = await recordOutbox(tx, {
            type: "STAFF_RECONCILIATION_ALERT",
            aggregateType: "Order",
            aggregateId: request.orderId,
            organizationId: request.order.organizationId,
            title: "Cancellation case awaiting action",
            message: stallMessage(request.status, stalledDays),
            actionPath: STALL_ACTION_PATH,
            payload: {
              requestId: request.id,
              orderId: request.orderId,
              caseStatus: request.status,
              stalledDays,
            },
            dedupKey: `staff:cancellation-case:${request.id}:stall:${stalledDays}`,
            recipientUserIds,
          })
          return event.eventId
        })
        if (eventId) {
          communicationEventIds.push(eventId)
          nudged++
        }
      } catch (error) {
        options.onError?.(request.id, error)
      }
    }

    const last = stalled[stalled.length - 1]
    cursor = { updatedAt: new Date(last.updatedAt), id: last.id }
    if (stalled.length < take) {
      reachedEnd = true
      break
    }
  }

  return {
    staleScanned,
    nudged,
    communicationEventIds,
    nextCursor:
      reachedEnd || !cursor
        ? null
        : { updatedAt: cursor.updatedAt.toISOString(), id: cursor.id },
  }
}
