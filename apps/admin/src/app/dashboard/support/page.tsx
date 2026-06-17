"use client"

import { useState } from "react"
import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"
import { Card, CardContent } from "@guestpost/ui"
import { Button } from "@guestpost/ui"
import { Input } from "@guestpost/ui"
import { Badge, StatusBadge, getTicketStatusPresentation, FulfillmentChannelBadge } from "@guestpost/ui"
import type { TicketStatus } from "@guestpost/database"
import { Skeleton } from "@guestpost/ui"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@guestpost/ui"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@guestpost/ui"
import {
  Search,
  RefreshCw,
  AlertCircle,
  HeadphonesIcon,
  ArrowRight,
} from "lucide-react"
import { formatDistanceToNow } from "date-fns"

// Phase 7.9 #28 — ticket status presentation comes from
// getTicketStatusPresentation in @guestpost/ui. Local STATUS_COLORS deleted.

// Phase 7.9 #29 — local ChannelBadge deleted; using shared
// <FulfillmentChannelBadge> from @guestpost/ui (channel snapshot per
// Phase 6.5). Same visual category, single source of truth.

export default function AdminSupportPage() {
  const { user } = useAuth()
  const isFinance = user?.staffRole === "FINANCE"

  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<string>("all")
  const [channelFilter, setChannelFilter] = useState<string>("all")
  const [assigneeFilter, setAssigneeFilter] = useState<string>("all")
  const [page, setPage] = useState(1)

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin", "tickets", search, statusFilter, channelFilter, assigneeFilter, page],
    queryFn: () =>
      api.admin.listTickets({
        search: search || undefined,
        status: statusFilter === "all" ? undefined : statusFilter,
        channel: channelFilter === "all" ? undefined : (channelFilter as "PLATFORM" | "PUBLISHER"),
        assignedToUserId:
          assigneeFilter === "all"
            ? undefined
            : assigneeFilter === "UNASSIGNED"
              ? "UNASSIGNED"
              : assigneeFilter,
        page,
        limit: 20,
      }),
  })

  const tickets = data?.items ?? []
  const pagination = data
    ? { page: data.page, totalPages: data.totalPages, total: data.total }
    : { page: 1, totalPages: 1, total: 0 }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <AlertCircle className="h-12 w-12 text-destructive mb-4" />
        <h2 className="text-xl font-semibold mb-2">Failed to load tickets</h2>
        <p className="text-muted-foreground mb-4">{(error as Error).message}</p>
        <Button onClick={() => refetch()}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Support</h1>
          <p className="text-muted-foreground">
            {isFinance
              ? "Read-only on Platform tickets; full reply on Publisher tickets. Internal notes available on every ticket."
              : "Customer support ticket queue"}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search tickets..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(1)
            }}
            className="pl-9"
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={(v) => {
            setStatusFilter(v)
            setPage(1)
          }}
        >
          <SelectTrigger className="w-44">
            <SelectValue placeholder="All status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All status</SelectItem>
            <SelectItem value="OPEN">Open</SelectItem>
            <SelectItem value="IN_PROGRESS">In Progress</SelectItem>
            <SelectItem value="WAITING_ON_CUSTOMER">Waiting on Customer</SelectItem>
            <SelectItem value="RESOLVED">Resolved</SelectItem>
            <SelectItem value="CLOSED">Closed</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={channelFilter}
          onValueChange={(v) => {
            setChannelFilter(v)
            setPage(1)
          }}
        >
          <SelectTrigger className="w-44">
            <SelectValue placeholder="All channels" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All channels</SelectItem>
            <SelectItem value="PLATFORM">Platform</SelectItem>
            <SelectItem value="PUBLISHER">Publisher</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={assigneeFilter}
          onValueChange={(v) => {
            setAssigneeFilter(v)
            setPage(1)
          }}
        >
          <SelectTrigger className="w-44">
            <SelectValue placeholder="All assignees" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All assignees</SelectItem>
            <SelectItem value="UNASSIGNED">Unassigned platform pool</SelectItem>
            {user?.id && <SelectItem value={user.id}>Assigned to me</SelectItem>}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : tickets.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <HeadphonesIcon className="h-12 w-12 text-muted-foreground/50" />
              <h3 className="mt-4 text-lg font-medium">No tickets found</h3>
              <p className="text-sm text-muted-foreground">
                {search ? "Try a different search" : "No support tickets match these filters"}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Subject</TableHead>
                    <TableHead>Channel</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Assigned</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Messages</TableHead>
                    <TableHead>Last Updated</TableHead>
                    <TableHead className="text-right" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tickets.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell className="font-medium max-w-[280px] truncate">{t.subject}</TableCell>
                      <TableCell>
                        <FulfillmentChannelBadge channel={t.fulfillmentChannel as any} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {t.customer.name || t.customer.email}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {t.fulfillmentChannel === "PLATFORM"
                          ? t.assignedTo?.name || (
                              <span className="text-amber-600">Unassigned</span>
                            )
                          : t.assignedPublisher?.name || "—"}
                      </TableCell>
                      <TableCell>
                        {(() => {
                          const p = getTicketStatusPresentation(t.status as TicketStatus)
                          return <StatusBadge variant={p.variant}>{p.label}</StatusBadge>
                        })()}
                      </TableCell>
                      <TableCell className="text-center">{t.messageCount}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDistanceToNow(new Date(t.updatedAt), { addSuffix: true })}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={`/dashboard/support/${t.id}`}>
                            View <ArrowRight className="ml-1 h-4 w-4" />
                          </Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={pagination.page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {pagination.page} of {pagination.totalPages} ({pagination.total} total)
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={pagination.page >= pagination.totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  )
}
