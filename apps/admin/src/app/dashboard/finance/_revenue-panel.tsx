"use client"

// Phase 7.1 — Admin Finance > Revenue panel.
//
// Reads from GET /admin/finance/revenue via the typed api.admin.getRevenue
// method (Phase 7.0 wiring inherits X-Request-ID + ApiError-with-requestId
// automatically; never use raw fetch here).
//
// Cache key uses the consistent ["admin", "revenue", filters] shape — the
// other tabs in this file still use bare keys like ["settlements"]
// (audit §7.3 drift); this tab sets the corrected pattern for a future sweep.

import {
  Button,
  Card,
  CardContent,
  Input,
  KpiCard,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@guestpost/ui"
import { useQuery } from "@tanstack/react-query"
import { AlertCircle, AlertTriangle, Download, RefreshCw } from "lucide-react"
import { useState } from "react"
import { api } from "../../../lib/api"

type GroupBy = "channel" | "month" | "serviceType" | "listing"

const GROUP_BY_LABELS: Record<GroupBy, string> = {
  channel: "Channel",
  month: "Month",
  serviceType: "Service type",
  listing: "Listing (top earners)",
}

function fmtUsd(value: string | number): string {
  const n = typeof value === "string" ? Number(value) : value
  if (!Number.isFinite(n)) return "$0.00"
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtCount(n: number): string {
  return n.toLocaleString("en-US")
}

function trendOf(
  deltaPct: number | undefined,
): { value: number; isPositive: boolean } | undefined {
  if (deltaPct === undefined || deltaPct === null) return undefined
  if (!Number.isFinite(deltaPct)) return undefined
  return { value: Math.round(deltaPct * 10) / 10, isPositive: deltaPct >= 0 }
}

export function RevenuePanel() {
  const [from, setFrom] = useState<string>("")
  const [to, setTo] = useState<string>("")
  const [groupBy, setGroupBy] = useState<GroupBy>("channel")

  const filters = { from: from || undefined, to: to || undefined, groupBy }
  const q = useQuery({
    queryKey: ["admin", "revenue", filters],
    queryFn: () => api.admin.getRevenue(filters),
  })

  const data = q.data
  const current = data?.totals.current
  const delta = data?.totals.deltaPct

  const onExportCsv = () => {
    // Server-side CSV streaming via direct URL — browser streams it without
    // ever materializing the full body in JS. Better than client-side Blob
    // assembly when Finance exports months/years.
    const url = new URL("/api/v1/admin/finance/revenue", window.location.origin)
    url.searchParams.set("groupBy", groupBy)
    url.searchParams.set("format", "csv")
    if (from) url.searchParams.set("from", from)
    if (to) url.searchParams.set("to", to)
    // Same origin in dev; production proxies through Next.js — works either way.
    window.location.href = url.toString()
  }

  return (
    <div className="space-y-6">
      {/* Filter row */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto] items-end">
            <div className="space-y-1">
              <Label htmlFor="rev-from">From</Label>
              <Input
                id="rev-from"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rev-to">To</Label>
              <Input
                id="rev-to"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rev-groupby">Group by</Label>
              <Select
                value={groupBy}
                onValueChange={(v) => setGroupBy(v as GroupBy)}
              >
                <SelectTrigger id="rev-groupby">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(GROUP_BY_LABELS) as GroupBy[]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {GROUP_BY_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => q.refetch()}
              disabled={q.isFetching}
            >
              <RefreshCw
                className={`mr-2 h-3 w-3 ${q.isFetching ? "animate-spin" : ""}`}
              />
              Refresh
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Timezone: UTC · Reversed (refunded) rows are excluded from totals
            but counted separately.
          </p>
        </CardContent>
      </Card>

      {/* Currency-mismatch warning banner */}
      {data?.meta.currencyMismatch && (
        <div className="flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
          <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5" />
          <div>
            <p className="font-medium text-amber-900">
              Non-USD orders detected in this range
            </p>
            <p className="text-amber-800">
              {fmtCount(data.meta.currencyMismatch.rowCount)} order(s) in{" "}
              {data.meta.currencyMismatch.distinctCurrencies.join(", ")}.
              Revenue totals below are shown in USD only — verify before
              reporting externally.
            </p>
          </div>
        </div>
      )}

      {/* KPI strip */}
      <div className="grid gap-4 md:grid-cols-4">
        <KpiCard
          label="Gross revenue"
          value={current ? fmtUsd(current.grossAmount) : "—"}
          trend={trendOf(delta?.grossAmount)}
        />
        <KpiCard
          label="Platform fee"
          value={current ? fmtUsd(current.platformFee) : "—"}
          trend={trendOf(delta?.platformFee)}
        />
        <KpiCard
          label="Net revenue"
          value={current ? fmtUsd(current.netRevenue) : "—"}
          trend={trendOf(delta?.netRevenue)}
        />
        <KpiCard
          label="Reversed (refunded)"
          value={current ? fmtCount(current.reversedCount) : "—"}
        />
      </div>

      {/* Grouped table */}
      <Card>
        <div className="flex items-center justify-between border-b px-4 py-2">
          <h3 className="text-sm font-medium">
            By {GROUP_BY_LABELS[groupBy].toLowerCase()}
          </h3>
          <Button
            variant="outline"
            size="sm"
            onClick={onExportCsv}
            disabled={q.isLoading || !data || data.buckets.length === 0}
          >
            <Download className="mr-2 h-3 w-3" /> Export CSV
          </Button>
        </div>
        {q.isLoading && (
          <div className="p-6 space-y-3">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        )}
        {q.isError && (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <AlertCircle className="h-10 w-10 text-destructive" />
            <p className="text-muted-foreground">
              {(q.error as Error | undefined)?.message ??
                "Failed to load revenue"}
            </p>
            <Button variant="outline" size="sm" onClick={() => q.refetch()}>
              <RefreshCw className="mr-2 h-3 w-3" /> Retry
            </Button>
          </div>
        )}
        {!q.isLoading && !q.isError && data && data.buckets.length === 0 && (
          <div className="py-16 text-center text-muted-foreground">
            No revenue in this range.
          </div>
        )}
        {!q.isLoading && !q.isError && data && data.buckets.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{GROUP_BY_LABELS[groupBy]}</TableHead>
                <TableHead className="text-right">Gross</TableHead>
                <TableHead className="text-right">Platform fee</TableHead>
                <TableHead className="text-right">Net</TableHead>
                <TableHead className="text-right">Rows</TableHead>
                <TableHead className="text-right">Reversed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.buckets.map((b) => (
                <TableRow key={b.bucketKey}>
                  <TableCell>
                    {b.listingId ? (
                      // Phase 7.1 — listing drill-down reads `listingId` directly
                      // from the structured field, never parses `bucket`.
                      <a
                        href={`/dashboard/marketplace/listings/${b.listingId}`}
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        {b.bucket}
                      </a>
                    ) : (
                      <span>{b.bucket}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmtUsd(b.grossAmount)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmtUsd(b.platformFee)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">
                    {fmtUsd(b.netRevenue)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmtCount(b.rowCount)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {fmtCount(b.reversedCount)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  )
}
