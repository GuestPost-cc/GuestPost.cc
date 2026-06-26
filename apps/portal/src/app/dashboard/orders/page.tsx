"use client"

import type { OrderStatus } from "@guestpost/database"
import { isActiveOrder, sortOrdersByPriority } from "@guestpost/shared"
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  getOrderStatusPresentation,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@guestpost/ui"
import { zodResolver } from "@hookform/resolvers/zod"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  type ColumnDef,
  type ColumnFiltersState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table"
import { format } from "date-fns"
import {
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Edit,
  Eye,
  FileText,
  MoreHorizontal,
  Plus,
  Search,
  XCircle,
} from "lucide-react"
import Link from "next/link"
import { useMemo, useState } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"
import { api } from "../../../lib/api"

const ORDER_STATUSES = [
  "DRAFT",
  "PENDING_PAYMENT",
  "PAID",
  "ASSIGNED",
  "CONTENT_CREATION",
  "OUTREACH",
  "PUBLISHED",
  "UNDER_REVIEW",
  "COMPLETED",
  "CANCELLED",
  "REFUNDED",
] as const

const SERVICE_TYPES = [
  "GUEST_POST",
  "NICHE_EDIT",
  "EDITORIAL_LINK",
  "OUTREACH_LINK",
  "LOCAL_CITATION",
  "FOUNDATION_LINK",
  "BLOG_ARTICLE",
  "SEO_CONTENT",
] as const

const createOrderSchema = z.object({
  campaignId: z.string().min(1, "Campaign is required"),
  serviceType: z.string().min(1, "Service type is required"),
  topic: z.string().optional(),
  instructions: z.string().optional(),
  budget: z.coerce.number().optional(),
})

type CreateOrderForm = z.infer<typeof createOrderSchema>

function OrdersTableSkeleton() {
  return (
    <div className="space-y-3">
      {[...Array(5)].map((_, i) => (
        <div key={i} className="flex items-center gap-4 rounded-lg border p-4">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-6 w-24 rounded-full" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-8 w-8" />
        </div>
      ))}
    </div>
  )
}

interface Order {
  id: string
  status: string
  campaignId?: string
  campaign?: { id: string; name: string }
  items: Array<{
    id: string
    serviceType: string
    topic: string | null
    website: { id: string; url: string } | null
  }>
  totalAmount: number | null
  createdAt: string
  updatedAt: string
  events: Array<{
    id: string
    eventType: string
    createdAt: string
  }>
}

export default function OrdersPage() {
  const queryClient = useQueryClient()
  const [showCreateOrder, setShowCreateOrder] = useState(false)
  const [statusFilter, setStatusFilter] = useState<string>("")
  const [searchQuery, setSearchQuery] = useState("")
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 10 })
  const [_selectedOrder, _setSelectedOrder] = useState<Order | null>(null)
  const [showCancelDialog, setShowCancelDialog] = useState<Order | null>(null)

  const cancelMutation = useMutation({
    mutationFn: (id: string) =>
      api.orders.updateStatus(id, "CANCELLED") as Promise<any>,
    onSuccess: () => {
      toast.success("Order cancelled successfully")
      queryClient.invalidateQueries({ queryKey: ["orders"] })
      setShowCancelDialog(null)
    },
    onError: () => {
      toast.error("Failed to cancel order")
    },
  })

  const { data: ordersData, isLoading } = useQuery<Order[]>({
    queryKey: ["orders"],
    queryFn: () => api.orders.list() as Promise<Order[]>,
  })

  const { data: campaignsData } = useQuery({
    queryKey: ["campaigns"],
    queryFn: () => api.campaigns.listCampaigns(),
  })

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
  } = useForm<CreateOrderForm>({
    resolver: zodResolver(createOrderSchema),
  })

  const onSubmit = async (data: CreateOrderForm) => {
    try {
      // Mirrors CreateOrderDto — quick-create makes a DRAFT without a
      // website; the user picks placements before payment. Budget was a
      // fabricated field: prices come from listings server-side.
      await api.orders.create({
        type: data.serviceType as any,
        title: data.topic,
        instructions: data.instructions,
        campaignId: data.campaignId,
      })
      toast.success("Order created successfully")
      queryClient.invalidateQueries({ queryKey: ["orders"] })
      setShowCreateOrder(false)
      reset()
    } catch (_error) {
      toast.error("Failed to create order")
    }
  }

  const columns = useMemo<ColumnDef<Order>[]>(
    () => [
      {
        accessorKey: "id",
        header: ({ column }) => (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Order ID
            <ArrowUpDown className="ml-2 h-4 w-4" />
          </Button>
        ),
        cell: ({ row }) => (
          <Link
            href={`/dashboard/orders/${row.original.id}`}
            className="font-mono text-xs hover:text-primary"
          >
            #{row.original.id.slice(0, 8)}
          </Link>
        ),
      },
      {
        accessorKey: "website",
        header: "Website",
        cell: ({ row }) => (
          <span className="text-sm">
            {row.original.items?.[0]?.website?.url
              ? new URL(row.original.items[0].website.url).hostname
              : "—"}
          </span>
        ),
      },
      {
        accessorKey: "campaign",
        header: "Campaign",
        cell: ({ row }) => (
          <span className="text-sm">{row.original.campaign?.name || "—"}</span>
        ),
      },
      {
        accessorKey: "serviceType",
        header: ({ column }) => (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Service
            <ArrowUpDown className="ml-2 h-4 w-4" />
          </Button>
        ),
        cell: ({ row }) => (
          <span className="text-sm capitalize">
            {row.original.items?.[0]?.serviceType
              ?.replace(/_/g, " ")
              .toLowerCase() ?? "—"}
          </span>
        ),
      },
      {
        accessorKey: "status",
        header: ({ column }) => (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Status
            <ArrowUpDown className="ml-2 h-4 w-4" />
          </Button>
        ),
        cell: ({ row }) => {
          const p = getOrderStatusPresentation(
            row.original.status as OrderStatus,
          )
          return <StatusBadge variant={p.variant}>{p.label}</StatusBadge>
        },
      },
      {
        accessorKey: "totalAmount",
        header: ({ column }) => (
          <Button
            variant="ghost"
            size="sm"
            className="justify-end"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Price
            <ArrowUpDown className="ml-2 h-4 w-4" />
          </Button>
        ),
        cell: ({ row }) => (
          <span className="text-right font-mono text-sm">
            {row.original.totalAmount
              ? `$${row.original.totalAmount.toFixed(2)}`
              : "—"}
          </span>
        ),
      },
      {
        accessorKey: "createdAt",
        header: ({ column }) => (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Created
            <ArrowUpDown className="ml-2 h-4 w-4" />
          </Button>
        ),
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {format(new Date(row.original.createdAt), "PP")}
          </span>
        ),
      },
      {
        id: "actions",
        cell: ({ row }) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link href={`/dashboard/orders/${row.original.id}`}>
                  <Eye className="mr-2 h-4 w-4" />
                  View Details
                </Link>
              </DropdownMenuItem>
              {row.original.status !== "COMPLETED" &&
                row.original.status !== "CANCELLED" && (
                  <>
                    <DropdownMenuItem asChild>
                      <Link href={`/dashboard/orders/${row.original.id}`}>
                        <Edit className="mr-2 h-4 w-4" />
                        Request Revision
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive"
                      onClick={() => setShowCancelDialog(row.original)}
                    >
                      <XCircle className="mr-2 h-4 w-4" />
                      Cancel Order
                    </DropdownMenuItem>
                  </>
                )}
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    [],
  )

  const filteredData = useMemo(() => {
    if (!ordersData) return []
    let data = ordersData

    if (statusFilter && statusFilter !== "all") {
      data = data.filter((order: Order) => order.status === statusFilter)
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      data = data.filter(
        (order: Order) =>
          order.id.toLowerCase().includes(query) ||
          order.items?.[0]?.serviceType?.toLowerCase().includes(query) ||
          order.items?.[0]?.website?.url?.toLowerCase().includes(query),
      )
    }

    // Unfinished / unsettled orders (and anything needing attention) always
    // rank above closed ones, newest first within each tier.
    return sortOrdersByPriority(data)
  }, [ordersData, statusFilter, searchQuery])

  const activeCount = useMemo(
    () =>
      (ordersData ?? []).filter((o: Order) => isActiveOrder(o.status)).length,
    [ordersData],
  )

  const table = useReactTable({
    data: filteredData,
    columns,
    state: {
      sorting,
      columnFilters,
      pagination,
    },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Orders</h1>
            <p className="text-muted-foreground">
              Manage your guest post orders
            </p>
          </div>
        </div>
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-32" />
          </CardHeader>
          <CardContent>
            <OrdersTableSkeleton />
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Orders</h1>
          <p className="text-muted-foreground">
            {activeCount > 0
              ? `${activeCount} order${activeCount !== 1 ? "s" : ""} in progress — shown first`
              : "Manage your guest post orders"}
          </p>
        </div>
        <Button onClick={() => setShowCreateOrder(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New Order
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>All Orders</CardTitle>
              <CardDescription>
                {filteredData.length} order
                {filteredData.length !== 1 ? "s" : ""} found
              </CardDescription>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search orders..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value)
                    setPagination((p) => ({ ...p, pageIndex: 0 }))
                  }}
                  className="pl-9 w-64"
                />
              </div>
              <Select value={statusFilter} onValueChange={(value) => {
                  setStatusFilter(value)
                  setPagination((p) => ({ ...p, pageIndex: 0 }))
                }}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {ORDER_STATUSES.map((status) => (
                    <SelectItem key={status} value={status}>
                      {status.replace(/_/g, " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {filteredData.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <FileText className="h-12 w-12 text-muted-foreground/50" />
              <h3 className="mt-4 text-lg font-medium">No orders found</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {searchQuery || statusFilter
                  ? "Try adjusting your filters"
                  : "Create your first order to get started"}
              </p>
              {!searchQuery && !statusFilter && (
                <Button
                  className="mt-4"
                  onClick={() => setShowCreateOrder(true)}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  New Order
                </Button>
              )}
            </div>
          ) : (
            <>
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    {table.getHeaderGroups().map((headerGroup) => (
                      <TableRow key={headerGroup.id}>
                        {headerGroup.headers.map((header) => (
                          <TableHead key={header.id}>
                            {header.isPlaceholder
                              ? null
                              : flexRender(
                                  header.column.columnDef.header,
                                  header.getContext(),
                                )}
                          </TableHead>
                        ))}
                      </TableRow>
                    ))}
                  </TableHeader>
                  <TableBody>
                    {table.getRowModel().rows.map((row) => (
                      <TableRow key={row.id}>
                        {row.getVisibleCells().map((cell) => (
                          <TableCell key={cell.id}>
                            {flexRender(
                              cell.column.columnDef.cell,
                              cell.getContext(),
                            )}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="flex items-center justify-between py-4">
                <div className="text-sm text-muted-foreground">
                  Page {table.getState().pagination.pageIndex + 1} of{" "}
                  {table.getPageCount()} ({filteredData.length} total)
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => table.setPageIndex(0)}
                    disabled={!table.getCanPreviousPage()}
                  >
                    <ChevronsLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => table.previousPage()}
                    disabled={!table.getCanPreviousPage()}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => table.nextPage()}
                    disabled={!table.getCanNextPage()}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => table.setPageIndex(table.getPageCount() - 1)}
                    disabled={!table.getCanNextPage()}
                  >
                    <ChevronsRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={showCreateOrder} onOpenChange={setShowCreateOrder}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Create New Order</DialogTitle>
            <DialogDescription>
              Create a new order for your campaign
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="campaignId">Campaign *</Label>
                <Select
                  onValueChange={(value) => {
                    const event = { target: { value } }
                    register("campaignId").onChange(event)
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select campaign" />
                  </SelectTrigger>
                  <SelectContent>
                    {campaignsData?.map((campaign: any) => (
                      <SelectItem key={campaign.id} value={campaign.id}>
                        {campaign.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.campaignId && (
                  <p className="text-sm text-destructive">
                    {errors.campaignId.message}
                  </p>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="serviceType">Service Type *</Label>
                <Select
                  onValueChange={(value) => {
                    const event = { target: { value } }
                    register("serviceType").onChange(event)
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select service type" />
                  </SelectTrigger>
                  <SelectContent>
                    {SERVICE_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {type.replace(/_/g, " ")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.serviceType && (
                  <p className="text-sm text-destructive">
                    {errors.serviceType.message}
                  </p>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="topic">Topic</Label>
                <Input
                  id="topic"
                  {...register("topic")}
                  placeholder="e.g., Best SEO practices"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="instructions">Instructions</Label>
                <Input
                  id="instructions"
                  {...register("instructions")}
                  placeholder="Any specific requirements"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="budget">Budget (USD)</Label>
                <Input
                  id="budget"
                  type="number"
                  step="0.01"
                  {...register("budget", { valueAsNumber: true })}
                  placeholder="0.00"
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowCreateOrder(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Creating..." : "Create Order"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!showCancelDialog}
        onOpenChange={(open) => !open && setShowCancelDialog(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel Order</DialogTitle>
            <DialogDescription>
              Are you sure you want to cancel order #
              {showCancelDialog?.id.slice(0, 8)}? This action cannot be undone.
              Any reserved funds will be released back to your wallet.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowCancelDialog(null)}>
              Keep Order
            </Button>
            <Button
              variant="destructive"
              disabled={cancelMutation.isPending}
              onClick={() =>
                showCancelDialog && cancelMutation.mutate(showCancelDialog.id)
              }
            >
              {cancelMutation.isPending ? "Cancelling..." : "Cancel Order"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
