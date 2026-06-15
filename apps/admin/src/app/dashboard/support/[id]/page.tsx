"use client"

import { useState, useMemo } from "react"
import { useParams, useRouter } from "next/navigation"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../../../lib/api"
import { useAuth } from "../../../../lib/auth"
import { Card, CardContent, CardHeader, CardTitle } from "@guestpost/ui"
import { Button } from "@guestpost/ui"
import { Skeleton } from "@guestpost/ui"
import { Textarea } from "@guestpost/ui"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@guestpost/ui"
import {
  ArrowLeft,
  Send,
  AlertCircle,
  RefreshCw,
  Lock,
  Eye,
  Info,
  Cog,
} from "lucide-react"
import { format, formatDistanceToNow } from "date-fns"
import { toast } from "sonner"

const STATUS_OPTIONS = ["OPEN", "IN_PROGRESS", "WAITING_ON_CUSTOMER", "RESOLVED", "CLOSED"]

type Visibility = "PUBLIC" | "INTERNAL"
type ParticipantRole = "CUSTOMER" | "PUBLISHER" | "OPS" | "ADMIN" | "FINANCE"
type MessageType = "MESSAGE" | "INTERNAL_NOTE" | "SYSTEM_EVENT"
type ActorSnapshot = {
  kind: "CUSTOMER" | "PUBLISHER" | "STAFF"
  staffRole: "SUPER_ADMIN" | "OPERATIONS" | "FINANCE" | null
  organizationRole: "OWNER" | "MEMBER" | null
  publisherRole: "PUBLISHER_OWNER" | "PUBLISHER_MEMBER" | null
} | null

// Phase 6.6.2: render the uncollapsed role snapshot as a hover-readable
// string. participantRole collapses ADMIN/OPS/FINANCE to a chip; this
// surfaces the raw role + the customer/publisher membership context that
// the chip can't fit. Used as the title= on the RoleBadge.
function describeActorSnapshot(snap: ActorSnapshot): string {
  if (!snap) return "Role at write time — snapshot unavailable (pre-Phase-6.6.2 row)"
  if (snap.kind === "STAFF") {
    return `Role at write time: STAFF · ${snap.staffRole ?? "(no role)"}`
  }
  if (snap.kind === "PUBLISHER") {
    return `Role at write time: PUBLISHER · ${snap.publisherRole ?? "(no role)"}`
  }
  return `Role at write time: CUSTOMER · ${snap.organizationRole ?? "(no role)"}`
}

// Channel badge — shared visual language with the inbox.
function ChannelBadge({ channel }: { channel: "PUBLISHER" | "PLATFORM" | null }) {
  if (!channel) return <span className="text-xs text-muted-foreground">No channel</span>
  const cls =
    channel === "PLATFORM"
      ? "bg-violet-100 text-violet-800"
      : "bg-sky-100 text-sky-800"
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {channel === "PLATFORM" ? "Platform" : "Publisher"}
    </span>
  )
}

// Phase 6.6.1: role-at-write-time badge. Distinct colors per role so a
// dispute reviewer can scan a long thread and immediately see "Finance
// posted then Ops verified then Admin closed". Colors are stable across
// channels — Finance is always green, Admin is always indigo, etc.
const ROLE_STYLES: Record<ParticipantRole, { label: string; cls: string }> = {
  CUSTOMER:  { label: "CUSTOMER",  cls: "bg-slate-100 text-slate-800" },
  PUBLISHER: { label: "PUBLISHER", cls: "bg-sky-100 text-sky-800" },
  OPS:       { label: "OPS",       cls: "bg-blue-100 text-blue-800" },
  ADMIN:     { label: "ADMIN",     cls: "bg-indigo-100 text-indigo-800" },
  FINANCE:   { label: "FINANCE",   cls: "bg-emerald-100 text-emerald-800" },
}

function RoleBadge({ role, snapshot }: { role: ParticipantRole; snapshot?: ActorSnapshot }) {
  const s = ROLE_STYLES[role]
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${s.cls}`}
      title={describeActorSnapshot(snapshot ?? null)}
    >
      [{s.label}]
    </span>
  )
}

export default function AdminTicketDetailPage() {
  const params = useParams()
  const router = useRouter()
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const staffRole = user?.staffRole ?? null

  const [replyContent, setReplyContent] = useState("")
  const [visibility, setVisibility] = useState<Visibility>("PUBLIC")

  const { data: ticket, isLoading, error, refetch } = useQuery({
    queryKey: ["admin", "ticket", params.id],
    queryFn: () => api.admin.getTicketDetail(params.id as string),
    enabled: !!params.id,
  })

  // Phase 6.6: FINANCE on PLATFORM tickets is read-only for the customer-
  // facing thread — internal notes only. Force the toggle accordingly and
  // disable the PUBLIC option.
  const platformChannel = ticket?.fulfillmentChannel === "PLATFORM"
  const financeOnPlatform = staffRole === "FINANCE" && platformChannel
  const publicReplyDisabled = financeOnPlatform
  const effectiveVisibility: Visibility = publicReplyDisabled ? "INTERNAL" : visibility

  // Keep the local state coherent if the ticket finishes loading after mount.
  useMemo(() => {
    if (publicReplyDisabled && visibility !== "INTERNAL") {
      setVisibility("INTERNAL")
    }
  }, [publicReplyDisabled, visibility])

  const { mutate: updateStatus } = useMutation({
    mutationFn: (status: string) =>
      api.admin.updateTicketStatus(params.id as string, status as any),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "ticket", params.id] })
      queryClient.invalidateQueries({ queryKey: ["admin", "tickets"] })
      toast.success("Status updated")
    },
    onError: (err: any) => toast.error(err?.message || "Failed to update status"),
  })

  const { mutate: sendReply, isPending: sendingReply } = useMutation({
    mutationFn: () =>
      api.admin.addTicketMessage(params.id as string, {
        content: replyContent,
        visibility: effectiveVisibility,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "ticket", params.id] })
      setReplyContent("")
      toast.success(effectiveVisibility === "INTERNAL" ? "Internal note added" : "Reply sent")
    },
    onError: (err: any) => toast.error(err?.message || "Failed to send reply"),
  })

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  if (error || !ticket) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <AlertCircle className="h-12 w-12 text-destructive mb-4" />
        <h2 className="text-xl font-semibold mb-2">Ticket Not Found</h2>
        <p className="text-muted-foreground mb-4">
          {(error as Error)?.message || "This ticket doesn't exist."}
        </p>
        <Button onClick={() => refetch()}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back
        </Button>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <CardTitle className="text-xl">{ticket.subject}</CardTitle>
                <ChannelBadge channel={ticket.fulfillmentChannel} />
              </div>
              <p className="text-sm text-muted-foreground">
                by {ticket.user.name || ticket.user.email} — Created{" "}
                {formatDistanceToNow(new Date(ticket.createdAt), { addSuffix: true })}
              </p>
              {ticket.organization && (
                <p className="text-sm text-muted-foreground">
                  Organization: {ticket.organization.name}
                </p>
              )}
              {ticket.fulfillmentChannel === "PLATFORM" && (
                <p className="text-sm text-muted-foreground">
                  Assigned Ops:{" "}
                  {ticket.assignedTo?.name || (
                    <span className="text-amber-600">Unassigned</span>
                  )}
                </p>
              )}
              {ticket.fulfillmentChannel === "PUBLISHER" && ticket.assignedPublisher && (
                <p className="text-sm text-muted-foreground">
                  Publisher: {ticket.assignedPublisher.name}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Select defaultValue={ticket.status} onValueChange={(v) => updateStatus(v)}>
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s.replace(/_/g, " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
      </Card>

      {financeOnPlatform && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 flex items-start gap-2">
          <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span>
            This is a <strong>Platform</strong> ticket. Finance is read-only on the customer
            thread — public replies are disabled. Use an internal note to flag concerns to
            Admin / Ops.
          </span>
        </div>
      )}

      <div className="space-y-4">
        {ticket.messages.map((msg) => {
          const role = msg.participantRole as ParticipantRole
          const msgType = msg.messageType as MessageType
          const isInternal = msg.visibility === "INTERNAL" || msgType === "INTERNAL_NOTE"
          const isSystem = msgType === "SYSTEM_EVENT"
          const isStaffRole = role === "OPS" || role === "ADMIN" || role === "FINANCE"

          // SYSTEM_EVENT: centered, muted row — distinct from human messages.
          if (isSystem) {
            return (
              <div key={msg.id} className="flex justify-center">
                <div className="flex items-center gap-2 rounded-full border border-dashed bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
                  <Cog className="h-3 w-3" />
                  <span className="font-medium">[SYSTEM]</span>
                  <span>{msg.content}</span>
                  <span className="text-[10px]">
                    {format(new Date(msg.createdAt), "MMM d HH:mm")}
                  </span>
                </div>
              </div>
            )
          }

          return (
            <div
              key={msg.id}
              className={`flex gap-3 ${isStaffRole ? "flex-row-reverse" : ""}`}
            >
              <div
                className={[
                  "flex-1 rounded-lg border p-4",
                  isInternal
                    ? "border-amber-200 bg-amber-50/60 ring-1 ring-amber-100"
                    : isStaffRole
                      ? "bg-primary/5"
                      : "",
                ].join(" ")}
              >
                <div className="flex items-center justify-between mb-2 gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <RoleBadge
                      role={role}
                      snapshot={(msg.actorSnapshot ?? null) as ActorSnapshot}
                    />
                    <span className="text-sm font-medium">
                      {msg.user?.name || msg.user?.email || "Unknown"}
                    </span>
                    {isInternal && (
                      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-medium">
                        <Lock className="h-3 w-3" />
                        Internal — staff only
                      </span>
                    )}
                    {!isInternal && isStaffRole && (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <Eye className="h-3 w-3" />
                        Customer-visible
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {format(new Date(msg.createdAt), "MMM d, yyyy HH:mm")}
                  </span>
                </div>
                <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
              </div>
            </div>
          )
        })}
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <label className="text-sm font-medium">Reply</label>
              <fieldset className="inline-flex rounded-md border bg-muted/30 p-0.5 text-xs">
                <button
                  type="button"
                  disabled={publicReplyDisabled}
                  className={[
                    "px-3 py-1 rounded transition-colors flex items-center gap-1",
                    effectiveVisibility === "PUBLIC"
                      ? "bg-background shadow text-foreground"
                      : "text-muted-foreground",
                    publicReplyDisabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer",
                  ].join(" ")}
                  onClick={() => !publicReplyDisabled && setVisibility("PUBLIC")}
                  title={
                    publicReplyDisabled
                      ? "Finance can't post public replies on Platform tickets"
                      : "Customer-visible reply"
                  }
                >
                  <Eye className="h-3 w-3" />
                  Public reply
                </button>
                <button
                  type="button"
                  className={[
                    "px-3 py-1 rounded transition-colors flex items-center gap-1 cursor-pointer",
                    effectiveVisibility === "INTERNAL"
                      ? "bg-amber-100 text-amber-900 shadow"
                      : "text-muted-foreground",
                  ].join(" ")}
                  onClick={() => setVisibility("INTERNAL")}
                >
                  <Lock className="h-3 w-3" />
                  Internal note
                </button>
              </fieldset>
            </div>
            <Textarea
              placeholder={
                effectiveVisibility === "INTERNAL"
                  ? "Leave an internal note — visible only to staff (Ops / Admin / Finance)…"
                  : "Type your reply — customer will see this…"
              }
              value={replyContent}
              onChange={(e) => setReplyContent(e.target.value)}
              rows={4}
            />
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                {effectiveVisibility === "INTERNAL"
                  ? "Internal notes are invisible to the customer and to publishers."
                  : "Public replies appear in the customer's ticket thread."}
              </p>
              <Button
                onClick={() => sendReply()}
                disabled={!replyContent.trim() || sendingReply}
                variant={effectiveVisibility === "INTERNAL" ? "outline" : "default"}
              >
                {effectiveVisibility === "INTERNAL" ? (
                  <Lock className="mr-2 h-4 w-4" />
                ) : (
                  <Send className="mr-2 h-4 w-4" />
                )}
                {sendingReply
                  ? "Sending..."
                  : effectiveVisibility === "INTERNAL"
                    ? "Add internal note"
                    : "Send reply"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
