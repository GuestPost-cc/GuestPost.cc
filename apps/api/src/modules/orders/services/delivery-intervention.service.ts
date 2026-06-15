import { Injectable, BadRequestException, NotFoundException, ConflictException, ForbiddenException } from "@nestjs/common"
import { PrismaService } from "../../../common/prisma.service"
import { AuditService } from "../../audit/audit.service"
import { QueueService } from "../../queues/queue.service"
import { QUEUES, orderEventMetadata } from "@guestpost/shared"
import { presignGet } from "@guestpost/shared/dist/object-storage"

const MIN_REASON = 20

// Manual intervention + evidence retrieval for deliveries. All transitions are
// optimistic-lock guarded, require a substantive reason, and are audited +
// notified. Override is SUPER_ADMIN-only.
@Injectable()
export class DeliveryInterventionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  private requireReason(reason: string | undefined) {
    if (!reason || reason.trim().length < MIN_REASON) {
      throw new BadRequestException(`A reason of at least ${MIN_REASON} characters is required`)
    }
    return reason.trim()
  }

  private async loadVersionWithOrder(deliveryVersionId: string) {
    const version = await this.prisma.orderDeliveryVersion.findUnique({ where: { id: deliveryVersionId } })
    if (!version) throw new NotFoundException("Delivery version not found")
    const order = await this.prisma.order.findUnique({
      where: { id: version.orderId },
      include: { website: { select: { publisherId: true } } },
    })
    if (!order) throw new NotFoundException("Order not found")
    return { version, order }
  }

  // Phase 6.9 — Audit finding #4 closure. The legacy `auditMeta` helper has
  // been retired in favor of `orderEventMetadata` from @guestpost/shared. The
  // shared helper supplies the Phase 6 snapshot trio uniformly across every
  // money-audit callsite; the delivery-specific extras (deliveryVersionId,
  // publishedUrl, publisherId) are appended on top. Reports that group audit
  // rows by serviceType / fulfillmentChannel / listingServiceId now see this
  // surface consistently.
  private deliveryAuditMeta(order: any, version: any, extra: Record<string, unknown> = {}) {
    return {
      ...orderEventMetadata(order),
      orderId: order.id,
      deliveryVersionId: version.id,
      publisherId: order.website?.publisherId ?? null,
      publishedUrl: version.publishedUrl,
      ...extra,
    }
  }

  private async notifyOrderParties(order: any, type: string, message: string) {
    const ids = new Set<string>([order.customerId])
    if (order.website?.publisherId) {
      const owners = await this.prisma.publisherMembership.findMany({
        where: { publisherId: order.website.publisherId, role: "PUBLISHER_OWNER" },
        select: { userId: true },
      })
      owners.forEach((o: any) => ids.add(o.userId))
    }
    for (const userId of ids) {
      await this.prisma.notification.create({ data: { userId, organizationId: order.organizationId, type, message } }).catch(() => undefined)
    }
  }

  // FAILED | MANUAL_REVIEW -> APPROVED (treated as verified for settlement).
  async manualApprove(deliveryVersionId: string, userId: string, role: string, reason: string) {
    const r = this.requireReason(reason)
    const { version, order } = await this.loadVersionWithOrder(deliveryVersionId)
    if (!["FAILED", "MANUAL_REVIEW"].includes(version.verificationStatus)) {
      throw new BadRequestException(`Only FAILED or MANUAL_REVIEW deliveries can be manually approved (is ${version.verificationStatus})`)
    }
    const upd = await this.prisma.orderDeliveryVersion.updateMany({
      where: { id: version.id, verificationVersion: version.verificationVersion },
      data: { interventionStatus: "APPROVED", verificationFailureReason: null, verificationVersion: version.verificationVersion + 1 },
    })
    if (upd.count === 0) throw new ConflictException("Delivery was modified by another request. Retry.")

    // Approving makes the delivery settlement-eligible; mirror order to VERIFIED.
    await this.prisma.order.updateMany({ where: { id: order.id, status: "PUBLISHED" }, data: { status: "VERIFIED", verifiedAt: new Date(), verifiedBy: userId, verifyMethod: "manual" } })

    await this.audit.log({ action: "ORDER_DELIVERY_MANUAL_APPROVED", entityType: "OrderDeliveryVersion", entityId: version.id, metadata: this.deliveryAuditMeta(order, version, { reason: r, roleAtTime: role }), userId, organizationId: order.organizationId })
    await this.notifyOrderParties(order, "ORDER_DELIVERY_MANUAL_APPROVED", `Delivery for order ${order.id} was manually approved.`)
    return { status: "APPROVED" }
  }

  async manualReject(deliveryVersionId: string, userId: string, role: string, reason: string) {
    const r = this.requireReason(reason)
    const { version, order } = await this.loadVersionWithOrder(deliveryVersionId)
    const upd = await this.prisma.orderDeliveryVersion.updateMany({
      where: { id: version.id, verificationVersion: version.verificationVersion },
      data: { interventionStatus: "REJECTED", verificationFailureReason: r, verificationVersion: version.verificationVersion + 1 },
    })
    if (upd.count === 0) throw new ConflictException("Delivery was modified by another request. Retry.")

    await this.audit.log({ action: "ORDER_DELIVERY_MANUAL_REJECTED", entityType: "OrderDeliveryVersion", entityId: version.id, metadata: this.deliveryAuditMeta(order, version, { reason: r, roleAtTime: role }), userId, organizationId: order.organizationId })
    await this.notifyOrderParties(order, "ORDER_DELIVERY_MANUAL_REJECTED", `Delivery for order ${order.id} was rejected: ${r}`)
    return { status: "REJECTED" }
  }

  // SUPER_ADMIN-only flip FAILED<->VERIFIED.
  async override(deliveryVersionId: string, userId: string, role: string, targetStatus: "VERIFIED" | "FAILED", reason: string) {
    if (role !== "SUPER_ADMIN") throw new ForbiddenException("Only SUPER_ADMIN may override verification")
    const r = this.requireReason(reason)
    if (!["VERIFIED", "FAILED"].includes(targetStatus)) throw new BadRequestException("Override target must be VERIFIED or FAILED")
    const { version, order } = await this.loadVersionWithOrder(deliveryVersionId)

    const upd = await this.prisma.orderDeliveryVersion.updateMany({
      where: { id: version.id, verificationVersion: version.verificationVersion },
      data: { verificationStatus: targetStatus, interventionStatus: "OVERRIDDEN", verificationFailureReason: targetStatus === "FAILED" ? r : null, verificationVersion: version.verificationVersion + 1 },
    })
    if (upd.count === 0) throw new ConflictException("Delivery was modified by another request. Retry.")

    if (targetStatus === "VERIFIED") {
      await this.prisma.order.updateMany({ where: { id: order.id, status: "PUBLISHED" }, data: { status: "VERIFIED", verifiedAt: new Date(), verifiedBy: userId, verifyMethod: "override" } })
    }

    await this.audit.log({ action: "ORDER_DELIVERY_OVERRIDDEN", entityType: "OrderDeliveryVersion", entityId: version.id, metadata: this.deliveryAuditMeta(order, version, { reason: r, targetStatus, roleAtTime: role }), userId, organizationId: order.organizationId })
    await this.notifyOrderParties(order, "ORDER_DELIVERY_OVERRIDDEN", `Delivery for order ${order.id} verification was overridden to ${targetStatus}.`)
    return { status: targetStatus }
  }

  // Re-run automated verification (staff). Resets to PENDING + re-enqueues.
  async reverify(deliveryVersionId: string, userId: string) {
    const { version, order } = await this.loadVersionWithOrder(deliveryVersionId)
    if (version.supersededByVersion != null) throw new BadRequestException("Cannot re-verify a superseded delivery")
    await this.prisma.orderDeliveryVersion.updateMany({
      where: { id: version.id, verificationVersion: version.verificationVersion },
      data: { verificationStatus: "PENDING", verificationVersion: version.verificationVersion + 1 },
    })
    await this.audit.log({ action: "ORDER_DELIVERY_VERIFICATION_STARTED", entityType: "OrderDeliveryVersion", entityId: version.id, metadata: this.deliveryAuditMeta(order, version, { reverify: true }), userId, organizationId: order.organizationId })
    await this.queue.addJob(QUEUES.DELIVERY_VERIFICATION, "delivery-verify", { deliveryVersionId: version.id, actorUserId: userId }, { jobId: `delivery-verify-${version.id}-${Date.now()}`, attempts: 3, backoff: { type: "custom" } })
    return { status: "PENDING" }
  }

  // Customer requests a revision. Creates a Revision (blocks settlement) and
  // returns the order to APPROVED so the next delivery is a NEW version.
  async requestRevision(orderId: string, organizationId: string, userId: string, notes: string) {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, organizationId }, include: { website: { select: { publisherId: true } } } })
    if (!order) throw new NotFoundException("Order not found")
    if (!["PUBLISHED", "VERIFIED"].includes(order.status)) {
      throw new BadRequestException("Revisions can only be requested on a delivered order")
    }
    return this.prisma.$transaction(async (tx: any) => {
      await tx.revision.create({ data: { orderId, notes, status: "REQUESTED" } })
      const upd = await tx.order.updateMany({ where: { id: orderId, version: order.version }, data: { status: "APPROVED", revisionCount: { increment: 1 }, version: { increment: 1 } } })
      if (upd.count === 0) throw new ConflictException("Order was modified by another request. Retry.")
      await tx.orderEvent.create({ data: { orderId, eventType: "REVISION_REQUESTED", actorId: userId, message: `Revision requested: ${notes}`, metadata: { notes } } })
      await this.audit.log({ action: "ORDER_DELIVERY_REVISION_REQUESTED", entityType: "Order", entityId: orderId, metadata: this.deliveryAuditMeta(order, { id: order.activeDeliveryVersionId ?? "", publishedUrl: order.publishedUrl }, { notes }), userId, organizationId }, tx)
      return { status: "REVISION_REQUESTED" }
    })
  }

  // ── Evidence retrieval ────────────────────────────────────────────────────
  async orderEvidence(orderId: string) {
    const versions = await this.prisma.orderDeliveryVersion.findMany({ where: { orderId }, orderBy: { version: "desc" }, include: { evidence: { orderBy: { createdAt: "desc" } } } })
    return versions
  }

  async orderSnapshots(orderId: string) {
    const versions = await this.prisma.orderDeliveryVersion.findMany({ where: { orderId }, select: { id: true, version: true, snapshots: true } })
    // Presign object keys for time-limited download
    const out = []
    for (const v of versions) {
      for (const s of v.snapshots) {
        out.push({
          deliveryVersionId: v.id,
          version: v.version,
          snapshotId: s.id,
          htmlUrl: await presignGet(s.htmlObjectKey).catch(() => null),
          screenshotUrl: s.screenshotObjectKey ? await presignGet(s.screenshotObjectKey).catch(() => null) : null,
          responseHeaders: s.responseHeaders,
          createdAt: s.createdAt,
        })
      }
    }
    return out
  }

  async orderAudit(orderId: string) {
    const versionIds = (await this.prisma.orderDeliveryVersion.findMany({ where: { orderId }, select: { id: true } })).map((v: any) => v.id)
    return this.prisma.auditLog.findMany({
      where: { OR: [{ entityType: "Order", entityId: orderId }, { entityType: "OrderDeliveryVersion", entityId: { in: versionIds } }, { entityType: "FulfillmentAssignment", metadata: { path: ["orderId"], equals: orderId } }] },
      orderBy: { createdAt: "desc" },
      take: 500,
    })
  }

  // Full dispute evidence package — reviewers never reconstruct history.
  async disputeEvidencePackage(orderId: string) {
    const [versions, snapshots, audit, dispute, fraudFlags, notifications] = await Promise.all([
      this.prisma.orderDeliveryVersion.findMany({ where: { orderId }, orderBy: { version: "desc" }, include: { evidence: { orderBy: { createdAt: "desc" } } } }),
      this.orderSnapshots(orderId),
      this.orderAudit(orderId),
      this.prisma.orderDispute.findUnique({ where: { orderId } }).catch(() => null),
      this.prisma.deliveryFraudFlag.findMany({ where: { orderId } }),
      this.prisma.orderEvent.findMany({ where: { orderId }, orderBy: { createdAt: "desc" }, take: 200 }),
    ])
    return { dispute, versions, snapshots, fraudFlags, auditTrail: audit, timeline: notifications }
  }
}
