"use client"

import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../../lib/api"
import { Card, CardContent } from "@guestpost/ui"
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
import { Search, RefreshCw, AlertCircle, Newspaper } from "lucide-react"
import { format } from "date-fns"
import { toast } from "sonner"

type Tier = "NEW" | "TRUSTED" | "VERIFIED"

// Tier is the platform's real trust lever: it drives withdrawal hold windows.
const TIER_BADGES: Record<Tier, { label: string; variant: "secondary" | "default" | "outline" }> = {
  NEW: { label: "New", variant: "secondary" },
  TRUSTED: { label: "Trusted", variant: "outline" },
  VERIFIED: { label: "Verified", variant: "default" },
}

export default function AdminPublishersPage() {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin", "publishers", search, page],
    queryFn: () => api.admin.listPublishers({ search: search || undefined, page, limit: 20 }),
  })

  const tierMutation = useMutation({
    mutationFn: ({ id, tier }: { id: string; tier: Tier }) => api.admin.updatePublisherTier(id, tier),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "publishers"] })
      toast.success("Publisher tier updated")
    },
    onError: (err: Error) => toast.error(err.message || "Failed to update tier"),
  })

  const publishers = data?.items ?? []
  const pagination = data
    ? { page: data.page, totalPages: data.totalPages, total: data.total }
    : { page: 1, totalPages: 1, total: 0 }

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
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Publishers</h1>
        <p className="text-muted-foreground">
          Publisher accounts, balances, and trust tier (tier controls withdrawal hold windows)
        </p>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search by name or email..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1) }}
          className="pl-9"
        />
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : publishers.length === 0 ? (
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
                  <TableHead>Tier</TableHead>
                  <TableHead className="text-center">Websites</TableHead>
                  <TableHead className="text-center">Listings</TableHead>
                  <TableHead className="text-center">Settlements</TableHead>
                  <TableHead>Withdrawable</TableHead>
                  <TableHead>Lifetime</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead className="text-right">Set Tier</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {publishers.map((p) => {
                  const tierBadge = TIER_BADGES[p.tier] ?? TIER_BADGES.NEW
                  return (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">
                        {p.name || "—"}
                        {p.ownerBanned && <Badge variant="destructive" className="ml-2">Owner banned</Badge>}
                        {p.debtBalance > 0 && <Badge variant="destructive" className="ml-2">Debt ${p.debtBalance.toFixed(2)}</Badge>}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{p.email ?? "—"}</TableCell>
                      <TableCell><Badge variant={tierBadge.variant}>{tierBadge.label}</Badge></TableCell>
                      <TableCell className="text-center">{p.websiteCount}</TableCell>
                      <TableCell className="text-center">{p.listingCount}</TableCell>
                      <TableCell className="text-center">{p.settlementCount}</TableCell>
                      <TableCell className="font-mono text-sm">${p.withdrawableBalance.toFixed(2)}</TableCell>
                      <TableCell className="font-mono text-sm">${p.lifetimeEarnings.toFixed(2)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{format(new Date(p.createdAt), "PP")}</TableCell>
                      <TableCell className="text-right">
                        <Select
                          value={p.tier}
                          onValueChange={(v) => tierMutation.mutate({ id: p.id, tier: v as Tier })}
                          disabled={tierMutation.isPending}
                        >
                          <SelectTrigger className="w-32 ml-auto"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="NEW">New</SelectItem>
                            <SelectItem value="TRUSTED">Trusted</SelectItem>
                            <SelectItem value="VERIFIED">Verified</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                    </TableRow>
                  )
                })}
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
