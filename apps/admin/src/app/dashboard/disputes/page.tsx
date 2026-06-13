"use client"

import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"
import { Card, CardContent, CardHeader, CardTitle, ErrorState, Button, Badge, Skeleton, Textarea } from "@guestpost/ui"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@guestpost/ui"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@guestpost/ui"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@guestpost/ui"
import { AlertTriangle, Scale, FileSearch, RotateCcw, DollarSign, XCircle, Clock } from "lucide-react"
import { format, formatDistanceToNow } from "date-fns"
import { toast } from "sonner"

const statusBadge: Record<string, { label: string; cls: string }> = {
  OPEN: { label: "Open", cls: "bg-red-100 text-red-700" },
  UNDER_REVIEW: { label: "Under Review", cls: "bg-amber-100 text-amber-700" },
  RESOLVED_REFUNDED: { label: "Refunded", cls: "bg-blue-100 text-blue-700" },
  RESOLVED_REJECTED: { label: "Rejected", cls: "bg-gray-100 text-gray-600" },
  RESOLVED_RESTORED: { label: "Restored", cls: "bg-emerald-100 text-emerald-700" },
}

type ResolveAction = "RESTORE" | "REFUND" | "REJECT"

export default function DisputesPage() {
  const qc = useQueryClient()
  const { user } = useAuth()
  const canResolve = user?.staffRole === "SUPER_ADMIN" || user?.staffRole === "OPERATIONS"
  const [status, setStatus] = useState("all")
  const [resolveTarget, setResolveTarget] = useState<{ id: string; action: ResolveAction } | null>(null)
  const [reason, setReason] = useState("")

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin", "disputes", status],
    queryFn: () => api.admin.listDisputes({ status: status === "all" ? undefined : status }),
  })

  const refresh = () => qc.invalidateQueries({ queryKey: ["admin", "disputes"] })

  const review = useMutation({
    mutationFn: (id: string) => api.admin.reviewDispute(id),
    onSuccess: () => { toast.success("Marked under review"); refresh() },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  })

  const resolve = useMutation({
    mutationFn: ({ id, action, resolution }: { id: string; action: ResolveAction; resolution: string }) =>
      api.admin.resolveDispute(id, action, resolution),
    onSuccess: () => {
      toast.success("Dispute resolved")
      setResolveTarget(null)
      setReason("")
      refresh()
      qc.invalidateQueries({ queryKey: ["admin", "orders"] })
    },
    onError: (e: any) => toast.error(e?.message || "Failed to resolve"),
  })

  if (error) return <ErrorState title="Failed to load disputes" description={(error as Error).message} onRetry={() => refetch()} />

  const items = data?.items ?? []
  const counts = data?.counts ?? { open: 0, underReview: 0, active: 0 }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2"><Scale className="h-7 w-7" /> Disputes</h1>
        <p className="text-muted-foreground">Customer disputes pause settlement until resolved. Review evidence, then restore, refund, or reject.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm font-medium flex items-center gap-1.5"><AlertTriangle className="h-4 w-4 text-red-500" /> Open</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold">{counts.open}</div></CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm font-medium flex items-center gap-1.5"><Clock className="h-4 w-4 text-amber-500" /> Under Review</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold">{counts.underReview}</div></CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Active total</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold">{counts.active}</div></CardContent></Card>
      </div>

      <div className="flex items-center gap-3">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[200px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All disputes</SelectItem>
            <SelectItem value="OPEN">Open</SelectItem>
            <SelectItem value="UNDER_REVIEW">Under Review</SelectItem>
            <SelectItem value="RESOLVED_REFUNDED">Refunded</SelectItem>
            <SelectItem value="RESOLVED_REJECTED">Rejected</SelectItem>
            <SelectItem value="RESOLVED_RESTORED">Restored</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-3 p-4">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Scale className="h-12 w-12 text-muted-foreground/40" />
              <h3 className="mt-4 text-lg font-medium">No disputes</h3>
              <p className="text-sm text-muted-foreground">Nothing matches this filter.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Raised</TableHead>
                  <TableHead>Order</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((d: any) => {
                  const sb = statusBadge[d.status] ?? { label: d.status, cls: "bg-gray-100" }
                  const active = d.status === "OPEN" || d.status === "UNDER_REVIEW"
                  return (
                    <TableRow key={d.id}>
                      <TableCell className="whitespace-nowrap text-sm" title={format(new Date(d.createdAt), "PPpp")}>
                        {formatDistanceToNow(new Date(d.createdAt), { addSuffix: true })}
                      </TableCell>
                      <TableCell>
                        <a href={`/dashboard/orders?focus=${d.orderId}`} className="font-mono text-xs text-primary hover:underline">#{d.orderId.slice(0, 8)}</a>
                        <div className="text-xs text-muted-foreground">{d.order?.title ?? "—"}</div>
                        {d.order?.website?.domain && <div className="text-xs text-muted-foreground">{d.order.website.domain}</div>}
                      </TableCell>
                      <TableCell className="text-sm">
                        {d.order?.customer?.name ?? "—"}
                        <div className="text-xs text-muted-foreground">{d.order?.customer?.email}</div>
                      </TableCell>
                      <TableCell className="font-mono text-sm">{d.order?.amount != null ? `$${d.order.amount.toLocaleString()}` : "—"}</TableCell>
                      <TableCell><Badge className={sb.cls}>{sb.label}</Badge></TableCell>
                      <TableCell className="max-w-[240px]"><span className="block truncate text-sm" title={d.reason}>{d.reason}</span></TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1.5">
                          <Button size="sm" variant="outline" asChild>
                            <a href={`/dashboard/disputes/${d.id}/evidence`}><FileSearch className="mr-1 h-3.5 w-3.5" />Evidence</a>
                          </Button>
                          {canResolve && active && (
                            <>
                              {d.status === "OPEN" && (
                                <Button size="sm" variant="ghost" onClick={() => review.mutate(d.id)} title="Mark under review">
                                  <Clock className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              <Button size="sm" variant="ghost" className="text-emerald-600" title="Restore order" onClick={() => setResolveTarget({ id: d.id, action: "RESTORE" })}><RotateCcw className="h-3.5 w-3.5" /></Button>
                              <Button size="sm" variant="ghost" className="text-blue-600" title="Refund customer" onClick={() => setResolveTarget({ id: d.id, action: "REFUND" })}><DollarSign className="h-3.5 w-3.5" /></Button>
                              <Button size="sm" variant="ghost" className="text-destructive" title="Reject dispute" onClick={() => setResolveTarget({ id: d.id, action: "REJECT" })}><XCircle className="h-3.5 w-3.5" /></Button>
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!resolveTarget} onOpenChange={(o) => { if (!o) { setResolveTarget(null); setReason("") } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {resolveTarget?.action === "RESTORE" && "Restore order"}
              {resolveTarget?.action === "REFUND" && "Refund customer"}
              {resolveTarget?.action === "REJECT" && "Reject dispute"}
            </DialogTitle>
            <DialogDescription>
              {resolveTarget?.action === "RESTORE" && "Return the order to its pre-dispute state and resume the workflow."}
              {resolveTarget?.action === "REFUND" && "Refund the customer. Any publisher settlement is reversed."}
              {resolveTarget?.action === "REJECT" && "Dismiss the dispute and return the order to its prior state."}
            </DialogDescription>
          </DialogHeader>
          <Textarea placeholder="Resolution note (recorded in the audit trail)..." value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} />
          <DialogFooter>
            <Button variant="outline" onClick={() => { setResolveTarget(null); setReason("") }}>Cancel</Button>
            <Button
              disabled={resolve.isPending || reason.trim().length < 3}
              onClick={() => resolveTarget && resolve.mutate({ id: resolveTarget.id, action: resolveTarget.action, resolution: reason.trim() })}
            >
              {resolve.isPending ? "Resolving..." : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
