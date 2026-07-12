import { createPrismaClient } from "@guestpost/database"
import {
  ProviderError,
  ReauthRequiredError,
  TokenExpiredError,
} from "../errors"
import type { DiscoveryResource, SyncResult } from "../types"
import type { DiscoveryProvider, SyncProvider } from "./provider.interface"

const GA4_SCOPES = ["https://www.googleapis.com/auth/analytics.readonly"]

const ADMIN_API = "https://analyticsadmin.googleapis.com/v1beta"
const DATA_API = "https://analyticsdata.googleapis.com/v1beta"

const db = createPrismaClient()

export class GoogleAnalyticsProvider
  implements DiscoveryProvider, SyncProvider
{
  async discoverResources(accessToken: string): Promise<DiscoveryResource[]> {
    const accounts = await this.listAccounts(accessToken)
    const resources: DiscoveryResource[] = []

    for (const account of accounts) {
      const properties = await this.listProperties(accessToken, account.name)
      for (const prop of properties) {
        resources.push({
          externalResourceId: prop.name.split("/").pop() ?? prop.name,
          externalResourceName: prop.displayName,
          metadata: {
            accountName: account.displayName,
            propertyName: prop.displayName,
          },
        })
      }
    }

    return resources
  }

  async sync(
    accessToken: string,
    externalResourceId: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<SyncResult> {
    const startedAt = new Date()
    const propertyId = `properties/${externalResourceId}`
    const end = endDate ?? new Date()
    const start =
      startDate ?? new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000)

    const formatDate = (d: Date) => d.toISOString().split("T")[0]

    try {
      const response = await fetch(`${DATA_API}/${propertyId}:runReport`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          dateRanges: [
            { startDate: formatDate(start), endDate: formatDate(end) },
          ],
          dimensions: [{ name: "date" }],
          metrics: [
            { name: "sessions" },
            { name: "totalUsers" },
            { name: "newUsers" },
            { name: "screenPageViews" },
            { name: "bounceRate" },
            { name: "averageSessionDuration" },
          ],
          keepEmptyRows: false,
        }),
      })

      if (!response.ok) {
        if (response.status === 401) throw new TokenExpiredError()
        if (response.status === 403) throw new ReauthRequiredError()
        const body = await response.text().catch(() => "")
        throw new ProviderError(
          `GA4 API error: ${response.status} ${body}`,
          "GA4_API_ERROR",
        )
      }

      const data: any = await response.json()
      const rows = data.rows ?? []

      // Find all website integrations linked to this GA4 property
      const websiteIntegrations = await (db.websiteIntegration as any).findMany(
        {
          where: { externalResourceId },
        },
      )

      if (websiteIntegrations.length === 0) {
        return {
          success: true,
          recordsProcessed: 0,
          syncedAt: new Date(),
          durationMs: Date.now() - startedAt.getTime(),
        }
      }

      // Aggregate rows by date. Metric order matches the request body:
      // sessions, totalUsers, newUsers, screenPageViews, bounceRate, averageSessionDuration
      const byDate = new Map<
        string,
        {
          sessions: number
          users: number
          newUsers: number
          pageviews: number
          bounceRate: number
          avgSessionDuration: number
          count: number
        }
      >()
      for (const row of rows) {
        const dateStr = row.dimensionValues[0].value
        const mv = row.metricValues
        const sessions = Number(mv[0].value)
        const users = Number(mv[1].value)
        const newUsers = Number(mv[2].value)
        const pageviews = Number(mv[3].value)
        const bounceRate = Number(mv[4].value)
        const avgSessionDuration = Number(mv[5].value)

        const existing = byDate.get(dateStr) ?? {
          sessions: 0,
          users: 0,
          newUsers: 0,
          pageviews: 0,
          bounceRate: 0,
          avgSessionDuration: 0,
          count: 0,
        }
        // GA4 date dimension already groups by day, so each dateStr appears once.
        // Accumulate defensively in case of duplicate rows.
        existing.sessions += sessions
        existing.users += users
        existing.newUsers += newUsers
        existing.pageviews += pageviews
        // bounceRate / avgSessionDuration are averages, so take the mean across rows.
        const prevCount = existing.count
        existing.bounceRate =
          (existing.bounceRate * prevCount + bounceRate) / (prevCount + 1)
        existing.avgSessionDuration =
          (existing.avgSessionDuration * prevCount + avgSessionDuration) /
          (prevCount + 1)
        existing.count += 1
        byDate.set(dateStr, existing)
      }

      let totalRecordsProcessed = 0

      for (const wi of websiteIntegrations) {
        try {
          for (const [dateStr, agg] of byDate) {
            const date = new Date(
              Date.UTC(
                Number(dateStr.slice(0, 4)),
                Number(dateStr.slice(4, 6)) - 1,
                Number(dateStr.slice(6, 8)),
              ),
            )

            await (db.websiteAnalyticsDaily as any).upsert({
              where: {
                websiteId_sourceIntegrationId_date: {
                  websiteId: wi.websiteId,
                  sourceIntegrationId: wi.id,
                  date,
                },
              },
              update: {
                sessions: agg.sessions,
                users: agg.users,
                newUsers: agg.newUsers,
                pageviews: agg.pageviews,
                bounceRate: agg.bounceRate,
                avgSessionDuration: agg.avgSessionDuration,
              },
              create: {
                websiteId: wi.websiteId,
                sourceIntegrationId: wi.id,
                date,
                sessions: agg.sessions,
                users: agg.users,
                newUsers: agg.newUsers,
                pageviews: agg.pageviews,
                bounceRate: agg.bounceRate,
                avgSessionDuration: agg.avgSessionDuration,
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
            durationMs: Date.now() - startedAt.getTime(),
          }
        }
      }

      return {
        success: true,
        recordsProcessed: totalRecordsProcessed,
        syncedAt: new Date(),
        durationMs: Date.now() - startedAt.getTime(),
      }
    } catch (err) {
      if (
        err instanceof TokenExpiredError ||
        err instanceof ReauthRequiredError
      )
        throw err
      if (err instanceof ProviderError) throw err
      return {
        success: false,
        recordsProcessed: 0,
        syncedAt: new Date(),
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt.getTime(),
      }
    }
  }

  private async listAccounts(
    accessToken: string,
  ): Promise<{ name: string; displayName: string }[]> {
    const response = await fetch(`${ADMIN_API}/accounts`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) return []
    const data: any = await response.json()
    return data.accounts ?? []
  }

  private async listProperties(
    accessToken: string,
    accountName: string,
  ): Promise<{ name: string; displayName: string }[]> {
    const response = await fetch(
      `${ADMIN_API}/properties?filter=parent:${accountName}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    if (!response.ok) return []
    const data: any = await response.json()
    return (data.properties ?? []).filter(
      (p: any) => p.propertyType === "PROPERTY_TYPE_ORDINARY",
    )
  }

  getScopes(): string[] {
    return GA4_SCOPES
  }
}
