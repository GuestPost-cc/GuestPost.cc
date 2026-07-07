"use client"

import { useCallback, useState } from "react"
import { authClient } from "../client/auth-client"
import type { AuthenticatedUser } from "../types"

export interface UseSessionReturn {
  session: { id: string; userId: string; expiresAt: Date } | null
  user: AuthenticatedUser | null
  loading: boolean
  refresh: () => Promise<void>
}

export function useSession(): UseSessionReturn {
  const [refreshTrigger, setRefreshTrigger] = useState(0)
  const { data, isPending, refetch } = authClient.useSession()

  const refresh = useCallback(async () => {
    await refetch()
    setRefreshTrigger((n) => n + 1)
  }, [refetch])

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _trigger = refreshTrigger // consume for reactivity

  return {
    session: data?.session
      ? {
          id: data.session.id,
          userId: data.session.userId,
          expiresAt: new Date(data.session.expiresAt),
        }
      : null,
    user: data?.user ? (data.user as unknown as AuthenticatedUser) : null,
    loading: isPending,
    refresh,
  }
}
