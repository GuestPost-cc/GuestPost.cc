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
} from "@guestpost/integrations"
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

  connect(provider: string, returnUrl: string): Promise<ConnectResponse> {
    return this.client.post<ConnectResponse>(
      `/integrations/${provider}/connect`,
      { json: { returnUrl } satisfies ConnectRequest },
    )
  }

  // ─── CRUD ─────────────────────────────────────────────────────

  list(params?: {
    page?: number
    pageSize?: number
  }): Promise<IntegrationListResponse> {
    return this.client.get<IntegrationListResponse>("/integrations", {
      params: params as Record<string, string | number | boolean | undefined>,
    })
  }

  get(id: string): Promise<IntegrationSummary> {
    return this.client.get<IntegrationSummary>(`/integrations/${id}`)
  }

  disconnect(id: string): Promise<void> {
    return this.client.delete(`/integrations/${id}`)
  }

  // ─── Discovery & Resources ────────────────────────────────────

  discoverResources(id: string): Promise<EnqueueDiscoveryResponse> {
    return this.client.post<EnqueueDiscoveryResponse>(
      `/integrations/${id}/discover`,
    )
  }

  listResources(id: string): Promise<DiscoverResourcesResponse> {
    return this.client.get<DiscoverResourcesResponse>(
      `/integrations/${id}/resources`,
    )
  }

  linkProperty(
    integrationId: string,
    websiteId: string,
    externalId: string,
  ): Promise<LinkPropertyResponse> {
    return this.client.post<LinkPropertyResponse>(
      `/integrations/${integrationId}/link`,
      { json: { websiteId, externalId } satisfies LinkPropertyRequest },
    )
  }

  unlinkProperty(
    integrationId: string,
    websiteIntegrationId: string,
  ): Promise<void> {
    return this.client.delete(
      `/integrations/${integrationId}/link/${websiteIntegrationId}`,
    )
  }

  // ─── Sync ─────────────────────────────────────────────────────

  triggerSync(
    integrationId: string,
    options?: {
      propertyUrl?: string
      startDate?: string
      endDate?: string
    },
  ): Promise<TriggerSyncResponse> {
    return this.client.post<TriggerSyncResponse>(
      `/integrations/${integrationId}/sync`,
      { json: options ?? {} },
    )
  }

  getSyncStatus(syncId: string): Promise<SyncJob> {
    return this.client.get<SyncJob>(`/integrations/syncs/${syncId}`)
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
