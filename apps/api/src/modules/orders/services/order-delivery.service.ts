import { Injectable, BadRequestException, NotFoundException, ConflictException } from "@nestjs/common"
import { PrismaService } from "../../../common/prisma.service"
import { AuditService } from "../../audit/audit.service"
import { QueueService } from "../../queues/queue.service"
import { QUEUES, normalizeUrl } from "@guestpost/shared"

// Rejected placeholder "deliveries" — a human typing "done" is not a delivery.
const PLACEHOLDER_VALUES = new Set(["done", "n/a", "na", "none", "-", "tbd", "pending", "complete", "completed"])

@Injectable()
export class OrderDeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  // Validate + normalize a published URL. Throws on empty/placeholder/invalid.
  private validatePublishedUrl(raw: string | undefined | null): { publishedUrl: string; normalizedUrl: string } {
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
    order: { id: string; version: number; status: string; organizationId: string; websiteId: string | null },
    actorUserId: string,
    dto: { publishedUrl: string; articleTitle?: string; notes?: string; screenshotUrl?: string },
  ) {
    const { publishedUrl, normalizedUrl } = this.validatePublishedUrl(dto.publishedUrl)

    return this.prisma.$transaction(async (tx: any) => {
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
      if (upd.count === 0) throw new ConflictException("Order was modified by another request. Retry.")

      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          eventType: "PUBLICATION_MARKED",
          actorId: actorUserId,
          message: `Delivery v${nextVersion} submitted: ${publishedUrl}`,
          metadata: { publishedUrl, version: nextVersion, deliveryVersionId: version.id },
        },
      })

      await this.audit.log(
        {
          action: "ORDER_DELIVERY_SUBMITTED",
          entityType: "OrderDeliveryVersion",
          entityId: version.id,
          metadata: {
            orderId: order.id,
            deliveryVersionId: version.id,
            websiteId: order.websiteId,
            version: nextVersion,
            publishedUrl,
            submittedByUserId: actorUserId,
          },
          userId: actorUserId,
          organizationId: order.organizationId,
        },
        tx,
      )

      // Enqueue independent verification (signed, retry 3x w/ 5/15/60m backoff)
      await this.queue.addJob(
        QUEUES.DELIVERY_VERIFICATION,
        "delivery-verify",
        { deliveryVersionId: version.id, actorUserId },
        {
          jobId: `delivery-verify-${version.id}`,
          attempts: 3,
          backoff: { type: "custom" },
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 100 },
        },
      )

      return version
    })
  }

  async listDeliveries(orderId: string) {
    return this.prisma.orderDeliveryVersion.findMany({
      where: { orderId },
      orderBy: { version: "desc" },
      include: { evidence: { orderBy: { createdAt: "desc" }, take: 1 }, snapshots: true },
    })
  }

  // Customer-safe delivery proof — verification results as booleans, no internal
  // evidence (HTML hashes, object keys, fraud flags stay staff-only).
  async deliveryProof(orderId: string, organizationId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, organizationId },
      include: { website: { select: { ownershipType: true } } },
    })
    if (!order) throw new NotFoundException("Order not found")
    if (!order.activeDeliveryVersionId) return { hasDelivery: false }
    const version = await this.prisma.orderDeliveryVersion.findUnique({
      where: { id: order.activeDeliveryVersionId },
      include: { evidence: { orderBy: { createdAt: "desc" }, take: 1 } },
    })
    if (!version) return { hasDelivery: false }
    const ev = version.evidence[0]
    return {
      hasDelivery: true,
      publishedUrl: version.publishedUrl,
      articleTitle: version.articleTitle,
      screenshotUrl: version.screenshotUrl,
      verificationStatus: version.verificationStatus,
      interventionStatus: version.interventionStatus,
      submittedAt: version.submittedAt,
      deliveredBy: (order.fulfillmentChannel ?? (order.website?.ownershipType === "PLATFORM" ? "PLATFORM" : "PUBLISHER")) === "PLATFORM" ? "Platform" : "Publisher",
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
    }
  }

  // Customer manual acceptance — a SECONDARY fallback. The automated system
  // check is always authoritative: this is only allowed when auto verification
  // FAILED or needs MANUAL_REVIEW. A VERIFIED delivery uses Confirm Delivery
  // instead; a still-running check must be waited out. Accepting completes the
  // order (DELIVERED) so settlement can proceed.
  async customerAcceptDelivery(orderId: string, organizationId: string, userId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, organizationId },
      include: { website: { select: { publisherId: true } } },
    })
    if (!order) throw new NotFoundException("Order not found")
    if (!order.activeDeliveryVersionId) throw new BadRequestException("There is no delivery to accept yet")

    const v = await this.prisma.orderDeliveryVersion.findUnique({ where: { id: order.activeDeliveryVersionId } })
    if (!v) throw new BadRequestException("Active delivery not found")

    // System-check priority: manual accept is the fallback path only.
    if (v.verificationStatus === "VERIFIED") {
      throw new BadRequestException("This delivery passed automated verification — use Confirm Delivery.")
    }
    if (!["FAILED", "MANUAL_REVIEW"].includes(v.verificationStatus)) {
      throw new BadRequestException("Automated verification is still running — please wait for it to finish.")
    }
    if (order.status !== "PUBLISHED") {
      throw new BadRequestException("Order is not awaiting delivery confirmation")
    }

    return this.prisma.$transaction(async (tx: any) => {
      const upd = await tx.orderDeliveryVersion.updateMany({
        where: { id: v.id, verificationVersion: v.verificationVersion },
        data: { interventionStatus: "APPROVED", verificationFailureReason: null, verificationVersion: v.verificationVersion + 1 },
      })
      if (upd.count === 0) throw new ConflictException("Delivery was modified by another request. Retry.")

      const ordUpd = await tx.order.updateMany({
        where: { id: order.id, version: order.version, status: "PUBLISHED" },
        data: { status: "DELIVERED", deliveredAt: new Date(), verifiedAt: new Date(), verifiedBy: userId, verifyMethod: "customer_manual", version: { increment: 1 } },
      })
      if (ordUpd.count === 0) throw new ConflictException("Order was modified by another request. Retry.")

      await tx.orderEvent.create({
        data: {
          orderId,
          eventType: "DELIVERY_CONFIRMED",
          actorId: userId,
          message: "Customer manually accepted the delivery after the automated check could not verify it",
          metadata: { priorVerification: v.verificationStatus, deliveryVersionId: v.id },
        },
      })
      await this.audit.log(
        {
          action: "ORDER_DELIVERY_CUSTOMER_ACCEPTED",
          entityType: "OrderDeliveryVersion",
          entityId: v.id,
          metadata: { orderId, publishedUrl: v.publishedUrl, priorVerification: v.verificationStatus, publisherId: order.website?.publisherId ?? null },
          userId,
          organizationId,
        },
        tx,
      )

      // Best-effort notify the publisher owners.
      if (order.website?.publisherId) {
        const owners = await tx.publisherMembership.findMany({ where: { publisherId: order.website.publisherId, role: "PUBLISHER_OWNER" }, select: { userId: true } })
        for (const o of owners) {
          await tx.notification.create({ data: { userId: o.userId, organizationId, type: "ORDER_DELIVERY_CUSTOMER_ACCEPTED", message: `Customer manually accepted delivery for order ${orderId}.` } }).catch(() => undefined)
        }
      }

      return { status: "DELIVERED", acceptedBy: "customer" }
    })
  }

  async getDelivery(id: string) {
    const v = await this.prisma.orderDeliveryVersion.findUnique({
      where: { id },
      include: { evidence: { orderBy: { createdAt: "desc" } }, snapshots: true, fraudFlags: true },
    })
    if (!v) throw new NotFoundException("Delivery version not found")
    return v
  }
}
