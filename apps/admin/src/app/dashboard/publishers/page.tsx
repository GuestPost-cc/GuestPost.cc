"use client"

import { useState, useMemo } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../../lib/api"
import { Card, CardContent, CardHeader, CardTitle } from "@guestpost/ui"
import { Button } from "@guestpost/ui"
import { Input } from "@guestpost/ui"
import { Badge } from "@guestpost/ui"
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
  CheckCircle,
  XCircle,
  Ban,
  UserCheck,
  ExternalLink,
  Newspaper,
} from "lucide-react"
import { format } from "date-fns"
import { toast } from "sonner"

export default function AdminPublishersPage() {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState("")
  const [page, setPage] = useState(1)

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin", "publishers", search, statusFilter, page],
    queryFn: () => api.admin.listPublishers({ search: search || undefined, status: statusFilter || undefined, page, limit: 20 }),
  })

  const approveMutation = useMutation({
    mutationFn: (id: string) => api.admin.approvePublisher(id),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["admin", "publishers"] }); toast.success("Publisher approved") },
    onError: () => toast.error("Failed to approve publisher"),
  })

  const rejectMutation = useMutation({
    mutationFn: (id: string) => api.admin.rejectPublisher(id),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["admin", "publishers"] }); toast.success("Publisher rejected") },
    onError: () => toast.error("Failed to reject publisher"),
  })

  const suspendMutation = useMutation({
    mutationFn: (id: string) => api.admin.suspendPublisher(id),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["admin", "publishers"] }); toast.success("Publisher suspended") },
    onError: () => toast.error("Failed to suspend publisher"),
  })

  const restoreMutation = useMutation({
    mutationFn: (id: string) => api.admin.restorePublisher(id),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["admin", "publishers"] }); toast.success("Publisher restored") },
    onError: () => toast.error("Failed to restore publisher"),
  })

  const publishers = data?.items ?? []
  const pagination = data ? { page: data.page, totalPages: data.totalPages, total: data.total } : { page: 1, totalPages: 1, total: 0 }

  const filteredPublishers = useMemo(() => {
    if (!search) return publishers
    const q = search.toLowerCase()
    return publishers.filter((p: any) =>
      p.name?.toLowerCase().includes(q) || p.email.toLowerCase().includes(q)
    )
  }, [publishers, search])

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <AlertCircle className="h-12 w-12 text-destructive mb-4" />
        <h2 className="text-xl font-semibold mb-2">Failed to load publishers</h2>
        <p className="text-muted-foreground mb-4">{(error as Error).message}</p>
        <Button onClick={() => refetch()}><RefreshCw className="mr-2 h-4 w-4" />Retry</Button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Publishers</h1>
          <p className="text-muted-foreground">Manage publisher accounts and applications</p>
        </div>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search publishers..." value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }} className="pl-9" />
        </div>
        <div className="flex gap-2">
          <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1) }}>
            <SelectTrigger className="w-36"><SelectValue placeholder="All status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All status</SelectItem>
              <SelectItem value="ACTIVE">Active</SelectItem>
              <SelectItem value="PENDING">Pending</SelectItem>
              <SelectItem value="SUSPENDED">Suspended</SelectItem>
              <SelectItem value="REJECTED">Rejected</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : filteredPublishers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Newspaper className="h-12 w-12 text-muted-foreground/50" />
              <h3 className="mt-4 text-lg font-medium">No publishers found</h3>
              <p className="text-sm text-muted-foreground">{search ? "Try a different search" : "No publishers registered yet"}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="text-center">Websites</TableHead>
                  <TableHead className="text-center">Active Orders</TableHead>
                  <TableHead>Earnings</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredPublishers.map((p: any) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.name || "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{p.email}</TableCell>
                    <TableCell><Badge variant="secondary">{p.publisherRole || "NONE"}</Badge></TableCell>
                    <TableCell className="text-center">{p.websiteCount}</TableCell>
                    <TableCell className="text-center">{p.activeOrderCount}</TableCell>
                    <TableCell className="font-mono text-sm">${(p.totalEarnings || 0).toFixed(2)}</TableCell>
                    <TableCell>
                      {p.banned ? (
                        <Badge variant="destructive">Suspended</Badge>
                      ) : p.publisherRole === "REJECTED" ? (
                        <Badge variant="destructive">Rejected</Badge>
                      ) : p.publisherRole === "PENDING" || !p.publisherRole ? (
                        <Badge variant="secondary">Pending</Badge>
                      ) : (
                        <Badge variant="default">Active</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{format(new Date(p.createdAt), "PP")}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        {p.publisherRole === "PENDING" || !p.publisherRole ? (
                          <>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-green-500" onClick={() => approveMutation.mutate(p.id)} disabled={approveMutation.isPending}>
                              <CheckCircle className="h-4 w-4" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => rejectMutation.mutate(p.id)} disabled={rejectMutation.isPending}>
                              <XCircle className="h-4 w-4" />
                            </Button>
                          </>
                        ) : p.banned ? (
                          <Button variant="ghost" size="sm" onClick={() => restoreMutation.mutate(p.id)} disabled={restoreMutation.isPending}>
                            <UserCheck className="mr-1 h-4 w-4" />Restore
                          </Button>
                        ) : (
                          <Button variant="ghost" size="sm" onClick={() => suspendMutation.mutate(p.id)} disabled={suspendMutation.isPending}>
                            <Ban className="mr-1 h-4 w-4" />Suspend
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button variant="outline" size="sm" disabled={pagination.page <= 1} onClick={() => setPage(p => p - 1)}>Previous</Button>
          <span className="text-sm text-muted-foreground">Page {pagination.page} of {pagination.totalPages} ({pagination.total} total)</span>
          <Button variant="outline" size="sm" disabled={pagination.page >= pagination.totalPages} onClick={() => setPage(p => p + 1)}>Next</Button>
        </div>
      )}
    </div>
  )
}
