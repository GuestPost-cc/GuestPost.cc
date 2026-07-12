import { ListingFulfillmentType, ListingStatus } from "@guestpost/database"
import {
  generateVerificationToken,
  QUEUES,
  verificationTxtValue,
} from "@guestpost/shared"
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { normalizeDomain } from "../../common/domain"
import { PrismaService } from "../../common/prisma.service"
import { AuditService } from "../audit/audit.service"
import { QueueService } from "../queues/queue.service"
import { CreateWebsiteDto, UpdateWebsiteDto } from "./dto/websites.dto"

@Injectable()
export class WebsitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  async createWebsite(
    publisherId: string,
    organizationId: string,
    dto: CreateWebsiteDto,
    user: any,
  ) {
    const publisher = await this.prisma.publisher.findUnique({
      where: { id: publisherId },
    })

    if (!publisher) {
      throw new NotFoundException("Publisher not found")
    }
    if (publisher.organizationId !== organizationId) {
      throw new ForbiddenException(
        "Publisher does not belong to this organization",
      )
    }

    // Canonical domain = dedupe + ownership-uniqueness key (protocol/path/www
    // stripped, lowercase, punycode). www.example.com and example.com collapse.
    const domain = normalizeDomain(dto.url)
    const canonicalDomain = domain

    // Platform-wide ownership uniqueness: one canonical domain = one publisher
    // website. Platform-owned inventory is exempt (partial unique index).
    const existingWebsite = await this.prisma.website.findFirst({
      where: { OR: [{ url: dto.url }, { domain }, { canonicalDomain }] },
    })
    if (existingWebsite) {
      // Cross-publisher takeover attempt — audit before refusing.
      if (
        existingWebsite.ownershipType === "PUBLISHER" &&
        existingWebsite.publisherId !== publisherId
      ) {
        await this.audit.log({
          action: "WEBSITE_DUPLICATE_DOMAIN_ATTEMPT",
          entityType: "Website",
          entityId: existingWebsite.id,
          metadata: {
            canonicalDomain,
            attemptedByPublisherId: publisherId,
            ownedByPublisherId: existingWebsite.publisherId,
            organizationId,
          },
          userId: user.id,
          organizationId,
        })
      }
      throw new BadRequestException({
        code: "DOMAIN_ALREADY_REGISTERED",
        message: `Domain ${canonicalDomain} is already registered`,
      })
    }

    // Domain ownership must be proven before the site can sell. Mint a
    // cryptographically random token now; the publisher publishes it as a
    // DNS TXT record and the worker validates it.
    const verificationToken = generateVerificationToken()

    let website
    try {
      const result = await this.prisma.$transaction(async (tx: any) => {
        const w = await tx.website.create({
          data: {
            url: dto.url,
            domain,
            canonicalDomain,
            country: dto.country,
            language: dto.language,
            category: dto.category,
            metrics: {
              dr: dto.domainRating,
              traffic: dto.monthlyTraffic,
            },
            publisherId,
            verificationStatus: "PENDING_VERIFICATION",
            verificationMethod: "DNS_TXT",
            verificationToken,
          },
        })

        const slug =
          dto.url
            .replace(/^https?:\/\//, "")
            .replace(/[^a-z0-9]+/gi, "-")
            .toLowerCase() +
          "-" +
          Date.now()

        await tx.marketplaceListing.create({
          data: {
            title: dto.url,
            slug,
            description: `Guest posting placement on ${dto.url}`,
            status: ListingStatus.DRAFT,
            fulfillmentType: ListingFulfillmentType.PUBLISHER,
            currency: "USD",
            domainRating: dto.domainRating,
            traffic: dto.monthlyTraffic,
            country: dto.country,
            language: dto.language,
            websiteUrl: dto.url,
            publisherId,
            websiteId: w.id,
            organizationId,
            ownerType: "PUBLISHER",
            services: {
              create: [
                {
                  serviceType: "GUEST_POST",
                  price: dto.price ?? 0,
                  currency: "USD",
                  turnaroundDays: dto.turnaroundDays ?? 7,
                  availability: "AVAILABLE",
                },
              ],
            },
          },
        })

        return w
      })
      website = result
    } catch (err: any) {
      // Partial unique index is the hard guarantee against a concurrent
      // duplicate-domain race that slips past the findFirst check above.
      if (
        err?.code === "P2002" ||
        /Website_canonicalDomain_publisher_key/.test(err?.message ?? "")
      ) {
        await this.audit.log({
          action: "WEBSITE_DUPLICATE_DOMAIN_ATTEMPT",
          entityType: "Website",
          entityId: canonicalDomain,
          metadata: {
            canonicalDomain,
            attemptedByPublisherId: publisherId,
            organizationId,
            race: true,
          },
          userId: user.id,
          organizationId,
        })
        throw new BadRequestException({
          code: "DOMAIN_ALREADY_REGISTERED",
          message: `Domain ${canonicalDomain} is already registered`,
        })
      }
      throw err
    }

    await this.audit.log({
      action: "WEBSITE_CREATED",
      entityType: "Website",
      entityId: website.id,
      metadata: { url: website.url },
      userId: user.id,
      organizationId,
    })
    await this.audit.log({
      action: "WEBSITE_VERIFICATION_CREATED",
      entityType: "Website",
      entityId: website.id,
      metadata: { domain, publisherId, organizationId, method: "DNS_TXT" },
      userId: user.id,
      organizationId,
    })

    return website
  }

  // Returns the DNS record the publisher must publish + the current status.
  // Enqueues the actual DNS check — lookups never run in the request path.
  async requestVerification(
    publisherId: string,
    organizationId: string,
    id: string,
    user: any,
  ) {
    const publisher = await this.prisma.publisher.findUnique({
      where: { id: publisherId },
    })
    if (!publisher || publisher.organizationId !== organizationId) {
      throw new NotFoundException("Publisher not found")
    }
    const website = await this.prisma.website.findFirst({
      where: { id, publisherId },
    })
    if (!website) throw new NotFoundException("Website not found")
    if (website.verificationStatus === "VERIFIED") {
      throw new BadRequestException("Website is already verified")
    }
    let verificationToken = website.verificationToken
    if (!verificationToken) {
      verificationToken = generateVerificationToken()
      await this.prisma.website.update({
        where: { id: website.id },
        data: {
          verificationMethod: "DNS_TXT",
          verificationToken,
          verificationStatus: "PENDING_VERIFICATION",
          verificationFailureReason: null,
        },
      })
    }

    // ── Rate limiting (anti DNS-abuse / verification spam) ────────────────────
    const COOLDOWN_MS = Number(process.env.VERIFY_COOLDOWN_SECONDS ?? 60) * 1000
    const cooldownStart = new Date(Date.now() - COOLDOWN_MS)
    const cooldownOk = await this.prisma.website.updateMany({
      where: {
        id: website.id,
        OR: [
          { lastVerificationRequestAt: null },
          { lastVerificationRequestAt: { lte: cooldownStart } },
        ],
      },
      data: { lastVerificationRequestAt: new Date() },
    })
    if (cooldownOk.count === 0) {
      throw new BadRequestException({
        code: "VERIFICATION_RATE_LIMITED",
        message: "Please wait before requesting verification again",
      })
    }
    // Per-publisher hourly cap across all their websites.
    const HOURLY_CAP = Number(process.env.VERIFY_HOURLY_CAP ?? 20)
    const recent = await this.prisma.auditLog.count({
      where: {
        action: "WEBSITE_VERIFICATION_REQUESTED",
        userId: user.id,
        createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
      },
    })
    if (recent >= HOURLY_CAP) {
      throw new BadRequestException({
        code: "VERIFICATION_RATE_LIMITED",
        message: "Hourly verification request limit reached. Try again later.",
      })
    }

    await this.audit.log({
      action: "WEBSITE_VERIFICATION_REQUESTED",
      entityType: "Website",
      entityId: website.id,
      metadata: { domain: website.domain, publisherId, organizationId },
      userId: user.id,
      organizationId,
    })

    // Enqueue the DNS check. jobId dedupes rapid re-clicks within the window
    // so a publisher can't spam-trigger lookups.
    await this.queue.addJob(
      QUEUES.WEBSITE_VERIFICATION,
      "website-verify",
      { websiteId: website.id, actorUserId: user.id },
      {
        jobId: `website-verify-${website.id}`,
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 50 },
      },
    )

    return {
      status: website.verificationStatus,
      verificationStatus: website.verificationStatus,
      instructions: {
        type: "DNS_TXT",
        host: "@",
        value: verificationTxtValue(verificationToken),
        note: "Add this as a TXT record on your root domain (and optionally www). DNS changes can take up to 48 hours to propagate. Click Verify after adding it.",
      },
    }
  }

  async updateWebsite(
    publisherId: string,
    organizationId: string,
    id: string,
    dto: UpdateWebsiteDto,
    user: any,
  ) {
    const publisher = await this.prisma.publisher.findUnique({
      where: { id: publisherId },
    })
    if (!publisher || publisher.organizationId !== organizationId) {
      throw new NotFoundException("Publisher not found")
    }
    const website = await this.prisma.website.findFirst({
      where: { id, publisherId },
    })

    if (!website) {
      throw new NotFoundException("Website not found")
    }

    let domain = website.domain
    if (dto.url && dto.url !== website.url) {
      domain = normalizeDomain(dto.url)
      const duplicate = await this.prisma.website.findFirst({
        where: { id: { not: id }, OR: [{ url: dto.url }, { domain }] },
      })
      if (duplicate) {
        throw new BadRequestException(
          `Website with this domain already exists (${duplicate.url})`,
        )
      }
    }

    const updated = await this.prisma.website.update({
      where: { id },
      data: {
        url: dto.url,
        domain,
        country: dto.country,
        language: dto.language,
        category: dto.category,
        metrics: {
          dr: dto.domainRating,
          traffic: dto.monthlyTraffic,
        },
      },
    })

    // Also update the pending listing if exists
    const listing = await this.prisma.marketplaceListing.findFirst({
      where: {
        websiteId: id,
        status: { in: [ListingStatus.DRAFT, ListingStatus.PENDING_REVIEW] },
      },
    })

    if (listing) {
      // Phase 7: price + turnaroundDays move per-service. If the dto
      // carried them, propagate to the matching ListingService row(s)
      // (currently a publisher only has GUEST_POST seeded by the create
      // path; multi-service edits happen through the Services dialog).
      await this.prisma.marketplaceListing.update({
        where: { id: listing.id },
        data: {
          title: dto.url,
          domainRating: dto.domainRating,
          traffic: dto.monthlyTraffic,
          country: dto.country,
          language: dto.language,
          websiteUrl: dto.url,
        },
      })
      if (dto.price != null || dto.turnaroundDays != null) {
        await this.prisma.listingService.updateMany({
          where: { listingId: listing.id },
          data: {
            ...(dto.price != null ? { price: dto.price } : {}),
            ...(dto.turnaroundDays != null
              ? { turnaroundDays: dto.turnaroundDays }
              : {}),
          },
        })
      }
    }

    await this.audit.log({
      action: "WEBSITE_UPDATED",
      entityType: "Website",
      entityId: id,
      metadata: { url: dto.url },
      userId: user.id,
      organizationId,
    })

    return updated
  }

  async getWebsiteById(
    publisherId: string,
    organizationId: string,
    websiteId: string,
  ) {
    const publisher = await this.prisma.publisher.findUnique({
      where: { id: publisherId },
    })
    if (!publisher || publisher.organizationId !== organizationId) {
      throw new NotFoundException("Publisher not found")
    }

    const website = await this.prisma.website.findFirst({
      where: { id: websiteId, publisherId },
      include: {
        websiteIntegrations: {
          include: {
            integration: true,
          },
        },
      },
    })

    if (!website) {
      throw new NotFoundException("Website not found")
    }

    const gscIntegrationRecord =
      await this.prisma.publisherIntegration.findFirst({
        where: {
          ownerType: "PUBLISHER",
          ownerId: publisherId,
          provider: "GOOGLE_SEARCH_CONSOLE",
        },
      })
    const gscAccountExists = !!gscIntegrationRecord

    const gscIntegration = website.websiteIntegrations.find(
      (wi) => wi.integration.provider === "GOOGLE_SEARCH_CONSOLE",
    )

    let lastSuccessfulSyncAt: string | null = null
    let lastSyncAttemptAt: string | null = null
    let lastSyncAttemptStatus: string | null = null
    let lastSyncError: string | null = null

    if (gscIntegration) {
      const syncs = await this.prisma.integrationSync.findMany({
        where: { integrationId: gscIntegration.integrationId },
        orderBy: { startedAt: "desc" },
        take: 10,
      })
      lastSyncAttemptAt = syncs[0]?.startedAt.toISOString() ?? null
      lastSyncAttemptStatus = syncs[0]?.status ?? null
      lastSyncError = syncs[0]?.errorMessage ?? null

      const successful = syncs.find((s) => s.status === "COMPLETED")
      lastSuccessfulSyncAt = successful?.completedAt?.toISOString() ?? null
    }

    const seoIntegration = gscIntegration
      ? {
          linked: true,
          integrationId: gscIntegration.integration.id,
          provider: gscIntegration.integration.provider,
          integrationStatus: gscIntegration.integration.status,
          externalResourceId: gscIntegration.externalResourceId,
          externalResourceName: gscIntegration.externalResourceName,
          websiteIntegrationId: gscIntegration.id,
          websiteIntegrationStatus: gscIntegration.status,
          lastSyncedAt: gscIntegration.syncedAt?.toISOString() ?? null,
          lastSuccessfulSyncAt,
          lastSyncAttemptAt,
          lastSyncAttemptStatus,
          lastSyncError,
          syncInProgress: gscIntegration.status === "SYNCING",
          needsReauth:
            gscIntegration.integration.status === "TOKEN_EXPIRED" ||
            gscIntegration.integration.status === "REAUTH_REQUIRED",
        }
      : null

    const { websiteIntegrations, ...rest } = website

    return {
      ...rest,
      verifiedAt: rest.verifiedAt?.toISOString() ?? null,
      lastVerificationRequestAt:
        rest.lastVerificationRequestAt?.toISOString() ?? null,
      lastVerificationCheckAt:
        rest.lastVerificationCheckAt?.toISOString() ?? null,
      lastSuccessfulVerificationAt:
        rest.lastSuccessfulVerificationAt?.toISOString() ?? null,
      verificationInstructions:
        rest.verificationStatus !== "VERIFIED" && rest.verificationToken
          ? {
              type: "DNS_TXT",
              host: "@",
              value: verificationTxtValue(rest.verificationToken),
              note: "Add this TXT record on your root domain. DNS changes can take up to 48 hours to propagate; use Re-check DNS after publishing it.",
            }
          : null,
      createdAt: rest.createdAt.toISOString(),
      updatedAt: rest.updatedAt.toISOString(),
      websiteIntegrations: websiteIntegrations.map((wi) => ({
        id: wi.id,
        integrationId: wi.integrationId,
        websiteId: wi.websiteId,
        externalResourceId: wi.externalResourceId,
        externalResourceName: wi.externalResourceName,
        status: wi.status,
        syncedAt: wi.syncedAt?.toISOString() ?? null,
        integration: {
          id: wi.integration.id,
          provider: wi.integration.provider,
          status: wi.integration.status,
        },
      })),
      seoIntegration,
      gscAccountExists,
      gscIntegration: gscIntegrationRecord
        ? {
            id: gscIntegrationRecord.id,
            provider: gscIntegrationRecord.provider,
            status: gscIntegrationRecord.status,
            createdAt: gscIntegrationRecord.createdAt?.toISOString() ?? null,
          }
        : null,
    }
  }

  async getWebsites(publisherId: string, organizationId: string) {
    const publisher = await this.prisma.publisher.findUnique({
      where: { id: publisherId },
    })
    if (!publisher || publisher.organizationId !== organizationId) {
      throw new NotFoundException("Publisher not found")
    }
    return this.prisma.website.findMany({
      where: { publisherId },
      include: {
        // Phase 7: legacy price + turnaroundDays selectors were dropped.
        // Surface the AVAILABLE services so callers can render per-service
        // price/TAT directly.
        marketplaceListings: {
          select: {
            status: true,
            services: {
              where: { availability: "AVAILABLE" },
              select: { serviceType: true, price: true, turnaroundDays: true },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    })
  }

  async deleteWebsite(
    publisherId: string,
    organizationId: string,
    id: string,
    user: any,
  ) {
    const publisher = await this.prisma.publisher.findUnique({
      where: { id: publisherId },
    })
    if (!publisher || publisher.organizationId !== organizationId) {
      throw new NotFoundException("Publisher not found")
    }
    const website = await this.prisma.website.findFirst({
      where: { id, publisherId },
    })

    if (!website) {
      throw new NotFoundException("Website not found")
    }

    // Instead of hard deleting, we archive the listings and pause the website
    await this.prisma.website.update({
      where: { id },
      data: { isActive: false },
    })

    await this.prisma.marketplaceListing.updateMany({
      where: { websiteId: id },
      data: { status: ListingStatus.ARCHIVED },
    })

    await this.audit.log({
      action: "WEBSITE_DELETED",
      entityType: "Website",
      entityId: id,
      metadata: { url: website.url },
      userId: user.id,
      organizationId,
    })

    return { success: true }
  }

  async submitForReview(
    publisherId: string,
    organizationId: string,
    id: string,
    user: any,
  ) {
    const publisher = await this.prisma.publisher.findUnique({
      where: { id: publisherId },
    })
    if (!publisher || publisher.organizationId !== organizationId) {
      throw new NotFoundException("Publisher not found")
    }
    const website = await this.prisma.website.findFirst({
      where: { id, publisherId },
    })

    if (!website) {
      throw new NotFoundException("Website not found")
    }

    if (website.verificationStatus !== "VERIFIED") {
      throw new BadRequestException({
        code: "WEBSITE_NOT_VERIFIED",
        message:
          "Verify domain ownership before submitting this website for review",
      })
    }

    const listing = await this.prisma.marketplaceListing.findFirst({
      where: { websiteId: id, status: ListingStatus.DRAFT },
    })

    if (listing) {
      await this.prisma.marketplaceListing.update({
        where: { id: listing.id },
        data: { status: ListingStatus.PENDING_REVIEW },
      })
    }

    await this.audit.log({
      action: "WEBSITE_SUBMITTED_FOR_REVIEW",
      entityType: "Website",
      entityId: id,
      userId: user.id,
      organizationId,
    })

    return { success: true }
  }
}
