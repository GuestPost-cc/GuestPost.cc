import {
  assertCanonicalPlatformRevenueFundingCore,
  evaluateLockedSettlementEligibility,
  getSettlementReviewDays,
  orderEventMetadata,
  PlatformRevenueEvidenceError,
  type PublisherTier,
  QUEUES,
  runLockedOrderSerializableTransaction,
  WorkflowDecisionService,
} from "@guestpost/shared"
import { isRetryablePrismaTransactionError } from "@guestpost/shared/dist/prisma-transaction-retry"
import { recomputePublisherTrustCore } from "@guestpost/shared/dist/publisher-trust-core"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/client"
import { assertApiFinanceOperationAllowed } from "../../../common/finance-runtime-mode"
import { notificationThreshold } from "../../../common/notification-config"
import {
  resolvePlatformFeePolicy,
  splitPlatformFee,
} from "../../../common/platform-fee"
import { PrismaService } from "../../../common/prisma.service"
import { AuditService } from "../../audit/audit.service"
import { CommunicationsService } from "../../communications/communications.service"
import { QueueService } from "../../queues/queue.service"
import {
  deliveryFraudReviewRequiredForCustomer,
  recordCustomerDeliveryFraudBlock,
} from "./delivery-fraud-guard"
import { OrderCancellationService } from "./order-cancellation.service"

@Injectable()
export class OrderReviewService {
  private readonly decision = new WorkflowDecisionService()

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
    private readonly cancellation: OrderCancellationService,
    @Optional() private readonly communications?: CommunicationsService,
  ) {}

  // Customer review for a completed order. One per order. Recomputes the
  // publisher's aggregate rating (the trust score in TR-B3 builds on this).
  async submitReview(
    orderId: string,
    organizationId: string,
    userId: string,
    rating: number,
    comment?: string,
  ) {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new BadRequestException("Rating must be an integer from 1 to 5")
    }
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, organizationId },
      include: { website: { select: { publisherId: true } } },
    })
    if (!order) throw new NotFoundException("Order not found")
    if (!["DELIVERED", "SETTLED", "COMPLETED"].includes(order.status)) {
      throw new BadRequestException(
        "You can review an order once it is delivered",
      )
    }
    const isCreator = order.customerId === userId
    const membership = await this.prisma.membership.findFirst({
      where: { organizationId, userId, status: "ACTIVE" },
      select: { role: true },
    })
    const isOwner = membership?.role === "OWNER"
    if (!membership || (!isCreator && !isOwner))
      throw new ForbiddenException(
        "Only the order creator or organization owner can review",
      )

    const publisherId = order.website?.publisherId ?? null

    const existing = await this.prisma.orderReview.findUnique({
      where: { orderId },
      select: { id: true },
    })
    const review = await this.prisma.orderReview.upsert({
      where: { orderId },
      create: {
        orderId,
        publisherId,
        customerId: userId,
        rating,
        comment: comment?.slice(0, 2000) || null,
      },
      update: { rating, comment: comment?.slice(0, 2000) || null },
    })

    // Event-driven trust recompute (debounced/deduped via the queue).
    await this.queue.enqueueTrustRecompute(
      publisherId,
      existing ? "ORDER_REVIEW_UPDATED" : "ORDER_REVIEW_CREATED",
      `review on order ${orderId}`,
    )

    await this.prisma.orderEvent.create({
      data: {
        orderId,
        eventType: "DELIVERY_CONFIRMED",
        actorId: userId,
        message: `Customer left a ${rating}-star review`,
      },
    })
    await this.audit.log({
      action: "ORDER_REVIEWED",
      entityType: "Order",
      entityId: orderId,
      metadata: { ...orderEventMetadata(order), rating, publisherId },
      userId,
      organizationId,
    })
    return review
  }

  // Synchronous recompute (manual admin endpoint). The shared core is the single
  // implementation; the worker uses the same one for the event-driven path.
  async recomputePublisherTrust(publisherId: string, sourceEvent = "MANUAL") {
    const r = await recomputePublisherTrustCore(this.prisma, publisherId, {
      sourceEvent,
    })
    if (r?.changed && this.communications) {
      const [publisher, audit, publisherRecipients, staffRecipients] =
        await Promise.all([
          this.prisma.publisher.findUnique({
            where: { id: publisherId },
            select: { name: true, organizationId: true },
          }),
          this.prisma.auditLog.findFirst({
            where: {
              action: "PUBLISHER_TIER_CHANGED",
              entityType: "Publisher",
              entityId: publisherId,
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            select: { id: true },
          }),
          this.communications.publisherRecipients(publisherId),
          this.communications.staffRecipients(["SUPER_ADMIN", "OPERATIONS"]),
        ])
      if (publisher) {
        const transitionId = audit?.id ?? `${r.oldTier}-${r.newTier}`
        const publisherEvent = await this.communications.record({
          type: "PUBLISHER_TIER_CHANGED",
          aggregateType: "Publisher",
          aggregateId: publisherId,
          organizationId: publisher.organizationId,
          title: "Publisher tier changed",
          message: `Your publisher tier changed from ${r.oldTier ?? "NEW"} to ${r.newTier}.`,
          actionPath: "/dashboard/settings",
          payload: { from: r.oldTier, to: r.newTier, trustScore: r.newScore },
          dedupKey: `publisher:${publisherId}:tier-change:${transitionId}`,
          recipientUserIds: publisherRecipients,
        })
        this.communications.dispatchBestEffort(publisherEvent.eventId)
        const staffEvent = await this.communications.record({
          type: "STAFF_PUBLISHER_TIER_CHANGED",
          aggregateType: "Publisher",
          aggregateId: publisherId,
          organizationId: publisher.organizationId,
          title: "Publisher tier changed",
          message: `Publisher ${publisher.name ?? publisherId} changed from ${r.oldTier ?? "NEW"} to ${r.newTier}.`,
          actionPath: "/dashboard/publishers",
          payload: { from: r.oldTier, to: r.newTier, trustScore: r.newScore },
          dedupKey: `staff:publisher:${publisherId}:tier-change:${transitionId}`,
          recipientUserIds: staffRecipients,
        })
        this.communications.dispatchBestEffort(staffEvent.eventId)
      }
    }
    return r
      ? {
          publisherId,
          score: r.newScore,
          tier: r.newTier,
          band: r.newScore >= 70 ? "High" : r.newScore >= 40 ? "Medium" : "Low",
        }
      : null
  }

  async getReview(
    orderId: string,
    access: {
      organizationId?: string | null
      publisherId?: string | null
    },
  ) {
    const ownershipScope = access.organizationId
      ? { organizationId: access.organizationId }
      : access.publisherId
        ? { website: { publisherId: access.publisherId } }
        : null
    if (!ownershipScope) throw new NotFoundException("Order not found")

    const order = await this.prisma.order.findFirst({
      where: { id: orderId, ...ownershipScope },
      select: { id: true },
    })
    if (!order) throw new NotFoundException("Order not found")
    return this.prisma.orderReview.findUnique({ where: { orderId } })
  }

  private async transition(
    orderId: string,
    fromVersion: number,
    data: any,
    expectedStatus?: string,
    prisma: any = this.prisma,
  ) {
    const r = await prisma.order.updateMany({
      where: {
        id: orderId,
        version: fromVersion,
        ...(expectedStatus ? { status: expectedStatus as any } : {}),
      },
      data: { ...data, version: { increment: 1 } },
    })
    if (r.count === 0) {
      throw new ConflictException(
        "Order was modified by another request. Retry.",
      )
    }
    return prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  }

  async approveContent(
    orderId: string,
    organizationId: string,
    userId: string,
  ) {
    let communicationEventId: string | null = null
    const result = await runLockedOrderSerializableTransaction(
      this.prisma,
      orderId,
      async (tx: any) => {
        const order = await tx.order.findFirst({
          where: { id: orderId, organizationId },
          include: {
            items: {
              include: { website: { select: { publisherId: true } } },
            },
          },
        })
        if (!order) throw new NotFoundException("Order not found")
        if (order.status !== "CUSTOMER_REVIEW") {
          throw new BadRequestException(
            "Order must be in CUSTOMER_REVIEW to approve content",
          )
        }
        await this.cancellation.assertNoActiveCancellation(orderId, tx)

        const membership = await tx.membership.findFirst({
          where: { organizationId, userId, status: "ACTIVE" },
        })
        const isOwner = membership?.role === "OWNER"
        const isCreator = order.customerId === userId
        if (!membership || (!isOwner && !isCreator)) {
          throw new ForbiddenException(
            "Only organization owner or order creator can approve content",
          )
        }

        const activeRevisions = await tx.revision.findMany({
          where: {
            orderId,
            status: { notIn: ["APPROVED", "REJECTED"] },
          },
          orderBy: { createdAt: "desc" },
          take: 2,
        })
        if (activeRevisions.length > 1) {
          throw new ConflictException({
            code: "REVISION_LIFECYCLE_CORRUPT",
            message:
              "Multiple active revisions require staff repair before content approval",
          })
        }

        const fresh = await this.transition(
          orderId,
          order.version,
          { status: "APPROVED" },
          "CUSTOMER_REVIEW",
          tx,
        )
        const activeRevision = activeRevisions[0]
        if (activeRevision) {
          const closed = await tx.revision.updateMany({
            where: {
              id: activeRevision.id,
              orderId,
              status: { notIn: ["APPROVED", "REJECTED"] },
            },
            data: { status: "APPROVED" },
          })
          if (closed.count !== 1) {
            throw new ConflictException(
              "Revision changed during content approval. Refresh and retry.",
            )
          }
        }
        await tx.orderEvent.create({
          data: {
            orderId,
            eventType: "CONTENT_APPROVED",
            actorId: userId,
            message: "Content approved by customer",
            metadata: {
              revisionId: activeRevision?.id ?? null,
              revisionClosed: activeRevision != null,
            },
          },
        })
        if (this.communications) {
          const publisherIds = [
            ...new Set<string>(
              order.items.flatMap((item: any) =>
                typeof item.website?.publisherId === "string"
                  ? [item.website.publisherId]
                  : [],
              ),
            ),
          ]
          const recipients = [
            ...new Set<string>([
              ...(await this.communications.customerOrderRecipients(
                orderId,
                tx,
              )),
              ...(
                await Promise.all(
                  publisherIds.map((publisherId) =>
                    this.communications!.publisherRecipients(
                      publisherId,
                      false,
                      tx,
                    ),
                  ),
                )
              ).flat(),
            ]),
          ]
          const event = await this.communications.record(
            {
              type: "ORDER_CONTENT_APPROVED",
              aggregateType: "Order",
              aggregateId: orderId,
              organizationId,
              title: "Content approved",
              message: `Content for order ${orderId} was approved and is ready to publish.`,
              actionPath: `/dashboard/orders/${orderId}`,
              dedupKey: `order:${orderId}:content-approved:${fresh.version}`,
              recipientUserIds: recipients,
              actorUserId: userId,
            },
            tx,
          )
          communicationEventId = event.eventId
        }
        return { order: fresh, assigneeId: order.assigneeId }
      },
    )

    if (communicationEventId) {
      this.communications?.dispatchBestEffort(communicationEventId)
    } else if (result.assigneeId) {
      await this.queue.addJob(QUEUES.NOTIFICATION, "push-in-app", {
        userId: result.assigneeId,
        organizationId,
        type: "CONTENT_APPROVED",
        message: `Content for order ${orderId} was approved — proceed to publish`,
      })
    }

    return result.order
  }

  async requestRevision(
    orderId: string,
    organizationId: string,
    userId: string,
    notes: string,
  ) {
    const normalizedNotes = notes?.trim()
    if (!normalizedNotes || normalizedNotes.length < 10) {
      throw new BadRequestException(
        "Revision notes must contain at least 10 characters",
      )
    }
    if (normalizedNotes.length > 2000) {
      throw new BadRequestException(
        "Revision notes must be 2,000 characters or fewer",
      )
    }

    let communicationEventId: string | null = null
    const updated = await runLockedOrderSerializableTransaction(
      this.prisma,
      orderId,
      async (tx: any) => {
        // All policy facts are re-read only after the canonical Order lock.
        // This keeps the legacy campaign route and the primary order route on
        // one fail-closed revision state machine.
        const order = await tx.order.findFirst({
          where: { id: orderId, organizationId },
          include: {
            items: {
              include: { website: { select: { publisherId: true } } },
            },
          },
        })
        if (!order) throw new NotFoundException("Order not found")
        if (order.status !== "CUSTOMER_REVIEW") {
          throw new BadRequestException(
            "Order must be in CUSTOMER_REVIEW to request revision",
          )
        }
        await this.cancellation.assertNoActiveCancellation(orderId, tx)

        const membership = await tx.membership.findFirst({
          where: { organizationId, userId, status: "ACTIVE" },
          select: { role: true },
        })
        const isOwner = membership?.role === "OWNER"
        const isCreator = order.customerId === userId
        if (!membership || (!isOwner && !isCreator)) {
          throw new ForbiddenException(
            "Only organization owner or order creator can request revisions",
          )
        }

        const activeRevisions = await tx.revision.findMany({
          where: {
            orderId,
            status: { notIn: ["APPROVED", "REJECTED"] },
          },
          orderBy: { createdAt: "desc" },
          take: 2,
          select: { id: true },
        })
        if (activeRevisions.length > 0) {
          throw new ConflictException({
            code:
              activeRevisions.length > 1
                ? "REVISION_LIFECYCLE_CORRUPT"
                : "REVISION_ALREADY_ACTIVE",
            message:
              activeRevisions.length > 1
                ? "Multiple active revisions require staff repair"
                : "Replacement content must be submitted before another revision can be requested",
          })
        }

        // Revision entitlement is immutable order-contract evidence. The live
        // ListingService may change for future buyers and is never consulted
        // for an in-flight order.
        const maxRevisions = order.revisionRoundsSnapshot
        if (!Number.isInteger(maxRevisions) || maxRevisions < 0) {
          throw new ConflictException({
            code: "REVISION_POLICY_EVIDENCE_MISSING",
            message:
              "This order is missing its immutable revision entitlement; staff review is required",
          })
        }
        if (order.revisionCount >= maxRevisions) {
          throw new BadRequestException(
            `Maximum revisions (${maxRevisions}) reached. Open a dispute if unsatisfied.`,
          )
        }

        const fresh = await this.transition(
          orderId,
          order.version,
          {
            status: "CONTENT_REQUESTED",
            revisionCount: { increment: 1 },
          },
          "CUSTOMER_REVIEW",
          tx,
        )
        await tx.revision.create({
          data: { orderId, notes: normalizedNotes, status: "REQUESTED" },
        })
        await tx.orderEvent.create({
          data: {
            orderId,
            eventType: "REVISION_REQUESTED",
            actorId: userId,
            message: `Revision requested: ${normalizedNotes}`,
            metadata: {
              revisionNumber: order.revisionCount + 1,
              notes: normalizedNotes,
            },
          },
        })
        await this.audit.log(
          {
            action: "REVISION_REQUESTED",
            entityType: "Order",
            entityId: orderId,
            metadata: {
              ...orderEventMetadata(order),
              revisionNumber: order.revisionCount + 1,
            },
            userId,
            organizationId,
          },
          tx,
        )
        if (this.communications) {
          const publisherIds = [
            ...new Set<string>(
              order.items.flatMap((item: any) =>
                typeof item.website?.publisherId === "string"
                  ? [item.website.publisherId]
                  : [],
              ),
            ),
          ]
          const recipients = [
            ...new Set<string>([
              ...(await this.communications.customerOrderRecipients(
                orderId,
                tx,
              )),
              ...(
                await Promise.all(
                  publisherIds.map((publisherId) =>
                    this.communications!.publisherRecipients(
                      publisherId,
                      false,
                      tx,
                    ),
                  ),
                )
              ).flat(),
            ]),
          ]
          const event = await this.communications.record(
            {
              type: "ORDER_REVISION_REQUESTED",
              aggregateType: "Order",
              aggregateId: orderId,
              organizationId,
              title: "Content revision requested",
              message: `A revision was requested for order ${orderId}. Review the notes and submit an updated version.`,
              actionPath: `/dashboard/orders/${orderId}`,
              dedupKey: `order:${orderId}:revision:${order.revisionCount + 1}`,
              recipientUserIds: recipients,
              actorUserId: userId,
            },
            tx,
          )
          communicationEventId = event.eventId
        }
        return fresh
      },
    )
    if (communicationEventId) {
      this.communications?.dispatchBestEffort(communicationEventId)
    }
    return updated
  }

  async confirmDelivery(
    orderId: string,
    organizationId: string,
    userId: string,
  ) {
    assertApiFinanceOperationAllowed("new_liability")
    try {
      // Authorization, cancellation state, delivery transition, and
      // settlement/revenue creation are all re-read after the canonical Order
      // lock. The helper retries only trusted serialization/deadlock errors.
      const result = await runLockedOrderSerializableTransaction(
        this.prisma,
        orderId,
        async (tx: any) => {
          const [order, membership] = await Promise.all([
            tx.order.findFirst({ where: { id: orderId, organizationId } }),
            tx.membership.findFirst({
              where: { organizationId, userId, status: "ACTIVE" },
            }),
          ])
          if (!order) throw new NotFoundException("Order not found")
          if (order.status !== "VERIFIED") {
            throw new BadRequestException(
              "Order must be VERIFIED before confirming delivery",
            )
          }
          await this.cancellation.assertNoActiveCancellation(orderId, tx)

          const isOwner = membership?.role === "OWNER"
          const isCreator = order.customerId === userId
          if (!membership || (!isOwner && !isCreator)) {
            throw new ForbiddenException(
              "Only organization owner or order creator can confirm delivery",
            )
          }
          if (!order.activeDeliveryVersionId) {
            throw new ConflictException(
              "Verified order has no active delivery. Contact support.",
            )
          }
          const fraudBlocked = await recordCustomerDeliveryFraudBlock(
            tx,
            this.audit,
            {
              action: "CONFIRM",
              orderId,
              deliveryVersionId: order.activeDeliveryVersionId,
              organizationId,
              userId,
              now: new Date(),
            },
          )
          if (fraudBlocked) return { fraudBlocked }

          const transitioned = await tx.order.updateMany({
            where: { id: orderId, version: order.version, status: "VERIFIED" },
            data: {
              status: "DELIVERED",
              deliveredAt: new Date(),
              version: { increment: 1 },
            },
          })
          if (transitioned.count === 0) {
            throw new ConflictException(
              "Order was modified by another request. Retry.",
            )
          }

          await tx.orderEvent.create({
            data: {
              orderId,
              eventType: "DELIVERY_CONFIRMED",
              actorId: userId,
              message: "Delivery confirmed by customer",
            },
          })

          await this.createSettlementForOrder(tx, orderId)
          const fresh = await tx.order.findUniqueOrThrow({
            where: { id: orderId },
          })

          await this.audit.log(
            {
              action: "DELIVERY_CONFIRMED",
              entityType: "Order",
              entityId: orderId,
              metadata: { ...orderEventMetadata(fresh) },
              userId,
              organizationId,
            },
            tx,
          )

          if (this.communications) {
            const website = fresh.websiteId
              ? await tx.website.findUnique({
                  where: { id: fresh.websiteId },
                  select: { publisherId: true },
                })
              : null
            const recipients = [
              ...new Set<string>([
                ...(await this.communications.customerOrderRecipients(
                  orderId,
                  tx,
                )),
                ...(await this.communications.publisherRecipients(
                  website?.publisherId,
                  false,
                  tx,
                )),
              ]),
            ]
            await this.communications.record(
              {
                type: "ORDER_DELIVERED",
                aggregateType: "Order",
                aggregateId: orderId,
                organizationId,
                title: "Order delivered",
                message: `Delivery for order ${orderId} was confirmed.`,
                actionPath: `/dashboard/orders/${orderId}`,
                dedupKey: `order:${orderId}:delivered`,
                recipientUserIds: recipients,
                actorUserId: userId,
              },
              tx,
            )
            if (fresh.status === "COMPLETED") {
              await this.communications.record(
                {
                  type: "ORDER_COMPLETED",
                  aggregateType: "Order",
                  aggregateId: orderId,
                  organizationId,
                  title: "Order completed",
                  message: `Order ${orderId} is complete.`,
                  actionPath: `/dashboard/orders/${orderId}`,
                  dedupKey: `order:${orderId}:completed`,
                  recipientUserIds: recipients,
                  actorUserId: userId,
                },
                tx,
              )
            }
          }

          return fresh
        },
      )
      if ("fraudBlocked" in result) {
        throw deliveryFraudReviewRequiredForCustomer()
      }
      return result
    } catch (error) {
      if (isRetryablePrismaTransactionError(error)) {
        throw new ConflictException({
          code: "ORDER_CONFIRMATION_CONCURRENCY_CONFLICT",
          message:
            "Order state changed concurrently. Refresh and retry confirmation.",
        })
      }
      throw error
    }
  }

  async createSettlementForOrder(tx: any, orderId: string) {
    // This method is also called from delivery verification. Keep the gate at
    // the shared write boundary so an internal caller cannot bypass the
    // finance-wide maintenance/incident freeze.
    assertApiFinanceOperationAllowed("new_liability")
    const eligibility = await evaluateLockedSettlementEligibility(tx, orderId)
    if (!eligibility.eligible) {
      throw new BadRequestException({
        code: "SETTLEMENT_BLOCKED",
        message: `Settlement blocked: ${eligibility.reasons.join("; ")}`,
        reasons: eligibility.reasons,
      })
    }
    const existingSettlement = await tx.settlement.findFirst({
      where: { orderId, status: { not: "CANCELLED" } },
    })
    if (existingSettlement) return

    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { website: true },
    })
    if (!order?.amount) return

    // Phase 6 snapshot resolver. Reads the order's per-service price from
    // the snapshotted ListingService (or NULL for legacy orders) so both
    // PlatformRevenue and Settlement freeze the same five fields.
    const snapshotLsId: string | null = order.listingServiceId ?? null
    let snapshotServiceType: any = order.type ?? null
    let snapshotUnitPrice: any = null
    if (order.listingServiceId) {
      const ls = await tx.listingService.findUnique({
        where: { id: order.listingServiceId },
        select: { price: true, serviceType: true },
      })
      if (ls) {
        snapshotUnitPrice = ls.price
        snapshotServiceType = ls.serviceType
      }
    }
    const snapshotOwnerType = order.website?.ownershipType ?? null

    // Platform channel orders: record platform revenue, skip settlement.
    // Channel snapshot wins; ownership fallback for legacy orders only.
    const channel =
      order.fulfillmentChannel ??
      (order.website?.ownershipType === "PLATFORM" ? "PLATFORM" : "PUBLISHER")
    if (channel === "PLATFORM") {
      // Platform recognition is never inferred from mutable Website ownership.
      // Old orders without an explicit channel require Finance review rather
      // than silently becoming new revenue evidence.
      if (order.fulfillmentChannel !== "PLATFORM") {
        throw new ConflictException({
          code: "PLATFORM_REVENUE_CHANNEL_EVIDENCE_MISSING",
          message:
            "Platform revenue requires an explicit PLATFORM order snapshot.",
        })
      }
      try {
        await assertCanonicalPlatformRevenueFundingCore(tx, order)
      } catch (error) {
        if (!(error instanceof PlatformRevenueEvidenceError)) throw error
        throw new ConflictException({
          code:
            error.code === "INVALID_PURCHASE_EVIDENCE"
              ? "PLATFORM_REVENUE_PURCHASE_EVIDENCE_INVALID"
              : "PLATFORM_REVENUE_ORDER_EVIDENCE_INVALID",
          message:
            error.code === "INVALID_PURCHASE_EVIDENCE"
              ? "Platform revenue requires one exact canonical purchase record."
              : "Platform revenue requires a paid exact-USD platform order.",
        })
      }

      const existingRevenue = await tx.platformRevenue.findUnique({
        where: { orderId },
      })
      if (existingRevenue) {
        const existingAmount = new Decimal(existingRevenue.amount)
        const existingFee = new Decimal(existingRevenue.platformFee)
        const existingNet = new Decimal(existingRevenue.netRevenue)
        const existingFeeBps = existingRevenue.platformFeeBps
        const expectedFee = Number.isInteger(existingFeeBps)
          ? existingAmount
              .mul(existingFeeBps)
              .div(10_000)
              .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
          : null
        if (
          existingRevenue.reversedAt !== null ||
          existingRevenue.currency !== "USD" ||
          existingRevenue.fulfillmentChannel !== "PLATFORM" ||
          existingFeeBps == null ||
          existingFeeBps < 0 ||
          existingFeeBps > 10_000 ||
          !existingRevenue.feePolicyVersion ||
          !existingAmount.equals(order.amount) ||
          !expectedFee?.equals(existingFee) ||
          !existingFee.plus(existingNet).equals(existingAmount)
        ) {
          throw new ConflictException({
            code: "PLATFORM_REVENUE_EVIDENCE_CONFLICT",
            message:
              "Existing platform revenue does not match the immutable order evidence.",
          })
        }
      } else {
        const feePolicy = await resolvePlatformFeePolicy(tx)
        const { fee: platformFee, net: netRevenue } = splitPlatformFee(
          order.amount,
          feePolicy.fraction,
        )

        await tx.platformRevenue.create({
          data: {
            orderId,
            amount: order.amount,
            currency: "USD",
            platformFee,
            netRevenue,
            platformFeeBps: feePolicy.basisPoints,
            feePolicyVersion: feePolicy.policyVersion,
            recordedAt: new Date(),
            // Phase 6 snapshots — frozen at recognition time.
            listingServiceId: snapshotLsId,
            serviceType: snapshotServiceType,
            ownerType: snapshotOwnerType,
            fulfillmentChannel: "PLATFORM",
            unitPrice: snapshotUnitPrice,
          },
        })
      }

      const warrantyEndsAt = order.warrantyDays
        ? new Date(
            (order.deliveredAt?.getTime() ?? Date.now()) +
              order.warrantyDays * 86_400_000,
          )
        : null
      const completed = await tx.order.updateMany({
        where: { id: orderId, status: "DELIVERED" },
        data: {
          status: "COMPLETED",
          warrantyEndsAt,
          version: { increment: 1 },
        },
      })
      if (completed.count !== 1) {
        throw new ConflictException({
          code: "PLATFORM_REVENUE_COMPLETION_CONFLICT",
          message:
            "Order state changed while platform revenue was being recorded.",
        })
      }
      if (this.communications) {
        const customerRecipients =
          await this.communications.customerOrderRecipients(orderId, tx)
        await this.communications.record(
          {
            type: "ORDER_COMPLETED",
            aggregateType: "Order",
            aggregateId: orderId,
            organizationId: order.organizationId,
            title: "Order completed",
            message: `Order ${orderId} is complete.`,
            actionPath: `/dashboard/orders/${orderId}`,
            dedupKey: `order:${orderId}:completed`,
            recipientUserIds: customerRecipients,
          },
          tx,
        )
        if (
          new Decimal(order.amount).greaterThan(
            notificationThreshold("ADMIN_HIGH_VALUE_ORDER_THRESHOLD", 500),
          )
        ) {
          const staffRecipients = await this.communications.staffRecipients(
            ["SUPER_ADMIN", "OPERATIONS", "FINANCE"],
            tx,
          )
          await this.communications.record(
            {
              type: "STAFF_HIGH_VALUE_ORDER_COMPLETED",
              aggregateType: "Order",
              aggregateId: orderId,
              organizationId: order.organizationId,
              title: "High-value order completed",
              message: `Order ${orderId} completed at ${new Decimal(order.amount).toFixed(2)} ${order.currency}.`,
              actionPath: `/dashboard/orders/${orderId}`,
              payload: {
                amount: new Decimal(order.amount).toNumber(),
                currency: order.currency,
              },
              dedupKey: `staff:order:${orderId}:high-value-completed`,
              recipientUserIds: staffRecipients,
            },
            tx,
          )
        }
      }
      return
    }

    // Publisher-owned websites: create settlement for publisher payout
    if (!order.websiteId) {
      throw new Error(
        `Order ${orderId} has no websiteId — cannot create settlement`,
      )
    }
    const website = await tx.website.findUnique({
      where: { id: order.websiteId },
      select: { publisherId: true },
    })
    if (!website) {
      throw new Error(
        `Website ${order.websiteId} not found for order ${orderId}`,
      )
    }
    if (!website.publisherId) {
      throw new Error(
        `Website ${order.websiteId} has no publisher — cannot create settlement`,
      )
    }
    const publisher = await tx.publisher.findUnique({
      where: { id: website.publisherId },
    })
    if (!publisher) return

    const feePolicy = await resolvePlatformFeePolicy(tx)
    const { fee: platformFee, net: publisherAmount } = splitPlatformFee(
      order.amount,
      feePolicy.fraction,
    )
    // Phase 7.2 — tier-aware review window (audit #6). Helper applies env
    // override when set (incident-response escape hatch); otherwise per-tier
    // table in packages/shared/src/publisher-tier-policy.ts.
    const reviewDays = getSettlementReviewDays(
      publisher.tier as PublisherTier,
      process.env.SETTLEMENT_REVIEW_DAYS,
    )
    const reviewEndsAt = new Date(Date.now() + reviewDays * 24 * 60 * 60 * 1000)

    const fraudFlags = await tx.deliveryFraudFlag.findMany({
      where: { orderId, resolution: null },
      select: { type: true },
    })
    const releasePolicy = this.decision.computeSettlementReleasePolicy(
      { verifyMethod: order.verifyMethod, amount: Number(order.amount) },
      { tier: publisher.tier },
      fraudFlags,
      null,
    )

    const settlement = await tx.settlement.create({
      data: {
        orderId,
        publisherId: publisher.id,
        grossAmount: order.amount,
        currency: "USD",
        platformFee,
        publisherAmount,
        platformFeeBps: feePolicy.basisPoints,
        feePolicyVersion: feePolicy.policyVersion,
        status: "PENDING",
        reviewEndsAt,
        releasePolicy,
        // Phase 6 snapshots — same shape as createSettlement() in
        // SettlementsService for parity.
        listingServiceId: snapshotLsId,
        serviceType: snapshotServiceType,
        ownerType: snapshotOwnerType,
        fulfillmentChannel: "PUBLISHER",
        unitPrice: snapshotUnitPrice,
      },
    })
    if (this.communications) {
      const recipients = await this.communications.publisherRecipients(
        publisher.id,
        false,
        tx,
      )
      await this.communications.record(
        {
          type: "SETTLEMENT_CREATED",
          aggregateType: "Settlement",
          aggregateId: settlement.id,
          organizationId: order.organizationId,
          title: "Settlement created",
          message: `A ${publisherAmount.toFixed(2)} ${order.currency} settlement was created for order ${orderId}.`,
          actionPath: "/dashboard/earnings",
          payload: {
            amount: publisherAmount.toString(),
            currency: order.currency,
            orderId,
          },
          dedupKey: `settlement:${settlement.id}:created`,
          recipientUserIds: recipients,
        },
        tx,
      )
    }
  }
}
