"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../api"
import { integrationKeys } from "./keys"

export function useConnectIntegration() {
  return useMutation({
    mutationFn: ({
      provider,
      returnUrl,
    }: {
      provider: string
      returnUrl: string
    }) => api.integrations.connect(provider, returnUrl),
  })
}

export function useDiscoverResources(integrationId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () => api.integrations.discoverResources(integrationId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: integrationKeys.resources(integrationId),
      })
      queryClient.invalidateQueries({
        queryKey: integrationKeys.detail(integrationId),
      })
    },
  })
}

export function useLinkProperty(integrationId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({
      websiteId,
      externalResourceId,
    }: {
      websiteId: string
      externalResourceId: string
    }) =>
      api.integrations.linkProperty(
        integrationId,
        websiteId,
        externalResourceId,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: integrationKeys.detail(integrationId),
      })
      queryClient.invalidateQueries({
        queryKey: integrationKeys.resources(integrationId),
      })
    },
  })
}

export function useUnlinkProperty(integrationId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (websiteIntegrationId: string) =>
      api.integrations.unlinkProperty(integrationId, websiteIntegrationId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: integrationKeys.detail(integrationId),
      })
      queryClient.invalidateQueries({
        queryKey: integrationKeys.resources(integrationId),
      })
    },
  })
}

export function useTriggerSync(integrationId: string) {
  return useMutation({
    mutationFn: (options?: {
      websiteIntegrationId?: string
      startDate?: string
      endDate?: string
    }) => api.integrations.triggerSync(integrationId, options),
  })
}

export function useDisconnectIntegration() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => api.integrations.disconnect(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: integrationKeys.all })
    },
  })
}
