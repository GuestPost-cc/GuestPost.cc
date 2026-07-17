import type {
  ConnectRequest,
  ConnectResponse,
  DiscoverResourcesResponse,
  EnqueueDiscoveryResponse,
  IntegrationListResponse,
  IntegrationSummary,
  LinkPropertyRequest,
  LinkPropertyResponse,
  SyncHistoryResponse,
  SyncJob,
  TriggerSyncResponse,
} from "@guestpost/integrations/client"
import type { HttpClient } from "../../client"

/**
 * IntegrationsService — typed transport layer for the Integration domain.
 *
 * Every method maps to exactly one API call. No polling, no transformations,
 * no business logic. Hooks and UI orchestration live in the consuming app.
 *
 * Backend errors surface unchanged (TOKEN_EXPIRED, SYNC_ALREADY_RUNNING, etc.)
 * via ApiError — the UI layer decides how to present them.
 */
export class IntegrationsService {
  constructor(private client: HttpClient) {}

  // ─── OAuth ────────────────────────────────────────────────────

  connect(
    provider: string,
    returnUrl: string,
    platformWebsiteId?: string,
  ): Promise<ConnectResponse> {
    return this.client.post<ConnectResponse>(
      `/integrations/${provider}/connect`,
      {
        json: {
          provider: provider as ConnectRequest["provider"],
          returnUrl,
          platformWebsiteId,
        } satisfies ConnectRequest,
      },
    )
  }

  // ─── CRUD ─────────────────────────────────────────────────────

  list(params?: {
    page?: number
    pageSize?: number
    platformWebsiteId?: string
  }): Promise<IntegrationListResponse> {
    return this.client.get<IntegrationListResponse>("/integrations", {
      params: params as Record<string, string | number | boolean | undefined>,
    })
  }

  get(id: string, platformWebsiteId?: string): Promise<IntegrationSummary> {
    return this.client.get<IntegrationSummary>(`/integrations/${id}`, {
      params: { platformWebsiteId },
    })
  }

  disconnect(id: string, platformWebsiteId?: string): Promise<void> {
    return this.client.delete(`/integrations/${id}`, {
      params: { platformWebsiteId },
    })
  }

  // ─── Discovery & Resources ────────────────────────────────────

  discoverResources(
    id: string,
    platformWebsiteId?: string,
  ): Promise<EnqueueDiscoveryResponse> {
    return this.client.post<EnqueueDiscoveryResponse>(
      `/integrations/${id}/discover`,
      { params: { platformWebsiteId } },
    )
  }

  listResources(
    id: string,
    platformWebsiteId?: string,
  ): Promise<DiscoverResourcesResponse> {
    return this.client.get<DiscoverResourcesResponse>(
      `/integrations/${id}/resources`,
      { params: { platformWebsiteId } },
    )
  }

  linkProperty(
    integrationId: string,
    websiteId: string,
    externalResourceId: string,
  ): Promise<LinkPropertyResponse> {
    return this.client.post<LinkPropertyResponse>(
      `/integrations/${integrationId}/link`,
      { json: { websiteId, externalResourceId } satisfies LinkPropertyRequest },
    )
  }

  unlinkProperty(
    integrationId: string,
    websiteIntegrationId: string,
    platformWebsiteId?: string,
  ): Promise<void> {
    return this.client.delete(
      `/integrations/${integrationId}/link/${websiteIntegrationId}`,
      { params: { platformWebsiteId } },
    )
  }

  // ─── Sync ─────────────────────────────────────────────────────

  triggerSync(
    integrationId: string,
    options?: {
      websiteIntegrationId?: string
      startDate?: string
      endDate?: string
      platformWebsiteId?: string
    },
  ): Promise<TriggerSyncResponse> {
    return this.client.post<TriggerSyncResponse>(
      `/integrations/${integrationId}/sync`,
      { json: options ?? {} },
    )
  }

  getSyncStatus(syncId: string, platformWebsiteId?: string): Promise<SyncJob> {
    return this.client.get<SyncJob>(`/integrations/syncs/${syncId}`, {
      params: { platformWebsiteId },
    })
  }

  rediscoverConnection(
    connectionId: string,
    platformWebsiteId?: string,
  ): Promise<{ enqueued: boolean }> {
    return this.client.post<{ enqueued: boolean }>(
      `/integrations/connections/${connectionId}/rediscover`,
      { params: { platformWebsiteId } },
    )
  }

  getSyncHistory(
    integrationId: string,
    params?: {
      page?: number
      pageSize?: number
      status?: string
      trigger?: string
      dateFrom?: string
      dateTo?: string
      platformWebsiteId?: string
    },
  ): Promise<SyncHistoryResponse> {
    return this.client.get<SyncHistoryResponse>(
      `/integrations/${integrationId}/sync/history`,
      {
        params: params as Record<string, string | number | boolean | undefined>,
      },
    )
  }
}
