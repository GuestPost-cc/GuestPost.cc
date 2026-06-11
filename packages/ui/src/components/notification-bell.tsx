"use client"

import * as React from "react"
import { Bell, CheckCheck, Loader2 } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from "./dropdown-menu"
import { Button } from "./button"
import { cn } from "../lib/utils"

export interface NotificationBellItem {
  id: string
  type: string
  message: string
  read: boolean
  createdAt: string
}

export interface NotificationBellProps {
  items: NotificationBellItem[]
  unreadCount: number
  loading?: boolean
  onOpenChange?: (open: boolean) => void
  onMarkRead: (id: string) => void
  onMarkAllRead: () => void
  onLoadMore?: () => void
  hasMore?: boolean
}

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// Presentation-only bell + dropdown. Data fetching stays in the host app
// (react-query) — this package has no data dependencies.
export function NotificationBell({
  items,
  unreadCount,
  loading,
  onOpenChange,
  onMarkRead,
  onMarkAllRead,
  onLoadMore,
  hasMore,
}: NotificationBellProps) {
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}>
          <Bell className="h-5 w-5" />
          {unreadCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-96 p-0">
        <div className="flex items-center justify-between border-b px-4 py-2">
          <span className="text-sm font-semibold">Notifications</span>
          {unreadCount > 0 && (
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onMarkAllRead}>
              <CheckCheck className="mr-1 h-3 w-3" />
              Mark all read
            </Button>
          )}
        </div>
        <div className="max-h-96 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : items.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">No notifications</div>
          ) : (
            items.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => !n.read && onMarkRead(n.id)}
                className={cn(
                  "flex w-full flex-col gap-0.5 border-b px-4 py-3 text-left last:border-b-0 hover:bg-muted/50",
                  !n.read && "bg-primary/5",
                )}
              >
                <span className="flex items-start gap-2">
                  {!n.read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden />}
                  <span className={cn("text-sm", !n.read && "font-medium")}>{n.message}</span>
                </span>
                <span className="pl-4 text-xs text-muted-foreground">
                  {n.type.replace(/_/g, " ").toLowerCase()} — {timeAgo(n.createdAt)}
                </span>
              </button>
            ))
          )}
          {hasMore && !loading && (
            <button
              type="button"
              onClick={onLoadMore}
              className="w-full py-2 text-center text-xs text-muted-foreground hover:bg-muted/50"
            >
              Load more
            </button>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
