"use client"

import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../../lib/api"
import { Card, CardContent, CardHeader, CardTitle } from "@guestpost/ui"
import { Button } from "@guestpost/ui"
import { Input } from "@guestpost/ui"
import { Badge } from "@guestpost/ui"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@guestpost/ui"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@guestpost/ui"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@guestpost/ui"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@guestpost/ui"
import { Skeleton } from "@guestpost/ui"
import {
  Store,
  Star,
  Eye,
  CheckCircle,
  XCircle,
  MoreVertical,
  ToggleLeft,
  ToggleRight,
  Flag,
  Search,
  Filter,
  AlertTriangle,
  ShieldCheck,
} from "lucide-react"
import { format } from "date-fns"
import { toast } from "sonner"
import { flexRender } from "@tanstack/react-table"

interface Listing {
  id: string
  title: string
  slug: string
  type: string
  status: string
  price: number
  currency: string
  domainRating?: number
  traffic?: number
  featured: boolean
  verified: boolean
  category?: { name: string }
  organization?: { name: string }
  publisher?: { name: string }
  createdAt: string
}

const statusColors: Record<string, string> = {
  APPROVED: "bg-green-100 text-green-800",
  DRAFT: "bg-gray-100 text-gray-800",
  PENDING_REVIEW: "bg-yellow-100 text-yellow-800",
  PAUSED: "bg-orange-100 text-orange-800",
  REJECTED: "bg-red-100 text-red-800",
  ARCHIVED: "bg-gray-100 text-gray-500",
}

export default function AdminMarketplacePage() {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [typeFilter, setTypeFilter] = useState("all")
  const [page, setPage] = useState(1)

  const { data, isLoading } = useQuery({
    queryKey: ["admin-marketplace-listings", page, statusFilter, typeFilter],
    queryFn: async () => {
      const params: any = { page, limit: 20 }
      if (statusFilter !== "all") params.status = statusFilter
      if (typeFilter !== "all") params.type = typeFilter
      const res = await api.admin.listMarketplaceListings(params)
      return res
    },
  })

  const { data: stats } = useQuery({
    queryKey: ["admin-marketplace-stats"],
    queryFn: async () => {
      const res = await api.admin.getMarketplaceStats()
      return res
    },
  })

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.admin.updateListingStatus(id, status),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-marketplace-listings"] })
      toast.success("Listing status updated")
    },
    onError: () => toast.error("Failed to update status"),
  })

  const toggleFeatured = useMutation({
    mutationFn: ({ id, featured }: { id: string; featured: boolean }) =>
      api.admin.toggleListingFeatured(id, featured),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-marketplace-listings"] })
      toast.success("Featured status updated")
    },
    onError: () => toast.error("Failed to update featured status"),
  })

  const toggleVerified = useMutation({
    mutationFn: ({ id, verified }: { id: string; verified: boolean }) =>
      api.admin.toggleListingVerified(id, verified),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-marketplace-listings"] })
      toast.success("Verified status updated")
    },
    onError: () => toast.error("Failed to update verified status"),
  })

  const deleteListing = useMutation({
    mutationFn: (id: string) => api.admin.deleteListing(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-marketplace-listings"] })
      toast.success("Listing deleted")
    },
    onError: () => toast.error("Failed to delete listing"),
  })

  function formatPrice(price: number, currency: string = "USD") {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(price)
  }

  const listings = data?.listings || []
  const pagination = data?.pagination || { page: 1, totalPages: 0, total: 0 }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Marketplace Management</h1>
        <p className="text-muted-foreground">Manage marketplace listings and content</p>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total Listings</CardTitle>
            <Store className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.totalListings || 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Active</CardTitle>
            <CheckCircle className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.activeListings || 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total Reviews</CardTitle>
            <Star className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.totalReviews || 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Avg Rating</CardTitle>
            <Star className="h-4 w-4 text-yellow-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stats?.avgRating ? stats.avgRating.toFixed(1) : "N/A"}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search listings..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex gap-2">
          <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1) }}>
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="APPROVED">Approved</SelectItem>
              <SelectItem value="DRAFT">Draft</SelectItem>
              <SelectItem value="PENDING_REVIEW">Pending Review</SelectItem>
              <SelectItem value="PAUSED">Paused</SelectItem>
              <SelectItem value="REJECTED">Rejected</SelectItem>
              <SelectItem value="ARCHIVED">Archived</SelectItem>
            </SelectContent>
          </Select>
          <Select value={typeFilter} onValueChange={(v) => { setTypeFilter(v); setPage(1) }}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="GUEST_POST">Guest Post</SelectItem>
              <SelectItem value="NICHE_EDIT">Niche Edit</SelectItem>
              <SelectItem value="EDITORIAL_LINK">Editorial Link</SelectItem>
              <SelectItem value="PUBLISHER_WEBSITE">Publisher Website</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="border rounded-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[300px]">Listing</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Price</TableHead>
              <TableHead>DR</TableHead>
              <TableHead>Featured</TableHead>
              <TableHead>Verified</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-[50px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 10 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 9 }).map((_, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : listings.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                  No listings found
                </TableCell>
              </TableRow>
            ) : (
              listings.map((listing: Listing) => (
                <TableRow key={listing.id}>
                  <TableCell>
                    <div>
                      <div className="font-medium">{listing.title}</div>
                      <div className="text-sm text-muted-foreground">{listing.slug}</div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{listing.type.replace("_", " ")}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge className={statusColors[listing.status] || "bg-gray-100"}>
                      {listing.status.replace("_", " ")}
                    </Badge>
                  </TableCell>
                  <TableCell>{formatPrice(listing.price, listing.currency)}</TableCell>
                  <TableCell>{listing.domainRating || "-"}</TableCell>
                  <TableCell>
                    {listing.featured ? (
                      <ToggleRight className="h-5 w-5 text-primary" />
                    ) : (
                      <ToggleLeft
                        className="h-5 w-5 text-muted-foreground cursor-pointer"
                        onClick={() => toggleFeatured.mutate({ id: listing.id, featured: true })}
                      />
                    )}
                  </TableCell>
                  <TableCell>
                    {listing.verified ? (
                      <ShieldCheck className="h-5 w-5 text-green-500" />
                    ) : (
                      <XCircle className="h-5 w-5 text-muted-foreground" />
                    )}
                  </TableCell>
                  <TableCell>{format(new Date(listing.createdAt), "MMM d, yyyy")}</TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() =>
                            toggleFeatured.mutate({
                              id: listing.id,
                              featured: !listing.featured,
                            })
                          }
                        >
                          {listing.featured ? "Remove Featured" : "Mark Featured"}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() =>
                            toggleVerified.mutate({
                              id: listing.id,
                              verified: !listing.verified,
                            })
                          }
                        >
                          {listing.verified ? "Remove Verified" : "Mark Verified"}
                        </DropdownMenuItem>
                        <DropdownMenuItem asChild>
                          <a href={`/dashboard/marketplace/${listing.slug}`} target="_blank">
                            View Public Page
                          </a>
                        </DropdownMenuItem>
                        {listing.status !== "ARCHIVED" && (
                          <>
                            <DropdownMenuItem
                              onClick={() =>
                                updateStatus.mutate({
                                  id: listing.id,
                                  status: "APPROVED",
                                })
                              }
                            >
                              Approve
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() =>
                                updateStatus.mutate({
                                  id: listing.id,
                                  status: "REJECTED",
                                })
                              }
                            >
                              Reject
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() =>
                                updateStatus.mutate({
                                  id: listing.id,
                                  status: "PAUSED",
                                })
                              }
                            >
                              Pause / Suspend
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={() => deleteListing.mutate(listing.id)}
                            >
                              Delete
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            disabled={page === 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {pagination.page} of {pagination.totalPages}
          </span>
          <Button
            variant="outline"
            disabled={page === pagination.totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  )
}