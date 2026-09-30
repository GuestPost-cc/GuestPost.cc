"use client"

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@guestpost/ui"
import { useQuery } from "@tanstack/react-query"
import { AlertCircle, ChevronRight, RefreshCw } from "lucide-react"
import Link from "next/link"
import { useState } from "react"
import { api } from "../../../lib/api"

function timestamp(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString()
}

function CaseStatus({ status }: { status: string }) {
  const variant =
    status === "VERIFIED"
      ? "success"
      : status === "BLOCKED"
        ? "destructive"
        : status === "NEEDS_EVIDENCE"
          ? "warning"
          : "secondary"
  return <Badge variant={variant as any}>{status.replaceAll("_", " ")}</Badge>
}

function SafeFindingList({ findings }: { findings: unknown }) {
  if (!Array.isArray(findings) || findings.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No finding evidence recorded.
      </p>
    )
  }
  return (
    <div className="space-y-3">
      {findings.map((finding, index) => {
        const row =
          finding && typeof finding === "object"
            ? (finding as Record<string, unknown>)
            : {}
        return (
          <div key={index} className="rounded-md border p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{String(row.code ?? "UNKNOWN")}</Badge>
              <span className="text-muted-foreground">
                {String(row.entityType ?? "Record")}{" "}
                {String(row.entityId ?? "")}
              </span>
              {row.amount !== undefined && (
                <span>USD {String(row.amount)}</span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** Detection-only case workbench. Any financial correction remains unavailable
 * until its separately approved maker-checker recovery implementation exists. */
export function ReconciliationCases({ enabled }: { enabled: boolean }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [skip, setSkip] = useState(0)
  const pageSize = 20
  const casesQ = useQuery({
    queryKey: ["reconciliation-cases", skip],
    queryFn: () => api.admin.getReconciliationCases({ take: pageSize, skip }),
    enabled,
  })
  const caseQ = useQuery({
    queryKey: ["reconciliation-case", selectedId],
    queryFn: () => api.admin.getReconciliationCase(selectedId!),
    enabled: enabled && Boolean(selectedId),
  })

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="text-base">Reconciliation cases</CardTitle>
          <CardDescription className="mt-1 leading-6">
            Related order findings are grouped into one immutable evidence case.
            This release is investigation-only: it cannot change wallet balances
            or provider money.
          </CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => casesQ.refetch()}
          disabled={casesQ.isFetching}
        >
          <RefreshCw className="mr-2 h-3 w-3" /> Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {casesQ.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : casesQ.isError ? (
          <div className="flex items-center gap-2 rounded-md border border-destructive/30 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" /> Unable to load reconciliation
            cases.
          </div>
        ) : casesQ.data?.cases.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            No order-level cases have been detected.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Findings</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last detected</TableHead>
                <TableHead className="text-right">Evidence</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {casesQ.data?.cases.map((caseRow) => (
                <TableRow key={caseRow.id}>
                  <TableCell className="font-mono text-xs">
                    {caseRow.orderId ? caseRow.orderId.slice(0, 12) : "Unknown"}
                  </TableCell>
                  <TableCell className="max-w-[260px] truncate text-xs">
                    {caseRow.snapshots[0]?.findingCodes.join(", ") ??
                      "No snapshot"}
                  </TableCell>
                  <TableCell>
                    <CaseStatus status={caseRow.status} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {timestamp(caseRow.lastDetectedAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelectedId(caseRow.id)}
                    >
                      Open <ChevronRight className="ml-1 h-3 w-3" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {selectedId && (
          <div className="rounded-lg border bg-muted/20 p-4">
            {caseQ.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : caseQ.isError || !caseQ.data ? (
              <p className="text-sm text-destructive">
                Unable to load this case.
              </p>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-medium">Case evidence</p>
                    <p className="text-xs text-muted-foreground">
                      Latest scan: {timestamp(caseQ.data.lastDetectedAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <CaseStatus status={caseQ.data.status} />
                    {caseQ.data.orderId && (
                      <Button asChild variant="outline" size="sm">
                        <Link href={`/dashboard/orders/${caseQ.data.orderId}`}>
                          Open order
                        </Link>
                      </Button>
                    )}
                  </div>
                </div>
                {caseQ.data.order && (
                  <div className="grid gap-2 text-sm sm:grid-cols-4">
                    <span>Order: {caseQ.data.order.id.slice(0, 12)}</span>
                    <span>
                      Amount: {caseQ.data.order.currency}{" "}
                      {caseQ.data.order.amount ?? "—"}
                    </span>
                    <span>Status: {caseQ.data.order.status}</span>
                    <span>Payment: {caseQ.data.order.paymentStatus}</span>
                  </div>
                )}
                <SafeFindingList findings={caseQ.data.snapshots[0]?.findings} />
                <p className="text-xs text-muted-foreground">
                  Evidence fingerprint{" "}
                  {caseQ.data.currentFingerprint.slice(0, 16)}… · Showing the
                  latest {caseQ.data.snapshots.length} distinct evidence
                  revision{caseQ.data.snapshots.length === 1 ? "" : "s"} (up to
                  20).
                </p>
              </div>
            )}
          </div>
        )}

        {casesQ.data && casesQ.data.total > pageSize && (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              Showing {skip + 1}–
              {Math.min(skip + casesQ.data.cases.length, casesQ.data.total)} of{" "}
              {casesQ.data.total} cases
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSkip(Math.max(0, skip - pageSize))}
                disabled={skip === 0 || casesQ.isFetching}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSkip(skip + pageSize)}
                disabled={
                  skip + pageSize >= casesQ.data.total || casesQ.isFetching
                }
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
