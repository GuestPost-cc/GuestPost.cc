import {
  prisma,
  WebsiteMetricKey,
  WebsiteMetricProvider,
  WebsiteMetricSource,
} from "@guestpost/database"
import { QUEUE_JOBS, QUEUES } from "@guestpost/shared"
import { verifyJobPayload } from "@guestpost/shared/dist/job-signing"
import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"
import {
  DomainMetricProviderError,
  fetchAhrefsDomainRating,
  fetchOpenPageRanks,
} from "../domain-metrics/providers"
import { createObservableWorker } from "../lib/queue-observability"
import { connection } from "../redis"
import { isRepeatableJob } from "../repeatable-job-registry"

const logger = createLogger("worker.domain-metrics")
const REFRESH_DAYS = 30
const MAX_WEBSITES_PER_JOB = 100

type SyncPayload = {
  websiteIds?: string[]
  trigger?: string
  batchSize?: number
}

async function persistMetric(
  websiteId: string,
  input: {
    key: WebsiteMetricKey
    provider: WebsiteMetricProvider
    source: WebsiteMetricSource
    value: number
    measuredAt: Date
  },
) {
  await prisma.$transaction(async (tx: any) => {
    const current = await tx.websiteMetric.findUnique({
      where: { websiteId_key: { websiteId, key: input.key } },
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
          metadata: { replacedBy: input.source },
        },
      })
    }
    const collectedAt = new Date()
    const expiresAt = new Date(
      collectedAt.getTime() + REFRESH_DAYS * 86_400_000,
    )
    const data = {
      provider: input.provider,
      source: input.source,
      status: "CURRENT",
      value: input.value,
      measuredAt: input.measuredAt,
      collectedAt,
      expiresAt,
      enteredByUserId: null,
      importBatchId: null,
    }
    if (current) {
      await tx.websiteMetric.update({ where: { id: current.id }, data })
    } else {
      await tx.websiteMetric.create({
        data: { websiteId, key: input.key, ...data },
      })
    }
    if (input.key === WebsiteMetricKey.AHREFS_DOMAIN_RATING) {
      await tx.marketplaceListing.updateMany({
        where: { websiteId },
        data: { domainRating: Math.round(input.value) },
      })
    }
  })
}

async function resolveWebsiteIds(payload: SyncPayload): Promise<string[]> {
  if (payload.websiteIds) {
    const ids = [...new Set(payload.websiteIds)]
    if (
      ids.length === 0 ||
      ids.length > MAX_WEBSITES_PER_JOB ||
      ids.some((id) => typeof id !== "string" || id.length > 64)
    ) {
      throw new Error("domain metric job contains invalid websiteIds")
    }
    return ids
  }
  const cutoff = new Date(Date.now() - REFRESH_DAYS * 86_400_000)
  const batchSize = Math.min(
    Math.max(Number(payload.batchSize) || MAX_WEBSITES_PER_JOB, 1),
    MAX_WEBSITES_PER_JOB,
  )
  const websites = await prisma.website.findMany({
    where: {
      isActive: true,
      OR: [
        { metricsHistory: { none: {} } },
        { metricsHistory: { some: { collectedAt: { lte: cutoff } } } },
      ],
    },
    select: { id: true },
    orderBy: { updatedAt: "asc" },
    take: batchSize,
  })
  return websites.map((website) => website.id)
}

export async function processDomainMetrics(payload: SyncPayload) {
  const websiteIds = await resolveWebsiteIds(payload)
  if (websiteIds.length === 0) return { requested: 0, updated: 0, failures: 0 }
  const websites = await prisma.website.findMany({
    where: { id: { in: websiteIds }, isActive: true },
    select: { id: true, canonicalDomain: true, domain: true },
  })
  const valid = websites
    .map((website) => ({
      id: website.id,
      domain: website.canonicalDomain ?? website.domain,
    }))
    .filter((website): website is { id: string; domain: string } =>
      Boolean(website.domain),
    )

  let updated = 0
  let failures = 0
  const oprKey = process.env.OPENPAGERANK_API_KEY?.trim() ?? ""
  if (oprKey && valid.length > 0) {
    try {
      const rows = await fetchOpenPageRanks(
        valid.map((website) => website.domain),
        oprKey,
      )
      const byDomain = new Map(rows.map((row) => [row.domain, row]))
      for (const website of valid) {
        const row = byDomain.get(website.domain)
        if (!row?.found || row.openPageRank === null) continue
        await persistMetric(website.id, {
          key: WebsiteMetricKey.OPEN_PAGE_RANK,
          provider: WebsiteMetricProvider.OPEN_PAGE_RANK,
          source: WebsiteMetricSource.OPEN_PAGE_RANK_API,
          value: row.openPageRank,
          measuredAt: row.asOf,
        })
        if (row.globalRank !== null) {
          await persistMetric(website.id, {
            key: WebsiteMetricKey.OPEN_PAGE_RANK_GLOBAL_RANK,
            provider: WebsiteMetricProvider.OPEN_PAGE_RANK,
            source: WebsiteMetricSource.OPEN_PAGE_RANK_API,
            value: row.globalRank,
            measuredAt: row.asOf,
          })
        }
        if (row.referringDomains !== null) {
          await persistMetric(website.id, {
            key: WebsiteMetricKey.OPEN_PAGE_RANK_REFERRING_DOMAINS,
            provider: WebsiteMetricProvider.OPEN_PAGE_RANK,
            source: WebsiteMetricSource.OPEN_PAGE_RANK_API,
            value: row.referringDomains,
            measuredAt: row.asOf,
          })
        }
        updated++
      }
    } catch (error) {
      failures += valid.length
      logger.warn("OpenPageRank batch failed", {
        code:
          error instanceof DomainMetricProviderError ? error.code : "UNKNOWN",
      })
    }
  }

  const ahrefsKey = process.env.AHREFS_API_KEY?.trim() ?? ""
  if (ahrefsKey) {
    // The free Ahrefs endpoint is one target per call. Keep concurrency low so
    // a bulk import cannot burst through provider limits.
    for (let offset = 0; offset < valid.length; offset += 4) {
      const chunk = valid.slice(offset, offset + 4)
      const results = await Promise.allSettled(
        chunk.map(async (website) => {
          const rating = await fetchAhrefsDomainRating(
            website.domain,
            ahrefsKey,
          )
          await persistMetric(website.id, {
            key: WebsiteMetricKey.AHREFS_DOMAIN_RATING,
            provider: WebsiteMetricProvider.AHREFS,
            source: WebsiteMetricSource.AHREFS_FREE_API,
            value: rating,
            measuredAt: new Date(),
          })
        }),
      )
      updated += results.filter(
        (result) => result.status === "fulfilled",
      ).length
      failures += results.filter(
        (result) => result.status === "rejected",
      ).length
    }
  }

  return {
    requested: websiteIds.length,
    eligible: valid.length,
    updated,
    failures,
    configured: { ahrefs: Boolean(ahrefsKey), openPageRank: Boolean(oprKey) },
  }
}

export function createDomainMetricsWorker() {
  return createObservableWorker(
    QUEUES.DOMAIN_METRICS,
    async (job) => {
      if (
        !verifyJobPayload(job.data, {
          maxAgeMs: isRepeatableJob(job.name) ? 0 : undefined,
        })
      ) {
        logger.error("job signature invalid — rejecting", { jobId: job.id })
        throw new Error("Invalid job signature")
      }
      if (
        job.name !== QUEUE_JOBS[QUEUES.DOMAIN_METRICS].SYNC &&
        job.name !== "domain-metrics-refresh"
      ) {
        throw new Error(`Unknown domain metrics job: ${job.name}`)
      }
      const result = await processDomainMetrics(job.data as SyncPayload)
      logger.info("domain metrics job completed", { jobId: job.id, result })
      return result
    },
    { connection, concurrency: 1 },
  )
}
