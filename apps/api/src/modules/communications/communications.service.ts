import {
  type CommunicationEventInput,
  type NotificationCategory,
  notificationPreferenceDefaults,
  QUEUE_JOBS,
  QUEUES,
  recordCommunicationOutbox,
  repairCommunicationOutboxProjections,
  type ValidatedCommunicationProjectionEvent,
} from "@guestpost/shared"
import { getRequestId } from "@guestpost/shared/dist/observability/request-context"
import { BadRequestException, Injectable, Logger } from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { QueueService } from "../queues/queue.service"

type DbClient = PrismaService | any

@Injectable()
export class CommunicationsService {
  private readonly logger = new Logger(CommunicationsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  private assertDomainTransaction(tx: DbClient): void {
    if (!tx || tx === this.prisma) {
      throw new Error(
        "Communication outbox writes require the authoritative domain transaction client",
      )
    }
  }

  // A communication event is part of its domain mutation, not a follow-up
  // side effect. Requiring the caller's transaction client makes it
  // impossible for API call sites to accidentally create a split commit.
  async record(input: CommunicationEventInput, tx: DbClient) {
    this.assertDomainTransaction(tx)
    return recordCommunicationOutbox(tx, input, getRequestId())
  }

  /**
   * Rebuild projections only after a caller has exhaustively validated an
   * immutable historical event and its source artifact. This intentionally
   * cannot mutate or replace the event/document winner.
   */
  async repairValidatedLegacyEvent(
    event: ValidatedCommunicationProjectionEvent,
    recipientUserIds: readonly string[],
    actorUserId: string | null | undefined,
    tx: DbClient,
  ) {
    this.assertDomainTransaction(tx)
    return repairCommunicationOutboxProjections(
      tx,
      event,
      recipientUserIds,
      actorUserId,
    )
  }

  // Call only after the surrounding domain transaction commits. Queue failure
  // is non-fatal because the scheduled outbox sweep recovers PENDING rows.
  async dispatch(eventId: string): Promise<void> {
    const deliveries = await this.prisma.communicationDelivery.findMany({
      where: {
        eventId,
        channel: "EMAIL",
        status: { in: ["PENDING", "FAILED"] },
        availableAt: { lte: new Date() },
      },
      select: { id: true },
    })
    await Promise.all(
      deliveries.map((delivery) =>
        this.queue.addJob(
          QUEUES.EMAIL,
          QUEUE_JOBS[QUEUES.EMAIL].SEND_DELIVERY,
          { deliveryId: delivery.id },
          { jobId: `email-delivery-${delivery.id}` },
        ),
      ),
    )
  }

  dispatchBestEffort(eventId: string): void {
    void this.dispatch(eventId).catch((error) => {
      this.logger.warn(
        `Communication event ${eventId} remains pending for catch-up: ${error}`,
      )
    })
  }

  // Invoke only after the transaction that returned these IDs has committed.
  // Deduplication avoids redundant wake jobs when idempotent domain work
  // returns the same event more than once; the DB sweep remains authoritative.
  dispatchManyBestEffort(eventIds: Iterable<string>): void {
    for (const eventId of new Set(eventIds)) {
      this.dispatchBestEffort(eventId)
    }
  }

  // Retried serializable transactions may allocate a different event ID on a
  // successful attempt. Resolve the stable domain dedup key only after commit
  // instead of leaking an ID from a rolled-back attempt into queue dispatch.
  dispatchByDedupKeyBestEffort(dedupKey: string): void {
    void this.prisma.communicationEvent
      .findUnique({ where: { dedupKey }, select: { id: true } })
      .then((event) => {
        if (event) this.dispatchBestEffort(event.id)
      })
      .catch((error) => {
        this.logger.warn(
          `Communication event ${dedupKey} remains pending for catch-up: ${error}`,
        )
      })
  }

  dispatchManyByDedupKeyBestEffort(dedupKeys: Iterable<string>): void {
    for (const dedupKey of new Set(dedupKeys)) {
      this.dispatchByDedupKeyBestEffort(dedupKey)
    }
  }

  async customerOrderRecipients(
    orderId: string,
    tx: DbClient,
  ): Promise<string[]> {
    this.assertDomainTransaction(tx)
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        customerId: true,
        organization: {
          select: {
            memberships: {
              where: { status: "ACTIVE", role: "OWNER" },
              select: { userId: true },
            },
          },
        },
      },
    })
    if (!order) return []
    return [
      ...new Set([
        order.customerId,
        ...order.organization.memberships.map(
          (membership: { userId: string }) => membership.userId,
        ),
      ]),
    ]
  }

  async publisherRecipients(
    publisherId: string | null | undefined,
    ownersOnly: boolean,
    tx: DbClient,
  ): Promise<string[]> {
    this.assertDomainTransaction(tx)
    if (!publisherId) return []
    const memberships = await tx.publisherMembership.findMany({
      where: {
        publisherId,
        ...(ownersOnly ? { role: "PUBLISHER_OWNER" } : {}),
      },
      select: { userId: true },
    })
    return [
      ...new Set<string>(
        memberships.map((membership: { userId: string }) => membership.userId),
      ),
    ]
  }

  async organizationRecipients(
    organizationId: string | null | undefined,
    ownersOnly: boolean,
    tx: DbClient,
  ): Promise<string[]> {
    this.assertDomainTransaction(tx)
    if (!organizationId) return []
    const memberships = await tx.membership.findMany({
      where: {
        organizationId,
        status: "ACTIVE",
        ...(ownersOnly ? { role: "OWNER" } : {}),
      },
      select: { userId: true },
    })
    return [
      ...new Set<string>(
        memberships.map((membership: { userId: string }) => membership.userId),
      ),
    ]
  }

  async staffRecipients(
    roles: Array<"SUPER_ADMIN" | "OPERATIONS" | "FINANCE">,
    tx: DbClient,
  ): Promise<string[]> {
    this.assertDomainTransaction(tx)
    const memberships = await tx.staffMembership.findMany({
      where: {
        role: { in: roles },
        user: { banned: false, userType: "STAFF" },
      },
      select: { userId: true },
    })
    return memberships.map(
      (membership: { userId: string }) => membership.userId,
    )
  }

  async getPreferences(userId: string, isStaff: boolean) {
    const rows = await this.prisma.notificationPreference.findMany({
      where: { userId },
      select: { category: true, channel: true, enabled: true },
    })
    const stored = new Map(
      rows.map((row) => [`${row.category}:${row.channel}`, row.enabled]),
    )
    return notificationPreferenceDefaults()
      .filter((item) => isStaff || item.category !== "STAFF_ALERTS")
      .map((item) => ({
        category: item.category,
        mutable: item.mutable,
        inApp: stored.get(`${item.category}:IN_APP`) ?? item.inApp,
        email: stored.get(`${item.category}:EMAIL`) ?? item.email,
      }))
  }

  async updatePreferences(
    userId: string,
    isStaff: boolean,
    updates: Array<{
      category: NotificationCategory
      inApp: boolean
      email: boolean
    }>,
  ) {
    const defaults = new Map(
      notificationPreferenceDefaults().map((item) => [item.category, item]),
    )
    const categories = new Set<NotificationCategory>()
    for (const update of updates) {
      if (categories.has(update.category)) {
        throw new BadRequestException(
          `Duplicate notification category: ${update.category}`,
        )
      }
      categories.add(update.category)
      const policy = defaults.get(update.category)
      if (!policy)
        throw new BadRequestException("Unknown notification category")
      if (update.category === "STAFF_ALERTS" && !isStaff) {
        throw new BadRequestException(
          "Staff alert preferences are not available",
        )
      }
      if (!policy.mutable && (!update.inApp || !update.email)) {
        throw new BadRequestException(
          `${update.category} notifications cannot be disabled`,
        )
      }
    }

    await this.prisma.$transaction(
      updates.flatMap((update) =>
        (
          [
            ["IN_APP", update.inApp],
            ["EMAIL", update.email],
          ] as const
        ).map(([channel, enabled]) =>
          this.prisma.notificationPreference.upsert({
            where: {
              userId_category_channel: {
                userId,
                category: update.category,
                channel,
              },
            },
            create: { userId, category: update.category, channel, enabled },
            update: { enabled },
          }),
        ),
      ),
    )
    return this.getPreferences(userId, isStaff)
  }
}
