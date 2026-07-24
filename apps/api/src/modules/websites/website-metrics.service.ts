import {
  WebsiteMetricKey,
  WebsiteMetricProvider,
  WebsiteMetricSource,
  WebsiteMetricStatus,
} from "@guestpost/database"
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { AuditService } from "../audit/audit.service"
import { UpdateManualWebsiteMetricsDto } from "./dto/websites.dto"

const MANUAL_METRIC_FRESH_DAYS = 90
const DAY_MS = 86_400_000

export type WebsiteMetricWrite = {
  websiteId: string
  key: WebsiteMetricKey
  provider: WebsiteMetricProvider
  source: WebsiteMetricSource
  value: number
  measuredAt: Date
  collectedAt?: Date
  expiresAt?: Date | null
  enteredByUserId?: string | null
  importBatchId?: string | null
  status?: WebsiteMetricStatus
  metadata?: Record<string, unknown>
}

type ManualMetricValues = {
  ahrefsOrganicTraffic: number
  mozDomainAuthority: number
}

export function assertManualMetricValues(values: ManualMetricValues) {
  if (
    !Number.isSafeInteger(values.ahrefsOrganicTraffic) ||
    values.ahrefsOrganicTraffic < 0 ||
    values.ahrefsOrganicTraffic > 2_147_483_647
  ) {
    throw new BadRequestException({
      code: "INVALID_AHREFS_TRAFFIC",
      message:
        "Ahrefs organic traffic must be a whole number from 0 to 2147483647",
    })
  }
  if (
    !Number.isSafeInteger(values.mozDomainAuthority) ||
    values.mozDomainAuthority < 0 ||
    values.mozDomainAuthority > 100
  ) {
    throw new BadRequestException({
      code: "INVALID_MOZ_DOMAIN_AUTHORITY",
      message: "Moz Domain Authority must be a whole number from 0 to 100",
    })
  }
}

export function assertMeasurementDate(
  value: string,
  field: string,
  options: { requireFresh?: boolean } = {},
): Date {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00.000Z`)
    : new Date(Number.NaN)
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new BadRequestException({
      code: "INVALID_METRIC_DATE",
      message: `${field} must be a real date in YYYY-MM-DD format`,
    })
  }
  const todayUtc = new Date()
  todayUtc.setUTCHours(0, 0, 0, 0)
  if (date.getTime() > todayUtc.getTime()) {
    throw new BadRequestException({
      code: "METRIC_DATE_IN_FUTURE",
      message: `${field} cannot be in the future`,
    })
  }
  if (
    options.requireFresh &&
    date.getTime() < manualMetricFreshAfter(todayUtc).getTime()
  ) {
    throw new BadRequestException({
      code: "METRIC_DATE_STALE",
      message: `${field} must be within the last ${MANUAL_METRIC_FRESH_DAYS} days`,
    })
  }
  return date
}

export function manualMetricExpiry(measuredAt: Date): Date {
  return new Date(measuredAt.getTime() + MANUAL_METRIC_FRESH_DAYS * DAY_MS)
}

export function manualMetricFreshAfter(now = new Date()): Date {
  const cutoff = new Date(now)
  cutoff.setUTCHours(0, 0, 0, 0)
  cutoff.setUTCDate(cutoff.getUTCDate() - MANUAL_METRIC_FRESH_DAYS)
  return cutoff
}

// Keep a forensic revision before replacing a current metric. Both writes run
// in the caller's transaction so a failed replacement cannot lose history.
export async function upsertWebsiteMetric(tx: any, input: WebsiteMetricWrite) {
  const current = await tx.websiteMetric.findUnique({
    where: {
      websiteId_key: { websiteId: input.websiteId, key: input.key },
    },
  })
  if (current) {
    await tx.websiteMetricRevision.create({
      data: {
        metricId: current.id,
        websiteId: current.websiteId,
        key: current.key,
        provider: current.provider,
        source: current.source,
        status: current.status,
        value: current.value,
        measuredAt: current.measuredAt,
        collectedAt: current.collectedAt,
        expiresAt: current.expiresAt,
        enteredByUserId: current.enteredByUserId,
        importBatchId: current.importBatchId,
        metadata: input.metadata ?? undefined,
      },
    })
  }

  const data = {
    provider: input.provider,
    source: input.source,
    status: input.status ?? WebsiteMetricStatus.CURRENT,
    value: input.value,
    measuredAt: input.measuredAt,
    collectedAt: input.collectedAt ?? new Date(),
    expiresAt: input.expiresAt ?? null,
    enteredByUserId: input.enteredByUserId ?? null,
    importBatchId: input.importBatchId ?? null,
  }
  return current
    ? tx.websiteMetric.update({ where: { id: current.id }, data })
    : tx.websiteMetric.create({
        data: { websiteId: input.websiteId, key: input.key, ...data },
      })
}

export function serializeWebsiteMetrics(metrics: any[]) {
  const byKey = new Map(metrics.map((metric) => [metric.key, metric]))
  const project = (key: WebsiteMetricKey) => {
    const metric = byKey.get(key)
    if (!metric) return undefined
    return {
      value: Number(metric.value),
      source: metric.source,
      status:
        metric.expiresAt && new Date(metric.expiresAt) < new Date()
          ? WebsiteMetricStatus.STALE
          : metric.status,
      measuredAt: metric.measuredAt.toISOString(),
      collectedAt: metric.collectedAt.toISOString(),
      expiresAt: metric.expiresAt?.toISOString() ?? null,
    }
  }
  return {
    ahrefsDomainRating: project(WebsiteMetricKey.AHREFS_DOMAIN_RATING),
    ahrefsOrganicTraffic: project(WebsiteMetricKey.AHREFS_ORGANIC_TRAFFIC),
    mozDomainAuthority: project(WebsiteMetricKey.MOZ_DOMAIN_AUTHORITY),
    openPageRank: project(WebsiteMetricKey.OPEN_PAGE_RANK),
    openPageRankGlobalRank: project(
      WebsiteMetricKey.OPEN_PAGE_RANK_GLOBAL_RANK,
    ),
    openPageRankReferringDomains: project(
      WebsiteMetricKey.OPEN_PAGE_RANK_REFERRING_DOMAINS,
    ),
  }
}

// Display-safe marketplace shape. Raw provider payloads and actor identifiers
// never leave this projection; publisher- and platform-owned websites use the
// exact same source/status contract.
export function serializeMarketplaceDomainMetrics(metrics: any[]) {
  const serialized = serializeWebsiteMetrics(metrics)
  if (Object.values(serialized).every((metric) => metric == null)) {
    return undefined
  }
  return {
    ahrefs: {
      domainRating: serialized.ahrefsDomainRating,
      organicTraffic: serialized.ahrefsOrganicTraffic,
    },
    moz: { domainAuthority: serialized.mozDomainAuthority },
    openPageRank: {
      pageRank: serialized.openPageRank,
      globalRank: serialized.openPageRankGlobalRank,
      referringDomains: serialized.openPageRankReferringDomains,
    },
  }
}

@Injectable()
export class WebsiteMetricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async updatePublisherManualMetrics(
    publisherId: string,
    organizationId: string,
    websiteId: string,
    dto: UpdateManualWebsiteMetricsDto,
    user: { id: string },
  ) {
    assertManualMetricValues(dto)
    const website = await this.prisma.website.findFirst({
      where: { id: websiteId, publisherId, ownershipType: "PUBLISHER" },
      include: { publisher: { select: { organizationId: true } } },
    })
    if (!website) throw new NotFoundException("Website not found")
    if (website.publisher?.organizationId !== organizationId) {
      throw new ForbiddenException("Website is outside the active publisher")
    }

    const trafficAsOf = assertMeasurementDate(
      dto.ahrefsTrafficAsOf,
      "ahrefsTrafficAsOf",
    )
    const mozAsOf = assertMeasurementDate(
      dto.mozDomainAuthorityAsOf,
      "mozDomainAuthorityAsOf",
    )

    await this.prisma.$transaction(async (tx: any) => {
      await upsertWebsiteMetric(tx, {
        websiteId,
        key: WebsiteMetricKey.AHREFS_ORGANIC_TRAFFIC,
        provider: WebsiteMetricProvider.AHREFS,
        source: WebsiteMetricSource.PUBLISHER_MANUAL,
        value: dto.ahrefsOrganicTraffic,
        measuredAt: trafficAsOf,
        expiresAt: manualMetricExpiry(trafficAsOf),
        enteredByUserId: user.id,
      })
      await upsertWebsiteMetric(tx, {
        websiteId,
        key: WebsiteMetricKey.MOZ_DOMAIN_AUTHORITY,
        provider: WebsiteMetricProvider.MOZ,
        source: WebsiteMetricSource.PUBLISHER_MANUAL,
        value: dto.mozDomainAuthority,
        measuredAt: mozAsOf,
        expiresAt: manualMetricExpiry(mozAsOf),
        enteredByUserId: user.id,
      })
      // Compatibility read model only. Provenance remains WebsiteMetric.
      await tx.marketplaceListing.updateMany({
        where: { websiteId },
        data: {
          domainAuthority: dto.mozDomainAuthority,
          traffic: Math.round(dto.ahrefsOrganicTraffic),
        },
      })
      await this.audit.log(
        {
          action: "WEBSITE_MANUAL_METRICS_UPDATED",
          entityType: "Website",
          entityId: websiteId,
          metadata: {
            ahrefsOrganicTraffic: dto.ahrefsOrganicTraffic,
            ahrefsTrafficAsOf: trafficAsOf.toISOString(),
            mozDomainAuthority: dto.mozDomainAuthority,
            mozDomainAuthorityAsOf: mozAsOf.toISOString(),
            source: "PUBLISHER_MANUAL",
          },
          userId: user.id,
          organizationId,
        },
        tx,
      )
    })

    return this.getWebsiteMetrics(websiteId)
  }

  async getWebsiteMetrics(websiteId: string) {
    const metrics = await this.prisma.websiteMetric.findMany({
      where: { websiteId },
      orderBy: { key: "asc" },
    })
    return serializeWebsiteMetrics(metrics)
  }
}
