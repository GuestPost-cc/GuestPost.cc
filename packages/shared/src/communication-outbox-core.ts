import {
  COMMUNICATION_EVENT_POLICIES,
  type CommunicationEventInput,
  type CommunicationEventType,
  communicationEventInputSchema,
  defaultCommunicationChannels,
  shouldDeliverCommunicationChannel,
} from "./communications"
import { issueFinancialDocumentForCommunication } from "./financial-document-outbox-core"

export class CommunicationOutboxDeduplicationConflictError extends Error {
  constructor() {
    super(
      "Communication deduplication key conflicts with immutable event inputs",
    )
    this.name = "CommunicationOutboxDeduplicationConflictError"
  }
}

function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(value ?? null)
  if (serialized === undefined) return "null"
  const parsed = JSON.parse(serialized) as unknown
  const stable = (entry: unknown): string => {
    if (entry === null || typeof entry !== "object") {
      return JSON.stringify(entry)
    }
    if (Array.isArray(entry)) {
      return `[${entry.map(stable).join(",")}]`
    }
    return `{${Object.entries(entry as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`
  }
  return stable(parsed)
}

function assertImmutableEventWinner(
  event: any,
  expected: {
    type: string
    category: string
    severity: string
    aggregateType: string
    aggregateId: string
    organizationId: string | null
    title: string
    message: string
    actionPath: string | null
    payload: unknown
  },
): void {
  if (
    event.type !== expected.type ||
    event.category !== expected.category ||
    event.severity !== expected.severity ||
    event.aggregateType !== expected.aggregateType ||
    event.aggregateId !== expected.aggregateId ||
    event.organizationId !== expected.organizationId ||
    event.title !== expected.title ||
    event.message !== expected.message ||
    event.actionPath !== expected.actionPath ||
    canonicalJson(event.payload) !== canonicalJson(expected.payload)
  ) {
    throw new CommunicationOutboxDeduplicationConflictError()
  }
}

async function reconcileCommunicationEventStatus(
  db: any,
  eventId: string,
): Promise<void> {
  const outstanding = await db.communicationDelivery.count({
    where: {
      eventId,
      status: {
        in: ["PENDING", "PROCESSING", "FAILED", "DELIVERY_UNCERTAIN"],
      },
    },
  })
  if (outstanding === 0) {
    await db.communicationEvent.updateMany({
      where: { id: eventId, status: { not: "PROCESSED" } },
      data: {
        status: "PROCESSED",
        processedAt: new Date(),
        lockedAt: null,
      },
    })
    return
  }
  await db.communicationEvent.updateMany({
    where: { id: eventId, status: "PROCESSED" },
    data: { status: "PENDING", processedAt: null },
  })
}

export interface ValidatedCommunicationProjectionEvent {
  id: string
  type: CommunicationEventType
  category: string
  severity: string
  organizationId: string | null
  title: string
  message: string
  actionPath: string | null
}

/**
 * Rebuilds missing delivery projections for an already-validated immutable
 * event. This exists for narrowly grandfathered historical events whose
 * accounting artifact cannot be replaced. Callers must validate every event
 * and document identity field before invoking it; this helper only applies the
 * current catalog, preference, suppression, event-lock, and status rules.
 */
export async function repairCommunicationOutboxProjections(
  db: any,
  event: ValidatedCommunicationProjectionEvent,
  recipientUserIds: readonly string[],
  actorUserId?: string | null,
): Promise<{ eventId: string; deliveryIds: string[] }> {
  const policy = COMMUNICATION_EVENT_POLICIES[event.type]
  if (
    !policy ||
    event.category !== policy.category ||
    event.severity !== policy.severity
  ) {
    throw new CommunicationOutboxDeduplicationConflictError()
  }
  const shouldExcludeActor = policy.actorRecipientPolicy !== "INCLUDE_IF_LISTED"
  const projectedUserIds = [
    ...new Set<string>(
      recipientUserIds.filter(
        (userId) => !shouldExcludeActor || userId !== actorUserId,
      ),
    ),
  ]

  // Email finalization also locks parent Event before inspecting Deliveries.
  // Match that parent-first order so replay/status reconciliation cannot race
  // the final delivery and incorrectly mark an event complete.
  const lockedEvent = await db.$queryRaw`
    SELECT "id"
    FROM "CommunicationEvent"
    WHERE "id" = ${event.id}
    FOR UPDATE
  `
  if (!Array.isArray(lockedEvent) || lockedEvent.length !== 1) {
    throw new Error("Communication event was not found after deduplication")
  }

  if (projectedUserIds.length === 0) {
    await reconcileCommunicationEventStatus(db, event.id)
    return { eventId: event.id, deliveryIds: [] }
  }

  const users = await db.user.findMany({
    where: { id: { in: projectedUserIds } },
    select: {
      id: true,
      email: true,
      emailVerified: true,
      banned: true,
      notificationPreferences: {
        where: { category: policy.category },
        select: { channel: true, enabled: true },
      },
      emailSuppressions: {
        where: { active: true },
        select: { email: true },
      },
    },
  })

  const deliveryIds: string[] = []
  for (const user of users) {
    if (user.banned) continue
    const preference = new Map<string, boolean>(
      user.notificationPreferences.map(
        (item: { channel: string; enabled: boolean }) => [
          item.channel,
          item.enabled,
        ],
      ),
    )
    for (const channel of defaultCommunicationChannels(event.type)) {
      if (
        !shouldDeliverCommunicationChannel(
          event.type,
          channel,
          preference.get(channel),
        )
      ) {
        continue
      }

      if (channel === "IN_APP") {
        await db.notification.upsert({
          where: { eventId_userId: { eventId: event.id, userId: user.id } },
          create: {
            eventId: event.id,
            userId: user.id,
            organizationId: event.organizationId,
            type: event.type,
            title: event.title,
            message: event.message,
            category: policy.category,
            severity: policy.severity,
            actionPath: event.actionPath,
            dedupKey: `comm:${event.id}`,
          },
          update: {},
        })
        continue
      }

      const normalizedEmail = user.email.trim().toLowerCase()
      const suppressed = user.emailSuppressions.some(
        (item: { email: string }) =>
          item.email.trim().toLowerCase() === normalizedEmail,
      )
      const delivery = await db.communicationDelivery.upsert({
        where: {
          eventId_userId_channel: {
            eventId: event.id,
            userId: user.id,
            channel: "EMAIL",
          },
        },
        create: {
          eventId: event.id,
          userId: user.id,
          channel: "EMAIL",
          status: !user.emailVerified || suppressed ? "SUPPRESSED" : "PENDING",
        },
        update: {},
        select: { id: true, status: true },
      })
      if (delivery.status === "PENDING" || delivery.status === "FAILED") {
        deliveryIds.push(delivery.id)
      }
    }
  }

  await reconcileCommunicationEventStatus(db, event.id)
  return { eventId: event.id, deliveryIds }
}

/**
 * Persists all channel deliveries with the domain event. It deliberately has
 * no queue dependency: API and worker transactions can use the same outbox,
 * while a later sweep handles dispatch after commit.
 */
export async function recordCommunicationOutbox(
  db: any,
  input: CommunicationEventInput,
  requestId?: string | null,
) {
  const parsed = communicationEventInputSchema.parse(input)
  const financialDocumentId = await issueFinancialDocumentForCommunication(
    db,
    parsed,
  )
  const eventPayload = financialDocumentId
    ? { ...(parsed.payload ?? {}), financialDocumentId }
    : parsed.payload
  const policy = COMMUNICATION_EVENT_POLICIES[parsed.type]
  const immutableEvent = {
    type: parsed.type,
    category: policy.category,
    severity: policy.severity,
    aggregateType: parsed.aggregateType,
    aggregateId: parsed.aggregateId,
    organizationId: parsed.organizationId ?? null,
    title: parsed.title,
    message: parsed.message,
    actionPath: parsed.actionPath ?? null,
    payload: eventPayload ?? null,
  }
  const event = await db.communicationEvent.upsert({
    where: { dedupKey: parsed.dedupKey },
    create: {
      ...immutableEvent,
      payload: eventPayload ?? undefined,
      dedupKey: parsed.dedupKey,
      requestId: requestId ?? null,
    },
    update: {},
    select: {
      id: true,
      type: true,
      category: true,
      severity: true,
      aggregateType: true,
      aggregateId: true,
      organizationId: true,
      title: true,
      message: true,
      actionPath: true,
      payload: true,
    },
  })
  // requestId is tracing metadata, not logical event identity: an exact
  // idempotent replay can legitimately arrive in a later HTTP/job request.
  // Recipients are also intentionally outside the immutable identity so a
  // safe replay can repair a missing authorized projection. Every content
  // and tenant field must still match before any derived row is written.
  assertImmutableEventWinner(event, immutableEvent)
  return repairCommunicationOutboxProjections(
    db,
    event,
    parsed.recipientUserIds,
    parsed.actorUserId,
  )
}
