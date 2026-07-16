"use client"

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  downloadCsv,
  ErrorState,
  Input,
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { format } from "date-fns"
import {
  Download,
  Gavel,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
} from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { api } from "../../../lib/api"
import { ForbiddenPage, useRequireRole } from "../../../lib/use-require-role"

const statusBadge: Record<string, { variant: any; Icon: any }> = {
  VERIFIED: { variant: "success", Icon: ShieldCheck },
  PENDING_VERIFICATION: { variant: "secondary", Icon: ShieldAlert },
  VERIFICATION_FAILED: { variant: "destructive", Icon: ShieldX },
  REVOKED: { variant: "destructive", Icon: ShieldX },
}
const trustVariant: Record<string, any> = {
  High: "success",
  Medium: "warning",
  Low: "destructive",
  Unknown: "secondary",
}

export default function VerificationCenterPage() {
  const { allowed, loading } = useRequireRole("SUPER_ADMIN", "OPERATIONS")
  if (loading) return null
  if (!allowed) return <ForbiddenPage requires="Operations or Super Admin" />
  return <VerificationCenterPageInner />
}

function VerificationCenterPageInner() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<"review" | "force">("review")
  const [domain, setDomain] = useState("")
  const [status, setStatus] = useState("all")
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const { data, isLoading, error } = useQuery({
    queryKey: ["verification-center", domain, status],
    queryFn: () =>
      api.admin.verificationReviewCenter({
        domain: domain || undefined,
        status: status === "all" ? undefined : status,
      }),
  })

  const { data: force } = useQuery({
    queryKey: ["force-approved"],
    queryFn: () => api.admin.forceApprovedReport(),
    enabled: tab === "force",
  })

  const bulkRetry = useMutation({
    mutationFn: (ids: string[]) => api.admin.bulkRetryVerification(ids),
    onSuccess: (r: any) => {
      toast.success(`Queued ${r.queued} re-verification(s)`)
      setSelected(new Set())
      qc.invalidateQueries({ queryKey: ["verification-center"] })
    },
    onError: (e: any) => toast.error(e?.message || "Bulk retry failed"),
  })

  if (error)
    return (
      <ErrorState
        title="Failed to load domain verification"
        description={(error as Error).message}
      />
    )

  const websites = data?.websites ?? []
  const sections = data?.sections ?? {
    pending: 0,
    failed: 0,
    revoked: 0,
    recentlyVerified: 0,
  }

  const toggle = (id: string) => {
    const next = new Set(selected)
    next.has(id) ? next.delete(id) : next.add(id)
    setSelected(next)
  }

  const exportCsv = () => {
    downloadCsv(
      "domain-verification-review.csv",
      [
        "Domain",
        "Status",
        "Trust",
        "Verified At",
        "Last Check",
        "Consecutive Failures",
        "Publisher",
      ],
      websites.map((w: any) => [
        w.domain,
        w.verificationStatus,
        w.trustBand,
        w.verifiedAt ?? "",
        w.lastVerificationCheckAt ?? "",
        w.consecutiveFailures,
        w.publisher?.email ?? "",
      ]),
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
          <ShieldCheck className="h-7 w-7" /> Domain Verification
        </h1>
        <p className="text-muted-foreground">
          Domain ownership operations, trust scoring, and force-approval
          governance.
        </p>
      </div>

      <div className="flex gap-2">
        <Button
          variant={tab === "review" ? "default" : "outline"}
          onClick={() => setTab("review")}
        >
          Review Center
        </Button>
        <Button
          variant={tab === "force" ? "default" : "outline"}
          onClick={() => setTab("force")}
        >
          <Gavel className="h-4 w-4 mr-1" />
          Force Approvals
        </Button>
      </div>

      {tab === "review" ? (
        <>
          <div className="grid gap-4 md:grid-cols-4">
            {[
              ["Pending", sections.pending],
              ["Failed", sections.failed],
              ["Revoked", sections.revoked],
              ["Recently Verified", sections.recentlyVerified],
            ].map(([label, n]) => (
              <Card key={label as string}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">{label}</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{n as number}</div>
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Filter by domain..."
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="PENDING_VERIFICATION">Pending</SelectItem>
                <SelectItem value="VERIFIED">Verified</SelectItem>
                <SelectItem value="VERIFICATION_FAILED">Failed</SelectItem>
                <SelectItem value="REVOKED">Revoked</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={exportCsv}>
              <Download className="h-4 w-4 mr-1" />
              Export CSV
            </Button>
            <Button
              disabled={selected.size === 0 || bulkRetry.isPending}
              onClick={() => bulkRetry.mutate([...selected])}
            >
              <RefreshCw className="h-4 w-4 mr-1" />
              Retry ({selected.size})
            </Button>
          </div>

          <div className="rounded-lg border">
            {isLoading ? (
              <Skeleton className="h-64 w-full" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8"></TableHead>
                    <TableHead>Domain</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Trust</TableHead>
                    <TableHead>Checks</TableHead>
                    <TableHead>Fails</TableHead>
                    <TableHead>Verified</TableHead>
                    <TableHead>Publisher</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {websites.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={8}
                        className="text-center py-8 text-muted-foreground"
                      >
                        No websites match.
                      </TableCell>
                    </TableRow>
                  ) : (
                    websites.map((w: any) => {
                      const sb =
                        statusBadge[w.verificationStatus] ??
                        statusBadge.PENDING_VERIFICATION
                      return (
                        <TableRow key={w.id}>
                          <TableCell>
                            <input
                              type="checkbox"
                              checked={selected.has(w.id)}
                              onChange={() => toggle(w.id)}
                              disabled={w.verificationStatus === "VERIFIED"}
                            />
                          </TableCell>
                          <TableCell className="font-medium">
                            {w.domain}
                          </TableCell>
                          <TableCell>
                            <Badge variant={sb.variant} className="gap-1">
                              <sb.Icon className="h-3 w-3" />
                              {w.verificationStatus.replace("_", " ")}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant={trustVariant[w.trustBand]}>
                              {w.trustBand}
                              {w.trustScore != null ? ` (${w.trustScore})` : ""}
                            </Badge>
                          </TableCell>
                          <TableCell>{w.verificationCheckCount}</TableCell>
                          <TableCell>
                            {w.consecutiveFailures > 0 ? (
                              <span className="text-destructive font-medium">
                                {w.consecutiveFailures}
                              </span>
                            ) : (
                              0
                            )}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {w.verifiedAt
                              ? format(new Date(w.verifiedAt), "PP")
                              : "—"}
                          </TableCell>
                          <TableCell className="text-xs">
                            {w.publisher?.email ?? "—"}
                          </TableCell>
                        </TableRow>
                      )
                    })
                  )}
                </TableBody>
              </Table>
            )}
          </div>
        </>
      ) : (
        <>
          {force && (
            <div className="grid gap-4 md:grid-cols-5">
              {Object.entries(force.metrics).map(([k, v]) => (
                <Card key={k}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium capitalize">
                      {k}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">{v as number}</div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                Force-Approved Domains (governance audit)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Domain</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Publisher</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(force?.forceApproved ?? []).length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="text-center py-8 text-muted-foreground"
                      >
                        No force approvals on record.
                      </TableCell>
                    </TableRow>
                  ) : (
                    force.forceApproved.map((r: any) => (
                      <TableRow key={r.auditId}>
                        <TableCell className="font-medium">
                          {r.domain ?? "—"}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {r.actorId?.slice(0, 8) ?? "—"}
                        </TableCell>
                        <TableCell
                          className="text-sm max-w-xs truncate"
                          title={r.reason}
                        >
                          {r.reason ?? "—"}
                        </TableCell>
                        <TableCell className="text-xs">
                          {r.publisher?.email ?? "—"}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {format(new Date(r.timestamp), "PPp")}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
