"use client"

import { useState, Fragment } from "react"
import { useQuery } from "@tanstack/react-query"
import { api } from "../../../../lib/api"
import { Card, CardContent, CardHeader, CardTitle, Badge, Skeleton, ErrorState, Button } from "@guestpost/ui"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@guestpost/ui"
import { ShieldCheck, ShieldX, ShieldAlert, ChevronDown, ChevronRight, Scale } from "lucide-react"
import { format } from "date-fns"

const vBadge: Record<string, { variant: any; Icon: any }> = {
  VERIFIED: { variant: "success", Icon: ShieldCheck },
  FAILED: { variant: "destructive", Icon: ShieldX },
  PENDING: { variant: "secondary", Icon: ShieldAlert },
  RETRYING: { variant: "warning", Icon: ShieldAlert },
  MANUAL_REVIEW: { variant: "warning", Icon: ShieldAlert },
}

// Per-settlement delivery evidence + computed settlement eligibility. Finance
// sees exactly why a settlement is (in)eligible before releasing.
function DeliveryRow({ orderId }: { orderId: string }) {
  const { data: deliveries = [], isLoading } = useQuery({
    queryKey: ["settlement-deliveries", orderId],
    queryFn: () => api.admin.listDeliveries(orderId),
  })
  if (isLoading) return <Skeleton className="h-16 w-full" />
  const active = deliveries.find((d: any) => !d.supersededByVersion) ?? deliveries[0]
  if (!active) return <p className="text-sm text-muted-foreground p-3">No delivery submitted.</p>

  const verified = active.verificationStatus === "VERIFIED" || ["APPROVED", "OVERRIDDEN"].includes(active.interventionStatus)
  const fraud = deliveries.some((d: any) => d.fraudFlags?.length > 0)
  const vb = vBadge[active.verificationStatus] ?? vBadge.PENDING

  return (
    <div className="space-y-2 p-3 bg-muted/30 rounded-lg">
      <div className="flex items-center gap-2">
        <Badge variant={vb.variant} className="gap-1"><vb.Icon className="h-3 w-3" />{active.verificationStatus}</Badge>
        {active.interventionStatus !== "NONE" && <Badge variant="outline">{active.interventionStatus}</Badge>}
        {fraud && <Badge variant="destructive">FRAUD FLAGGED</Badge>}
        <Badge variant={verified && !fraud ? "success" : "destructive"}>{verified && !fraud ? "Settlement Eligible" : "Settlement Blocked"}</Badge>
      </div>
      <a href={active.publishedUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline break-all">{active.publishedUrl}</a>
      {active.evidence?.[0] && (
        <div className="grid grid-cols-4 gap-1 text-xs text-muted-foreground">
          <span>HTTP {active.evidence[0].httpStatus}</span>
          <span>Link {active.evidence[0].linkFound ? "✓" : "✗"}</span>
          <span>Target {active.evidence[0].targetUrlMatched ? "✓" : "✗"}</span>
          <span>Anchor {active.evidence[0].anchorFound ? "✓" : "✗"}</span>
        </div>
      )}
    </div>
  )
}

export default function SettlementReviewPage() {
  const [expanded, setExpanded] = useState<string | null>(null)
  const { data, isLoading, error } = useQuery({
    queryKey: ["finance-settlements"],
    queryFn: () => api.admin.listSettlements(100, 0),
  })

  if (error) return <ErrorState title="Failed to load settlements" description={(error as Error).message} />

  const settlements = data?.items ?? []
  const reviewable = settlements.filter((s: any) => ["PENDING", "UNDER_REVIEW", "CUSTOMER_APPROVED", "ADMIN_APPROVED"].includes(s.status))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2"><Scale className="h-7 w-7" /> Settlement Review</h1>
        <p className="text-muted-foreground">Verify delivery evidence before releasing settlement. Settlement is gated on independent verification.</p>
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Settlements awaiting review ({reviewable.length})</CardTitle></CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : reviewable.length === 0 ? (
            <p className="text-sm text-muted-foreground">None awaiting review.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead>Order</TableHead>
                  <TableHead>Publisher</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reviewable.map((s: any) => (
                  <Fragment key={s.id}>
                    <TableRow className="cursor-pointer" onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
                      <TableCell>{expanded === s.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</TableCell>
                      <TableCell className="font-mono text-xs">{s.orderId.slice(0, 8)}</TableCell>
                      <TableCell className="text-sm">{s.publisher?.name ?? s.publisher?.email}</TableCell>
                      <TableCell>{s.currency} {s.amount}</TableCell>
                      <TableCell><Badge variant="outline">{s.status}</Badge></TableCell>
                      <TableCell className="text-xs text-muted-foreground">{format(new Date(s.createdAt), "PP")}</TableCell>
                    </TableRow>
                    {expanded === s.id && (
                      <TableRow>
                        <TableCell colSpan={6}><DeliveryRow orderId={s.orderId} /></TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
