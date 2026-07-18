"use client"

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorState,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@guestpost/ui"
import { useQuery } from "@tanstack/react-query"
import { format } from "date-fns"
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Scale,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
} from "lucide-react"
import { Fragment, useState } from "react"
import { api } from "../../../../lib/api"

const vBadge: Record<string, { variant: any; Icon: any }> = {
  VERIFIED: { variant: "success", Icon: ShieldCheck },
  FAILED: { variant: "destructive", Icon: ShieldX },
  PENDING: { variant: "secondary", Icon: ShieldAlert },
  RETRYING: { variant: "warning", Icon: ShieldAlert },
  MANUAL_REVIEW: { variant: "warning", Icon: ShieldAlert },
}

const PAGE_SIZE = 20
const REVIEWABLE_STATUSES = [
  "PENDING",
  "UNDER_REVIEW",
  "CUSTOMER_APPROVED",
  "ADMIN_APPROVED",
] as const

// Per-settlement delivery evidence + computed settlement eligibility. Finance
// sees exactly why a settlement is (in)eligible before releasing.
function DeliveryRow({ orderId }: { orderId: string }) {
  const { data: deliveries = [], isLoading } = useQuery({
    queryKey: ["settlement-deliveries", orderId],
    queryFn: () => api.admin.listDeliveries(orderId),
  })
  if (isLoading) return <Skeleton className="h-16 w-full" />
  const active =
    deliveries.find((d: any) => !d.supersededByVersion) ?? deliveries[0]
  if (!active)
    return (
      <p className="text-sm text-muted-foreground p-3">
        No delivery submitted.
      </p>
    )

  const verified =
    active.verificationStatus === "VERIFIED" ||
    ["APPROVED", "OVERRIDDEN"].includes(active.interventionStatus)
  const fraud = deliveries.some((d: any) => d.fraudFlags?.length > 0)
  const vb = vBadge[active.verificationStatus] ?? vBadge.PENDING

  return (
    <div className="space-y-2 p-3 bg-muted/30 rounded-lg">
      <div className="flex items-center gap-2">
        <Badge variant={vb.variant} className="gap-1">
          <vb.Icon className="h-3 w-3" />
          {active.verificationStatus}
        </Badge>
        {active.interventionStatus !== "NONE" && (
          <Badge variant="outline">{active.interventionStatus}</Badge>
        )}
        {fraud && <Badge variant="destructive">FRAUD FLAGGED</Badge>}
        <Badge variant={verified && !fraud ? "success" : "destructive"}>
          {verified && !fraud ? "Settlement Eligible" : "Settlement Blocked"}
        </Badge>
      </div>
      <a
        href={active.publishedUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm text-primary hover:underline break-all"
      >
        {active.publishedUrl}
      </a>
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
  const [page, setPage] = useState(1)
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin", "finance-settlements", "reviewable", page],
    queryFn: () =>
      api.admin.listSettlements(PAGE_SIZE, (page - 1) * PAGE_SIZE, [
        ...REVIEWABLE_STATUSES,
      ]),
  })

  if (error)
    return (
      <ErrorState
        title="Failed to load settlements"
        description={(error as Error).message}
      />
    )

  const settlements = data?.items ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
          <Scale className="h-7 w-7" /> Settlement Review
        </h1>
        <p className="text-muted-foreground">
          Verify delivery evidence before releasing settlement. Settlement is
          gated on independent verification.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            Settlements awaiting review ({total})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : settlements.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              None awaiting review.
            </p>
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
                {settlements.map((s) => (
                  <Fragment key={s.id}>
                    <TableRow
                      className="cursor-pointer"
                      onClick={() =>
                        setExpanded(expanded === s.id ? null : s.id)
                      }
                    >
                      <TableCell>
                        {expanded === s.id ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {s.orderId.slice(0, 8)}
                      </TableCell>
                      <TableCell className="text-sm">
                        {s.publisher?.name ?? s.publisher?.email}
                      </TableCell>
                      <TableCell>
                        {s.order.currency} {s.publisherAmount}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{s.status}</Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {format(new Date(s.createdAt), "PP")}
                      </TableCell>
                    </TableRow>
                    {expanded === s.id && (
                      <TableRow>
                        <TableCell colSpan={6}>
                          <DeliveryRow orderId={s.orderId} />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
        {totalPages > 1 ? (
          <div className="flex items-center justify-between gap-4 border-t px-4 py-3">
            <p className="text-xs text-muted-foreground">
              Page {page} of {totalPages} · {total} settlements
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => {
                  setExpanded(null)
                  setPage((current) => Math.max(1, current - 1))
                }}
              >
                <ChevronLeft className="mr-1 h-4 w-4" /> Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => {
                  setExpanded(null)
                  setPage((current) => Math.min(totalPages, current + 1))
                }}
              >
                Next <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            </div>
          </div>
        ) : null}
      </Card>
    </div>
  )
}
