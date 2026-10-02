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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertCircle, ChevronRight, RefreshCw } from "lucide-react"
import Link from "next/link"
import { useState } from "react"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"

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

function repairBlockerMessage(code: string) {
  if (code === "INSUFFICIENT_AVAILABLE_FUNDS") {
    return "Available wallet funds are below the exact reversal amount. Reserved funds cannot be used."
  }
  return code.replaceAll("_", " ")
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

export function ReconciliationCases({ enabled }: { enabled: boolean }) {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [skip, setSkip] = useState(0)
  const [previewState, setPreviewState] = useState<{
    caseId: string
    data: Awaited<ReturnType<typeof api.admin.previewRefundCreditRepair>>
  } | null>(null)
  const preview = previewState?.caseId === selectedId ? previewState.data : null
  const setPreview = (value: null) => setPreviewState(value)
  const [incidentReference, setIncidentReference] = useState("")
  const [reason, setReason] = useState("")
  const [providerRefundConfirmedAbsent, setProviderRefundConfirmedAbsent] =
    useState(false)
  const pageSize = 20
  const refreshCase = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["reconciliation-case", selectedId],
      }),
      queryClient.invalidateQueries({ queryKey: ["reconciliation-cases"] }),
    ])
    setPreview(null)
  }
  const previewMutation = useMutation({
    mutationFn: (caseId: string) => api.admin.previewRefundCreditRepair(caseId),
    onSuccess: (data, caseId) => setPreviewState({ caseId, data }),
  })
  const proposeMutation = useMutation({
    mutationFn: () => {
      if (!selectedId || !preview)
        throw new Error("Create a fresh preview first")
      return api.admin.proposeRefundCreditRepair(selectedId, {
        evidenceDigest: preview.evidenceDigest,
        expectedCaseVersion: preview.expectedCaseVersion,
        incidentReference: incidentReference.trim(),
        providerRefundConfirmedAbsent,
        reason: reason.trim(),
      })
    },
    onSuccess: refreshCase,
  })
  const approveMutation = useMutation({
    mutationFn: (proposal: { id: string; proposalDigest: string }) => {
      if (!selectedId) throw new Error("Select a case")
      return api.admin.approveRefundCreditRepair(
        selectedId,
        proposal.id,
        proposal.proposalDigest,
      )
    },
    onSuccess: refreshCase,
  })
  const executeMutation = useMutation({
    mutationFn: (proposal: {
      id: string
      proposalDigest: string
      incidentReference: string
    }) => {
      if (!selectedId) throw new Error("Select a case")
      return api.admin.executeRefundCreditRepair(
        selectedId,
        proposal.id,
        proposal.proposalDigest,
        `repair_${proposal.id}`,
      )
    },
    onSuccess: refreshCase,
  })
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
            The only supported correction is a maker-checker reversal of an
            eligible internal wallet refund credit. Provider refunds are never
            changed.
          </CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void casesQ.refetch()
            if (selectedId) void caseQ.refetch()
          }}
          disabled={casesQ.isFetching || caseQ.isFetching}
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
                      onClick={() => {
                        setPreviewState(null)
                        setIncidentReference("")
                        setReason("")
                        setProviderRefundConfirmedAbsent(false)
                        setSelectedId(caseRow.id)
                      }}
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
                <div className="space-y-3 rounded-md border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">
                        Typed repair preview
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Mutations are disabled unless the recovery feature is
                        explicitly enabled and finance runtime is in
                        recovery-only mode.
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {caseQ.data.makerCheckerRequired
                          ? "A different Finance or Super Admin user must approve and execute this proposal."
                          : "Staging test mode: this staff account may approve and execute its own proposal. Production requires independent staff accounts."}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => previewMutation.mutate(caseQ.data.id)}
                      disabled={previewMutation.isPending}
                    >
                      {previewMutation.isPending
                        ? "Checking…"
                        : "Preview exact correction"}
                    </Button>
                  </div>
                  {preview && (
                    <div className="space-y-2 text-sm">
                      {preview.eligible && preview.entry && preview.balance ? (
                        <div className="rounded-md bg-muted p-3">
                          <p>
                            Append {preview.entry.type} {preview.entry.amount}{" "}
                            {preview.entry.currency}, linked only to refund{" "}
                            {preview.entry.reversesTransactionId}.
                          </p>
                          <p className="mt-1">
                            Available balance: {preview.balance.availableBefore}{" "}
                            → {preview.balance.availableAfter}; reserved balance
                            remains {preview.balance.reservedUnchanged}.
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {preview.immutableEvidence} Preview expires when
                            bound evidence changes.
                          </p>
                        </div>
                      ) : (
                        <div className="rounded-md border border-amber-500/40 p-3">
                          <p className="font-medium">
                            Blocked — no money will move.
                          </p>
                          {preview.blockers.length > 0 ? (
                            <ul className="mt-1 list-inside list-disc text-xs text-muted-foreground">
                              {preview.blockers.map((blocker) => (
                                <li key={blocker}>
                                  {repairBlockerMessage(blocker)}{" "}
                                  <span className="font-mono">({blocker})</span>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="mt-1 text-xs text-muted-foreground">
                              Repair is not currently eligible.
                            </p>
                          )}
                          {preview.balance && (
                            <p className="mt-2 text-xs text-muted-foreground">
                              Available now: USD{" "}
                              {preview.balance.availableBefore}
                              {preview.entry && (
                                <>
                                  {" "}
                                  · reversal requires {preview.entry.currency}{" "}
                                  {preview.entry.amount.replace(/^-/, "")}
                                </>
                              )}{" "}
                              · reserved balance remains USD{" "}
                              {preview.balance.reservedUnchanged}
                            </p>
                          )}
                        </div>
                      )}
                      {preview.eligible && !preview.featureEnabled && (
                        <p className="text-xs text-muted-foreground">
                          Preview is read-only. Feature enablement and
                          FINANCE_RUNTIME_MODE=recovery_only are required before
                          proposing.
                        </p>
                      )}
                    </div>
                  )}
                  {preview?.eligible && preview.featureEnabled && (
                    <div className="grid gap-2">
                      <input
                        className="h-9 rounded-md border bg-background px-3 text-sm"
                        placeholder="Provider evidence / incident reference"
                        value={incidentReference}
                        onChange={(event) =>
                          setIncidentReference(event.target.value)
                        }
                        maxLength={191}
                      />
                      <input
                        className="h-9 rounded-md border bg-background px-3 text-sm"
                        placeholder="Reason (20–1000 characters)"
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        maxLength={1000}
                      />
                      <label className="flex items-start gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={providerRefundConfirmedAbsent}
                          onChange={(event) =>
                            setProviderRefundConfirmedAbsent(
                              event.target.checked,
                            )
                          }
                          className="mt-0.5"
                        />
                        I reviewed the referenced provider records and confirm
                        no card or bank refund was issued; this repair is only
                        for the internal GuestPost wallet credit.
                      </label>
                      <Button
                        size="sm"
                        onClick={() => proposeMutation.mutate()}
                        disabled={
                          proposeMutation.isPending ||
                          !providerRefundConfirmedAbsent ||
                          incidentReference.trim().length < 3 ||
                          reason.trim().length < 20
                        }
                      >
                        {proposeMutation.isPending
                          ? "Submitting…"
                          : "Propose for approval"}
                      </Button>
                    </div>
                  )}
                  {(previewMutation.isError ||
                    proposeMutation.isError ||
                    approveMutation.isError ||
                    executeMutation.isError) && (
                    <p role="alert" className="text-sm text-destructive">
                      The repair action failed or its evidence changed. Refresh
                      the case and preview again before retrying.
                    </p>
                  )}
                </div>
                {caseQ.data.repairProposals.length > 0 && (
                  <div className="space-y-2 rounded-md border p-3">
                    <p className="text-sm font-medium">
                      Immutable repair activity
                    </p>
                    {caseQ.data.repairProposals.map((proposal) => (
                      <div
                        key={proposal.id}
                        className="flex flex-wrap items-center justify-between gap-3 border-t pt-2 text-sm"
                      >
                        <div>
                          <p>
                            {proposal.currency} {proposal.amount} ·{" "}
                            {proposal.incidentReference} · expires{" "}
                            {timestamp(proposal.expiresAt)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Proposed by {proposal.initiatedByUserId};{" "}
                            {proposal.approval
                              ? `approved by ${proposal.approval.approvedByUserId}`
                              : "awaiting independent approval"}
                            {proposal.execution
                              ? ` · applied as ${proposal.execution.reversalTransactionId}`
                              : ""}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {proposal.reason}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            External refund absence confirmed:{" "}
                            {proposal.providerRefundConfirmedAbsent
                              ? "yes"
                              : "no"}
                          </p>
                        </div>
                        {!proposal.approval &&
                          (!caseQ.data.makerCheckerRequired ||
                            proposal.initiatedByUserId !== user?.id) && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => approveMutation.mutate(proposal)}
                              disabled={approveMutation.isPending}
                            >
                              Approve exact proposal
                            </Button>
                          )}
                        {proposal.approval &&
                          !proposal.execution &&
                          (!caseQ.data.makerCheckerRequired ||
                            proposal.approval.approvedByUserId !==
                              user?.id) && (
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => {
                                if (
                                  window.confirm(
                                    `Execute the approved USD ${proposal.amount} internal wallet-credit reversal? This cannot be undone.`,
                                  )
                                )
                                  executeMutation.mutate(proposal)
                              }}
                              disabled={executeMutation.isPending}
                            >
                              Execute approved repair
                            </Button>
                          )}
                        {proposal.approval &&
                          !proposal.execution &&
                          caseQ.data.makerCheckerRequired &&
                          proposal.approval.approvedByUserId === user?.id && (
                            <p className="text-xs text-muted-foreground">
                              An authorized Finance or Super Admin user other
                              than the approver must execute this repair.
                            </p>
                          )}
                      </div>
                    ))}
                  </div>
                )}
                {caseQ.data.snapshots.length === 0 ? (
                  <SafeFindingList findings={undefined} />
                ) : (
                  <div className="space-y-3">
                    {caseQ.data.snapshots.map((snapshot) => (
                      <section
                        key={snapshot.id}
                        className="space-y-2 rounded-md border p-3"
                      >
                        <p className="text-xs text-muted-foreground">
                          {timestamp(snapshot.scan.ranAt)} ·{" "}
                          {snapshot.scan.detector} · v
                          {snapshot.scan.reportVersion}
                        </p>
                        <SafeFindingList findings={snapshot.findings} />
                        <p className="font-mono text-xs text-muted-foreground">
                          Fingerprint{" "}
                          {snapshot.evidenceFingerprint.slice(0, 16)}…
                        </p>
                      </section>
                    ))}
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  Current fingerprint{" "}
                  {caseQ.data.currentFingerprint.slice(0, 16)}… · Showing{" "}
                  {caseQ.data.snapshots.length} most recent distinct evidence
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
