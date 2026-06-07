"use client"

import { useState, useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { api } from "../../../lib/api"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@guestpost/ui"
import { Button } from "@guestpost/ui"
import { Badge } from "@guestpost/ui"
import { Skeleton } from "@guestpost/ui"
import { Input } from "@guestpost/ui"
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
  FileText,
  Download,
  Calendar,
  Search,
  ExternalLink,
  FileSpreadsheet,
} from "lucide-react"
import { format, subDays, startOfMonth, endOfMonth } from "date-fns"
import { toast } from "sonner"

interface ReportOrder {
  id: string
  status: string
  items: Array<{
    serviceType: string
    topic: string | null
    targetUrl?: string | null
    anchorText?: string | null
    website: { id: string; url: string } | null
    publications?: Array<{
      id: string
      publishedUrl?: string
      publishedAt?: string
    }>
  }>
  amount?: number | null
  totalAmount?: number | null
  createdAt: string
  updatedAt: string
  events: Array<{
    eventType: string
    createdAt: string
  }>
}

const dateRangeOptions = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "month", label: "This month" },
  { value: "quarter", label: "This quarter" },
  { value: "year", label: "This year" },
  { value: "all", label: "All time" },
]

function getDateRange(option: string) {
  const now = new Date()
  switch (option) {
    case "7":
      return { start: subDays(now, 7), end: now }
    case "30":
      return { start: subDays(now, 30), end: now }
    case "90":
      return { start: subDays(now, 90), end: now }
    case "month":
      return { start: startOfMonth(now), end: endOfMonth(now) }
    case "quarter":
      return { start: subDays(now, 90), end: now }
    case "year":
      return { start: new Date(now.getFullYear(), 0, 1), end: now }
    default:
      return null
  }
}

function ReportsTableSkeleton() {
  return (
    <div className="space-y-3">
      {[...Array(5)].map((_, i) => (
        <div key={i} className="flex items-center gap-4 rounded-lg border p-4">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-20" />
        </div>
      ))}
    </div>
  )
}

function getFirstPublishedUrl(order: ReportOrder): string | null {
  const pub = order.items?.[0]?.publications?.[0]
  return pub?.publishedUrl || null
}

function getFirstPublishedDate(order: ReportOrder): string | null {
  const pub = order.items?.[0]?.publications?.[0]
  return pub?.publishedAt || null
}

export default function ReportsPage() {
  const [dateRange, setDateRange] = useState("30")
  const [searchQuery, setSearchQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState("")

  const { data: ordersData, isLoading } = useQuery<ReportOrder[]>({
    queryKey: ["orders"],
    queryFn: () => api.orders.list() as Promise<ReportOrder[]>,
  })

  const filteredOrders = useMemo(() => {
    if (!ordersData) return []

    const range = getDateRange(dateRange)
    let orders = ordersData

    if (range) {
      orders = orders.filter((order: ReportOrder) => {
        const created = new Date(order.createdAt)
        return created >= range.start && created <= range.end
      })
    }

    if (statusFilter && statusFilter !== "all") {
      orders = orders.filter((order: ReportOrder) => order.status === statusFilter)
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      orders = orders.filter((order: ReportOrder) =>
        order.id.toLowerCase().includes(query) ||
        order.items?.[0]?.topic?.toLowerCase().includes(query) ||
        order.items?.[0]?.website?.url?.toLowerCase().includes(query)
      )
    }

    return orders
  }, [ordersData, dateRange, statusFilter, searchQuery])

  const publishedOrders = filteredOrders.filter((o: ReportOrder) => 
    ["PUBLISHED", "COMPLETED", "VERIFIED"].includes(o.status)
  )

  const stats = useMemo(() => {
    const orders = filteredOrders
    return {
      totalOrders: orders.length,
      published: orders.filter((o: ReportOrder) => ["PUBLISHED", "COMPLETED", "VERIFIED"].includes(o.status)).length,
      totalSpend: orders.reduce((sum: number, o: ReportOrder) => sum + (Number(o.amount || o.totalAmount || 0)), 0),
      avgOrderValue: orders.length > 0 
        ? orders.reduce((sum: number, o: ReportOrder) => sum + (Number(o.amount || o.totalAmount || 0)), 0) / orders.length 
        : 0,
    }
  }, [filteredOrders])

  const exportToCSV = () => {
    const headers = ["Order ID", "Published URL", "Target URL", "Anchor Text", "Service", "Status", "Publish Date", "Price"]
    const rows = publishedOrders.map((order: ReportOrder) => {
      const item = order.items?.[0]
      const publishedUrl = getFirstPublishedUrl(order)
      const publishedDate = getFirstPublishedDate(order)
      return [
        order.id,
        publishedUrl || "",
        item?.targetUrl || item?.topic || "",
        item?.anchorText || "",
        item?.serviceType?.replace(/_/g, " ") || "",
        order.status,
        publishedDate ? format(new Date(publishedDate), "yyyy-MM-dd") : "",
        (Number(order.amount || order.totalAmount || 0)).toFixed(2),
      ]
    })

    const csv = [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(",")).join("\n")
    const blob = new Blob([csv], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `guestpost-report-${format(new Date(), "yyyy-MM-dd")}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast.success("Report exported to CSV")
  }

  const exportReport = async (orderId: string) => {
    try {
      await api.reporting.generateOrderReport(orderId)
      toast.success("Report generation started. Check your reports tab.")
    } catch {
      toast.error("Failed to start report generation")
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Reports</h1>
            <p className="text-muted-foreground">View and export your order reports</p>
          </div>
        </div>
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-32" />
          </CardHeader>
          <CardContent>
            <ReportsTableSkeleton />
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Reports</h1>
          <p className="text-muted-foreground">View and export your order reports</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={exportToCSV}>
            <Download className="mr-2 h-4 w-4" />
            CSV
          </Button>
          <Button variant="outline" disabled>
            <FileText className="mr-2 h-4 w-4" />
            PDF
          </Button>
          <Button variant="outline" disabled>
            <FileSpreadsheet className="mr-2 h-4 w-4" />
            XLSX
          </Button>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Orders</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalOrders}</div>
            <p className="text-xs text-muted-foreground">in selected period</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Published</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.published}</div>
            <p className="text-xs text-muted-foreground">completed links</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Spend</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">${stats.totalSpend.toFixed(2)}</div>
            <p className="text-xs text-muted-foreground">in selected period</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Avg Order Value</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">${stats.avgOrderValue.toFixed(2)}</div>
            <p className="text-xs text-muted-foreground">per order</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>Order Report</CardTitle>
              <CardDescription>
                {publishedOrders.length} published orders in selected period
              </CardDescription>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search orders..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9 w-64"
                />
              </div>
              <Select value={dateRange} onValueChange={setDateRange}>
                <SelectTrigger className="w-40">
                  <Calendar className="mr-2 h-4 w-4" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {dateRangeOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="PUBLISHED">Published</SelectItem>
                  <SelectItem value="COMPLETED">Completed</SelectItem>
                  <SelectItem value="VERIFIED">Verified</SelectItem>
                  <SelectItem value="UNDER_REVIEW">Under Review</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {publishedOrders.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <FileText className="h-12 w-12 text-muted-foreground/50" />
              <h3 className="mt-4 text-lg font-medium">No published orders</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {searchQuery || statusFilter || dateRange !== "30"
                  ? "Try adjusting your filters"
                  : "Completed orders will appear here"}
              </p>
            </div>
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Published URL</TableHead>
                    <TableHead>Target URL</TableHead>
                    <TableHead>Anchor Text</TableHead>
                    <TableHead>Publisher</TableHead>
                    <TableHead>Publish Date</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead className="text-right" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {publishedOrders.map((order: ReportOrder) => {
                    const item = order.items?.[0]
                    const publishedUrl = getFirstPublishedUrl(order)
                    const publishedDate = getFirstPublishedDate(order)
                    return (
                      <TableRow key={order.id}>
                        <TableCell>
                          {publishedUrl ? (
                            <a
                              href={publishedUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-1 text-primary hover:underline"
                            >
                              {new URL(publishedUrl).hostname}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {item?.targetUrl || item?.topic ? (
                            <span className="text-sm truncate max-w-[200px] block">
                              {item.targetUrl || item.topic}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <span className="text-sm">{item?.anchorText || "—"}</span>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm">{item?.website?.url ? new URL(item.website.url).hostname : "—"}</span>
                        </TableCell>
                        <TableCell>
                          {publishedDate ? format(new Date(publishedDate), "PP") : format(new Date(order.createdAt), "PP")}
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary" className="capitalize">
                            {order.status.replace(/_/g, " ").toLowerCase()}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          ${(Number(order.amount || order.totalAmount || 0)).toFixed(2)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" onClick={() => exportReport(order.id)}>
                            <Download className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}