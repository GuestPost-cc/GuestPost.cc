"use client"

import { useState, useMemo } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../../lib/api"
import { Card, CardContent } from "@guestpost/ui"
import { Button } from "@guestpost/ui"
import { Input } from "@guestpost/ui"
import { Badge } from "@guestpost/ui"
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@guestpost/ui"
import { Skeleton } from "@guestpost/ui"
import {
  ShoppingCart,
  Search,
  CheckCircle,
  XCircle,
  AlertCircle,
  RefreshCw,
  DollarSign,
  Eye,
} from "lucide-react"
import { format } from "date-fns"
import { toast } from "sonner"
import { ORDER_STATUS_LABELS } from "@guestpost/shared"
import {
  createColumnHelper,
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  flexRender,
  type ColumnDef,
} from "@tanstack/react-table"
import { adminFetch } from "../../../lib/api"

interface Order {
  id: string
  type: string
  status: string
  amount: number | null
  currency: string
  createdAt: string
  customer: { id: string; name: string | null; email: string } | null
  website?: { id: string; url: string } | null
  items?: Array<{ website: { id: string; url: string } | null }>
}

const statusVariant = (status: string) => {
  switch (status) {
    case "COMPLETED":
    case "SETTLED":
    case "VERIFIED":
      return "default"
    case "PENDING_PAYMENT":
    case "PENDING":
      return "secondary"
    case "PUBLISHED":
      return "default"
    case "REJECTED":
    case "CANCELLED":
    case "REFUNDED":
      return "destructive"
    case "UNDER_REVIEW":
      return "secondary"
    case "PAID":
    case "ASSIGNED":
      return "outline"
    default:
      return "outline"
  }
}

function OrderActions({ order }: { order: Order }) {
  const queryClient = useQueryClient()
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)

  const transitionMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      return api.orders.transitionStatus(id, status as any)
    },
    onSuccess: () => {
      toast.success("Order status updated")
      queryClient.invalidateQueries({ queryKey: ["admin", "orders"] })
    },
    onError: () => toast.error("Failed to update order"),
  })

  return (
    <>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => { setSelectedOrder(order); setDetailOpen(true) }}>
          <Eye className="h-3 w-3" />
        </Button>
        {order.status === "PENDING_PAYMENT" && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => transitionMutation.mutate({ id: order.id, status: "PAID" })}
            disabled={transitionMutation.isPending}
          >
            <CheckCircle className="h-3 w-3" />
          </Button>
        )}
        {order.status === "ASSIGNED" && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => transitionMutation.mutate({ id: order.id, status: "CONTENT_CREATION" })}
            disabled={transitionMutation.isPending}
          >
            <RefreshCw className="h-3 w-3" />
          </Button>
        )}
        {order.status === "PUBLISHED" && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => transitionMutation.mutate({ id: order.id, status: "VERIFIED" })}
            disabled={transitionMutation.isPending}
          >
            <CheckCircle className="h-3 w-3" />
          </Button>
        )}
        {["PENDING_PAYMENT", "DRAFT"].includes(order.status) && (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => transitionMutation.mutate({ id: order.id, status: "CANCELLED" })}
            disabled={transitionMutation.isPending}
          >
            <XCircle className="h-3 w-3" />
          </Button>
        )}
        {["COMPLETED", "VERIFIED", "PUBLISHED"].includes(order.status) && (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => transitionMutation.mutate({ id: order.id, status: "REFUNDED" })}
            disabled={transitionMutation.isPending}
          >
            <DollarSign className="h-3 w-3" />
          </Button>
        )}
      </div>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Order Details</DialogTitle>
          </DialogHeader>
          {selectedOrder && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground">Order ID</p>
                  <p className="font-mono">{selectedOrder.id}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Service Type</p>
                  <p className="capitalize">
                    {(selectedOrder.type ?? "").replace(/_/g, " ").toLowerCase() || "—"}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">Status</p>
                  <Badge variant={statusVariant(selectedOrder.status) as any}>
                    {selectedOrder.status.replace(/_/g, " ")}
                  </Badge>
                </div>
                <div>
                  <p className="text-muted-foreground">Amount</p>
                  <p className="font-medium">
                    {selectedOrder.amount
                      ? `${selectedOrder.currency} ${Number(selectedOrder.amount).toFixed(2)}`
                      : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">Customer</p>
                  <p>{selectedOrder.customer?.name ?? selectedOrder.customer?.email ?? "—"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Created</p>
                  <p>{format(new Date(selectedOrder.createdAt), "PP p")}</p>
                </div>
              </div>
              {(selectedOrder.items?.length ?? 0) > 0 && (
                <div>
                  <p className="text-sm font-medium mb-2">Items</p>
                  <div className="space-y-2">
                    {selectedOrder.items?.map((item, i) => (
                      <div key={i} className="rounded border p-3 text-sm">
                        {item.website?.url ?? "No website assigned"}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

const columnHelper = createColumnHelper<Order>()

export default function OrdersPage() {
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<string>("all")

  const { data: orders = [], isLoading, error, refetch } = useQuery({
    queryKey: ["admin", "orders"],
    queryFn: () => api.admin.listOrders() as Promise<Order[]>,
    retry: 1,
  })

  const columns = useMemo<ColumnDef<Order, any>[]>(
    () => [
      columnHelper.accessor("id", {
        header: "ID",
        cell: (info) => (
          <span className="font-mono text-xs">{info.getValue().slice(0, 8)}</span>
        ),
      }),
      columnHelper.accessor("customer", {
        header: "Customer",
        cell: (info) => (
          <div>
            <div className="font-medium">{info.getValue()?.name ?? "—"}</div>
            <div className="text-xs text-muted-foreground">{info.getValue()?.email ?? "—"}</div>
          </div>
        ),
      }),
      columnHelper.accessor("type", {
        header: "Type",
        cell: (info) => (
          <span className="text-muted-foreground capitalize">
            {(info.getValue() ?? "").replace(/_/g, " ").toLowerCase() || "—"}
          </span>
        ),
      }),
      columnHelper.accessor("status", {
        header: "Status",
        cell: (info) => (
          <Badge variant={statusVariant(info.getValue()) as any}>
            {info.getValue().replace(/_/g, " ")}
          </Badge>
        ),
      }),
      columnHelper.accessor("items", {
        header: "Review Window",
        cell: (info) => {
          const items = info.getValue()
          const website = items?.[0]?.website?.url
          return (
            <span className="text-muted-foreground text-xs">
              {website ?? "—"}
            </span>
          )
        },
      }),
      columnHelper.accessor("amount", {
        header: "Amount",
        cell: (info) => (
          <span className="font-medium">
            {info.getValue() ? `${info.row.original.currency} ${Number(info.getValue()).toFixed(2)}` : "—"}
          </span>
        ),
      }),
      columnHelper.accessor("createdAt", {
        header: "Created",
        cell: (info) => (
          <span className="text-muted-foreground">
            {format(new Date(info.getValue()), "PP")}
          </span>
        ),
      }),
      columnHelper.display({
        id: "actions",
        cell: (info) => <OrderActions order={info.row.original} />,
      }),
    ],
    [],
  )

  const filteredOrders = useMemo(() => {
    return orders.filter((o) => {
      const matchesSearch =
        search === "" ||
        o.customer?.name?.toLowerCase().includes(search.toLowerCase()) ||
        o.customer?.email?.toLowerCase().includes(search.toLowerCase()) ||
        o.id.toLowerCase().includes(search.toLowerCase())
      const matchesStatus = statusFilter === "all" || o.status === statusFilter
      return matchesSearch && matchesStatus
    })
  }, [orders, search, statusFilter])

  const table = useReactTable({
    data: filteredOrders,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    state: { pagination: { pageIndex: 0, pageSize: 20 } },
  })

  if (error) {
    return (
      <div className="flex min-h-[400px] flex-col items-center justify-center gap-4">
        <AlertCircle className="h-12 w-12 text-destructive" />
        <p className="text-destructive">{error.message}</p>
        <Button onClick={() => refetch()}>Retry</Button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Orders</h1>
        <span className="text-sm text-muted-foreground">
          {isLoading ? "..." : `${filteredOrders.length} orders`}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by customer or ID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            {Object.entries(ORDER_STATUS_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : filteredOrders.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <ShoppingCart className="h-10 w-10 text-muted-foreground" />
              <p className="text-muted-foreground">No orders found</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map((hg) => (
                  <TableRow key={hg.id}>
                    {hg.headers.map((h) => (
                      <TableHead key={h.id}>
                        {h.isPlaceholder
                          ? null
                          : flexRender(h.column.columnDef.header, h.getContext())}
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
                        {typeof cell.column.columnDef.cell === 'function' 
                          ? cell.column.columnDef.cell(cell.getContext())
                          : null}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {filteredOrders.length > 20 && (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  )
}