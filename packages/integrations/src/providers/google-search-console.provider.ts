import { createPrismaClient } from "@guestpost/database"
import {
  ProviderError,
  ProviderRateLimitError,
  TokenExpiredError,
} from "../errors"
import type { DiscoveryResource, SyncResult } from "../types"
import type { DiscoveryProvider, SyncProvider } from "./provider.interface"

interface GscSite {
  siteUrl: string
  permissionLevel: string
}

interface GscSiteWithUrl {
  url: string
  permissionLevel: string
}

interface GscSearchAnalyticsRow {
  keys: string[]
  clicks: number
  impressions: number
  ctr: number
  position: number
}

interface GscSearchAnalyticsResponse {
  rows?: GscSearchAnalyticsRow[]
  responseAggregationType?: string
}

const db = createPrismaClient()

export class GoogleSearchConsoleProvider
  implements DiscoveryProvider, SyncProvider
{
  private readonly baseUrl = "https://www.googleapis.com/webmasters/v3"

  async discoverResources(accessToken: string): Promise<DiscoveryResource[]> {
    const sites = await this.listSites(accessToken)
    return sites.map((site) => ({
      externalResourceId: site.url,
      externalResourceName: site.url.replace(/^sc-domain:/, ""),
      metadata: { permissionLevel: site.permissionLevel },
    }))
  }

  async sync(
    accessToken: string,
    externalResourceId: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<SyncResult> {
    const startMs = Date.now()

    const end = endDate ?? new Date()
    // Default: last 3 days if no start date provided
    const start = startDate ?? new Date(end.getTime() - 3 * 24 * 60 * 60 * 1000)

    // Find all website integrations for this external resource
    const websiteIntegrations = await (db.websiteIntegration as any).findMany({
      where: { externalResourceId },
    })

    if (websiteIntegrations.length === 0) {
      return {
        success: true,
        recordsProcessed: 0,
        syncedAt: new Date(),
        durationMs: Date.now() - startMs,
      }
    }

    let totalRecordsProcessed = 0

    for (const wi of websiteIntegrations) {
      try {
        const rows = await this.fetchSearchAnalytics(
          accessToken,
          externalResourceId,
          start,
          end,
        )

        if (rows.length === 0) continue

        // Aggregate rows by date (keys[0] is the date when dimension is "date")
        const byDate = new Map<
          string,
          {
            clicks: number
            impressions: number
            ctrTotal: number
            positionWeighted: number
            count: number
          }
        >()
        for (const row of rows) {
          const date = row.keys[0]
          const existing = byDate.get(date) ?? {
            clicks: 0,
            impressions: 0,
            ctrTotal: 0,
            positionWeighted: 0,
            count: 0,
          }
          existing.clicks += row.clicks
          existing.impressions += row.impressions
          existing.ctrTotal += row.ctr * row.impressions
          existing.positionWeighted += row.position * row.impressions
          existing.count++
          byDate.set(date, existing)
        }

        // Upsert daily aggregates
        for (const [dateStr, data] of byDate) {
          const date = new Date(dateStr)
          const avgCtr =
            data.impressions > 0 ? data.ctrTotal / data.impressions : 0
          const avgPosition =
            data.impressions > 0 ? data.positionWeighted / data.impressions : 0

          await (db.websiteSearchDaily as any).upsert({
            where: {
              websiteId_sourceIntegrationId_date: {
                websiteId: wi.websiteId,
                sourceIntegrationId: wi.id,
                date,
              },
            },
            update: {
              clicks: data.clicks,
              impressions: data.impressions,
              ctr: avgCtr,
              position: avgPosition,
            },
            create: {
              websiteId: wi.websiteId,
              sourceIntegrationId: wi.id,
              date,
              clicks: data.clicks,
              impressions: data.impressions,
              ctr: avgCtr,
              position: avgPosition,
            },
          })

          totalRecordsProcessed++
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        return {
          success: false,
          recordsProcessed: totalRecordsProcessed,
          syncedAt: new Date(),
          error: errorMessage,
          durationMs: Date.now() - startMs,
        }
      }
    }

    return {
      success: true,
      recordsProcessed: totalRecordsProcessed,
      syncedAt: new Date(),
      durationMs: Date.now() - startMs,
    }
  }

  private async fetchSearchAnalytics(
    accessToken: string,
    siteUrl: string,
    startDate: Date,
    endDate: Date,
  ): Promise<GscSearchAnalyticsRow[]> {
    const url = `${this.baseUrl}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        startDate: this.formatDate(startDate),
        endDate: this.formatDate(endDate),
        dimensions: ["date"],
        rowLimit: 25000,
      }),
    })

    if (response.status === 401) throw new TokenExpiredError()
    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After")
      throw new ProviderRateLimitError(
        `Google rate limit. Retry after ${retryAfter ?? "unknown"}`,
      )
    }
    if (!response.ok) {
      throw new ProviderError(`Failed to fetch search analytics for ${siteUrl}`)
    }

    const data = (await response.json()) as GscSearchAnalyticsResponse
    return data.rows ?? []
  }

  private async listSites(accessToken: string): Promise<GscSiteWithUrl[]> {
    const response = await fetch(
      `${this.baseUrl}/sites?fields=sites%2FpermissionLevel%2Csites%2FsiteUrl`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    )

    if (response.status === 401) throw new TokenExpiredError()
    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After")
      throw new ProviderRateLimitError(
        `Google rate limit. Retry after ${retryAfter ?? "unknown"}`,
      )
    }
    if (!response.ok) {
      throw new ProviderError("Failed to list GSC sites")
    }

    const data = (await response.json()) as { sites?: GscSite[] }
    return (data.sites ?? []).map((s: GscSite) => ({
      url: s.siteUrl,
      permissionLevel: s.permissionLevel,
    }))
  }

  private formatDate(date: Date): string {
    return date.toISOString().split("T")[0]
  }
}
