"use client"

import { useState, useMemo } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { sortOrdersByPriority } from "@guestpost/shared"
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
  DialogDescription,
  DialogFooter,
} from "@guestpost/ui"
import { Skeleton, Textarea } from "@guestpost/ui"
import {
  ShoppingCart,
  Search,
  XCircle,
  AlertCircle,
  DollarSign,
  Eye,
  Ban,
  ClipboardList,
  Scale,
} from "lucide-react"
import Link from "next/link"
import { format } from "date-fns"
import { toast } from "sonner"
import { useAuth } from "../../../lib/auth"
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

// Lifecycle is automated: customer pays -> publisher/ops fulfill -> the system
// verifies the live link -> customer confirms -> settlement. Staff don't push
// status manually; they monitor and intervene (force-cancel / refund), review
// deliveries in Fulfillment, and work Disputes there.
const TERMINAL = ["COMPLETED", "CANCELLED", "REFUNDED"]
const CANCELLABLE = ["DRAFT", "PENDING_PAYMENT", "PAID", "SUBMITTED", "ACCEPTED", "CONTENT_REQUESTED", "CONTENT_CREATION", "CONTENT_READY", "CUSTOMER_REVIEW", "APPROVED"]
const REFUNDABLE = ["PAID", "SUBMITTED", "ACCEPTED", "CONTENT_REQUESTED", "CONTENT_CREATION", "CONTENT_READY", "CUSTOMER_REVIEW", "APPROVED", "PUBLISHED", "VERIFIED", "DELIVERED", "SETTLED", "DISPUTED"]

function OrderActions({ order }: { order: Order }) {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const isSuperAdmin = user?.staffRole === "SUPER_ADMIN"
  const canRefund = user?.staffRole === "SUPER_ADMIN" || user?.staffRole === "FINANCE"
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [action, setAction] = useState<null | "cancel" | "refund">(null)
  const [reason, setReason] = useState("")

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["admin", "orders"] })

  const intervene = useMutation({
    mutationFn: ({ kind, reason }: { kind: "cancel" | "refund"; reason: string }) =>
      kind === "cancel" ? api.admin.forceCancelOrder(order.id, reason) : api.admin.refundOrder(order.id, reason),
    onSuccess: (_d, vars) => {
      toast.success(vars.kind === "cancel" ? "Order force-cancelled" : "Order refunded")
      setAction(null); setReason(""); refresh()
    },
    onError: (e: any) => toast.error(e?.message || "Action failed"),
  })

  const showCancel = isSuperAdmin && CANCELLABLE.includes(order.status)
  const showRefund = canRefund && REFUNDABLE.includes(order.status) && !TERMINAL.includes(order.status)

  return (
    <>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" title="View" onClick={() => { setSelectedOrder(order); setDetailOpen(true) }}>
          <Eye className="h-3.5 w-3.5" />
        </Button>
        {order.status === "DISPUTED" && (
          <Button size="sm" variant="ghost" title="Work dispute" asChild>
            <Link href="/dashboard/disputes"><Scale className="h-3.5 w-3.5 text-orange-600" /></Link>
          </Button>
        )}
        {["PUBLISHED", "VERIFIED"].includes(order.status) && (
          <Button size="sm" variant="ghost" title="Review delivery in Fulfillment" asChild>
            <Link href="/dashboard/fulfillment"><ClipboardList className="h-3.5 w-3.5" /></Link>
          </Button>
        )}
        {showCancel && (
          <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" title="Force cancel" onClick={() => { setAction("cancel"); setReason("") }}>
            <Ban className="h-3.5 w-3.5" />
          </Button>
        )}
        {showRefund && (
          <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" title="Refund" onClick={() => { setAction("refund"); setReason("") }}>
            <DollarSign className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <Dialog open={!!action} onOpenChange={(o) => { if (!o) { setAction(null); setReason("") } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{action === "cancel" ? "Force-cancel order" : "Refund order"}</DialogTitle>
            <DialogDescription>
              {action === "cancel"
                ? "Cancels the order and refunds any captured payment. Use only for stuck or erroneous orders."
                : "Refunds the customer. If a settlement was already released, the publisher is clawed back."}
            </DialogDescription>
          </DialogHeader>
          <Textarea placeholder="Reason (recorded in the audit trail)..." value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} />
          <DialogFooter>
            <Button variant="outline" onClick={() => { setAction(null); setReason("") }}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={intervene.isPending || reason.trim().length < 3}
              onClick={() => action && intervene.mutate({ kind: action, reason: reason.trim() })}
            >
              {intervene.isPending ? "Working..." : action === "cancel" ? "Force Cancel" : "Refund"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Order Details</DialogTitle>
            <DialogDescription>Read-only — the order lifecycle is automated; intervene via Fulfillment, Disputes, or the actions here.</DialogDescription>
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
    const filtered = orders.filter((o) => {
      const matchesSearch =
        search === "" ||
        o.customer?.name?.toLowerCase().includes(search.toLowerCase()) ||
        o.customer?.email?.toLowerCase().includes(search.toLowerCase()) ||
        o.id.toLowerCase().includes(search.toLowerCase())
      const matchesStatus = statusFilter === "all" || o.status === statusFilter
      return matchesSearch && matchesStatus
    })
    // Ops verify + settle from the top: unsettled/disputed first, newest first.
    return sortOrdersByPriority(filtered)
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