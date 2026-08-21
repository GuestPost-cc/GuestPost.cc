import {
  ListingFulfillmentType,
  ListingStatus,
  ModerationAction,
  ModerationAuthority,
  ModerationReasonCode,
  WebsiteMetricKey,
  WebsiteMetricProvider,
  WebsiteMetricSource,
} from "@guestpost/database"
import {
  buildModerationProjection,
  generateVerificationToken,
  getPublisherListingLifecycleActions,
  getPublisherWebsiteLifecycleActions,
  QUEUES,
  USD_CURRENCY,
  validateWebsiteEnlistmentInput,
  verificationTxtValue,
} from "@guestpost/shared"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { normalizeDomain } from "../../common/domain"
import { PrismaService } from "../../common/prisma.service"
import {
  hasCompleteListingPolicy,
  isMarketplaceLanguage,
  requireActiveMarketplaceCategories,
} from "../../common/utils/marketplace-categories"
import { AuditService } from "../audit/audit.service"
import { QueueService } from "../queues/queue.service"
import { CreateWebsiteDto, UpdateWebsiteDto } from "./dto/websites.dto"
import {
  assertManualMetricValues,
  assertMeasurementDate,
  manualMetricExpiry,
  manualMetricFreshAfter,
  serializeWebsiteMetrics,
  upsertWebsiteMetric,
} from "./website-metrics.service"

@Injectable()
export class WebsitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  private publisherModerationHistory(events: any[] = []) {
    return events.map((event) => ({
      id: event.id,
      scope: event.scope,
      action: event.action,
      authority: event.authority,
      reasonCode: event.reasonCode,
      publisherMessage: event.publisherMessage,
      resubmissionAllowed: event.resubmissionAllowed,
      previousStatus: event.previousStatus,
      resultingStatus: event.resultingStatus,
      previousWebsiteActive: event.previousWebsiteActive,
      resultingWebsiteActive: event.resultingWebsiteActive,
      createdAt: event.createdAt,
    }))
  }

  private publisherListingProjection(listing: any) {
    const {
      activeModerationAction: _activeModerationAction,
      activeModerationAuthority: _activeModerationAuthority,
      activeModerationReasonCode: _activeModerationReasonCode,
      activeModerationMessage: _activeModerationMessage,
      activeModerationPreviousStatus: _activeModerationPreviousStatus,
      moderationResubmissionAllowed: _moderationResubmissionAllowed,
      moderationVersion: _moderationVersion,
      moderationEvents = [],
      ...safeListing
    } = listing
    return {
      ...safeListing,
      moderation: {
        ...buildModerationProjection(
          listing,
          getPublisherListingLifecycleActions(listing),
        ),
        history: this.publisherModerationHistory(moderationEvents),
      },
    }
  }

  private publisherWebsiteProjection(website: any) {
    const {
      activeModerationAction: _activeModerationAction,
      activeModerationAuthority: _activeModerationAuthority,
      activeModerationReasonCode: _activeModerationReasonCode,
      activeModerationMessage: _activeModerationMessage,
      activeModerationPreviousActive: _activeModerationPreviousActive,
      moderationVersion: _moderationVersion,
      moderationEvents = [],
      ...safeWebsite
    } = website
    return {
      ...safeWebsite,
      moderation: {
        ...buildModerationProjection(
          website,
          getPublisherWebsiteLifecycleActions(website),
        ),
        history: this.publisherModerationHistory(moderationEvents),
      },
    }
  }

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

    const inputIssue = validateWebsiteEnlistmentInput({
      url: dto.url,
      name: dto.name,
      country: dto.country,
      listingTitle: dto.listingTitle,
      description: dto.description,
    })[0]
    if (inputIssue) {
      throw new BadRequestException(inputIssue)
    }

    if (!dto.manualMetrics) {
      throw new BadRequestException({
        code: "MANUAL_METRICS_REQUIRED",
        message: "Ahrefs organic traffic and Moz Domain Authority are required",
      })
    }
    assertManualMetricValues(dto.manualMetrics)
    const ahrefsTrafficAsOf = assertMeasurementDate(
      dto.manualMetrics.ahrefsTrafficAsOf,
      "manualMetrics.ahrefsTrafficAsOf",
      { requireFresh: true },
    )
    const mozDomainAuthorityAsOf = assertMeasurementDate(
      dto.manualMetrics.mozDomainAuthorityAsOf,
      "manualMetrics.mozDomainAuthorityAsOf",
      { requireFresh: true },
    )

    // Canonical domain = dedupe + ownership-uniqueness key (protocol/path/www
    // stripped, lowercase, punycode). www.example.com and example.com collapse.
    const domain = normalizeDomain(dto.url)
    const canonicalDomain = domain

    // Platform-wide inventory uniqueness: one canonical domain maps to one
    // Website aggregate, regardless of publisher/platform ownership.
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

    const marketplaceCategories = await requireActiveMarketplaceCategories(
      this.prisma,
      dto.categoryIds,
    )

    // New clients send the first service as a nested, validated object. Keep
    // the legacy price fields as a compatibility bridge, but never create an
    // AVAILABLE zero-price service.
    const initialService = dto.initialService ?? null
    if (
      initialService?.currency !== undefined &&
      initialService.currency !== USD_CURRENCY
    ) {
      throw new BadRequestException({
        code: "UNSUPPORTED_CURRENCY",
        message: "Website service currency must be exactly USD",
      })
    }

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
            category: marketplaceCategories
              .map((category) => category.name)
              .join(", "),
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
            title: dto.listingTitle,
            slug,
            description: dto.description,
            status: ListingStatus.DRAFT,
            fulfillmentType: ListingFulfillmentType.PUBLISHER,
            currency: "USD",
            country: dto.country,
            language: dto.language,
            websiteUrl: dto.url,
            publisherId,
            websiteId: w.id,
            organizationId,
            ownerType: "PUBLISHER",
            traffic: dto.manualMetrics.ahrefsOrganicTraffic,
            domainAuthority: dto.manualMetrics.mozDomainAuthority,
            sportsGamingAllowed: dto.sportsGamingAllowed,
            pharmacyAllowed: dto.pharmacyAllowed,
            cryptoAllowed: dto.cryptoAllowed,
            backlinkCount: dto.backlinkCount,
            linkType: dto.linkType,
            linkValidity: dto.linkValidity,
            googleNews: dto.googleNews,
            markedSponsored: dto.markedSponsored,
            foreignLanguageAllowed: dto.foreignLanguageAllowed,
            categories: {
              create: marketplaceCategories.map((category) => ({
                category: { connect: { id: category.id } },
              })),
            },
            services: initialService
              ? {
                  create: [
                    {
                      serviceType: initialService.serviceType,
                      price: initialService.price,
                      currency: USD_CURRENCY,
                      turnaroundDays: initialService.turnaroundDays,
                      revisionRounds: initialService.revisionRounds ?? 2,
                      warrantyDays: initialService.warrantyDays,
                      availability: "AVAILABLE",
                    },
                  ],
                }
              : undefined,
          },
        })

        await upsertWebsiteMetric(tx, {
          websiteId: w.id,
          key: WebsiteMetricKey.AHREFS_ORGANIC_TRAFFIC,
          provider: WebsiteMetricProvider.AHREFS,
          source: WebsiteMetricSource.PUBLISHER_MANUAL,
          value: dto.manualMetrics.ahrefsOrganicTraffic,
          measuredAt: ahrefsTrafficAsOf,
          expiresAt: manualMetricExpiry(ahrefsTrafficAsOf),
          enteredByUserId: user.id,
        })
        await upsertWebsiteMetric(tx, {
          websiteId: w.id,
          key: WebsiteMetricKey.MOZ_DOMAIN_AUTHORITY,
          provider: WebsiteMetricProvider.MOZ,
          source: WebsiteMetricSource.PUBLISHER_MANUAL,
          value: dto.manualMetrics.mozDomainAuthority,
          measuredAt: mozDomainAuthorityAsOf,
          expiresAt: manualMetricExpiry(mozDomainAuthorityAsOf),
          enteredByUserId: user.id,
        })
        await this.audit.log(
          {
            action: "WEBSITE_MANUAL_METRICS_CREATED",
            entityType: "Website",
            entityId: w.id,
            metadata: {
              ahrefsOrganicTraffic: dto.manualMetrics.ahrefsOrganicTraffic,
              ahrefsTrafficAsOf: ahrefsTrafficAsOf.toISOString(),
              mozDomainAuthority: dto.manualMetrics.mozDomainAuthority,
              mozDomainAuthorityAsOf: mozDomainAuthorityAsOf.toISOString(),
              source: "PUBLISHER_MANUAL",
            },
            userId: user.id,
            organizationId,
          },
          tx,
        )

        return w
      })
      website = result
    } catch (err: any) {
      // Partial unique index is the hard guarantee against a concurrent
      // duplicate-domain race that slips past the findFirst check above.
      if (
        err?.code === "P2002" ||
        /Website_canonicalDomain_(?:publisher_)?key/.test(err?.message ?? "")
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

    // The website transaction is already durable. External provider failures
    // must never roll it back, so enqueue best-effort after commit.
    try {
      await this.queue.addJob(
        QUEUES.DOMAIN_METRICS,
        "domain-metrics-sync",
        { websiteIds: [website.id], trigger: "WEBSITE_CREATED" },
        { jobId: `domain-metrics-${website.id}` },
      )
    } catch {
      // Scheduled/backfill sync can recover; creation remains successful.
    }

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
    if (
      website.verificationStatus === "VERIFIED" &&
      website.verificationMethod !== "SUPER_ADMIN_OVERRIDE"
    ) {
      throw new BadRequestException("Website is already verified")
    }
    let verificationToken = website.verificationToken
    if (!verificationToken) {
      verificationToken = generateVerificationToken()
      await this.prisma.website.update({
        where: { id: website.id },
        data: {
          verificationToken,
          ...(website.verificationMethod === "SUPER_ADMIN_OVERRIDE"
            ? {}
            : {
                verificationMethod: "DNS_TXT" as const,
                verificationStatus: "PENDING_VERIFICATION" as const,
              }),
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
      // Domain identity anchors DNS ownership, marketplace inventory, orders,
      // and (eventually) provider-property bindings. A generic profile edit
      // must never retarget those records to another hostname. Formatting-only
      // URL changes for the same canonical domain remain safe.
      if (!website.canonicalDomain || domain !== website.canonicalDomain) {
        throw new BadRequestException({
          code: "WEBSITE_DOMAIN_IMMUTABLE",
          message:
            "A website domain cannot be changed after registration. Add the new domain as a separate website and verify it independently.",
        })
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.website.update({
        where: { id },
        data: {
          ...(dto.url !== undefined ? { url: dto.url } : {}),
          domain,
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.country !== undefined ? { country: dto.country } : {}),
          ...(dto.language !== undefined ? { language: dto.language } : {}),
        },
      })

      // Keep every non-archived marketplace projection consistent with the
      // Website aggregate in the same commit. Approved/paused listings are
      // included: a formatting-only URL change must not leave a stale buyer
      // projection, and a later audit failure must roll the whole edit back.
      await tx.marketplaceListing.updateMany({
        where: { websiteId: id, status: { not: ListingStatus.ARCHIVED } },
        data: {
          ...(dto.country !== undefined ? { country: dto.country } : {}),
          ...(dto.language !== undefined ? { language: dto.language } : {}),
          ...(dto.url !== undefined ? { websiteUrl: dto.url } : {}),
        },
      })

      await this.audit.log(
        {
          action: "WEBSITE_UPDATED",
          entityType: "Website",
          entityId: id,
          metadata: { url: dto.url ?? website.url },
          userId: user.id,
          organizationId,
        },
        tx,
      )

      return updated
    })
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
        metricsHistory: { orderBy: { key: "asc" } },
        moderationEvents: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 20,
        },
        websiteIntegrations: {
          include: {
            integration: true,
          },
        },
        marketplaceListings: {
          orderBy: { createdAt: "desc" },
          take: 1,
          include: {
            categories: { include: { category: true } },
            moderationEvents: {
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: 20,
            },
            services: {
              orderBy: [{ availability: "asc" }, { price: "asc" }],
            },
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

    const {
      websiteIntegrations,
      marketplaceListings,
      metricsHistory,
      moderationEvents: _moderationEvents,
      activeModerationAction: _activeModerationAction,
      activeModerationAuthority: _activeModerationAuthority,
      activeModerationReasonCode: _activeModerationReasonCode,
      activeModerationMessage: _activeModerationMessage,
      activeModerationPreviousActive: _activeModerationPreviousActive,
      moderationVersion: _moderationVersion,
      ...rest
    } = website
    const listing = marketplaceListings?.[0]

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
        (rest.verificationStatus !== "VERIFIED" ||
          rest.verificationMethod === "SUPER_ADMIN_OVERRIDE") &&
        rest.verificationToken
          ? {
              type: "DNS_TXT",
              host: "@",
              value: verificationTxtValue(rest.verificationToken),
              note: "Add this TXT record on your root domain. DNS changes can take up to 48 hours to propagate; use Re-check DNS after publishing it.",
            }
          : null,
      createdAt: rest.createdAt.toISOString(),
      updatedAt: rest.updatedAt.toISOString(),
      domainMetrics: serializeWebsiteMetrics(metricsHistory),
      moderation: this.publisherWebsiteProjection(website).moderation,
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
      listing: listing
        ? {
            ...this.publisherListingProjection(listing),
            categories: listing.categories.map((item) => item.category),
            category: listing.categories[0]?.category ?? null,
            services: listing.services.map((service) => ({
              ...service,
              price: Number(service.price),
              createdAt: service.createdAt.toISOString(),
              updatedAt: service.updatedAt.toISOString(),
            })),
            createdAt: listing.createdAt.toISOString(),
            updatedAt: listing.updatedAt.toISOString(),
          }
        : null,
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
    const websites = await this.prisma.website.findMany({
      where: { publisherId },
      include: {
        metricsHistory: { orderBy: { key: "asc" } },
        moderationEvents: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 20,
        },
        // Phase 7: legacy price + turnaroundDays selectors were dropped.
        // Surface the AVAILABLE services so callers can render per-service
        // price/TAT directly.
        marketplaceListings: {
          select: {
            id: true,
            title: true,
            slug: true,
            description: true,
            status: true,
            ownerType: true,
            activeModerationAction: true,
            activeModerationAuthority: true,
            activeModerationReasonCode: true,
            activeModerationMessage: true,
            activeModerationPreviousStatus: true,
            moderationResubmissionAllowed: true,
            moderationVersion: true,
            moderationEvents: {
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: 20,
            },
            categories: {
              select: {
                category: { select: { id: true, name: true, slug: true } },
              },
            },
            services: {
              select: {
                id: true,
                serviceType: true,
                price: true,
                currency: true,
                turnaroundDays: true,
                revisionRounds: true,
                warrantyDays: true,
                availability: true,
                version: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    })
    return websites.map((website) => {
      const projectedWebsite = this.publisherWebsiteProjection(website)
      return {
        ...projectedWebsite,
        domainMetrics: serializeWebsiteMetrics(website.metricsHistory),
        metricsHistory: undefined,
        marketplaceListings: website.marketplaceListings.map((listing) => {
          const categories = listing.categories.map((item) => item.category)
          return {
            ...this.publisherListingProjection(listing),
            categories,
            category: categories[0] ?? null,
          }
        }),
      }
    })
  }

  async deleteWebsite(
    publisherId: string,
    organizationId: string,
    id: string,
    user: any,
  ) {
    const website = await this.prisma.website.findFirst({
      where: { id, publisherId },
      select: { moderationVersion: true },
    })
    if (!website) throw new NotFoundException("Website not found")
    await this.archiveWebsite(
      publisherId,
      organizationId,
      id,
      user,
      website.moderationVersion,
    )
    return { success: true }
  }

  async archiveWebsite(
    publisherId: string,
    organizationId: string,
    id: string,
    user: any,
    expectedVersion: number,
  ) {
    return this.publisherWebsiteLifecycleCommand(
      publisherId,
      organizationId,
      id,
      user,
      expectedVersion,
      ModerationAction.ARCHIVE,
    )
  }

  async reopenWebsite(
    publisherId: string,
    organizationId: string,
    id: string,
    user: any,
    expectedVersion: number,
  ) {
    return this.publisherWebsiteLifecycleCommand(
      publisherId,
      organizationId,
      id,
      user,
      expectedVersion,
      ModerationAction.REOPEN,
    )
  }

  private async publisherWebsiteLifecycleCommand(
    publisherId: string,
    organizationId: string,
    id: string,
    user: any,
    expectedVersion: number,
    action: typeof ModerationAction.ARCHIVE | typeof ModerationAction.REOPEN,
  ) {
    const publisher = await this.prisma.publisher.findUnique({
      where: { id: publisherId },
    })
    if (!publisher || publisher.organizationId !== organizationId) {
      throw new NotFoundException("Publisher not found")
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id"
        FROM "Website"
        WHERE "id" = ${id}
        FOR UPDATE
      `
      const website = await tx.website.findFirst({
        where: { id, publisherId },
      })
      if (!website) throw new NotFoundException("Website not found")
      if (website.moderationVersion !== expectedVersion) {
        throw new ConflictException({
          code: "MODERATION_VERSION_CONFLICT",
          message: "Website moderation changed; refresh and retry",
          currentVersion: website.moderationVersion,
        })
      }
      const allowedActions = getPublisherWebsiteLifecycleActions(website)
      if (!allowedActions.includes(action)) {
        throw new BadRequestException({
          code: "MODERATION_HOLD",
          message: `This website cannot be ${action === ModerationAction.ARCHIVE ? "archived" : "reopened"} while the current moderation decision is active`,
          allowedActions,
        })
      }

      const reopening = action === ModerationAction.REOPEN

      const transition = await tx.website.updateMany({
        where: { id, publisherId, moderationVersion: expectedVersion },
        data: {
          isActive: reopening,
          activeModerationAction: reopening ? null : ModerationAction.ARCHIVE,
          activeModerationAuthority: reopening
            ? null
            : ModerationAuthority.PUBLISHER,
          activeModerationReasonCode: reopening
            ? null
            : ModerationReasonCode.PUBLISHER_REQUEST,
          activeModerationMessage: null,
          activeModerationPreviousActive: reopening ? null : website.isActive,
          moderationVersion: { increment: 1 },
        },
      })
      if (transition.count !== 1) {
        throw new ConflictException({
          code: "MODERATION_VERSION_CONFLICT",
          message: "Website moderation changed; refresh and retry",
        })
      }
      const event = await tx.moderationEvent.create({
        data: {
          scope: "WEBSITE",
          websiteId: id,
          action,
          reasonCode: reopening
            ? ModerationReasonCode.ISSUE_RESOLVED
            : ModerationReasonCode.PUBLISHER_REQUEST,
          actorUserId: user.id,
          actorStaffRole: null,
          authority: ModerationAuthority.PUBLISHER,
          previousWebsiteActive: website.isActive,
          resultingWebsiteActive: reopening,
          previousModerationAction: website.activeModerationAction,
          resultingModerationAction: reopening
            ? null
            : ModerationAction.ARCHIVE,
          resubmissionAllowed: false,
        },
      })
      await this.audit.log(
        {
          action: reopening ? "WEBSITE_REOPENED" : "WEBSITE_ARCHIVED",
          entityType: "Website",
          entityId: id,
          metadata: {
            url: website.url,
            moderationEventId: event.id,
            listingLifecyclePreserved: true,
            previousVersion: website.moderationVersion,
            resultingVersion: website.moderationVersion + 1,
          },
          userId: user.id,
          organizationId,
        },
        tx,
      )
      const updated = await tx.website.findUniqueOrThrow({ where: { id } })
      return this.publisherWebsiteProjection(updated)
    })
  }

  async submitForReview(
    publisherId: string,
    organizationId: string,
    id: string,
    user: any,
    expectedVersion?: number,
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

    if (!website.isActive) {
      throw new BadRequestException({
        code: "WEBSITE_INACTIVE",
        message: "Restore this website before submitting its listing",
      })
    }

    if (website.verificationStatus !== "VERIFIED") {
      throw new BadRequestException({
        code: "WEBSITE_NOT_VERIFIED",
        message:
          "Verify domain ownership before submitting this website for review",
      })
    }

    const listing = await this.prisma.marketplaceListing.findFirst({
      where: { websiteId: id, publisherId },
      orderBy: { createdAt: "asc" },
      include: {
        categories: { select: { categoryId: true } },
        services: {
          where: { availability: "AVAILABLE" },
          select: { id: true },
          take: 1,
        },
      },
    })

    if (!listing) {
      throw new BadRequestException({
        code: "LISTING_NOT_READY",
        message: "This website does not have a draft listing to submit",
      })
    }
    if (
      !getPublisherListingLifecycleActions(listing).includes(
        "SUBMIT_FOR_REVIEW",
      )
    ) {
      throw new BadRequestException({
        code: "MODERATION_HOLD",
        message:
          "This listing cannot be submitted while a staff moderation decision is active",
      })
    }
    if (listing.services.length === 0) {
      throw new BadRequestException({
        code: "NO_AVAILABLE_SERVICES",
        message: "Add at least one available service before submitting",
      })
    }
    if (listing.categories.length < 1 || listing.categories.length > 7) {
      throw new BadRequestException({
        code: "LISTING_CATEGORIES_REQUIRED",
        message:
          "Choose between 1 and 7 marketplace categories before submitting",
      })
    }
    if (
      !isMarketplaceLanguage(listing.language) ||
      !hasCompleteListingPolicy(listing)
    ) {
      throw new BadRequestException({
        code: "LISTING_POLICY_REQUIRED",
        message:
          "Choose a primary language and complete every listing policy before submitting",
      })
    }
    if (!listing.description.trim() || listing.description.length > 500) {
      throw new BadRequestException({
        code: "LISTING_DESCRIPTION_REQUIRED",
        message:
          "Add a listing description of no more than 500 characters before submitting",
      })
    }

    const requiredManualMetrics = await this.prisma.websiteMetric.findMany({
      where: {
        websiteId: id,
        key: {
          in: [
            WebsiteMetricKey.AHREFS_ORGANIC_TRAFFIC,
            WebsiteMetricKey.MOZ_DOMAIN_AUTHORITY,
          ],
        },
        source: { in: ["PUBLISHER_MANUAL", "ADMIN_IMPORT"] },
        status: "CURRENT",
        measuredAt: { gte: manualMetricFreshAfter() },
      },
      select: { key: true },
    })
    if (new Set(requiredManualMetrics.map((metric) => metric.key)).size < 2) {
      throw new BadRequestException({
        code: "MANUAL_METRICS_REQUIRED",
        message:
          "Add current Ahrefs organic traffic and Moz Domain Authority before submitting",
      })
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id"
        FROM "Website"
        WHERE "id" = ${id}
        FOR SHARE
      `
      await tx.$queryRaw`
        SELECT "id"
        FROM "MarketplaceListing"
        WHERE "id" = ${listing.id}
        FOR UPDATE
      `

      const [currentWebsite, currentListing] = await Promise.all([
        tx.website.findFirst({ where: { id, publisherId } }),
        tx.marketplaceListing.findUnique({
          where: { id: listing.id },
          include: {
            categories: { select: { categoryId: true } },
            services: {
              where: { availability: "AVAILABLE" },
              select: { id: true },
              take: 1,
            },
          },
        }),
      ])
      if (!currentWebsite || !currentListing) {
        throw new ConflictException({
          code: "MODERATION_VERSION_CONFLICT",
          message: "Listing moderation changed; refresh and retry",
        })
      }
      if (!currentWebsite.isActive) {
        throw new BadRequestException({
          code: "WEBSITE_INACTIVE",
          message: "Restore this website before submitting its listing",
        })
      }
      if (currentWebsite.verificationStatus !== "VERIFIED") {
        throw new BadRequestException({
          code: "WEBSITE_NOT_VERIFIED",
          message:
            "Verify domain ownership before submitting this website for review",
        })
      }
      if (
        currentListing.status !== listing.status ||
        currentListing.moderationVersion !== listing.moderationVersion ||
        (expectedVersion !== undefined &&
          currentListing.moderationVersion !== expectedVersion)
      ) {
        throw new ConflictException({
          code: "MODERATION_VERSION_CONFLICT",
          message: "Listing moderation changed; refresh and retry",
        })
      }
      if (
        !getPublisherListingLifecycleActions(currentListing).includes(
          "SUBMIT_FOR_REVIEW",
        )
      ) {
        throw new BadRequestException({
          code: "MODERATION_HOLD",
          message:
            "This listing cannot be submitted while a staff moderation decision is active",
        })
      }
      if (currentListing.services.length === 0) {
        throw new BadRequestException({
          code: "NO_AVAILABLE_SERVICES",
          message: "Add at least one available service before submitting",
        })
      }
      if (
        currentListing.categories.length < 1 ||
        currentListing.categories.length > 7
      ) {
        throw new BadRequestException({
          code: "LISTING_CATEGORIES_REQUIRED",
          message:
            "Choose between 1 and 7 marketplace categories before submitting",
        })
      }
      if (
        !isMarketplaceLanguage(currentListing.language) ||
        !hasCompleteListingPolicy(currentListing)
      ) {
        throw new BadRequestException({
          code: "LISTING_POLICY_REQUIRED",
          message:
            "Choose a primary language and complete every listing policy before submitting",
        })
      }
      if (
        !currentListing.description.trim() ||
        currentListing.description.length > 500
      ) {
        throw new BadRequestException({
          code: "LISTING_DESCRIPTION_REQUIRED",
          message:
            "Add a listing description of no more than 500 characters before submitting",
        })
      }
      const currentManualMetrics = await tx.websiteMetric.findMany({
        where: {
          websiteId: id,
          key: {
            in: [
              WebsiteMetricKey.AHREFS_ORGANIC_TRAFFIC,
              WebsiteMetricKey.MOZ_DOMAIN_AUTHORITY,
            ],
          },
          source: { in: ["PUBLISHER_MANUAL", "ADMIN_IMPORT"] },
          status: "CURRENT",
          measuredAt: { gte: manualMetricFreshAfter() },
        },
        select: { key: true },
      })
      if (new Set(currentManualMetrics.map((metric) => metric.key)).size < 2) {
        throw new BadRequestException({
          code: "MANUAL_METRICS_REQUIRED",
          message:
            "Add current Ahrefs organic traffic and Moz Domain Authority before submitting",
        })
      }

      const reasonCode =
        currentListing.status === ListingStatus.DRAFT
          ? ("INITIAL_SUBMISSION" as const)
          : ("CORRECTIONS_COMPLETE" as const)
      const updated = await tx.marketplaceListing.updateMany({
        where: {
          id: currentListing.id,
          status: currentListing.status,
          moderationVersion: currentListing.moderationVersion,
        },
        data: {
          status: ListingStatus.PENDING_REVIEW,
          activeModerationAction: "SUBMIT_FOR_REVIEW",
          activeModerationAuthority: "PUBLISHER",
          activeModerationReasonCode: reasonCode,
          activeModerationMessage: null,
          activeModerationPreviousStatus: currentListing.status,
          moderationResubmissionAllowed: false,
          moderationVersion: { increment: 1 },
        },
      })
      if (updated.count !== 1) {
        throw new ConflictException({
          code: "MODERATION_VERSION_CONFLICT",
          message: "Listing moderation changed; refresh and retry",
        })
      }

      const event = await tx.moderationEvent.create({
        data: {
          scope: "LISTING",
          listingId: currentListing.id,
          action: "SUBMIT_FOR_REVIEW",
          reasonCode,
          actorUserId: user.id,
          actorStaffRole: null,
          authority: "PUBLISHER",
          previousStatus: currentListing.status,
          resultingStatus: ListingStatus.PENDING_REVIEW,
          previousModerationAction: currentListing.activeModerationAction,
          resultingModerationAction: "SUBMIT_FOR_REVIEW",
          resubmissionAllowed: false,
        },
      })

      await this.audit.log(
        {
          action: "WEBSITE_SUBMITTED_FOR_REVIEW",
          entityType: "Website",
          entityId: id,
          metadata: {
            listingId: currentListing.id,
            previousStatus: currentListing.status,
            resultingStatus: ListingStatus.PENDING_REVIEW,
            moderationEventId: event.id,
            moderationVersion: currentListing.moderationVersion + 1,
          },
          userId: user.id,
          organizationId,
        },
        tx,
      )
    })

    return { success: true }
  }
}
