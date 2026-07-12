"use client"

import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"
import { api } from "../api"

/**
 * Determines whether the current customer can see publisher website URLs
 * on marketplace listings.
 *
 * URLs are blurred for customers who have never deposited money, have no
 * balance, AND have never placed an order. The URL becomes fully visible
 * once the customer meets ANY of:
 *   1. Has a positive wallet balance
 *   2. Has a DEPOSIT transaction on record
 *   3. Has created at least one order on the platform
 */
export function useCustomerAccess() {
  const { data: walletData } = useQuery({
    queryKey: ["wallet"],
    queryFn: () => api.billing.getWallet(),
  })

  const { data: ordersData } = useQuery({
    queryKey: ["my-orders"],
    queryFn: () => api.orders.list(),
  })

  const canViewUrls = useMemo(() => {
    if (!walletData) return false
    if (Number(walletData.availableBalance) > 0) return true
    if (walletData.transactions?.some((t) => t.type === "DEPOSIT")) return true
    if (ordersData && ordersData.length > 0) return true
    return false
  }, [walletData, ordersData])

  return { canViewUrls }
}
