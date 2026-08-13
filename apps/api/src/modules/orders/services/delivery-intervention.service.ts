import {
  deliveryVerificationJobId,
  isUniqueViolation,
  notificationDedupKey,
  orderEventMetadata,
  QUEUE_JOBS,
  QUEUES,
  runLockedOrderSerializableTransaction,
  WorkflowDecisionService,
} from "@guestpost/shared"
import { presignGet } from "@guestpost/shared/dist/object-storage"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common"
import { PrismaService } from "../../../common/prisma.service"
import { AuditService } from "../../audit/audit.service"
import { QueueService } from "../../queues/queue.service"
import {
  DELIVERY_FRAUD_DISPOSITIONS,
  type DeliveryFraudDisposition,
} from "../dto/delivery-intervention.dto"
import { assertNoUnresolvedDeliveryFraudHolds } from "./delivery-fraud-guard"
import { assertCurrentStaffAuthority } from "./staff-authority"

const MIN_REASON = 20
const FRAUD_RESOLVER_ROLES = new Set(["SUPER_ADMIN", "OPERATIONS", "FINANCE"])
const FINANCIALLY_TERMINAL_ORDER_STATUSES = new Set([
  "DELIVERED",
  "COMPLETED",
  "CANCELLED",
  "REFUNDED",
])

// Manual intervention + evidence retrieval for deliveries. All transitions are
// optimistic-lock guarded, require a substantive reason, and are audited +
// notified. Override is SUPER_ADMIN-only.
@Injectable()
export class DeliveryInterventionService {
  private readonly logger = new Logger(DeliveryInterventionService.name)
  private readonly decision = new WorkflowDecisionService()

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  private requireReason(reason: string | undefined) {
    if (!reason || reason.trim().length < MIN_REASON) {
      throw new BadRequestException(
        `A reason of at least ${MIN_REASON} characters is required`,
      )
    }
    if (reason.trim().length > 1000) {
      throw new BadRequestException("Reason must be 1,000 characters or fewer")
    }
    return reason.trim()
  }

  private async assertDeliveryEvidenceMutable(
    tx: any,
    orderId: string,
    action: string,
  ) {
    const currentOrder = await tx.order.findUnique({
      where: { id: orderId },
      select: { status: true },
    })
    if (!currentOrder) throw new NotFoundException("Order not found")
    if (FINANCIALLY_TERMINAL_ORDER_STATUSES.has(currentOrder.status)) {
      throw new BadRequestException(
        `Cannot ${action} delivery evidence after the order is financially final`,
      )
    }
    return currentOrder
  }

  private async loadVersionWithOrder(deliveryVersionId: string) {
    const version = await this.prisma.orderDeliveryVersion.findUnique({
      where: { id: deliveryVersionId },
    })
    if (!version) throw new NotFoundException("Delivery version not found")
    const order = await this.prisma.order.findUnique({
      where: { id: version.orderId },
      include: { website: { select: { publisherId: true } } },
    })
    if (!order) throw new NotFoundException("Order not found")
    return { version, order }
  }

  private async loadActiveVersionUnderLock(
    tx: any,
    orderId: string,
    deliveryVersionId: string,
    expectedVerificationVersion: number,
  ) {
    const [currentOrder, currentVersion] = await Promise.all([
      tx.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          status: true,
          version: true,
          activeDeliveryVersionId: true,
        },
      }),
      tx.orderDeliveryVersion.findUnique({
        where: { id: deliveryVersionId },
        select: {
          id: true,
          orderId: true,
          verificationStatus: true,
          verificationVersion: true,
          supersededByVersion: true,
        },
      }),
    ])
    if (!currentOrder || !currentVersion) {
      throw new NotFoundException("Order or delivery version not found")
    }
    if (
      currentOrder.activeDeliveryVersionId !== deliveryVersionId ||
      currentVersion.orderId !== orderId ||
      currentVersion.supersededByVersion != null
    ) {
      throw new ConflictException(
        "Delivery is no longer the active version. Refresh before intervening.",
      )
    }
    if (currentVersion.verificationVersion !== expectedVerificationVersion) {
      throw new ConflictException(
        "Delivery was modified by another request. Refresh and retry.",
      )
    }
    return { currentOrder, currentVersion }
  }

  /**
   * Adjudicate one immutable fraud flag without changing Order or delivery
   * lifecycle state. The database independently revalidates role-at-time and
   * deletes only the matching current-hold projection.
   */
  async resolveFraudFlag(
    fraudFlagId: string,
    userId: string,
    role: string,
    reason: string,
    disposition: DeliveryFraudDisposition,
    evidenceReference?: string,
  ) {
    const r = this.requireReason(reason)
    if (!DELIVERY_FRAUD_DISPOSITIONS.includes(disposition)) {
      throw new BadRequestException("Invalid delivery fraud disposition")
    }
    const normalizedEvidenceReference = evidenceReference?.trim() || null
    if (
      normalizedEvidenceReference &&
      normalizedEvidenceReference.length > 200
    ) {
      throw new BadRequestException(
        "Evidence reference must be 200 characters or fewer",
      )
    }
    if (disposition !== "FALSE_POSITIVE" && !normalizedEvidenceReference) {
      throw new BadRequestException(
        "An evidence or case reference is required when authorizing or accepting delivery risk",
      )
    }
    if (!FRAUD_RESOLVER_ROLES.has(role)) {
      throw new ForbiddenException(
        "Only authorized staff may resolve delivery fraud holds",
      )
    }

    const candidate = await this.prisma.deliveryFraudFlag.findUnique({
      where: { id: fraudFlagId },
      select: { orderId: true },
    })
    if (!candidate) throw new NotFoundException("Fraud flag not found")

    return runLockedOrderSerializableTransaction(
      this.prisma,
      candidate.orderId,
      async (tx: any) => {
        const [flag, order] = await Promise.all([
          tx.deliveryFraudFlag.findUnique({
            where: { id: fraudFlagId },
            include: { resolution: true },
          }),
          tx.order.findUnique({
            where: { id: candidate.orderId },
            include: { website: { select: { publisherId: true } } },
          }),
        ])
        if (!flag || flag.orderId !== candidate.orderId) {
          throw new NotFoundException("Fraud flag not found")
        }
        if (!order) throw new NotFoundException("Order not found")
        const currentRole = await assertCurrentStaffAuthority(
          tx,
          userId,
          role,
          [...FRAUD_RESOLVER_ROLES],
        )
        if (flag.resolution) {
          return {
            status: "ALREADY_RESOLVED",
            fraudFlagId,
            resolutionId: flag.resolution.id,
          }
        }
        if (
          disposition !== "FALSE_POSITIVE" &&
          currentRole !== "SUPER_ADMIN" &&
          currentRole !== "FINANCE"
        ) {
          throw new ForbiddenException(
            "Only Finance or Super Admin may accept or authorize a known delivery risk",
          )
        }
        if (disposition === "AUTHORIZED_REUSE" && flag.type !== "URL_REUSED") {
          throw new BadRequestException(
            "AUTHORIZED_REUSE applies only to a URL_REUSED fraud signal",
          )
        }

        const resolution = await tx.deliveryFraudFlagResolution.create({
          data: {
            fraudFlagId,
            orderId: flag.orderId,
            deliveryVersionId: flag.deliveryVersionId,
            kind: "STAFF_CLEARED",
            reason: r,
            resolvedByUserId: userId,
            resolvedByRole: currentRole,
            evidence: {
              activeDeliveryVersionId: order.activeDeliveryVersionId,
              adjudicatedDeliveryVersionId: flag.deliveryVersionId,
              fraudType: flag.type,
              disposition,
              evidenceReference: normalizedEvidenceReference,
              orderStatusAtResolution: order.status,
              roleAtTime: currentRole,
            },
          },
        })
        await this.audit.log(
          {
            action: "ORDER_DELIVERY_FRAUD_RESOLVED",
            entityType: "DeliveryFraudFlag",
            entityId: fraudFlagId,
            metadata: {
              ...orderEventMetadata(order),
              fraudFlagId,
              fraudDeliveryVersionId: flag.deliveryVersionId,
              fraudType: flag.type,
              resolutionId: resolution.id,
              resolutionKind: "STAFF_CLEARED",
              disposition,
              evidenceReference: normalizedEvidenceReference,
              reason: r,
              roleAtTime: currentRole,
            },
            userId,
            organizationId: order.organizationId,
          },
          tx,
        )
        return {
          status: "RESOLVED",
          fraudFlagId,
          resolutionId: resolution.id,
        }
      },
    )
  }

  // Phase 6.9 — Audit finding #4 closure. The legacy `auditMeta` helper has
  // been retired in favor of `orderEventMetadata` from @guestpost/shared. The
  // shared helper supplies the Phase 6 snapshot trio uniformly across every
  // money-audit callsite; the delivery-specific extras (deliveryVersionId,
  // publishedUrl, publisherId) are appended on top. Reports that group audit
  // rows by serviceType / fulfillmentChannel / listingServiceId now see this
  // surface consistently.
  private deliveryAuditMeta(
    order: any,
    version: any,
    extra: Record<string, unknown> = {},
  ) {
    return {
      ...orderEventMetadata(order),
      orderId: order.id,
      deliveryVersionId: version.id,
      publisherId: order.website?.publisherId ?? null,
      publishedUrl: version.publishedUrl,
      ...extra,
    }
  }

  // Phase 7.4 (audit #12) — `deliveryVersionId` flows in so we can key the
  // dedup uniquely per (version, recipient). A worker retry of the same
  // delivery decision writes the row once.
  private async notifyOrderParties(
    order: any,
    deliveryVersionId: string,
    type: string,
    message: string,
  ) {
    const ids = new Set<string>([order.customerId])
    if (order.website?.publisherId) {
      const owners = await this.prisma.publisherMembership.findMany({
        where: {
          publisherId: order.website.publisherId,
          role: "PUBLISHER_OWNER",
        },
        select: { userId: true },
      })
      owners.forEach((o: any) => ids.add(o.userId))
    }
    for (const userId of ids) {
      const dedupKey = notificationDedupKey.deliveryManual(
        deliveryVersionId,
        userId,
      )
      try {
        await this.prisma.notification.create({
          data: {
            userId,
            organizationId: order.organizationId,
            type,
            message,
            dedupKey,
          },
        })
      } catch (err) {
        // P2002 = already notified for this (version, user). Idempotent retry.
        if (!isUniqueViolation(err)) {
          // swallow other errors as before — notification is best-effort
        }
      }
    }
  }

  // FAILED | MANUAL_REVIEW -> APPROVED (treated as verified for settlement).
  async manualApprove(
    deliveryVersionId: string,
    userId: string,
    role: string,
    reason: string,
    context?: {
      overrideReason?:
        | "CRAWLER_BLOCKED"
        | "ROBOTS_TXT"
        | "LOGIN_REQUIRED"
        | "JS_RENDERING"
        | "TEMPORARY_FAILURE"
        | "OTHER"
      notes?: string
    },
  ) {
    const r = this.requireReason(reason)
    const now = new Date()
    const autoAcceptAt = new Date(
      now.getTime() +
        this.decision.computeReviewWindowDays() * 24 * 60 * 60 * 1000,
    )
    const { version, order } =
      await this.loadVersionWithOrder(deliveryVersionId)
    if (!["FAILED", "MANUAL_REVIEW"].includes(version.verificationStatus)) {
      throw new BadRequestException(
        `Only FAILED or MANUAL_REVIEW deliveries can be manually approved (is ${version.verificationStatus})`,
      )
    }
    await runLockedOrderSerializableTransaction(
      this.prisma,
      order.id,
      async (tx: any) => {
        const currentRole = await assertCurrentStaffAuthority(
          tx,
          userId,
          role,
          ["SUPER_ADMIN", "OPERATIONS"],
        )
        const { currentOrder, currentVersion } =
          await this.loadActiveVersionUnderLock(
            tx,
            order.id,
            version.id,
            version.verificationVersion,
          )
        if (
          !["FAILED", "MANUAL_REVIEW"].includes(
            currentVersion.verificationStatus,
          ) ||
          currentOrder.status !== "PUBLISHED"
        ) {
          throw new ConflictException(
            "Delivery or order state changed. Refresh before approving.",
          )
        }
        await assertNoUnresolvedDeliveryFraudHolds(tx, order.id)
        const upd = await tx.orderDeliveryVersion.updateMany({
          where: {
            id: version.id,
            orderId: order.id,
            supersededByVersion: null,
            verificationVersion: version.verificationVersion,
          },
          data: {
            interventionStatus: "APPROVED",
            verificationFailureReason: null,
            verificationVersion: version.verificationVersion + 1,
            adminVerifiedById: userId,
            adminOverrideReason: context?.overrideReason ?? null,
            adminVerifiedNotes: context?.notes?.trim() || null,
          },
        })
        if (upd.count === 0) {
          throw new ConflictException(
            "Delivery was modified by another request. Retry.",
          )
        }

        const orderUpdate = await tx.order.updateMany({
          where: {
            id: order.id,
            status: "PUBLISHED",
            version: currentOrder.version,
            activeDeliveryVersionId: version.id,
          },
          data: {
            status: "VERIFIED",
            verifiedAt: now,
            verifiedBy: userId,
            verifyMethod: "MANUAL_ADMIN",
            autoAcceptAt,
            version: { increment: 1 },
          },
        })
        if (orderUpdate.count === 0) {
          throw new ConflictException(
            "Order was modified by another request. Refresh and retry.",
          )
        }

        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            eventType: "VERIFIED_MANUAL",
            actorId: userId,
            message: "Delivery manually verified by staff",
            metadata: {
              deliveryVersionId: version.id,
              reason: r,
              overrideReason: context?.overrideReason ?? null,
              notes: context?.notes?.trim() || null,
              autoAcceptAt: autoAcceptAt.toISOString(),
            },
          },
        })
        await this.audit.log(
          {
            action: "ORDER_DELIVERY_MANUAL_APPROVED",
            entityType: "OrderDeliveryVersion",
            entityId: version.id,
            metadata: this.deliveryAuditMeta(order, version, {
              reason: r,
              roleAtTime: currentRole,
              overrideReason: context?.overrideReason ?? null,
              notes: context?.notes?.trim() || null,
              autoAcceptAt: autoAcceptAt.toISOString(),
            }),
            userId,
            organizationId: order.organizationId,
          },
          tx,
        )
      },
    )
    await this.notifyOrderParties(
      order,
      version.id,
      "ORDER_DELIVERY_MANUAL_APPROVED",
      `Delivery for order ${order.id} was manually approved.`,
    )
    return {
      status: "VERIFIED",
      interventionStatus: "APPROVED",
      verifyMethod: "MANUAL_ADMIN",
      autoAcceptAt,
    }
  }

  async manualReject(
    deliveryVersionId: string,
    userId: string,
    role: string,
    reason: string,
  ) {
    const r = this.requireReason(reason)
    const { version, order } =
      await this.loadVersionWithOrder(deliveryVersionId)
    await runLockedOrderSerializableTransaction(
      this.prisma,
      order.id,
      async (tx: any) => {
        const currentRole = await assertCurrentStaffAuthority(
          tx,
          userId,
          role,
          ["SUPER_ADMIN", "OPERATIONS"],
        )
        await this.loadActiveVersionUnderLock(
          tx,
          order.id,
          version.id,
          version.verificationVersion,
        )
        const mutableOrder = await this.assertDeliveryEvidenceMutable(
          tx,
          order.id,
          "reject",
        )
        if (mutableOrder.status !== "PUBLISHED") {
          throw new ConflictException(
            "Only a published delivery awaiting verification can be rejected.",
          )
        }
        const upd = await tx.orderDeliveryVersion.updateMany({
          where: {
            id: version.id,
            orderId: order.id,
            supersededByVersion: null,
            verificationVersion: version.verificationVersion,
          },
          data: {
            interventionStatus: "REJECTED",
            verificationFailureReason: r,
            verificationVersion: version.verificationVersion + 1,
          },
        })
        if (upd.count === 0) {
          throw new ConflictException(
            "Delivery was modified by another request. Retry.",
          )
        }
        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            eventType: "VERIFICATION_ESCALATED",
            actorId: userId,
            message: "Delivery rejected during manual verification",
            metadata: { deliveryVersionId: version.id, reason: r },
          },
        })
        await this.audit.log(
          {
            action: "ORDER_DELIVERY_MANUAL_REJECTED",
            entityType: "OrderDeliveryVersion",
            entityId: version.id,
            metadata: this.deliveryAuditMeta(order, version, {
              reason: r,
              roleAtTime: currentRole,
            }),
            userId,
            organizationId: order.organizationId,
          },
          tx,
        )
      },
    )
    await this.notifyOrderParties(
      order,
      version.id,
      "ORDER_DELIVERY_MANUAL_REJECTED",
      `Delivery for order ${order.id} was rejected: ${r}`,
    )
    return { status: "REJECTED" }
  }

  // SUPER_ADMIN-only flip FAILED<->VERIFIED.
  async override(
    deliveryVersionId: string,
    userId: string,
    role: string,
    targetStatus: "VERIFIED" | "FAILED",
    reason: string,
  ) {
    if (role !== "SUPER_ADMIN")
      throw new ForbiddenException("Only SUPER_ADMIN may override verification")
    const r = this.requireReason(reason)
    if (!["VERIFIED", "FAILED"].includes(targetStatus))
      throw new BadRequestException(
        "Override target must be VERIFIED or FAILED",
      )
    const { version, order } =
      await this.loadVersionWithOrder(deliveryVersionId)
    const now = new Date()
    const autoAcceptAt = new Date(
      now.getTime() +
        this.decision.computeReviewWindowDays() * 24 * 60 * 60 * 1000,
    )

    await runLockedOrderSerializableTransaction(
      this.prisma,
      order.id,
      async (tx: any) => {
        const currentRole = await assertCurrentStaffAuthority(
          tx,
          userId,
          role,
          ["SUPER_ADMIN"],
        )
        if (targetStatus === "FAILED") {
          await this.assertDeliveryEvidenceMutable(tx, order.id, "override")
        }
        const { currentOrder } = await this.loadActiveVersionUnderLock(
          tx,
          order.id,
          version.id,
          version.verificationVersion,
        )
        if (
          (targetStatus === "VERIFIED" &&
            currentOrder.status !== "PUBLISHED") ||
          (targetStatus === "FAILED" && currentOrder.status !== "VERIFIED")
        ) {
          throw new ConflictException(
            "Order state changed. Refresh before overriding verification.",
          )
        }
        if (targetStatus === "VERIFIED") {
          await assertNoUnresolvedDeliveryFraudHolds(tx, order.id)
        }
        const upd = await tx.orderDeliveryVersion.updateMany({
          where: {
            id: version.id,
            orderId: order.id,
            supersededByVersion: null,
            verificationVersion: version.verificationVersion,
          },
          data: {
            verificationStatus: targetStatus,
            interventionStatus: "OVERRIDDEN",
            verificationFailureReason: targetStatus === "FAILED" ? r : null,
            verificationVersion: version.verificationVersion + 1,
          },
        })
        if (upd.count === 0) {
          throw new ConflictException(
            "Delivery was modified by another request. Retry.",
          )
        }

        if (targetStatus === "VERIFIED") {
          const orderUpdate = await tx.order.updateMany({
            where: {
              id: order.id,
              status: "PUBLISHED",
              version: currentOrder.version,
              activeDeliveryVersionId: version.id,
            },
            data: {
              status: "VERIFIED",
              verifiedAt: now,
              verifiedBy: userId,
              verifyMethod: "MANUAL_ADMIN",
              autoAcceptAt,
              version: { increment: 1 },
            },
          })
          if (orderUpdate.count === 0) {
            throw new ConflictException(
              "Order was modified by another request. Refresh and retry.",
            )
          }
        } else if (currentOrder.status === "VERIFIED") {
          const orderUpdate = await tx.order.updateMany({
            where: {
              id: order.id,
              status: "VERIFIED",
              version: currentOrder.version,
              activeDeliveryVersionId: version.id,
            },
            data: {
              status: "PUBLISHED",
              verifiedAt: null,
              verifiedBy: null,
              verifyMethod: null,
              autoAcceptAt: null,
              version: { increment: 1 },
            },
          })
          if (orderUpdate.count === 0) {
            throw new ConflictException(
              "Order was modified by another request. Refresh and retry.",
            )
          }
        }

        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            eventType:
              targetStatus === "VERIFIED"
                ? "VERIFIED_MANUAL"
                : "VERIFICATION_ESCALATED",
            actorId: userId,
            message:
              targetStatus === "VERIFIED"
                ? "Delivery verification overridden to verified"
                : "Delivery verification overridden to failed",
            metadata: {
              deliveryVersionId: version.id,
              reason: r,
              targetStatus,
            },
          },
        })
        await this.audit.log(
          {
            action: "ORDER_DELIVERY_OVERRIDDEN",
            entityType: "OrderDeliveryVersion",
            entityId: version.id,
            metadata: this.deliveryAuditMeta(order, version, {
              reason: r,
              targetStatus,
              roleAtTime: currentRole,
            }),
            userId,
            organizationId: order.organizationId,
          },
          tx,
        )
      },
    )
    await this.notifyOrderParties(
      order,
      version.id,
      "ORDER_DELIVERY_OVERRIDDEN",
      `Delivery for order ${order.id} verification was overridden to ${targetStatus}.`,
    )
    return { status: targetStatus }
  }

  // Re-run automated verification (staff). Resets to PENDING + re-enqueues.
  async reverify(deliveryVersionId: string, userId: string, role: string) {
    const { version, order } =
      await this.loadVersionWithOrder(deliveryVersionId)
    if (version.supersededByVersion != null)
      throw new BadRequestException("Cannot re-verify a superseded delivery")
    await runLockedOrderSerializableTransaction(
      this.prisma,
      order.id,
      async (tx: any) => {
        await assertCurrentStaffAuthority(tx, userId, role, [
          "SUPER_ADMIN",
          "OPERATIONS",
        ])
        const mutableOrder = await this.assertDeliveryEvidenceMutable(
          tx,
          order.id,
          "re-verify",
        )
        if (mutableOrder.status !== "PUBLISHED") {
          throw new ConflictException(
            "Only a published delivery awaiting verification can be re-verified.",
          )
        }
        const currentVersion = await tx.orderDeliveryVersion.findUnique({
          where: { id: version.id },
          select: { supersededByVersion: true },
        })
        if (!currentVersion) {
          throw new NotFoundException("Delivery version not found")
        }
        if (currentVersion.supersededByVersion != null) {
          throw new BadRequestException(
            "Cannot re-verify a superseded delivery",
          )
        }
        const updated = await tx.orderDeliveryVersion.updateMany({
          where: {
            id: version.id,
            verificationVersion: version.verificationVersion,
            supersededByVersion: null,
          },
          data: {
            verificationStatus: "PENDING",
            interventionStatus: "NONE",
            verificationFailureReason: null,
            verificationVersion: version.verificationVersion + 1,
            adminVerifiedById: null,
            adminOverrideReason: null,
            adminVerifiedNotes: null,
          },
        })
        if (updated.count === 0) {
          throw new ConflictException(
            "Delivery was modified by another request. Retry.",
          )
        }
        await this.audit.log(
          {
            action: "ORDER_DELIVERY_VERIFICATION_STARTED",
            entityType: "OrderDeliveryVersion",
            entityId: version.id,
            metadata: this.deliveryAuditMeta(order, version, {
              reverify: true,
            }),
            userId,
            organizationId: order.organizationId,
          },
          tx,
        )
      },
    )
    const nextVerificationVersion = version.verificationVersion + 1
    try {
      await this.queue.addJob(
        QUEUES.DELIVERY_VERIFICATION,
        QUEUE_JOBS[QUEUES.DELIVERY_VERIFICATION].VERIFY,
        {
          deliveryVersionId: version.id,
          verificationVersion: nextVerificationVersion,
          actorUserId: userId,
        },
        {
          jobId: deliveryVerificationJobId(version.id, nextVerificationVersion),
          attempts: 3,
          backoff: { type: "custom" },
        },
      )
    } catch (error) {
      this.logger.error(
        `Delivery ${version.id} re-verification committed but enqueue failed; the dispatch sweep will recover it`,
        error instanceof Error ? error.stack : String(error),
      )
      throw new ServiceUnavailableException({
        code: "DELIVERY_VERIFICATION_ENQUEUE_FAILED",
        message:
          "Re-verification was saved, but immediate dispatch failed. The recovery sweep will retry automatically.",
        deliveryVersionId: version.id,
      })
    }
    return { status: "PENDING" }
  }

  // ── Evidence retrieval ────────────────────────────────────────────────────
  async orderEvidence(orderId: string) {
    const versions = await this.prisma.orderDeliveryVersion.findMany({
      where: { orderId },
      orderBy: { version: "desc" },
      include: { evidence: { orderBy: { createdAt: "desc" } } },
    })
    return versions
  }

  async orderSnapshots(orderId: string) {
    const versions = await this.prisma.orderDeliveryVersion.findMany({
      where: { orderId },
      select: { id: true, version: true, snapshots: true },
    })
    // Presign object keys for time-limited download
    const out = []
    for (const v of versions) {
      for (const s of v.snapshots) {
        out.push({
          deliveryVersionId: v.id,
          version: v.version,
          snapshotId: s.id,
          htmlUrl: await presignGet(s.htmlObjectKey).catch(() => null),
          screenshotUrl: s.screenshotObjectKey
            ? await presignGet(s.screenshotObjectKey).catch(() => null)
            : null,
          responseHeaders: s.responseHeaders,
          createdAt: s.createdAt,
        })
      }
    }
    return out
  }

  async orderAudit(orderId: string) {
    const versionIds = (
      await this.prisma.orderDeliveryVersion.findMany({
        where: { orderId },
        select: { id: true },
      })
    ).map((v: any) => v.id)
    return this.prisma.auditLog.findMany({
      where: {
        OR: [
          { entityType: "Order", entityId: orderId },
          { entityType: "OrderDeliveryVersion", entityId: { in: versionIds } },
          {
            entityType: "FulfillmentAssignment",
            metadata: { path: ["orderId"], equals: orderId },
          },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    })
  }

  // Full dispute evidence package — reviewers never reconstruct history.
  async disputeEvidencePackage(orderId: string) {
    const [versions, snapshots, audit, dispute, fraudFlags, notifications] =
      await Promise.all([
        this.prisma.orderDeliveryVersion.findMany({
          where: { orderId },
          orderBy: { version: "desc" },
          include: { evidence: { orderBy: { createdAt: "desc" } } },
        }),
        this.orderSnapshots(orderId),
        this.orderAudit(orderId),
        this.prisma.orderDispute
          .findUnique({ where: { orderId } })
          .catch(() => null),
        this.prisma.deliveryFraudFlag.findMany({
          where: { orderId },
          include: { resolution: true },
        }),
        this.prisma.orderEvent.findMany({
          where: { orderId },
          orderBy: { createdAt: "desc" },
          take: 200,
        }),
      ])
    return {
      dispute,
      versions,
      snapshots,
      fraudFlags,
      auditTrail: audit,
      timeline: notifications,
    }
  }
}
