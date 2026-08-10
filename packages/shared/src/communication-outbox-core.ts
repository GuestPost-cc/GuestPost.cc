import {
  COMMUNICATION_EVENT_POLICIES,
  type CommunicationEventInput,
  communicationEventInputSchema,
  defaultCommunicationChannels,
  shouldDeliverCommunicationChannel,
} from "./communications"
import { issueFinancialDocumentForCommunication } from "./financial-document-outbox-core"

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
  const recipientUserIds = [
    ...new Set<string>(
      parsed.recipientUserIds.filter((userId) => userId !== parsed.actorUserId),
    ),
  ]

  const event = await db.communicationEvent.upsert({
    where: { dedupKey: parsed.dedupKey },
    create: {
      type: parsed.type,
      category: policy.category,
      severity: policy.severity,
      aggregateType: parsed.aggregateType,
      aggregateId: parsed.aggregateId,
      organizationId: parsed.organizationId ?? null,
      title: parsed.title,
      message: parsed.message,
      actionPath: parsed.actionPath ?? null,
      payload: eventPayload ?? undefined,
      dedupKey: parsed.dedupKey,
      requestId: requestId ?? null,
    },
    update: {},
  })

  if (recipientUserIds.length === 0) {
    await db.communicationEvent.updateMany({
      where: { id: event.id, status: "PENDING" },
      data: { status: "PROCESSED", processedAt: new Date() },
    })
    return { eventId: event.id, deliveryIds: [] as string[] }
  }

  const users = await db.user.findMany({
    where: { id: { in: recipientUserIds } },
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
    for (const channel of defaultCommunicationChannels(parsed.type)) {
      if (
        !shouldDeliverCommunicationChannel(
          parsed.type,
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
            organizationId: parsed.organizationId ?? null,
            type: parsed.type,
            title: parsed.title,
            message: parsed.message,
            category: policy.category,
            severity: policy.severity,
            actionPath: parsed.actionPath ?? null,
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

  if (deliveryIds.length === 0) {
    await db.communicationEvent.updateMany({
      where: { id: event.id, status: "PENDING" },
      data: { status: "PROCESSED", processedAt: new Date() },
    })
  } else {
    await db.communicationEvent.updateMany({
      where: { id: event.id, status: "PROCESSED" },
      data: { status: "PENDING", processedAt: null },
    })
  }

  return { eventId: event.id, deliveryIds }
}
