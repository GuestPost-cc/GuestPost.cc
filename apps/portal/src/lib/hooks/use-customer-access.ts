"use client"

import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"
import { api } from "../api"

/**
 * Determines whether the current customer can see publisher website URLs
 * on marketplace listings.
 *
 * URLs are blurred until the customer makes their first successful deposit.
 * Order drafts and zero balance after a deposit do NOT revoke access — once
 * a customer has deposited, the URL stays visible.
 */
export function useCustomerAccess() {
  const { data: walletData } = useQuery({
    queryKey: ["wallet"],
    queryFn: () => api.billing.getWallet(),
  })

  const canViewUrls = useMemo(() => {
    // Wait for wallet data before resolving — treat loading as hidden.
    if (!walletData) return false
    // Positive balance implies a prior deposit (or credit) — visible.
    if (Number(walletData.availableBalance) > 0) return true
    // Any DEPOSIT transaction on record unlocks URLs permanently.
    if (walletData.transactions?.some((t) => t.type === "DEPOSIT")) return true
    return false
  }, [walletData])

  return { canViewUrls }
}
