"use client"

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { api } from "../../../lib/api"
import { useRequireRole, ForbiddenPage } from "../../../lib/use-require-role"
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
import {
  Search,
  RefreshCw,
  AlertCircle,
  ScrollText,
} from "lucide-react"
import { format } from "date-fns"
import { toast } from "sonner"

const ACTION_COLORS: Record<string, string> = {
  CREATE: "text-green-500",
  UPDATE: "text-blue-500",
  DELETE: "text-red-500",
  LOGIN: "text-purple-500",
  LOGOUT: "text-gray-500",
  APPROVE: "text-green-500",
  REJECT: "text-red-500",
  SUSPEND: "text-orange-500",
  BAN: "text-red-500",
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
  const [page, setPage] = useState(1)

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin", "audit-logs", search, actionFilter, page],
    queryFn: () => api.admin.listAuditLogs({ action: actionFilter || undefined, page, limit: 50 }),
  })

  const logs = data?.items ?? []
  const pagination = data ? { page: data.page, totalPages: data.totalPages, total: data.total } : { page: 1, totalPages: 1, total: 0 }

  const filteredLogs = logs.filter((l: any) => {
    if (!search) return true
    const q = search.toLowerCase()
    return l.action.toLowerCase().includes(q) ||
      l.entity?.toLowerCase().includes(q) ||
      l.actorName?.toLowerCase().includes(q) ||
      l.entityId?.toLowerCase().includes(q) ||
      JSON.stringify(l.metadata ?? {}).toLowerCase().includes(q)
  })

  const exportCsv = () => {
    const header = ["createdAt", "action", "entity", "entityId", "actor", "ipAddress", "metadata"]
    const rows = filteredLogs.map((l: any) => [
      l.createdAt,
      l.action,
      l.entity ?? "",
      l.entityId ?? "",
      l.actorName ?? l.actorId ?? "system",
      l.ipAddress ?? "",
      JSON.stringify(l.metadata ?? {}),
    ])
    // Neutralize spreadsheet formula injection: metadata can carry
    // user-supplied text (=, +, -, @ prefixes execute in Excel/Sheets).
    const sanitize = (c: unknown) => {
      let s = String(c).replace(/"/g, '""')
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
      return `"${s}"`
    }
    const csv = [header, ...rows]
      .map((r) => r.map(sanitize).join(","))
      .join("\n")
    const blob = new Blob([csv], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `audit-logs-page${pagination.page}-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
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

  const uniqueActions = [...new Set(logs.map((l: any) => l.action))]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Audit Logs</h1>
          <p className="text-muted-foreground">Track all platform changes and user activity</p>
        </div>
        <Button variant="outline" onClick={exportCsv} disabled={filteredLogs.length === 0}>
          Export CSV
        </Button>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search logs..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
        <Select value={actionFilter} onValueChange={(v) => { setActionFilter(v); setPage(1) }}>
          <SelectTrigger className="w-40"><SelectValue placeholder="All actions" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actions</SelectItem>
            {uniqueActions.map((a) => (
              <SelectItem key={a as string} value={a as string}>{a as string}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[...Array(10)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : filteredLogs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <ScrollText className="h-12 w-12 text-muted-foreground/50" />
              <h3 className="mt-4 text-lg font-medium">No audit logs found</h3>
              <p className="text-sm text-muted-foreground">No matching activity recorded</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Timestamp</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Entity</TableHead>
                    <TableHead>Entity ID</TableHead>
                    <TableHead>IP Address</TableHead>
                    <TableHead>Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredLogs.map((log: any) => (
                    <TableRow key={log.id}>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap font-mono text-xs">
                        {format(new Date(log.createdAt), "MMM d, yyyy HH:mm:ss")}
                      </TableCell>
                      <TableCell className="font-medium">{log.actorName || log.actorId.slice(0, 8)}</TableCell>
                      <TableCell>
                        <span className={`font-medium text-xs ${ACTION_COLORS[log.action] || ""}`}>
                          {log.action}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="text-xs">{log.entity}</Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {log.entityId.slice(0, 12)}...
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {log.ipAddress || "—"}
                      </TableCell>
                      <TableCell className="max-w-[200px]">
                        {log.metadata ? (
                          <span className="text-xs text-muted-foreground truncate block">
                            {JSON.stringify(log.metadata).slice(0, 80)}
                            {JSON.stringify(log.metadata).length > 80 ? "..." : ""}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
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
