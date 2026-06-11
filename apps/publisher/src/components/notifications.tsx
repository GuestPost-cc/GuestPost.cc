"use client"

import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { NotificationBell } from "@guestpost/ui"
import { api } from "../lib/api"

// Live notification bell: unread badge polls every 60s; the list loads on
// open. All data comes from GET /notifications — rows written by the worker
// for orders, settlements, withdrawals, payouts, disputes, and chargebacks.
export function Notifications() {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [limit, setLimit] = useState(10)

  const countQ = useQuery({
    queryKey: ["notifications", "unread-count"],
    queryFn: () => api.notifications.unreadCount(),
    refetchInterval: 60_000,
  })

  const listQ = useQuery({
    queryKey: ["notifications", "list", limit],
    queryFn: () => api.notifications.list({ limit }),
    enabled: open,
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["notifications"] })
  const markRead = useMutation({
    mutationFn: (id: string) => api.notifications.markRead(id),
    onSuccess: invalidate,
  })
  const markAll = useMutation({
    mutationFn: () => api.notifications.markAllRead(),
    onSuccess: invalidate,
  })

  const items = listQ.data?.items ?? []
  const total = listQ.data?.total ?? 0

  return (
    <NotificationBell
      items={items}
      unreadCount={countQ.data?.count ?? listQ.data?.unreadCount ?? 0}
      loading={open && listQ.isLoading}
      onOpenChange={setOpen}
      onMarkRead={(id) => markRead.mutate(id)}
      onMarkAllRead={() => markAll.mutate()}
      onLoadMore={() => setLimit((l) => l + 10)}
      hasMore={items.length < total}
    />
  )
}
