"use client"

import type {
  IntegrationListResponse,
  IntegrationSummary,
  SyncHistoryResponse,
} from "@guestpost/api-client"
import { useQuery } from "@tanstack/react-query"
import { api } from "../../api"
import { integrationKeys } from "./keys"

export function useIntegrations(
  filters?: { page?: number; pageSize?: number },
  options?: { enabled?: boolean },
) {
  return useQuery<IntegrationListResponse>({
    queryKey: integrationKeys.list(filters),
    queryFn: () => api.integrations.list(filters),
    enabled: options?.enabled ?? true,
  })
}

export function useIntegration(id: string, options?: { enabled?: boolean }) {
  return useQuery<IntegrationSummary>({
    queryKey: integrationKeys.detail(id),
    queryFn: () => api.integrations.get(id),
    enabled: !!id && (options?.enabled ?? true),
  })
}

export function useResources(id: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: integrationKeys.resources(id),
    queryFn: () => api.integrations.listResources(id),
    enabled: !!id && (options?.enabled ?? true),
  })
}

export function useSyncHistory(
  integrationId: string,
  filters?: {
    page?: number
    pageSize?: number
    status?: string
    trigger?: string
    dateFrom?: string
    dateTo?: string
  },
  options?: { enabled?: boolean },
) {
  return useQuery<SyncHistoryResponse>({
    queryKey: integrationKeys.syncHistory(integrationId),
    queryFn: () => api.integrations.getSyncHistory(integrationId, filters),
    enabled: !!integrationId && (options?.enabled ?? true),
  })
}
