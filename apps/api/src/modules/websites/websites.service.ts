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
      website = await this.prisma.website.create({
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

    // Create associated MarketplaceListing with PENDING_REVIEW status
    const slug =
      dto.url
        .replace(/^https?:\/\//, "")
        .replace(/[^a-z0-9]+/gi, "-")
        .toLowerCase() +
      "-" +
      Date.now()

    // Phase 7: the legacy listing-level type/price/turnaroundDays columns
    // are gone. We materialize a single GUEST_POST ListingService alongside
    // the listing using the publisher's submitted price/TAT — they can add
    // more services later via the publisher Services dialog.
    await this.prisma.marketplaceListing.create({
      data: {
        title: dto.url,
        slug,
        description: `Guest posting placement on ${dto.url}`,
        status: ListingStatus.PENDING_REVIEW,
        fulfillmentType: ListingFulfillmentType.PUBLISHER,
        currency: "USD",
        domainRating: dto.domainRating,
        traffic: dto.monthlyTraffic,
        country: dto.country,
        language: dto.language,
        websiteUrl: dto.url,
        publisherId,
        websiteId: website.id,
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
    if (!website.verificationToken) {
      throw new BadRequestException("This website has no verification token")
    }

    // ── Rate limiting (anti DNS-abuse / verification spam) ────────────────────
    const now = Date.now()
    const COOLDOWN_MS = Number(process.env.VERIFY_COOLDOWN_SECONDS ?? 60) * 1000
    if (
      website.lastVerificationRequestAt &&
      now - new Date(website.lastVerificationRequestAt).getTime() < COOLDOWN_MS
    ) {
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
        organizationId,
        createdAt: { gte: new Date(now - 60 * 60 * 1000) },
      },
    })
    if (recent >= HOURLY_CAP) {
      throw new BadRequestException({
        code: "VERIFICATION_RATE_LIMITED",
        message: "Hourly verification request limit reached. Try again later.",
      })
    }

    await this.prisma.website.update({
      where: { id: website.id },
      data: { lastVerificationRequestAt: new Date(now) },
    })

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
        value: verificationTxtValue(website.verificationToken),
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
      where: { websiteId: id, status: ListingStatus.PENDING_REVIEW },
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
