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
    recordOutbox?: RecordOutbox
    onError?: (requestId: string, error: unknown) => void
  } = {},
): Promise<CancellationStallNudgeResult> {
  const recordOutbox = options.recordOutbox ?? recordCommunicationOutbox
  const batchSize = Math.max(1, Math.min(Math.trunc(options.take ?? 100), 1000))
  const cutoff = new Date(
    now.getTime() - config.caseStallFirstReminderDays * 86_400_000,
  )
  let cursor: { id: string } | undefined
  let staleScanned = 0
  let nudged = 0
  const communicationEventIds: string[] = []

  while (true) {
    const stalled: CancellationStallCase[] =
      await prisma.orderCancellationRequest.findMany({
        where: {
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
        take: batchSize,
        ...(cursor ? { cursor, skip: 1 } : {}),
      })

    if (stalled.length === 0) break
    staleScanned += stalled.length

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
      try {
        const eventId = await prisma.$transaction(async (tx: any) => {
          const existing = await tx.orderEvent.findFirst({
            where: {
              orderId: request.orderId,
              eventType: "CANCELLATION_STALL_REMINDER",
              metadata: { path: ["stalledDays"], equals: stalledDays },
            },
            select: { id: true },
          })
          if (existing) return null

          const staff = await tx.staffMembership.findMany({
            where: {
              role: { in: [...(REVIEWER_ROLES[request.status] ?? [])] },
              user: { banned: false },
            },
            select: { userId: true },
          })
          if (staff.length === 0) return null

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
            recipientUserIds: staff.map(
              (item: { userId: string }) => item.userId,
            ),
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

    cursor = { id: stalled[stalled.length - 1].id }
    if (stalled.length < batchSize) break
  }

  return { staleScanned, nudged, communicationEventIds }
}
