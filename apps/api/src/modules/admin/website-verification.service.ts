import { computeTrustScore, QUEUES, trustBand } from "@guestpost/shared"
import { BadRequestException, Injectable } from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { AuditService } from "../audit/audit.service"
import { QueueService } from "../queues/queue.service"

// Verification governance + operations: trust scoring, force-approval oversight,
// the review center (filter/sections/bulk retry). All staff-only; mounted under
// the admin controller's StaffRoles guard.
@Injectable()
export class WebsiteVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  // Break-glass ownership verification for Super Admin CSV onboarding. This
  // deliberately records a distinct verification method and short expiry: it
  // never fabricates DNS evidence, never auto-approves a listing, and can be
  // replaced at any time by a successful publisher TXT verification.
  async forceVerifyWebsites(
    input: { websiteIds: string[]; reason: string; expiresInDays: number },
    actor: { id: string; staffRole?: string | null },
  ) {
    if (actor.staffRole !== "SUPER_ADMIN") {
      throw new BadRequestException("Super Admin access is required")
    }

    const websiteIds = [...new Set(input.websiteIds)]
    const websites = await this.prisma.website.findMany({
      where: {
        id: { in: websiteIds },
        ownershipType: "PUBLISHER",
        publisherId: { not: null },
        importBatchId: { not: null },
        isActive: true,
        NOT: {
          verificationStatus: "VERIFIED",
          verificationMethod: "DNS_TXT",
        },
      },
      include: {
        publisher: { select: { id: true, organizationId: true } },
      },
    })

    // Fail the whole request rather than silently applying a partial override.
    // The generic message also avoids confirming whether an out-of-scope ID
    // exists.
    if (websites.length !== websiteIds.length) {
      throw new BadRequestException(
        "One or more websites are unavailable for forced verification",
      )
    }

    const now = new Date()
    const expiresAt = new Date(
      now.getTime() + input.expiresInDays * 24 * 60 * 60 * 1000,
    )
    const reason = input.reason.trim()

    await this.prisma.$transaction(async (tx: any) => {
      for (const website of websites) {
        await tx.website.update({
          where: { id: website.id },
          data: {
            verificationStatus: "VERIFIED",
            verificationMethod: "SUPER_ADMIN_OVERRIDE",
            verifiedAt: now,
            lastVerificationCheckAt: now,
            activeVerifiedToken: null,
            verificationOverrideExpiresAt: expiresAt,
            verificationOverrideReason: reason,
            verifiedByUserId: actor.id,
            verificationFailureReason: null,
            consecutiveFailures: 0,
            verificationVersion: { increment: 1 },
          },
        })
        await this.audit.log(
          {
            action: "WEBSITE_DOMAIN_VERIFICATION_OVERRIDE",
            entityType: "Website",
            entityId: website.id,
            metadata: {
              domain: website.canonicalDomain ?? website.domain,
              publisherId: website.publisherId,
              reason,
              expiresAt: expiresAt.toISOString(),
              priorStatus: website.verificationStatus,
              importBatchId: website.importBatchId,
            },
            userId: actor.id,
            organizationId: website.publisher?.organizationId ?? null,
          },
          tx,
        )
      }
    })

    return {
      verified: websites.length,
      expiresAt,
      websites: websites.map((website: any) => ({
        id: website.id,
        domain: website.canonicalDomain ?? website.domain,
      })),
    }
  }

  // Recompute + persist a website's internal trust score from platform signals.
  async recomputeTrustScore(websiteId: string) {
    const website = await this.prisma.website.findUnique({
      where: { id: websiteId },
    })
    if (!website) return null

    const [
      revocationCount,
      listingCount,
      totalOrderCount,
      completedOrderCount,
      disputeCount,
      refundCount,
      chargebackCount,
    ] = await Promise.all([
      this.prisma.auditLog.count({
        where: { action: "WEBSITE_VERIFICATION_REVOKED", entityId: websiteId },
      }),
      this.prisma.marketplaceListing.count({ where: { websiteId } }),
      this.prisma.order.count({ where: { websiteId } }),
      this.prisma.order.count({
        where: {
          websiteId,
          status: { in: ["DELIVERED", "SETTLED", "COMPLETED"] },
        },
      }),
      this.prisma.orderDispute.count({ where: { order: { websiteId } } }),
      this.prisma.order.count({
        where: {
          websiteId,
          status: "REFUNDED",
          refundResponsibility: "PUBLISHER",
        },
      }),
      this.prisma.transaction
        .count({ where: { type: "CHARGEBACK", order: { websiteId } } })
        .catch(() => 0),
    ])

    const { score, band } = computeTrustScore({
      verificationStatus: website.verificationStatus,
      verifiedAt: website.verifiedAt,
      verificationCheckCount: website.verificationCheckCount ?? 0,
      consecutiveFailures: website.consecutiveFailures ?? 0,
      revocationCount,
      listingCount,
      completedOrderCount,
      totalOrderCount,
      disputeCount,
      refundCount,
      chargebackCount,
    })

    await this.prisma.website.update({
      where: { id: websiteId },
      data: { trustScore: score },
    })
    return { websiteId, score, band }
  }

  // GET /admin/websites/force-approved — listing-approval force overrides +
  // metric counts, for abuse detection.
  async forceApprovedReport(actorUserId: string) {
    const overrides = await this.prisma.auditLog.findMany({
      where: { action: "WEBSITE_VERIFICATION_OVERRIDE" },
      orderBy: { createdAt: "desc" },
      take: 500,
    })

    // Resolve listing -> website/domain/publisher for each override.
    const rows = []
    for (const o of overrides) {
      const meta: any = o.metadata ?? {}
      const listing = o.entityId
        ? await this.prisma.marketplaceListing
            .findUnique({
              where: { id: o.entityId },
              include: {
                website: { select: { domain: true, canonicalDomain: true } },
                publisher: { select: { name: true, email: true } },
              },
            })
            .catch(() => null)
        : null
      rows.push({
        auditId: o.id,
        listingId: o.entityId,
        domain:
          listing?.website?.canonicalDomain ??
          listing?.website?.domain ??
          meta.domain ??
          null,
        actorId: o.userId,
        reason: meta.reason ?? null,
        timestamp: o.createdAt,
        publisher: listing?.publisher ?? null,
      })
    }

    const [verified, pending, failed, revoked] = await Promise.all([
      this.prisma.website.count({ where: { verificationStatus: "VERIFIED" } }),
      this.prisma.website.count({
        where: { verificationStatus: "PENDING_VERIFICATION" },
      }),
      this.prisma.website.count({
        where: { verificationStatus: "VERIFICATION_FAILED" },
      }),
      this.prisma.website.count({ where: { verificationStatus: "REVOKED" } }),
    ])

    await this.audit.log({
      action: "WEBSITE_FORCE_APPROVAL_REPORT_VIEWED",
      entityType: "Website",
      entityId: undefined,
      metadata: { forceApprovedCount: rows.length },
      userId: actorUserId,
      organizationId: null,
    })

    return {
      metrics: {
        verified,
        pending,
        failed,
        revoked,
        forceApproved: rows.length,
      },
      forceApproved: rows,
    }
  }

  // Verification review center: filtered website list + section counts.
  async reviewCenter(filters: {
    publisherId?: string
    domain?: string
    status?: string
    from?: string
    to?: string
  }) {
    const where: any = { ownershipType: "PUBLISHER" }
    if (filters.publisherId) where.publisherId = filters.publisherId
    if (filters.domain)
      where.canonicalDomain = { contains: filters.domain.toLowerCase() }
    if (filters.status) where.verificationStatus = filters.status
    if (filters.from || filters.to) {
      where.createdAt = {}
      if (filters.from) where.createdAt.gte = new Date(filters.from)
      if (filters.to) where.createdAt.lte = new Date(filters.to)
    }

    const websites = await this.prisma.website.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: 500,
      include: { publisher: { select: { id: true, name: true, email: true } } },
    })

    const [pending, failed, revoked, recentlyVerified] = await Promise.all([
      this.prisma.website.count({
        where: {
          ownershipType: "PUBLISHER",
          verificationStatus: "PENDING_VERIFICATION",
        },
      }),
      this.prisma.website.count({
        where: {
          ownershipType: "PUBLISHER",
          verificationStatus: "VERIFICATION_FAILED",
        },
      }),
      this.prisma.website.count({
        where: { ownershipType: "PUBLISHER", verificationStatus: "REVOKED" },
      }),
      this.prisma.website.count({
        where: {
          ownershipType: "PUBLISHER",
          verificationStatus: "VERIFIED",
          verifiedAt: { gte: new Date(Date.now() - 7 * 86_400_000) },
        },
      }),
    ])

    return {
      sections: { pending, failed, revoked, recentlyVerified },
      websites: websites.map((w: any) => ({
        id: w.id,
        url: w.url,
        domain: w.canonicalDomain ?? w.domain,
        verificationStatus: w.verificationStatus,
        verifiedAt: w.verifiedAt,
        lastVerificationCheckAt: w.lastVerificationCheckAt,
        consecutiveFailures: w.consecutiveFailures,
        verificationCheckCount: w.verificationCheckCount,
        trustScore: w.trustScore,
        trustBand: trustBand(w.trustScore),
        publisher: w.publisher,
      })),
    }
  }

  // Bulk re-trigger verification for a set of websites.
  async bulkRetry(websiteIds: string[], actorUserId: string) {
    let queued = 0
    for (const id of websiteIds) {
      const w = await this.prisma.website.findUnique({
        where: { id },
        select: { id: true, verificationStatus: true },
      })
      if (!w || w.verificationStatus === "VERIFIED") continue
      await this.queue.addJob(
        QUEUES.WEBSITE_VERIFICATION,
        "website-verify",
        { websiteId: id, actorUserId },
        {
          jobId: `website-verify-${id}-${Date.now()}`,
          removeOnComplete: { count: 50 },
          removeOnFail: { count: 50 },
        },
      )
      queued++
    }
    await this.audit.log({
      action: "WEBSITE_VERIFICATION_BULK_RETRY",
      entityType: "Website",
      entityId: undefined,
      metadata: { requested: websiteIds.length, queued },
      userId: actorUserId,
      organizationId: null,
    })
    return { requested: websiteIds.length, queued }
  }
}
