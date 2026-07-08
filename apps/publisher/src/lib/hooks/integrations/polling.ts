"use client"

import type { SyncJob } from "@guestpost/api-client"
import { POLL_CONFIG } from "@guestpost/api-client"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef } from "react"
import { api } from "../../api"
import { integrationKeys } from "./keys"

export function useSyncPolling(
  syncId: string | undefined,
  integrationId?: string,
  websiteId?: string,
) {
  const queryClient = useQueryClient()
  const pollStartRef = useRef<number | null>(null)

  const query = useQuery<SyncJob>({
    queryKey: integrationKeys.sync(syncId ?? "pending"),
    queryFn: () => api.integrations.getSyncStatus(syncId!),
    enabled: !!syncId,
    refetchInterval: (query) => {
      const data = query.state.data
      if (!data) return POLL_CONFIG.INITIAL_INTERVAL_MS
      if (data.status === "COMPLETED" || data.status === "FAILED") return false

      if (!pollStartRef.current) pollStartRef.current = Date.now()
      const elapsed = Date.now() - pollStartRef.current

      if (elapsed > POLL_CONFIG.MAX_DURATION_MS) return false

      if (elapsed > POLL_CONFIG.BACKOFF_AFTER_MS)
        return POLL_CONFIG.MAX_INTERVAL_MS

      return POLL_CONFIG.INITIAL_INTERVAL_MS
    },
  })

  const syncStatus = query.data?.status
  const prevStatusRef = useRef(syncStatus)

  useEffect(() => {
    if (
      !syncId ||
      !integrationId ||
      !syncStatus ||
      prevStatusRef.current === syncStatus
    )
      return

    prevStatusRef.current = syncStatus

    if (syncStatus === "COMPLETED" || syncStatus === "FAILED") {
      queryClient.invalidateQueries({
        queryKey: integrationKeys.detail(integrationId),
      })
      queryClient.invalidateQueries({
        queryKey: integrationKeys.syncHistory(integrationId),
      })
    }
  }, [syncStatus, syncId, integrationId, queryClient])

  return query
}
