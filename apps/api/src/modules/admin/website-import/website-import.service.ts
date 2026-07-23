import { createHash } from "node:crypto"
import path from "node:path"
import {
  ListingStatus,
  Prisma,
  ServiceType,
  WebsiteImportRowStatus,
  WebsiteMetricKey,
  WebsiteMetricProvider,
  WebsiteMetricSource,
} from "@guestpost/database"
import {
  generateVerificationToken,
  hasUnsafeMarketplaceText,
  isWebsiteAddressListingTitle,
  LISTING_LINK_TYPES,
  LISTING_LINK_VALIDITIES,
  MARKETPLACE_LANGUAGES,
  QUEUE_JOBS,
  QUEUES,
  validateWebsiteOrigin,
} from "@guestpost/shared"
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { normalizeDomain } from "../../../common/domain"
import { PrismaService } from "../../../common/prisma.service"
import { AuditService } from "../../audit/audit.service"
import { QueueService } from "../../queues/queue.service"
import {
  manualMetricExpiry,
  upsertWebsiteMetric,
} from "../../websites/website-metrics.service"
import {
  CsvValidationError,
  parseWebsiteImportCsv,
  type WebsiteImportCsvRow,
} from "./csv-parser"

type NormalizedImportRow = {
  url: string
  canonicalDomain: string
  websiteName: string | null
  listingTitle: string
  description: string
  country: string | null
  language: string | null
  categoryIds: string[]
  sportsGamingAllowed: boolean | null
  pharmacyAllowed: boolean | null
  cryptoAllowed: boolean | null
  backlinkCount: number | null
  linkType: string | null
  linkValidity: string | null
  googleNews: boolean | null
  markedSponsored: boolean | null
  foreignLanguageAllowed: boolean | null
  ahrefsOrganicTraffic: number | null
  ahrefsTrafficAsOf: string | null
  mozDomainAuthority: number | null
  mozDomainAuthorityAsOf: string | null
  initialService: {
    serviceType: ServiceType
    price: number
    currency: string
    turnaroundDays: number
    revisionRounds: number
    warrantyDays: number | null
  } | null
}

function optionalBoolean(
  value: string,
  field: string,
  warnings: string[],
): boolean | null {
  if (!value) return null
  if (value === "true") return true
  if (value === "false") return false
  warnings.push(`${field} was skipped; use true, false, or blank`)
  return null
}

function optionalInteger(
  value: string,
  field: string,
  warnings: string[],
  min: number,
  max: number,
): number | null {
  if (!value) return null
  if (!/^\d+$/.test(value)) {
    warnings.push(`${field} was skipped; use a whole number`)
    return null
  }
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    warnings.push(`${field} was skipped; use a value between ${min} and ${max}`)
    return null
  }
  return number
}

function optionalDate(
  value: string,
  field: string,
  warnings: string[],
): string | null {
  if (!value) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    warnings.push(`${field} was skipped; use YYYY-MM-DD`)
    return null
  }
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    warnings.push(`${field} was skipped because it is not a valid date`)
    return null
  }
  const todayUtc = new Date()
  todayUtc.setUTCHours(0, 0, 0, 0)
  if (parsed.getTime() > todayUtc.getTime()) {
    warnings.push(`${field} was skipped because it cannot be in the future`)
    return null
  } else if (parsed.getTime() < Date.now() - 90 * 86_400_000) {
    warnings.push(
      `${field} is older than 90 days and must be refreshed before review`,
    )
  }
  return parsed.toISOString()
}

function safeFileName(value: string): string {
  const name = path.basename(value || "website-import.csv")
  return name.replace(/[\u0000-\u001f\u007f]/g, "_").slice(0, 255)
}

@Injectable()
export class WebsiteImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  private async getEligiblePublisher(publisherId: string) {
    const publisher = await this.prisma.publisher.findUnique({
      where: { id: publisherId },
      include: {
        publisherMemberships: {
          where: { role: "PUBLISHER_OWNER", user: { banned: false } },
          select: { userId: true },
          take: 1,
        },
      },
    })
    if (!publisher) throw new NotFoundException("Publisher not found")
    if (publisher.publisherMemberships.length === 0) {
      throw new BadRequestException({
        code: "PUBLISHER_HAS_NO_ACTIVE_OWNER",
        message: "Choose a publisher with an active owner account",
      })
    }
    return publisher
  }

  private normalizeRow(
    row: WebsiteImportCsvRow,
    categoriesBySlug: Map<string, { id: string; name: string }>,
  ): {
    normalized: NormalizedImportRow | null
    errors: string[]
    warnings: string[]
  } {
    const errors: string[] = []
    const warnings: string[] = []
    const urlIssue = validateWebsiteOrigin(row.website_url)
    if (urlIssue) errors.push(urlIssue.message)

    let canonicalDomain = ""
    if (!urlIssue) {
      try {
        canonicalDomain = normalizeDomain(row.website_url)
      } catch (error) {
        errors.push(
          error instanceof Error ? error.message : "Invalid website URL",
        )
      }
    }

    let websiteName = row.website_name || null
    if (
      websiteName &&
      (websiteName.length > 100 ||
        hasUnsafeMarketplaceText(websiteName, { singleLine: true }))
    ) {
      warnings.push(
        "website_name was skipped; use 100 characters or fewer without HTML or control characters",
      )
      websiteName = null
    }

    let country = row.country || null
    if (
      country &&
      (country.length > 100 ||
        hasUnsafeMarketplaceText(country, { singleLine: true }))
    ) {
      warnings.push(
        "country was skipped; use 100 characters or fewer without HTML or control characters",
      )
      country = null
    }

    const derivedListingTitle = websiteName
      ? `${websiteName} guest publishing`
      : `Guest publishing on ${canonicalDomain || "website"}`
    let listingTitle = row.listing_title || derivedListingTitle
    if (
      listingTitle.length < 3 ||
      listingTitle.length > 200 ||
      hasUnsafeMarketplaceText(listingTitle, { singleLine: true }) ||
      isWebsiteAddressListingTitle(listingTitle)
    ) {
      warnings.push(
        "listing_title was skipped; use a descriptive 3–200 character title, not a URL",
      )
      listingTitle = derivedListingTitle
    } else if (!row.listing_title) {
      warnings.push("listing_title was derived and should be reviewed")
    }

    let description = row.description
    if (
      description &&
      (description.length < 20 ||
        description.length > 500 ||
        hasUnsafeMarketplaceText(description))
    ) {
      warnings.push(
        "description was skipped; use 20–500 characters without HTML or control characters",
      )
      description = ""
    }
    if (!description) warnings.push("description is required before review")

    let language = row.primary_language || null
    if (
      language &&
      !(MARKETPLACE_LANGUAGES as readonly string[]).includes(language)
    ) {
      warnings.push(
        "primary_language was skipped because it is not in the supported language list",
      )
      language = null
    }
    if (!language) warnings.push("primary_language is required before review")

    const categorySlugs = row.category_slugs
      ? row.category_slugs
          .split("|")
          .map((slug) => slug.trim())
          .filter(Boolean)
      : []
    const seenCategorySlugs = new Set<string>()
    const categoryIds: string[] = []
    for (const slug of categorySlugs) {
      if (seenCategorySlugs.has(slug)) {
        warnings.push(`Duplicate category slug was skipped: ${slug}`)
        continue
      }
      seenCategorySlugs.add(slug)
      const category = categoriesBySlug.get(slug)
      if (!category) {
        warnings.push(`Unknown or inactive category slug was skipped: ${slug}`)
      } else if (categoryIds.length >= 7) {
        warnings.push(
          `Category slug was skipped because the limit is 7: ${slug}`,
        )
      } else {
        categoryIds.push(category.id)
      }
    }
    if (categoryIds.length === 0)
      warnings.push("at least one category is required before review")

    const sportsGamingAllowed = optionalBoolean(
      row.sports_gaming_allowed,
      "sports_gaming_allowed",
      warnings,
    )
    const pharmacyAllowed = optionalBoolean(
      row.pharmacy_allowed,
      "pharmacy_allowed",
      warnings,
    )
    const cryptoAllowed = optionalBoolean(
      row.crypto_allowed,
      "crypto_allowed",
      warnings,
    )
    const googleNews = optionalBoolean(row.google_news, "google_news", warnings)
    const markedSponsored = optionalBoolean(
      row.marked_sponsored,
      "marked_sponsored",
      warnings,
    )
    const foreignLanguageAllowed = optionalBoolean(
      row.foreign_language_allowed,
      "foreign_language_allowed",
      warnings,
    )
    const backlinkCount = optionalInteger(
      row.backlink_count,
      "backlink_count",
      warnings,
      1,
      3,
    )
    let linkType = row.link_type || null
    let linkValidity = row.link_validity || null
    if (
      linkType &&
      !(LISTING_LINK_TYPES as readonly string[]).includes(linkType)
    ) {
      warnings.push("link_type was skipped because it is invalid")
      linkType = null
    }
    if (
      linkValidity &&
      !(LISTING_LINK_VALIDITIES as readonly string[]).includes(linkValidity)
    ) {
      warnings.push("link_validity was skipped because it is invalid")
      linkValidity = null
    }
    if (
      [
        sportsGamingAllowed,
        pharmacyAllowed,
        cryptoAllowed,
        backlinkCount,
        linkType,
        linkValidity,
        googleNews,
        markedSponsored,
        foreignLanguageAllowed,
      ].some((value) => value === null)
    ) {
      warnings.push("all placement policies are required before review")
    }

    let ahrefsOrganicTraffic = optionalInteger(
      row.ahrefs_organic_traffic,
      "ahrefs_organic_traffic",
      warnings,
      0,
      2_147_483_647,
    )
    let ahrefsTrafficAsOf = optionalDate(
      row.ahrefs_traffic_as_of,
      "ahrefs_traffic_as_of",
      warnings,
    )
    if ((ahrefsOrganicTraffic === null) !== (ahrefsTrafficAsOf === null)) {
      warnings.push(
        "Ahrefs traffic was skipped because value and as-of date must both be valid",
      )
      ahrefsOrganicTraffic = null
      ahrefsTrafficAsOf = null
    }
    if (ahrefsOrganicTraffic === null && ahrefsTrafficAsOf === null) {
      warnings.push("Ahrefs organic traffic is required before review")
    }

    let mozDomainAuthority = optionalInteger(
      row.moz_domain_authority,
      "moz_domain_authority",
      warnings,
      0,
      100,
    )
    let mozDomainAuthorityAsOf = optionalDate(
      row.moz_da_as_of,
      "moz_da_as_of",
      warnings,
    )
    if ((mozDomainAuthority === null) !== (mozDomainAuthorityAsOf === null)) {
      warnings.push(
        "Moz Domain Authority was skipped because value and as-of date must both be valid",
      )
      mozDomainAuthority = null
      mozDomainAuthorityAsOf = null
    }
    if (mozDomainAuthority === null && mozDomainAuthorityAsOf === null) {
      warnings.push("Moz Domain Authority is required before review")
    }

    const serviceFields = [
      row.service_type,
      row.service_price,
      row.currency,
      row.turnaround_days,
      row.revision_rounds,
      row.warranty_days,
    ]
    let initialService: NormalizedImportRow["initialService"] = null
    if (serviceFields.some(Boolean)) {
      const serviceType = Object.values(ServiceType).includes(
        row.service_type as ServiceType,
      )
        ? (row.service_type as ServiceType)
        : null
      if (!serviceType)
        warnings.push("service_type was skipped because it is invalid")
      const price = Number(row.service_price)
      const validPriceFormat = /^\d+(?:\.\d{1,2})?$/.test(row.service_price)
      if (
        !row.service_price ||
        !validPriceFormat ||
        !Number.isFinite(price) ||
        price <= 0 ||
        price > 1_000_000
      ) {
        warnings.push(
          "service_price was skipped; use a number greater than 0 and no more than 1000000",
        )
      }
      const currency = row.currency
      if (!(["USD", "EUR", "GBP"] as const).includes(currency as any)) {
        warnings.push("currency was skipped; use USD, EUR, or GBP")
      }
      const turnaroundDays = optionalInteger(
        row.turnaround_days,
        "turnaround_days",
        warnings,
        1,
        365,
      )
      const revisionRounds = row.revision_rounds
        ? (optionalInteger(
            row.revision_rounds,
            "revision_rounds",
            warnings,
            0,
            20,
          ) ?? 2)
        : 2
      const warrantyDays = optionalInteger(
        row.warranty_days,
        "warranty_days",
        warnings,
        0,
        3650,
      )
      if (
        serviceType &&
        validPriceFormat &&
        Number.isFinite(price) &&
        price > 0 &&
        price <= 1_000_000 &&
        ["USD", "EUR", "GBP"].includes(currency) &&
        turnaroundDays !== null &&
        revisionRounds !== null
      ) {
        initialService = {
          serviceType,
          price,
          currency,
          turnaroundDays,
          revisionRounds,
          warrantyDays,
        }
      } else {
        warnings.push(
          "initial service was skipped because its required values were incomplete or invalid",
        )
      }
    } else {
      warnings.push("at least one available service is required before review")
    }

    if (errors.length > 0 || !canonicalDomain) {
      return { normalized: null, errors, warnings }
    }
    return {
      normalized: {
        url: row.website_url,
        canonicalDomain,
        websiteName,
        listingTitle,
        description,
        country,
        language,
        categoryIds,
        sportsGamingAllowed,
        pharmacyAllowed,
        cryptoAllowed,
        backlinkCount,
        linkType,
        linkValidity,
        googleNews,
        markedSponsored,
        foreignLanguageAllowed,
        ahrefsOrganicTraffic,
        ahrefsTrafficAsOf,
        mozDomainAuthority,
        mozDomainAuthorityAsOf,
        initialService,
      },
      errors,
      warnings: [...new Set(warnings)],
    }
  }

  async preview(
    file: {
      originalname?: string
      buffer?: Buffer
      size?: number
      mimetype?: string
    },
    publisherId: string,
    actor: { id: string },
  ) {
    if (!file?.buffer || file.buffer.length === 0) {
      throw new BadRequestException({
        code: "CSV_REQUIRED",
        message: "Choose a CSV file",
      })
    }
    if (file.buffer.length > 2 * 1024 * 1024) {
      throw new BadRequestException({
        code: "CSV_TOO_LARGE",
        message: "CSV must be 2 MB or smaller",
      })
    }
    const fileName = safeFileName(file.originalname ?? "website-import.csv")
    if (!fileName.toLowerCase().endsWith(".csv")) {
      throw new BadRequestException({
        code: "INVALID_FILE_TYPE",
        message: "File must use the .csv extension",
      })
    }
    const publisher = await this.getEligiblePublisher(publisherId)
    let rows: WebsiteImportCsvRow[]
    try {
      rows = parseWebsiteImportCsv(file.buffer.toString("utf8"))
    } catch (error) {
      if (error instanceof CsvValidationError) {
        throw new BadRequestException({
          code: "INVALID_CSV",
          message: error.message,
        })
      }
      throw error
    }

    const categories = await this.prisma.marketplaceCategory.findMany({
      where: { isActive: true },
      select: { id: true, slug: true, name: true },
    })
    const categoriesBySlug = new Map(
      categories.map((category) => [category.slug, category]),
    )
    const normalized = rows.map((row) => ({
      row,
      ...this.normalizeRow(row, categoriesBySlug),
    }))
    const domainCounts = new Map<string, number>()
    for (const result of normalized) {
      if (result.normalized?.canonicalDomain) {
        domainCounts.set(
          result.normalized.canonicalDomain,
          (domainCounts.get(result.normalized.canonicalDomain) ?? 0) + 1,
        )
      }
    }
    const candidateDomains = [...domainCounts.keys()]
    // Older rows may still store the hostname with a leading www. Query both
    // forms, then normalize every returned identity before comparing. This
    // keeps legacy inventory from bypassing the row-level duplicate guard.
    const candidateDomainAliases = candidateDomains.flatMap((domain) => [
      domain,
      `www.${domain}`,
    ])
    const existing = await this.prisma.website.findMany({
      where: {
        OR: [
          { canonicalDomain: { in: candidateDomainAliases } },
          { domain: { in: candidateDomainAliases } },
        ],
      },
      select: { canonicalDomain: true, domain: true },
    })
    const existingDomains = new Set<string>()
    for (const website of existing) {
      for (const identity of [website.canonicalDomain, website.domain]) {
        if (!identity) continue
        try {
          existingDomains.add(normalizeDomain(identity))
        } catch {
          // A corrupt legacy identity is not trusted as a dedupe key. The
          // database uniqueness constraint remains the commit-time backstop.
        }
      }
    }

    const rowData = normalized.map((result) => {
      const domain = result.normalized?.canonicalDomain
      const errors = [...result.errors]
      if (domain && (domainCounts.get(domain) ?? 0) > 1) {
        errors.push(`Domain ${domain} appears more than once in this CSV`)
      }
      if (domain && existingDomains.has(domain)) {
        errors.push(`Domain ${domain} is already registered`)
      }
      return {
        rowNumber: result.row.rowNumber,
        canonicalDomain: domain ?? null,
        status:
          errors.length > 0
            ? WebsiteImportRowStatus.ERROR
            : result.warnings.length > 0
              ? WebsiteImportRowStatus.WARNING
              : WebsiteImportRowStatus.READY,
        normalizedData:
          errors.length > 0
            ? undefined
            : (result.normalized as unknown as Prisma.InputJsonValue),
        errors: [...new Set(errors)],
        warnings: result.warnings,
      }
    })
    const summary = {
      totalRows: rowData.length,
      readyRows: rowData.filter((row) => row.status === "READY").length,
      warningRows: rowData.filter((row) => row.status === "WARNING").length,
      errorRows: rowData.filter((row) => row.status === "ERROR").length,
    }
    const fileHash = createHash("sha256").update(file.buffer).digest("hex")
    const batch = await this.prisma.websiteImportBatch.create({
      data: {
        publisherId,
        organizationId: publisher.organizationId,
        actorUserId: actor.id,
        fileName,
        fileHash,
        ...summary,
        rows: { create: rowData },
      },
      include: { rows: { orderBy: { rowNumber: "asc" } } },
    })
    await this.audit.log({
      action: "WEBSITE_IMPORT_PREVIEWED",
      entityType: "WebsiteImportBatch",
      entityId: batch.id,
      metadata: { publisherId, fileHash, ...summary },
      userId: actor.id,
      organizationId: publisher.organizationId,
    })
    return batch
  }

  async commit(batchId: string, idempotencyKey: string, actor: { id: string }) {
    let batch = await this.prisma.websiteImportBatch.findUnique({
      where: { id: batchId },
      include: { rows: { orderBy: { rowNumber: "asc" } }, publisher: true },
    })
    if (!batch || batch.actorUserId !== actor.id) {
      throw new NotFoundException("Import batch not found")
    }
    if (["COMPLETED", "PARTIAL"].includes(batch.status)) {
      if (batch.idempotencyKey !== idempotencyKey) {
        throw new ConflictException(
          "Import batch was committed with a different idempotency key",
        )
      }
      return batch
    }
    const resuming = batch.status === "COMMITTING"
    if (
      (resuming && batch.idempotencyKey !== idempotencyKey) ||
      (!resuming && batch.status !== "PREVIEWED")
    ) {
      throw new ConflictException("Import batch is not ready to commit")
    }
    await this.getEligiblePublisher(batch.publisherId)
    if (!resuming) {
      try {
        const claimed = await this.prisma.websiteImportBatch.updateMany({
          where: { id: batch.id, actorUserId: actor.id, status: "PREVIEWED" },
          data: { status: "COMMITTING", idempotencyKey },
        })
        if (claimed.count === 0)
          throw new ConflictException("Import batch was already claimed")
      } catch (error: any) {
        if (error?.code === "P2002") {
          throw new ConflictException("This idempotency key was already used")
        }
        throw error
      }
    }

    const createdWebsiteIds = batch.rows.flatMap((row) =>
      row.status === "CREATED" && row.websiteId ? [row.websiteId] : [],
    )
    let createdRows = createdWebsiteIds.length
    let skippedRows =
      batch.errorRows +
      batch.rows.filter((row) => row.status === "SKIPPED").length
    let failedRows = batch.rows.filter((row) => row.status === "FAILED").length
    for (const row of batch.rows.filter((row) =>
      ["READY", "WARNING"].includes(row.status),
    )) {
      const data = row.normalizedData as unknown as NormalizedImportRow
      try {
        const exists = await this.prisma.website.findFirst({
          where: {
            OR: [
              { canonicalDomain: data.canonicalDomain },
              { domain: data.canonicalDomain },
              { url: data.url },
            ],
          },
          select: { id: true },
        })
        if (exists) {
          await this.prisma.websiteImportRow.update({
            where: { id: row.id },
            data: {
              status: "SKIPPED",
              errors: [
                `Domain ${data.canonicalDomain} was registered after preview`,
              ],
            },
          })
          skippedRows++
          continue
        }

        const website = await this.prisma.$transaction(async (tx: any) => {
          const activeCategoryCount = data.categoryIds.length
            ? await tx.marketplaceCategory.count({
                where: { id: { in: data.categoryIds }, isActive: true },
              })
            : 0
          if (activeCategoryCount !== data.categoryIds.length) {
            throw new Error("CATEGORY_CHANGED_AFTER_PREVIEW")
          }
          const created = await tx.website.create({
            data: {
              url: data.url,
              domain: data.canonicalDomain,
              canonicalDomain: data.canonicalDomain,
              name: data.websiteName,
              country: data.country,
              language: data.language,
              publisherId: batch!.publisherId,
              ownershipType: "PUBLISHER",
              verificationStatus: "PENDING_VERIFICATION",
              verificationMethod: "DNS_TXT",
              verificationToken: generateVerificationToken(),
              importBatchId: batch!.id,
            },
          })
          await tx.marketplaceListing.create({
            data: {
              title: data.listingTitle,
              slug: `publisher-import-${created.id}`,
              description: data.description,
              status: ListingStatus.DRAFT,
              fulfillmentType: "PUBLISHER",
              ownerType: "PUBLISHER",
              currency: data.initialService?.currency ?? "USD",
              country: data.country,
              language: data.language,
              websiteUrl: data.url,
              websiteId: created.id,
              publisherId: batch!.publisherId,
              organizationId: batch!.organizationId,
              sportsGamingAllowed: data.sportsGamingAllowed,
              pharmacyAllowed: data.pharmacyAllowed,
              cryptoAllowed: data.cryptoAllowed,
              backlinkCount: data.backlinkCount,
              linkType: data.linkType,
              linkValidity: data.linkValidity,
              googleNews: data.googleNews,
              markedSponsored: data.markedSponsored,
              foreignLanguageAllowed: data.foreignLanguageAllowed,
              domainAuthority: data.mozDomainAuthority,
              traffic: data.ahrefsOrganicTraffic,
              categories: data.categoryIds.length
                ? {
                    create: data.categoryIds.map((categoryId) => ({
                      category: { connect: { id: categoryId } },
                    })),
                  }
                : undefined,
              services: data.initialService
                ? {
                    create: [
                      {
                        ...data.initialService,
                        warrantyDays:
                          data.initialService.warrantyDays ?? undefined,
                        availability: "AVAILABLE",
                      },
                    ],
                  }
                : undefined,
            },
          })
          if (data.ahrefsOrganicTraffic !== null && data.ahrefsTrafficAsOf) {
            const measuredAt = new Date(data.ahrefsTrafficAsOf)
            await upsertWebsiteMetric(tx, {
              websiteId: created.id,
              key: WebsiteMetricKey.AHREFS_ORGANIC_TRAFFIC,
              provider: WebsiteMetricProvider.AHREFS,
              source: WebsiteMetricSource.ADMIN_IMPORT,
              value: data.ahrefsOrganicTraffic,
              measuredAt,
              expiresAt: manualMetricExpiry(measuredAt),
              enteredByUserId: actor.id,
              importBatchId: batch!.id,
            })
          }
          if (data.mozDomainAuthority !== null && data.mozDomainAuthorityAsOf) {
            const measuredAt = new Date(data.mozDomainAuthorityAsOf)
            await upsertWebsiteMetric(tx, {
              websiteId: created.id,
              key: WebsiteMetricKey.MOZ_DOMAIN_AUTHORITY,
              provider: WebsiteMetricProvider.MOZ,
              source: WebsiteMetricSource.ADMIN_IMPORT,
              value: data.mozDomainAuthority,
              measuredAt,
              expiresAt: manualMetricExpiry(measuredAt),
              enteredByUserId: actor.id,
              importBatchId: batch!.id,
            })
          }
          await tx.websiteImportRow.update({
            where: { id: row.id },
            data: { status: "CREATED", websiteId: created.id },
          })
          await this.audit.log(
            {
              action: "PUBLISHER_WEBSITE_IMPORTED",
              entityType: "Website",
              entityId: created.id,
              metadata: {
                importBatchId: batch!.id,
                rowNumber: row.rowNumber,
                publisherId: batch!.publisherId,
                canonicalDomain: data.canonicalDomain,
              },
              userId: actor.id,
              organizationId: batch!.organizationId,
            },
            tx,
          )
          return created
        })
        createdWebsiteIds.push(website.id)
        createdRows++
      } catch (error: any) {
        const duplicate = error?.code === "P2002"
        await this.prisma.websiteImportRow.update({
          where: { id: row.id },
          data: {
            status: duplicate ? "SKIPPED" : "FAILED",
            errors: [
              duplicate
                ? `Domain ${data.canonicalDomain} is already registered`
                : error?.message === "CATEGORY_CHANGED_AFTER_PREVIEW"
                  ? "A selected category became unavailable after preview"
                  : "Row could not be imported; retry after reviewing server logs",
            ],
          },
        })
        if (duplicate) skippedRows++
        else failedRows++
      }
    }

    const status = failedRows > 0 || skippedRows > 0 ? "PARTIAL" : "COMPLETED"
    batch = await this.prisma.websiteImportBatch.update({
      where: { id: batch.id },
      data: {
        status,
        createdRows,
        skippedRows,
        failedRows,
        committedAt: new Date(),
      },
      include: { rows: { orderBy: { rowNumber: "asc" } }, publisher: true },
    })
    for (let offset = 0; offset < createdWebsiteIds.length; offset += 100) {
      const websiteIds = createdWebsiteIds.slice(offset, offset + 100)
      try {
        await this.queue.addJob(
          QUEUES.DOMAIN_METRICS,
          QUEUE_JOBS[QUEUES.DOMAIN_METRICS].SYNC,
          { websiteIds, trigger: "ADMIN_IMPORT", importBatchId: batch.id },
          { jobId: `domain-metrics-import-${batch.id}-${offset / 100}` },
        )
      } catch {
        // The monthly refresh recovers a missed wake-up/job enqueue.
      }
    }
    await this.audit.log({
      action: "WEBSITE_IMPORT_COMMITTED",
      entityType: "WebsiteImportBatch",
      entityId: batch.id,
      metadata: {
        publisherId: batch.publisherId,
        totalRows: batch.totalRows,
        createdRows,
        skippedRows,
        failedRows,
      },
      userId: actor.id,
      organizationId: batch.organizationId,
    })
    return batch
  }

  async getBatch(batchId: string, actor: { id: string }) {
    const batch = await this.prisma.websiteImportBatch.findFirst({
      where: { id: batchId, actorUserId: actor.id },
      include: { rows: { orderBy: { rowNumber: "asc" } }, publisher: true },
    })
    if (!batch) throw new NotFoundException("Import batch not found")
    return batch
  }

  async listBatches(actor: { id: string }) {
    return this.prisma.websiteImportBatch.findMany({
      where: { actorUserId: actor.id },
      include: { publisher: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "desc" },
      take: 50,
    })
  }
}
