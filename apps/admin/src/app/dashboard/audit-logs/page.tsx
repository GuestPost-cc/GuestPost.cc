"use client"

import { useState, Fragment } from "react"
import { useQuery } from "@tanstack/react-query"
import { api } from "../../../lib/api"
import { useRequireRole, ForbiddenPage } from "../../../lib/use-require-role"
import { Card, CardContent, CardHeader, CardTitle } from "@guestpost/ui"
import { Button } from "@guestpost/ui"
import { Input } from "@guestpost/ui"
import { Badge } from "@guestpost/ui"
import { Skeleton } from "@guestpost/ui"
import { downloadCsv } from "@guestpost/ui"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@guestpost/ui"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@guestpost/ui"
import {
  Search, RefreshCw, AlertCircle, ScrollText, Download, ChevronDown, ChevronRight,
  DollarSign, Shield, ShieldCheck, Package, ShoppingCart, Store, AlertTriangle,
  UserCog, Settings, Copy,
} from "lucide-react"
import { format, formatDistanceToNow } from "date-fns"
import { toast } from "sonner"

// Forensic categorization — financial-integrity + security review need actions
// grouped by domain + severity, not raw CRUD verbs.
type Cat = { label: string; cls: string; Icon: any }
function actionCategory(action: string): Cat {
  const a = (action || "").toUpperCase()
  if (/SETTLEMENT|PAYOUT|REFUND|CHARGEBACK|WITHDRAWAL|BALANCE|DEPOSIT|TRANSACTION|\bFEE\b|CLAWBACK|RELEASE/.test(a))
    return { label: "Financial", cls: "bg-emerald-100 text-emerald-700", Icon: DollarSign }
  if (/LOGIN|LOGOUT|MFA|SESSION|PERMISSION|ROLE|BANNED?|SUSPEND|DECRYPT|OVERRIDE|FORCE|RATE_LIMIT|BLOCKED|UNAUTHORIZED/.test(a))
    return { label: "Security", cls: "bg-red-100 text-red-700", Icon: Shield }
  if (/WEBSITE_VERIF|DNS|DOMAIN|TOKEN_ROTAT|REVOK|TRUST|DUPLICATE_DOMAIN/.test(a))
    return { label: "Verification", cls: "bg-violet-100 text-violet-700", Icon: ShieldCheck }
  if (/DELIVERY|FRAUD|SNAPSHOT|FULFILLMENT/.test(a))
    return { label: "Delivery", cls: "bg-amber-100 text-amber-700", Icon: Package }
  if (/DISPUTE/.test(a))
    return { label: "Dispute", cls: "bg-orange-100 text-orange-700", Icon: AlertTriangle }
  if (/LISTING|MARKETPLACE/.test(a))
    return { label: "Marketplace", cls: "bg-blue-100 text-blue-700", Icon: Store }
  if (/ORDER/.test(a))
    return { label: "Order", cls: "bg-sky-100 text-sky-700", Icon: ShoppingCart }
  if (/PUBLISHER|CUSTOMER|MEMBERSHIP|ORGANIZATION|USER|IDENTITY|STAFF/.test(a))
    return { label: "Identity", cls: "bg-indigo-100 text-indigo-700", Icon: UserCog }
  return { label: "System", cls: "bg-gray-100 text-gray-600", Icon: Settings }
}

const CATEGORIES = ["Financial", "Security", "Verification", "Delivery", "Dispute", "Marketplace", "Order", "Identity", "System"]

function humanizeAction(action: string) {
  return (action || "").replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
}

// First meaningful metadata key -> a short human summary for the row.
function summarize(metadata: any): string {
  if (!metadata || typeof metadata !== "object") return ""
  const skip = new Set(["organizationId", "publisherId", "deliveryVersionId"])
  for (const [k, v] of Object.entries(metadata)) {
    if (skip.has(k) || v == null || typeof v === "object") continue
    return `${k}: ${String(v).slice(0, 48)}`
  }
  const reasons = (metadata as any).reasons
  if (Array.isArray(reasons) && reasons.length) return `reasons: ${reasons.join("; ").slice(0, 48)}`
  return ""
}

export default function AuditLogsPage() {
  const { allowed, loading } = useRequireRole("SUPER_ADMIN")
  if (loading) return null
  if (!allowed) return <ForbiddenPage requires="Super Admin" />
  return <AuditLogsPageInner />
}

function AuditLogsPageInner() {
  const [search, setSearch] = useState("")
  const [actionFilter, setActionFilter] = useState("")
  const [categoryFilter, setCategoryFilter] = useState("all")
  const [startDate, setStartDate] = useState("")
  const [endDate, setEndDate] = useState("")
  const [page, setPage] = useState(1)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["admin", "audit-logs", actionFilter, startDate, endDate, page],
    queryFn: () =>
      api.admin.listAuditLogs({
        action: actionFilter || undefined,
        startDate: startDate || undefined,
        endDate: endDate ? `${endDate}T23:59:59` : undefined,
        page,
        limit: 50,
      }),
  })

  const logs = data?.items ?? []
  const pagination = data
    ? { page: data.page, totalPages: data.totalPages, total: data.total }
    : { page: 1, totalPages: 1, total: 0 }

  // Text + category filtering over the loaded page (server handles action/date).
  const filteredLogs = logs.filter((l: any) => {
    if (categoryFilter !== "all" && actionCategory(l.action).label !== categoryFilter) return false
    if (!search) return true
    const q = search.toLowerCase()
    return (
      (l.action ?? "").toLowerCase().includes(q) ||
      (l.entity ?? "").toLowerCase().includes(q) ||
      (l.actorName ?? "").toLowerCase().includes(q) ||
      (l.actorId ?? "").toLowerCase().includes(q) ||
      (l.entityId ?? "").toLowerCase().includes(q) ||
      (l.ipAddress ?? "").toLowerCase().includes(q) ||
      JSON.stringify(l.metadata ?? {}).toLowerCase().includes(q)
    )
  })

  const toggle = (id: string) => {
    const next = new Set(expanded)
    next.has(id) ? next.delete(id) : next.add(id)
    setExpanded(next)
  }

  const copy = (v: string) => {
    navigator.clipboard.writeText(v)
    toast.success("Copied")
  }

  const exportCsv = () => {
    downloadCsv(
      `audit-logs-page${pagination.page}-${new Date().toISOString().slice(0, 10)}.csv`,
      ["Timestamp", "Category", "Action", "Actor", "ActorId", "Entity", "EntityId", "IP", "Metadata"],
      filteredLogs.map((l: any) => [
        l.createdAt,
        actionCategory(l.action).label,
        l.action,
        l.actorName ?? "system",
        l.actorId ?? "",
        l.entity ?? "",
        l.entityId ?? "",
        l.ipAddress ?? "",
        JSON.stringify(l.metadata ?? {}),
      ]),
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <AlertCircle className="h-12 w-12 text-destructive mb-4" />
        <h2 className="text-xl font-semibold mb-2">Failed to load audit logs</h2>
        <p className="text-muted-foreground mb-4">{(error as Error).message}</p>
        <Button onClick={() => refetch()}><RefreshCw className="mr-2 h-4 w-4" />Retry</Button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <ScrollText className="h-7 w-7" /> Audit Logs
          </h1>
          <p className="text-muted-foreground">Immutable record of every platform change — financial, security, and operational.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="icon" onClick={() => refetch()} title="Refresh">
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
          <Button variant="outline" onClick={exportCsv} disabled={filteredLogs.length === 0}>
            <Download className="mr-2 h-4 w-4" /> Export CSV
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="flex flex-col gap-3 p-4 lg:flex-row lg:items-end lg:flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Search (this page)</label>
            <Search className="absolute left-3 top-[34px] h-4 w-4 text-muted-foreground" />
            <Input placeholder="action, actor, id, IP, metadata..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
          </div>
          <div className="w-full lg:w-44">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Action contains</label>
            <Input placeholder="e.g. SETTLEMENT" value={actionFilter} onChange={(e) => { setActionFilter(e.target.value); setPage(1) }} />
          </div>
          <div className="w-full lg:w-44">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Category</label>
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="w-full lg:w-40">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">From</label>
            <Input type="date" value={startDate} onChange={(e) => { setStartDate(e.target.value); setPage(1) }} />
          </div>
          <div className="w-full lg:w-40">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">To</label>
            <Input type="date" value={endDate} onChange={(e) => { setEndDate(e.target.value); setPage(1) }} />
          </div>
          {(actionFilter || startDate || endDate || categoryFilter !== "all" || search) && (
            <Button variant="ghost" onClick={() => { setSearch(""); setActionFilter(""); setCategoryFilter("all"); setStartDate(""); setEndDate(""); setPage(1) }}>
              Clear
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-medium text-muted-foreground">
            {pagination.total.toLocaleString()} event{pagination.total !== 1 ? "s" : ""}
            {filteredLogs.length !== logs.length ? ` · ${filteredLogs.length} shown` : ""}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-3 p-4">
              {[...Array(10)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : filteredLogs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <ScrollText className="h-12 w-12 text-muted-foreground/40" />
              <h3 className="mt-4 text-lg font-medium">No audit logs found</h3>
              <p className="text-sm text-muted-foreground">No activity matches these filters.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8"></TableHead>
                    <TableHead>When</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Summary</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredLogs.map((log: any) => {
                    const cat = actionCategory(log.action)
                    const isOpen = expanded.has(log.id)
                    const Icon = cat.Icon
                    return (
                      <Fragment key={log.id}>
                        <TableRow className="cursor-pointer" onClick={() => toggle(log.id)}>
                          <TableCell>{isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</TableCell>
                          <TableCell className="whitespace-nowrap" title={format(new Date(log.createdAt), "PPpp")}>
                            <span className="text-sm">{formatDistanceToNow(new Date(log.createdAt), { addSuffix: true })}</span>
                          </TableCell>
                          <TableCell>
                            <span className="font-medium">{log.actorName ?? "System"}</span>
                            {!log.actorName && <span className="ml-1 text-xs text-muted-foreground">(automated)</span>}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Badge className={`gap-1 ${cat.cls}`}><Icon className="h-3 w-3" />{cat.label}</Badge>
                              <span className="text-sm font-medium">{humanizeAction(log.action)}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            {log.entity ? (
                              <span className="text-xs">
                                <span className="text-muted-foreground">{log.entity}</span>
                                {log.entityId ? <span className="ml-1 font-mono">#{String(log.entityId).slice(0, 8)}</span> : null}
                              </span>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="max-w-[260px]">
                            <span className="block truncate text-xs text-muted-foreground">{summarize(log.metadata) || "—"}</span>
                          </TableCell>
                        </TableRow>
                        {isOpen && (
                          <TableRow className="bg-muted/30">
                            <TableCell></TableCell>
                            <TableCell colSpan={5} className="py-3">
                              <div className="grid gap-3 text-xs sm:grid-cols-2">
                                <Field label="Raw action" value={log.action} mono onCopy={copy} />
                                <Field label="Timestamp" value={format(new Date(log.createdAt), "PPpp")} />
                                <Field label="Actor" value={log.actorName ?? "System (automated)"} />
                                <Field label="Actor ID" value={log.actorId ?? "—"} mono onCopy={log.actorId ? copy : undefined} />
                                <Field label="Entity" value={log.entity ?? "—"} />
                                <Field label="Entity ID" value={log.entityId ?? "—"} mono onCopy={log.entityId ? copy : undefined} />
                                <Field label="IP address" value={log.ipAddress ?? "—"} mono />
                                <Field label="Event ID" value={log.id} mono onCopy={copy} />
                              </div>
                              {log.metadata && (
                                <div className="mt-3">
                                  <p className="mb-1 text-xs font-medium text-muted-foreground">Metadata</p>
                                  <pre className="max-h-64 overflow-auto rounded-md border bg-background p-3 text-xs">
                                    {JSON.stringify(log.metadata, null, 2)}
                                  </pre>
                                </div>
                              )}
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button variant="outline" size="sm" disabled={pagination.page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span className="text-sm text-muted-foreground">Page {pagination.page} of {pagination.totalPages} ({pagination.total.toLocaleString()} total)</span>
          <Button variant="outline" size="sm" disabled={pagination.page >= pagination.totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      )}
    </div>
  )
}

function Field({ label, value, mono, onCopy }: { label: string; value: string; mono?: boolean; onCopy?: (v: string) => void }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="flex items-center gap-1.5">
        <span className={mono ? "font-mono break-all" : ""}>{value}</span>
        {onCopy && value && value !== "—" && (
          <button onClick={(e) => { e.stopPropagation(); onCopy(value) }} className="text-muted-foreground hover:text-foreground" title="Copy">
            <Copy className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  )
}
