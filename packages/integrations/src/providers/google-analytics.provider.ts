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
      const recordsProcessed = rows.length

      return {
        success: true,
        recordsProcessed,
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
