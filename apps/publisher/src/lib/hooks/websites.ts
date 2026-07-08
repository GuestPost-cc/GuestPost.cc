"use client"

import { useQuery } from "@tanstack/react-query"
import { api } from "../api"
import { useAuth } from "../auth"

export function useWebsite(websiteId: string) {
  const { user } = useAuth()
  const publisherId = user?.publisherId

  return useQuery({
    queryKey: ["website", websiteId],
    queryFn: () => api.publishers.getWebsite(publisherId!, websiteId),
    enabled: !!publisherId && !!websiteId,
  })
}
