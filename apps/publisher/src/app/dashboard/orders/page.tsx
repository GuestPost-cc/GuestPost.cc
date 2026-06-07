"use client"

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import Link from "next/link"
import { api } from "../../../lib/api"
import { toast } from "sonner"
import {
  ShoppingCart,
  Clock,
  CheckCircle,
  FileText,
  Send,
  ExternalLink,
  ChevronRight,
  RefreshCw,
  AlertCircle,
} from "lucide-react"
import { Badge } from "@guestpost/ui"
import { Button } from "@guestpost/ui"
import { Skeleton } from "@guestpost/ui"
import { Card, CardContent } from "@guestpost/ui"
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@guestpost/ui"

type OrderStatus =
  | "DRAFT"
  | "PENDING_PAYMENT"
  | "PAID"
  | "ASSIGNED"
  | "CONTENT_CREATION"
  | "OUTREACH"
  | "PUBLISHED"
  | "VERIFIED"
  | "COMPLETED"
  | "CANCELLED"
  | "REFUNDED"
  | "UNDER_REVIEW"

const statusConfig: Record<
  OrderStatus,
  { label: string; icon: React.ElementType; variant: "default" | "secondary" | "destructive" | "success" | "warning" | "info" }
> = {
  PENDING_PAYMENT: { label: "Pending Payment", icon: Clock, variant: "warning" },
  PAID: { label: "Paid", icon: Clock, variant: "info" },
  ASSIGNED: { label: "Assigned", icon: AlertCircle, variant: "info" },
  CONTENT_CREATION: { label: "In Progress", icon: FileText, variant: "info" },
  OUTREACH: { label: "Outreach", icon: Send, variant: "info" },
  UNDER_REVIEW: { label: "Under Review", icon: Clock, variant: "warning" },
  PUBLISHED: { label: "Published", icon: CheckCircle, variant: "success" },
  VERIFIED: { label: "Verified", icon: CheckCircle, variant: "success" },
  COMPLETED: { label: "Completed", icon: CheckCircle, variant: "success" },
  DRAFT: { label: "Draft", icon: FileText, variant: "secondary" },
  CANCELLED: { label: "Cancelled", icon: AlertCircle, variant: "destructive" },
  REFUNDED: { label: "Refunded", icon: AlertCircle, variant: "destructive" },
}

const mockOrders = [
  {
    id: "ord_1",
    status: "CONTENT_CREATION" as OrderStatus,
    customerName: "Acme Corp",
    serviceType: "GUEST_POST",
    website: "techdaily.example.com",
    price: 150,
    dueDate: "2026-06-15",
    createdAt: "2026-06-01",
  },
  {
    id: "ord_2",
    status: "PUBLISHED" as OrderStatus,
    customerName: "TechStart Inc",
    serviceType: "EDITORIAL_LINK",
    website: "financeworld.example.com",
    price: 200,
    dueDate: "2026-06-10",
    createdAt: "2026-05-25",
  },
  {
    id: "ord_3",
    status: "ASSIGNED" as OrderStatus,
    customerName: "Growth Labs",
    serviceType: "NICHE_EDIT",
    website: "healthyliving.example.com",
    price: 120,
    dueDate: "2026-06-20",
    createdAt: "2026-06-03",
  },
  {
    id: "ord_4",
    status: "OUTREACH" as OrderStatus,
    customerName: "DigitalFirst",
    serviceType: "GUEST_POST",
    website: "techdaily.example.com",
    price: 175,
    dueDate: "2026-06-18",
    createdAt: "2026-06-02",
  },
]

const WORKFLOW_STEPS = [
  { status: "ASSIGNED", label: "Accept" },
  { status: "CONTENT_CREATION", label: "Create Content" },
  { status: "OUTREACH", label: "Submit" },
  { status: "PUBLISHED", label: "Publish" },
  { status: "COMPLETED", label: "Complete" },
]

function getWorkflowStep(status: OrderStatus): number {
  const stepIndex = WORKFLOW_STEPS.findIndex((s) => s.status === status)
  return stepIndex === -1 ? 0 : stepIndex
}

function OrderCard({
  order,
}: {
  order: (typeof mockOrders)[0]
}) {
  const config = statusConfig[order.status]
  const Icon = config.icon
  const currentStep = getWorkflowStep(order.status)

  return (
    <Card className="overflow-hidden">
      <div className="border-b bg-muted/30 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 text-muted-foreground" />
            <span className="font-mono text-xs text-muted-foreground">
              {order.id}
            </span>
          </div>
          <Badge variant={config.variant}>{config.label}</Badge>
        </div>
      </div>
      <CardContent className="p-4">
        <div className="mb-4">
          <h3 className="font-medium">
            {order.serviceType.replace(/_/g, " ")}
          </h3>
          <p className="text-sm text-muted-foreground">
            {order.customerName}
          </p>
        </div>

        <div className="mb-4 flex items-center justify-between text-sm">
          <div className="flex items-center gap-1 text-muted-foreground">
            <ExternalLink className="h-3 w-3" />
            {order.website}
          </div>
          <span className="font-medium">${order.price}</span>
        </div>

        <div className="mb-4">
          <p className="mb-2 text-xs text-muted-foreground">Workflow Progress</p>
          <div className="flex items-center gap-1">
            {WORKFLOW_STEPS.map((step, index) => (
              <div key={step.status} className="flex items-center">
                <div
                  className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${
                    index <= currentStep
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {index + 1}
                </div>
                {index < WORKFLOW_STEPS.length - 1 && (
                  <div
                    className={`h-0.5 w-4 ${
                      index < currentStep ? "bg-primary" : "bg-muted"
                    }`}
                  />
                )}
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-xs text-muted-foreground">
            {WORKFLOW_STEPS.map((step) => (
              <span key={step.status}>{step.label}</span>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            Due: {new Date(order.dueDate).toLocaleDateString()}
          </span>
          <Button size="sm" asChild>
            <Link href={`/dashboard/orders/${order.id}`}>
              View Details
              <ChevronRight className="ml-1 h-3 w-3" />
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

export default function OrdersPage() {
  const [viewMode, setViewMode] = useState<"grid" | "table">("grid")
  const [statusFilter, setStatusFilter] = useState<OrderStatus | "ALL">("ALL")

  const { data: orders = mockOrders, isLoading, refetch } = useQuery({
    queryKey: ["publisher-orders"],
    queryFn: () => api.orders.list(),
  })

  const filteredOrders = orders.filter(
    (order: any) => statusFilter === "ALL" || order.status === statusFilter
  )

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Orders</h1>
            <p className="text-sm text-muted-foreground">
              Manage your guest post orders
            </p>
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-64" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Orders</h1>
          <p className="text-sm text-muted-foreground">
            Manage your guest post orders and content fulfillment
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={viewMode === "grid" ? "secondary" : "outline"}
            size="sm"
            onClick={() => setViewMode("grid")}
          >
            Grid
          </Button>
          <Button
            variant={viewMode === "table" ? "secondary" : "outline"}
            size="sm"
            onClick={() => setViewMode("table")}
          >
            Table
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant={statusFilter === "ALL" ? "secondary" : "outline"}
          size="sm"
          onClick={() => setStatusFilter("ALL")}
        >
          All
        </Button>
        {Object.entries(statusConfig).map(([status, config]) => (
          <Button
            key={status}
            variant={statusFilter === status ? "secondary" : "outline"}
            size="sm"
            onClick={() => setStatusFilter(status as OrderStatus)}
          >
            {config.label}
          </Button>
        ))}
      </div>

      {filteredOrders.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border py-16 text-center">
          <ShoppingCart className="mb-3 h-10 w-10 text-muted-foreground/50" />
          <p className="font-medium">No orders found</p>
          <p className="text-sm text-muted-foreground">
            {statusFilter === "ALL"
              ? "Orders will appear here when assigned to you"
              : "No orders with this status"}
          </p>
        </div>
      ) : viewMode === "grid" ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredOrders.map((order: any) => (
            <OrderCard key={order.id} order={order} />
          ))}
        </div>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order ID</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Service</TableHead>
                <TableHead>Website</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Due Date</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredOrders.map((order: any) => {
                const config = statusConfig[order.status as OrderStatus] || statusConfig.DRAFT
                return (
                  <TableRow key={order.id}>
                    <TableCell className="font-mono text-xs">
                      {order.id.slice(0, 8)}
                    </TableCell>
                    <TableCell>{order.customerName ?? "—"}</TableCell>
                    <TableCell>
                      {order.items?.[0]?.serviceType?.replace(/_/g, " ") ??
                        order.serviceType?.replace(/_/g, " ") ??
                        "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {order.items?.[0]?.website?.url ?? order.website ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={config.variant}>{config.label}</Badge>
                    </TableCell>
                    <TableCell className="font-medium">
                      {order.totalAmount
                        ? `$${Number(order.totalAmount).toFixed(2)}`
                        : order.price
                        ? `$${order.price}`
                        : "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {order.dueDate
                        ? new Date(order.dueDate).toLocaleDateString()
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" asChild>
                        <Link href={`/dashboard/orders/${order.id}`}>
                          View
                          <ChevronRight className="ml-1 h-3 w-3" />
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}