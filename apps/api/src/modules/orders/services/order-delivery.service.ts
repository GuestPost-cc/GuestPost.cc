import {
  deliveryVerificationJobId,
  lockDeliveryUrlClaim,
  normalizeUrl,
  orderEventMetadata,
  QUEUE_JOBS,
  QUEUES,
  refreshDeliveryUrlReuseEvidenceUnderLock,
  runLockedOrderSerializableTransaction,
} from "@guestpost/shared"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common"
import { PrismaService } from "../../../common/prisma.service"
import { AuditService } from "../../audit/audit.service"
import { CommunicationsService } from "../../communications/communications.service"
import { QueueService } from "../../queues/queue.service"
import {
  deliveryFraudReviewRequiredForCustomer,
  recordCustomerDeliveryFraudBlock,
} from "./delivery-fraud-guard"
import { OrderCancellationService } from "./order-cancellation.service"
import { OrderReviewService } from "./order-review.service"
import { assertOwnerOrCreator } from "./owner-or-creator"

// Rejected placeholder "deliveries" — a human typing "done" is not a delivery.
const PLACEHOLDER_VALUES = new Set([
  "done",
  "n/a",
  "na",
  "none",
  "-",
  "tbd",
  "pending",
  "complete",
  "completed",
])

@Injectable()
export class OrderDeliveryService {
  private readonly logger = new Logger(OrderDeliveryService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
    private readonly orderReview: OrderReviewService,
    private readonly cancellation: OrderCancellationService,
    @Optional() private readonly communications?: CommunicationsService,
  ) {}

  // Validate + normalize a published URL. Throws on empty/placeholder/invalid.
  private validatePublishedUrl(raw: string | undefined | null): {
    publishedUrl: string
    normalizedUrl: string
  } {
    const trimmed = (raw ?? "").trim()
    if (!trimmed) throw new BadRequestException("Published URL is required")
    if (PLACEHOLDER_VALUES.has(trimmed.toLowerCase())) {
      throw new BadRequestException(`"${trimmed}" is not a valid published URL`)
    }
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      throw new BadRequestException("Published URL must be a valid URL")
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new BadRequestException("Published URL must use http or https")
    }
    return { publishedUrl: trimmed, normalizedUrl: normalizeUrl(trimmed) }
  }

  // Create an immutable delivery version + enqueue independent verification.
  // Used by both publisher fulfillment and platform Operations — identical path.
  // `expectStatuses` guards the order state the caller transitioned from.
  async submitDelivery(
    order: {
      id: string
      version: number
      status: string
      organizationId: string
      websiteId: string | null
    },
    actorUserId: string,
    dto: {
      publishedUrl: string
      articleTitle?: string
      notes?: string
      screenshotUrl?: string
    },
    beforeCommit?: (tx: any) => Promise<void>,
  ) {
    await this.cancellation.assertNoActiveCancellation(order.id)
    const { publishedUrl, normalizedUrl } = this.validatePublishedUrl(
      dto.publishedUrl,
    )

    const version = await runLockedOrderSerializableTransaction(
      this.prisma,
      order.id,
      async (tx: any) => {
        // Cross-order URL claims use Order -> normalized URL as the canonical
        // lock order. Acceptance and settlement boundaries take the same lock,
        // closing the gap between their freshness read and protected write.
        await lockDeliveryUrlClaim(tx, normalizedUrl)

        // Next version number for this order (immutable history)
        const last = await tx.orderDeliveryVersion.findFirst({
          where: { orderId: order.id },
          orderBy: { version: "desc" },
          select: { version: true, id: true },
        })
        const nextVersion = (last?.version ?? 0) + 1

        // Supersede the prior active version (kept forever, marked superseded)
        if (last) {
          await tx.orderDeliveryVersion.update({
            where: { id: last.id },
            data: { supersededByVersion: nextVersion },
          })
        }

        const version = await tx.orderDeliveryVersion.create({
          data: {
            orderId: order.id,
            version: nextVersion,
            publishedUrl,
            normalizedUrl,
            articleTitle: dto.articleTitle ?? null,
            notes: dto.notes ?? null,
            screenshotUrl: dto.screenshotUrl ?? null,
            submittedByUserId: actorUserId,
            verificationStatus: "PENDING",
            interventionStatus: "NONE",
          },
        })

        // Optimistic-locked order transition to PUBLISHED + active pointer + mirror
        const upd = await tx.order.updateMany({
          where: { id: order.id, version: order.version },
          data: {
            status: "PUBLISHED",
            publishedUrl,
            publishedAt: new Date(),
            activeDeliveryVersionId: version.id,
            version: { increment: 1 },
          },
        })
        if (upd.count === 0)
          throw new ConflictException(
            "Order was modified by another request. Retry.",
          )

        // Platform fulfillment uses this hook to close the assignment in the
        // same transaction as publication. A reassignment, cancellation, or
        // duplicate publish racing this transaction therefore has one winner.
        await beforeCommit?.(tx)

        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            eventType: "PUBLICATION_MARKED",
            actorId: actorUserId,
            message: `Delivery v${nextVersion} submitted: ${publishedUrl}`,
            metadata: {
              publishedUrl,
              version: nextVersion,
              deliveryVersionId: version.id,
            },
          },
        })

        await this.audit.log(
          {
            action: "ORDER_DELIVERY_SUBMITTED",
            entityType: "OrderDeliveryVersion",
            entityId: version.id,
            metadata: {
              ...orderEventMetadata(order),
              orderId: order.id,
              deliveryVersionId: version.id,
              version: nextVersion,
              publishedUrl,
              submittedByUserId: actorUserId,
            },
            userId: actorUserId,
            organizationId: order.organizationId,
          },
          tx,
        )

        if (this.communications) {
          const current = await tx.order.findUnique({
            where: { id: order.id },
            select: { website: { select: { publisherId: true } } },
          })
          const recipients = [
            ...new Set<string>([
              ...(await this.communications.customerOrderRecipients(
                order.id,
                tx,
              )),
              ...(await this.communications.publisherRecipients(
                current?.website?.publisherId,
                false,
                tx,
              )),
            ]),
          ]
          await this.communications.record(
            {
              type: "ORDER_PUBLISHED",
              aggregateType: "Order",
              aggregateId: order.id,
              organizationId: order.organizationId,
              title: "Order published",
              message: `A published delivery is ready for order ${order.id}.`,
              actionPath: `/dashboard/orders/${order.id}`,
              dedupKey: `order:${order.id}:published:${version.id}`,
              recipientUserIds: recipients,
              actorUserId,
            },
            tx,
          )
        }

        return version
      },
    )
    this.communications?.dispatchByDedupKeyBestEffort(
      `order:${order.id}:published:${version.id}`,
    )

    // Redis is an external durability boundary and must not run inside the
    // retryable database closure. A deterministic jobId makes a caller retry
    // safe if Redis accepted the first enqueue but its response was lost.
    try {
      await this.queue.addJob(
        QUEUES.DELIVERY_VERIFICATION,
        QUEUE_JOBS[QUEUES.DELIVERY_VERIFICATION].VERIFY,
        {
          deliveryVersionId: version.id,
          verificationVersion: version.verificationVersion,
          actorUserId,
        },
        {
          jobId: deliveryVerificationJobId(
            version.id,
            version.verificationVersion,
          ),
          attempts: 3,
          backoff: { type: "custom" },
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 100 },
        },
      )
    } catch (error) {
      this.logger.error(
        `Delivery ${version.id} committed but verification enqueue failed; the dispatch sweep will recover it`,
        error instanceof Error ? error.stack : String(error),
      )
      throw new ServiceUnavailableException({
        code: "DELIVERY_VERIFICATION_ENQUEUE_FAILED",
        message:
          "Delivery was saved, but immediate verification dispatch failed. The recovery sweep will retry automatically.",
        deliveryVersionId: version.id,
      })
    }

    return version
  }

  async listDeliveries(orderId: string) {
    return this.prisma.orderDeliveryVersion.findMany({
      where: { orderId },
      orderBy: { version: "desc" },
      include: {
        evidence: { orderBy: { createdAt: "desc" }, take: 1 },
        snapshots: true,
        fraudFlags: { include: { resolution: true } },
      },
    })
  }

  // Customer-safe delivery proof — verification results as booleans, no internal
  // evidence (HTML hashes, object keys, fraud flags stay staff-only).
  async deliveryProof(
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
      include: {
        website: { select: { ownershipType: true } },
        fraudHolds: {
          select: {
            fraudFlag: { select: { finding: { select: { id: true } } } },
          },
        },
      },
    })
    if (!order) throw new NotFoundException("Order not found")
    const securityReview =
      order.fraudHolds.length > 0
        ? {
            status: order.fraudHolds.some((hold: any) => hold.fraudFlag.finding)
              ? ("CONFIRMED_ACTION_REQUIRED" as const)
              : ("UNDER_REVIEW" as const),
          }
        : null
    const unavailableDelivery = {
      hasDelivery: false as const,
      securityReview,
      capabilities: {
        canConfirm: false,
        canManualAccept: false,
        blockedReason: !access.organizationId
          ? null
          : securityReview
            ? ("SECURITY_REVIEW" as const)
            : ("NO_DELIVERY" as const),
      },
    }
    if (!order.activeDeliveryVersionId) return unavailableDelivery
    const version = await this.prisma.orderDeliveryVersion.findUnique({
      where: { id: order.activeDeliveryVersionId },
      include: { evidence: { orderBy: { createdAt: "desc" }, take: 1 } },
    })
    if (!version) return unavailableDelivery
    const ev = version.evidence[0]
    const isCustomer = Boolean(access.organizationId)
    const canConfirm =
      isCustomer &&
      !securityReview &&
      order.status === "VERIFIED" &&
      version.verificationStatus === "VERIFIED"
    const canManualAccept =
      isCustomer &&
      !securityReview &&
      order.status === "PUBLISHED" &&
      ["FAILED", "MANUAL_REVIEW"].includes(version.verificationStatus)
    return {
      hasDelivery: true,
      publishedUrl: version.publishedUrl,
      articleTitle: version.articleTitle,
      screenshotUrl: version.screenshotUrl,
      verificationStatus: version.verificationStatus,
      interventionStatus: version.interventionStatus,
      submittedAt: version.submittedAt,
      deliveredBy:
        (order.fulfillmentChannel ??
          (order.website?.ownershipType === "PLATFORM"
            ? "PLATFORM"
            : "PUBLISHER")) === "PLATFORM"
          ? "Platform"
          : "Publisher",
      verifyMethod: order.verifyMethod ?? null,
      autoAcceptAt: order.autoAcceptAt ?? null,
      verifiedAt: order.verifiedAt,
      pageTitle: ev?.pageTitle ?? null,
      results: ev
        ? {
            urlReachable: ev.httpStatus >= 200 && ev.httpStatus < 400,
            linkFound: ev.linkFound,
            targetUrlMatched: ev.targetUrlMatched,
            anchorVerified: ev.anchorFound,
            verifiedAnchorText: ev.verifiedAnchorText,
            checkedAt: ev.checkedAt,
          }
        : null,
      securityReview,
      capabilities: {
        canConfirm,
        canManualAccept,
        blockedReason: !isCustomer
          ? null
          : securityReview
            ? ("SECURITY_REVIEW" as const)
            : canConfirm || canManualAccept
              ? null
              : ["PENDING", "RETRYING"].includes(version.verificationStatus)
                ? ("VERIFICATION_PENDING" as const)
                : ("WRONG_STATUS" as const),
      },
    }
  }

  // Customer manual acceptance — a SECONDARY fallback. The automated system
  // check is always authoritative: this is only allowed when auto verification
  // FAILED or needs MANUAL_REVIEW. A VERIFIED delivery uses Confirm Delivery
  // instead; a still-running check must be waited out. Accepting completes the
  // order (DELIVERED) so settlement can proceed.
  async customerAcceptDelivery(
    orderId: string,
    organizationId: string,
    userId: string,
    actorRole?: string | null,
  ) {
    const result = await runLockedOrderSerializableTransaction(
      this.prisma,
      orderId,
      async (tx: any) => {
        // Keep retry-attempt state inside the callback. Only keys returned by
        // the committed SERIALIZABLE attempt may be dispatched after commit.
        const communicationDedupKeys = new Set<string>()
        const [order, membership] = await Promise.all([
          tx.order.findFirst({
            where: { id: orderId, organizationId },
            include: { website: { select: { publisherId: true } } },
          }),
          tx.membership.findFirst({
            where: { organizationId, userId, status: "ACTIVE" },
            select: { role: true },
          }),
        ])
        if (!order) throw new NotFoundException("Order not found")
        if (!membership) {
          throw new ForbiddenException(
            "An active organization membership is required to accept delivery",
          )
        }
        // A customer manual approval is money-adjacent. Revalidate creator or
        // owner authority only after taking the canonical Order lock.
        assertOwnerOrCreator({
          customerId: order.customerId,
          actorUserId: userId,
          actorRole: membership.role ?? actorRole,
          action: "accept delivery",
        })
        if (!order.activeDeliveryVersionId) {
          throw new BadRequestException("There is no delivery to accept yet")
        }
        const v = await tx.orderDeliveryVersion.findUnique({
          where: { id: order.activeDeliveryVersionId },
        })
        if (!v || v.orderId !== order.id || v.supersededByVersion != null) {
          throw new ConflictException(
            "Active delivery changed. Refresh before accepting.",
          )
        }
        if (v.verificationStatus === "VERIFIED") {
          throw new BadRequestException(
            "This delivery passed automated verification — use Confirm Delivery.",
          )
        }
        if (!["FAILED", "MANUAL_REVIEW"].includes(v.verificationStatus)) {
          throw new BadRequestException(
            "Automated verification is still running — please wait for it to finish.",
          )
        }
        if (order.status !== "PUBLISHED") {
          throw new BadRequestException(
            "Order is not awaiting delivery confirmation",
          )
        }
        await this.cancellation.assertNoActiveCancellation(orderId, tx)

        const now = new Date()
        const urlReuseFreshness =
          await refreshDeliveryUrlReuseEvidenceUnderLock(tx, {
            orderId,
            deliveryVersionId: v.id,
            normalizedUrl: v.normalizedUrl,
            organizationId,
            actorUserId: userId,
            source: "CUSTOMER_MANUAL_ACCEPT",
          })
        const fraudBlocked = await recordCustomerDeliveryFraudBlock(
          tx,
          this.audit,
          {
            action: "MANUAL_ACCEPT",
            orderId,
            deliveryVersionId: v.id,
            organizationId,
            userId,
            now,
          },
        )
        if (fraudBlocked || urlReuseFreshness.requiresReview) {
          return {
            fraudBlocked: fraudBlocked ?? {
              blocked: true as const,
              count: 1,
            },
            communicationDedupKeys: urlReuseFreshness.communicationDedupKey
              ? [urlReuseFreshness.communicationDedupKey]
              : [],
          }
        }

        const upd = await tx.orderDeliveryVersion.updateMany({
          where: { id: v.id, verificationVersion: v.verificationVersion },
          data: {
            interventionStatus: "APPROVED",
            verificationFailureReason: null,
            verificationVersion: v.verificationVersion + 1,
          },
        })
        if (upd.count === 0)
          throw new ConflictException(
            "Delivery was modified by another request. Retry.",
          )

        const ordUpd = await tx.order.updateMany({
          where: { id: order.id, version: order.version, status: "PUBLISHED" },
          data: {
            status: "DELIVERED",
            deliveredAt: now,
            verifiedAt: now,
            verifiedBy: userId,
            verifyMethod: "CUSTOMER_MANUAL",
            deliveryAcceptedMethod: "CUSTOMER",
            version: { increment: 1 },
          },
        })
        if (ordUpd.count === 0)
          throw new ConflictException(
            "Order was modified by another request. Retry.",
          )

        await tx.orderEvent.create({
          data: {
            orderId,
            eventType: "DELIVERY_CONFIRMED",
            actorId: userId,
            message:
              "Customer manually accepted the delivery after the automated check could not verify it",
            metadata: {
              priorVerification: v.verificationStatus,
              deliveryVersionId: v.id,
            },
          },
        })
        await this.audit.log(
          {
            action: "ORDER_DELIVERY_CUSTOMER_ACCEPTED",
            entityType: "OrderDeliveryVersion",
            entityId: v.id,
            metadata: {
              ...orderEventMetadata(order),
              orderId,
              publishedUrl: v.publishedUrl,
              priorVerification: v.verificationStatus,
              publisherId: order.website?.publisherId ?? null,
            },
            userId,
            organizationId,
          },
          tx,
        )

        // Create settlement with computed release policy — same as the
        // confirmDelivery path uses via OrderReviewService.
        const settlementCommunicationDedupKeys =
          (await this.orderReview.createSettlementForOrder(tx, orderId)) ?? []
        for (const dedupKey of settlementCommunicationDedupKeys) {
          communicationDedupKeys.add(dedupKey)
        }
        const completed = await tx.order.findUniqueOrThrow({
          where: { id: orderId },
          select: { status: true },
        })

        if (this.communications) {
          const recipients = [
            ...new Set<string>([
              ...(await this.communications.customerOrderRecipients(
                orderId,
                tx,
              )),
              ...(await this.communications.publisherRecipients(
                order.website?.publisherId,
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
              message: `Delivery for order ${orderId} was accepted.`,
              actionPath: `/dashboard/orders/${orderId}`,
              dedupKey: `order:${orderId}:delivered`,
              recipientUserIds: recipients,
              actorUserId: userId,
            },
            tx,
          )
          communicationDedupKeys.add(`order:${orderId}:delivered`)
          if (completed.status === "COMPLETED") {
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
            communicationDedupKeys.add(`order:${orderId}:completed`)
          }
        }

        return {
          value: { status: completed.status, acceptedBy: "customer" },
          communicationDedupKeys: [...communicationDedupKeys],
        }
      },
    )
    this.communications?.dispatchManyByDedupKeyBestEffort(
      result.communicationDedupKeys,
    )
    if ("fraudBlocked" in result) {
      this.logger.warn(
        `Blocked customer delivery acceptance pending fraud review: order=${orderId} user=${userId}`,
      )
      throw deliveryFraudReviewRequiredForCustomer()
    }
    return result.value
  }

  async getDelivery(id: string) {
    const v = await this.prisma.orderDeliveryVersion.findUnique({
      where: { id },
      include: {
        evidence: { orderBy: { createdAt: "desc" } },
        snapshots: true,
        fraudFlags: { include: { resolution: true } },
      },
    })
    if (!v) throw new NotFoundException("Delivery version not found")
    return v
  }
}
