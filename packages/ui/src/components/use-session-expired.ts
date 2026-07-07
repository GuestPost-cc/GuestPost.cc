"use client"

import { useEffect, useState } from "react"

export interface UseSessionExpiredReturn {
  expired: boolean
  reason: string | null
  dismiss: () => void
}

export function useSessionExpired(): UseSessionExpiredReturn {
  const [reason, setReason] = useState<string | null>(null)

  useEffect(() => {
    try {
      const r = sessionStorage.getItem("guestpost:auth-redirect-reason")
      if (r) {
        setReason(r)
        sessionStorage.removeItem("guestpost:auth-redirect-reason")
      }
    } catch {
      /* private mode */
    }
  }, [])

  return {
    expired: reason !== null,
    reason,
    dismiss: () => setReason(null),
  }
}
