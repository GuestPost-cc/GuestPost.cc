"use client"

import { use } from "react"
import { useQuery } from "@tanstack/react-query"
import { api } from "../../../../../lib/api"
import { Card, CardContent, CardHeader, CardTitle, Badge, Skeleton, ErrorState } from "@guestpost/ui"
import { FileText, Camera, ScrollText, ShieldAlert, ShieldCheck } from "lucide-react"
import { format } from "date-fns"

// Dispute evidence package — reviewers see the complete, immutable history
// (delivery versions + evidence, snapshots, fraud flags, audit trail) without
// reconstructing anything by hand.
export default function DisputeEvidencePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { data, isLoading, error } = useQuery<any>({
    queryKey: ["dispute-evidence", id],
    queryFn: () => api.admin.disputeEvidence(id),
  })

  if (error) return <ErrorState title="Failed to load evidence" description={(error as Error).message} />
  if (isLoading || !data) return <Skeleton className="h-96 w-full" />

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2"><ScrollText className="h-7 w-7" /> Dispute Evidence Package</h1>
        <p className="text-muted-foreground">Immutable delivery history, verification evidence, snapshots, and audit trail.</p>
      </div>

      {data.dispute && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Dispute</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <div>Status: <Badge variant="outline">{data.dispute.status}</Badge></div>
            <div className="text-muted-foreground">Reason: {data.dispute.reason}</div>
          </CardContent>
        </Card>
      )}

      {data.fraudFlags?.length > 0 && (
        <Card className="border-destructive">
          <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2 text-destructive"><ShieldAlert className="h-4 w-4" /> Fraud Flags</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {data.fraudFlags.map((f: any) => <Badge key={f.id} variant="destructive" title={JSON.stringify(f.details)}>{f.type}</Badge>)}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><FileText className="h-4 w-4" /> Delivery Versions</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {data.versions?.map((v: any) => {
            const ev = v.evidence?.[0]
            return (
              <div key={v.id} className="rounded-lg border p-3 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">v{v.version}{v.supersededByVersion ? ` → superseded by v${v.supersededByVersion}` : " (active)"}</span>
                  <Badge variant={v.verificationStatus === "VERIFIED" ? "success" : v.verificationStatus === "FAILED" ? "destructive" : "secondary"} className="gap-1">
                    {v.verificationStatus === "VERIFIED" ? <ShieldCheck className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />}{v.verificationStatus}
                  </Badge>
                </div>
                <a href={v.publishedUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline break-all">{v.publishedUrl}</a>
                {ev && (
                  <div className="grid grid-cols-2 gap-1 text-xs text-muted-foreground">
                    <span>HTTP {ev.httpStatus}</span><span>Link: {ev.linkFound ? "✓" : "✗"}</span>
                    <span>Target: {ev.targetUrlMatched ? "✓" : "✗"}</span><span>Anchor: {ev.anchorFound ? "✓" : "✗"}</span>
                    {ev.htmlHash && <span className="col-span-2 font-mono truncate">sha256: {ev.htmlHash}</span>}
                  </div>
                )}
              </div>
            )
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Camera className="h-4 w-4" /> Snapshots</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {data.snapshots?.length === 0 && <p className="text-sm text-muted-foreground">No snapshots.</p>}
          {data.snapshots?.map((s: any) => (
            <div key={s.snapshotId} className="flex items-center justify-between text-sm border-b pb-1">
              <span className="text-muted-foreground">v{s.version} · {format(new Date(s.createdAt), "PPp")}</span>
              <span className="flex gap-3">
                {s.htmlUrl && <a href={s.htmlUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">HTML</a>}
                {s.screenshotUrl && <a href={s.screenshotUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Screenshot</a>}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Audit Trail</CardTitle></CardHeader>
        <CardContent className="space-y-1 max-h-80 overflow-y-auto">
          {data.auditTrail?.map((a: any) => (
            <div key={a.id} className="flex items-center justify-between text-xs border-b py-1">
              <span className="font-mono">{a.action}</span>
              <span className="text-muted-foreground">{format(new Date(a.createdAt), "PPp")}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
