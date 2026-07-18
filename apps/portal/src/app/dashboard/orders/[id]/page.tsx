"use client"

import type {
  CancellationReasonCode,
  OrderResponse,
} from "@guestpost/api-client"
import type { OrderStatus } from "@guestpost/database"
import {
  BriefRenderer,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorState,
  getOrderStatusPresentation,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  SupportPanel,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  StatusBadge as UIStatusBadge,
} from "@guestpost/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { format, formatDistanceToNow } from "date-fns"
import DOMPurify from "isomorphic-dompurify"
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCircle,
  Clock,
  Code,
  ExternalLink,
  Eye,
  FileText,
  LifeBuoy,
  RefreshCw,
  ShieldCheck,
  Star,
  XCircle,
} from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { use, useState } from "react"
import { toast } from "sonner"
import { api } from "../../../../lib/api"
import { useAuth } from "../../../../lib/auth"
import {
  customerCanMutateOrder,
  formatCustomerMoney,
  getCustomerNextAction,
  getCustomerOrderDeadline,
} from "../../../../lib/customer-order-workflow"

// Phase 7.9 #28 — color + label live in the central STATUS_PRESENTATION
// table now (@guestpost/ui). This local map keeps only the page-specific
// concerns: which icon to render alongside the badge + a one-line
// description. Per the table's header comment, icons stay local rather
// than polluting the cross-page table.
//
// The colored circle around the icon (used in the "current status"
// header card, line ~870) uses the same variant -> Tailwind palette
// that `<StatusBadge>` does internally, so visuals stay aligned with
// the badge inside the card.
const VARIANT_CIRCLE_BG: Record<string, string> = {
  default: "bg-primary/10 text-primary",
  success: "bg-emerald-100 text-emerald-700",
  warning: "bg-amber-100 text-amber-700",
  destructive: "bg-red-100 text-red-700",
  info: "bg-blue-100 text-blue-700",
  pending: "bg-gray-100 text-gray-700",
}
const statusConfig: Record<
  string,
  { icon: React.ElementType; description: string }
> = {
  DRAFT: { icon: FileText, description: "Order is in draft state" },
  PENDING_PAYMENT: { icon: Clock, description: "Awaiting payment" },
  PAID: { icon: CheckCircle, description: "Payment received" },
  SUBMITTED: { icon: CheckCircle, description: "Order submitted" },
  ACCEPTED: { icon: CheckCircle, description: "Order accepted" },
  CONTENT_REQUESTED: { icon: FileText, description: "Content requested" },
  CONTENT_CREATION: { icon: FileText, description: "Creating content" },
  CONTENT_READY: { icon: Check, description: "Content ready" },
  CUSTOMER_REVIEW: { icon: AlertCircle, description: "Awaiting your review" },
  APPROVED: { icon: Check, description: "Content approved" },
  PUBLISHED: { icon: Check, description: "Content published" },
  VERIFIED: { icon: ShieldCheck, description: "Content verified" },
  DELIVERED: { icon: CheckCircle, description: "Order delivered" },
  SETTLED: { icon: CheckCircle, description: "Settlement processed" },
  COMPLETED: { icon: CheckCircle, description: "Order completed" },
  CANCELLED: { icon: XCircle, description: "Order cancelled" },
  REFUNDED: { icon: RefreshCw, description: "Refund issued" },
  DISPUTED: { icon: AlertCircle, description: "Order disputed" },
}

const eventLabels: Record<string, string> = {
  ORDER_CREATED: "Order created",
  PAYMENT_RECEIVED: "Payment received",
  ASSIGNED: "Writer assigned",
  CONTENT_SUBMITTED: "Content submitted",
  CONTENT_APPROVED: "Content approved",
  PUBLISHED: "Published live",
  VERIFIED: "Verified",
  UNDER_REVIEW: "Sent for review",
  DELIVERED: "Delivered",
  SETTLED: "Settlement processed",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  REFUNDED: "Refunded",
  DISPUTED: "Dispute opened",
  REJECTED: "Rejected",
  VERIFIED_AUTO: "Automatically verified",
  AUTO_ACCEPTED: "Auto-accepted (review window expired)",
  REVIEW_REMINDER: "Review reminder sent",
  VERIFICATION_ESCALATED: "Verification escalated to admin",
}

interface TimelineEvent {
  id: string
  eventType: string
  message?: string | null
  metadata: Record<string, unknown> | null
  createdAt: string
}

// Human one-liner for a timeline event — never raw JSON. Prefer the server
// message; otherwise build a readable detail from known metadata fields.
function eventDetail(event: TimelineEvent): string | null {
  const m = (event.metadata ?? {}) as Record<string, any>
  // Server message is already human ("Content published at https://…").
  if (event.message?.trim()) return event.message.trim()

  const parts: string[] = []
  const url = m.publishedUrl ?? m.url
  if (url) parts.push(`Published at ${url}`)
  if (m.reason) parts.push(`Reason: ${m.reason}`)
  if (m.notes) parts.push(String(m.notes))
  if (m.newStatus)
    parts.push(
      `Status → ${String(m.newStatus).replace(/_/g, " ").toLowerCase()}`,
    )
  if (typeof m.amount === "number")
    parts.push(`Amount: $${m.amount.toLocaleString()}`)
  if (typeof m.publisherAmount === "number")
    parts.push(`Publisher payout: $${m.publisherAmount.toLocaleString()}`)
  if (m.version != null && url == null) parts.push(`Revision v${m.version}`)
  return parts.length ? parts.join(" · ") : null
}

// Publisher-submitted content is rendered in the customer's browser — sanitize
// to neutralize XSS (scripts, event handlers, javascript: URLs). Links open in
// a new tab.
if (typeof window !== "undefined" && !(DOMPurify as any).__gpHook) {
  DOMPurify.addHook("afterSanitizeAttributes", (node: any) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank")
      node.setAttribute("rel", "noopener noreferrer")
    }
  })
  ;(DOMPurify as any).__gpHook = true
}

// Renders submitted content: plain text as-is, HTML via a sanitized Preview /
// raw HTML source tabbed view. Images + formatting are constrained so they
// never blow out the card layout.
function SubmittedContentBody({ content }: { content: string }) {
  const hasHtml = /<\/?[a-z][\s\S]*>/i.test(content)
  if (!hasHtml) {
    return (
      <div className="rounded-lg border bg-muted/30 p-3">
        <p className="whitespace-pre-wrap break-words text-sm">{content}</p>
      </div>
    )
  }
  const clean = DOMPurify.sanitize(content)
  return (
    <Tabs defaultValue="preview" className="w-full">
      <TabsList>
        <TabsTrigger value="preview" className="gap-1">
          <Eye className="h-3.5 w-3.5" /> Preview
        </TabsTrigger>
        <TabsTrigger value="html" className="gap-1">
          <Code className="h-3.5 w-3.5" /> HTML
        </TabsTrigger>
      </TabsList>
      <TabsContent value="preview">
        <div
          className="max-w-none overflow-x-auto rounded-lg border bg-background p-4 text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_h1]:mb-2 [&_h1]:mt-3 [&_h1]:text-lg [&_h1]:font-bold [&_h2]:mb-2 [&_h2]:mt-3 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:font-semibold [&_img]:my-2 [&_img]:max-w-full [&_img]:rounded-lg [&_li]:my-0.5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_table]:w-full [&_td]:border [&_td]:p-1 [&_th]:border [&_th]:p-1 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5"
          dangerouslySetInnerHTML={{ __html: clean }}
        />
      </TabsContent>
      <TabsContent value="html">
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/30 p-3 text-xs">
          {content}
        </pre>
      </TabsContent>
    </Tabs>
  )
}

// Revision.files Json is loosely shaped — accept array of strings or {url,name}.
function fileEntries(files: unknown): Array<{ url: string; name: string }> {
  if (!Array.isArray(files)) return []
  return files
    .map((f: any) => {
      if (typeof f === "string")
        return { url: f, name: f.split("/").pop() || f }
      if (f && typeof f === "object" && (f.url || f.href)) {
        const url = f.url ?? f.href
        return {
          url,
          name: f.name ?? f.filename ?? url.split("/").pop() ?? url,
        }
      }
      return null
    })
    .filter(Boolean) as Array<{ url: string; name: string }>
}

function OrderTimeline({ events }: { events: TimelineEvent[] }) {
  const sortedEvents = [...events].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )

  return (
    <div className="relative">
      <div className="absolute left-4 top-0 h-full w-px bg-border" />
      <div className="space-y-6">
        {sortedEvents.map((event, index) => {
          const config = statusConfig[event.eventType] || statusConfig.DRAFT
          const Icon = config.icon
          const isLatest = index === 0

          return (
            <div key={event.id} className="relative pl-10">
              <div
                className={`absolute left-2.5 top-1 flex h-5 w-5 items-center justify-center rounded-full ${
                  isLatest ? "bg-primary" : "bg-muted"
                }`}
              >
                <Icon
                  className={`h-3 w-3 ${isLatest ? "text-primary-foreground" : "text-muted-foreground"}`}
                />
              </div>
              <div className="flex flex-col">
                <span className="font-medium">
                  {eventLabels[event.eventType] ||
                    event.eventType
                      .replace(/_/g, " ")
                      .toLowerCase()
                      .replace(/\b\w/g, (c) => c.toUpperCase())}
                </span>
                {(() => {
                  const detail = eventDetail(event)
                  return detail ? (
                    <span className="mt-0.5 text-sm text-muted-foreground break-words">
                      {detail}
                    </span>
                  ) : null
                })()}
                <span
                  className="mt-0.5 text-xs text-muted-foreground"
                  title={format(new Date(event.createdAt), "PPpp")}
                >
                  {formatDistanceToNow(new Date(event.createdAt), {
                    addSuffix: true,
                  })}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const local = statusConfig[status] || statusConfig.DRAFT
  const p = getOrderStatusPresentation(status as OrderStatus)
  const Icon = local.icon

  return (
    <UIStatusBadge variant={p.variant} className="gap-1.5">
      <Icon className="h-3.5 w-3.5" />
      {p.label}
    </UIStatusBadge>
  )
}

// Visual lifecycle so the customer always knows where the order stands.
const PROGRESS_STEPS = [
  { label: "Payment", statuses: ["DRAFT", "PENDING_PAYMENT", "PAID"] },
  {
    label: "Content",
    statuses: [
      "SUBMITTED",
      "ACCEPTED",
      "CONTENT_REQUESTED",
      "CONTENT_CREATION",
      "CONTENT_READY",
    ],
  },
  { label: "Review", statuses: ["CUSTOMER_REVIEW", "APPROVED"] },
  { label: "Published", statuses: ["PUBLISHED"] },
  { label: "Verified", statuses: ["VERIFIED"] },
  { label: "Delivered", statuses: ["DELIVERED"] },
  { label: "Complete", statuses: ["SETTLED", "COMPLETED"] },
]

function OrderProgress({ status }: { status: string }) {
  // Off-track states get a banner instead of a progress bar.
  if (
    status === "CANCELLED" ||
    status === "REFUNDED" ||
    status === "DISPUTED"
  ) {
    const map: Record<string, { text: string; cls: string }> = {
      CANCELLED: {
        text: "This order was cancelled.",
        cls: "bg-gray-100 text-gray-700",
      },
      REFUNDED: {
        text: "This order was refunded.",
        cls: "bg-orange-100 text-orange-700",
      },
      DISPUTED: {
        text: "A dispute is open — settlement to the publisher is paused while we review.",
        cls: "bg-red-100 text-red-700",
      },
    }
    const m = map[status]
    return (
      <div className={`rounded-lg px-4 py-3 text-sm font-medium ${m.cls}`}>
        {m.text}
      </div>
    )
  }

  let current = PROGRESS_STEPS.findIndex((s) => s.statuses.includes(status))
  if (current === -1) current = 0

  return (
    <div className="flex items-center">
      {PROGRESS_STEPS.map((step, i) => {
        const done = i < current
        const active = i === current
        return (
          <div
            key={step.label}
            className="flex flex-1 items-center last:flex-none"
          >
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold transition-colors ${
                  done
                    ? "bg-primary text-primary-foreground"
                    : active
                      ? "bg-primary/15 text-primary ring-2 ring-primary"
                      : "bg-muted text-muted-foreground"
                }`}
              >
                {done ? <CheckCircle className="h-4 w-4" /> : i + 1}
              </div>
              <span
                className={`text-[11px] ${active ? "font-medium text-foreground" : "text-muted-foreground"}`}
              >
                {step.label}
              </span>
            </div>
            {i < PROGRESS_STEPS.length - 1 && (
              <div
                className={`mx-1 h-0.5 flex-1 ${done ? "bg-primary" : "bg-muted"}`}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

function OrderDetailSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Skeleton className="h-10 w-10" />
        <Skeleton className="h-8 w-48" />
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardContent className="pt-6">
              <Skeleton className="h-32 w-full" />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <Skeleton className="h-48 w-full" />
            </CardContent>
          </Card>
        </div>
        <div className="space-y-6">
          <Card>
            <CardContent className="pt-6">
              <Skeleton className="h-24 w-full" />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <Skeleton className="h-48 w-full" />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

export default function OrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const resolvedParams = use(params)
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const [showRevisionDialog, setShowRevisionDialog] = useState(false)
  const [showCancelDialog, setShowCancelDialog] = useState(false)
  const [showDisputeDialog, setShowDisputeDialog] = useState(false)
  const [showSupportDialog, setShowSupportDialog] = useState(false)
  const [revisionMessage, setRevisionMessage] = useState("")
  const [disputeReason, setDisputeReason] = useState("")
  const [supportSubject, setSupportSubject] = useState("")
  const [supportMessage, setSupportMessage] = useState("")
  const [cancelReason, setCancelReason] = useState<CancellationReasonCode>(
    "CUSTOMER_CHANGED_MIND",
  )
  const [cancelNote, setCancelNote] = useState("")
  const [cancellationResponseNote, setCancellationResponseNote] = useState("")
  const router = useRouter()

  const {
    data: order,
    isLoading,
    error,
    refetch,
  } = useQuery<OrderResponse>({
    queryKey: ["order", resolvedParams.id],
    queryFn: () => api.orders.getById(resolvedParams.id),
  })

  const { data: cancellationPreview, isLoading: cancellationPreviewLoading } =
    useQuery({
      queryKey: ["order-cancellation-preview", resolvedParams.id],
      queryFn: () => api.orders.cancellationPreview(resolvedParams.id),
      enabled: Boolean(order),
    })

  const { data: proof } = useQuery<any>({
    queryKey: ["order-proof", resolvedParams.id],
    queryFn: () => api.orders.deliveryProof(resolvedParams.id),
    enabled:
      !!order &&
      [
        "PUBLISHED",
        "VERIFIED",
        "DELIVERED",
        "SETTLED",
        "COMPLETED",
        "DISPUTED",
      ].includes(order.status),
  })

  // Phase 7.9 #29 — lifted from OrderSupportPanel (now deleted). Shared
  // <SupportPanel> is presentational; parent owns the fetch.
  const { data: orderTickets = [], isLoading: ticketsLoading } = useQuery<
    any[]
  >({
    queryKey: ["order-tickets", resolvedParams.id],
    queryFn: async () => {
      const all = await api.support.listTickets()
      return ((all ?? []) as any[]).filter(
        (t: any) => t.order?.id === resolvedParams.id,
      )
    },
  })

  const reviewable =
    !!order && ["DELIVERED", "SETTLED", "COMPLETED"].includes(order.status)
  const { data: existingReview } = useQuery<any>({
    queryKey: ["order-review", resolvedParams.id],
    queryFn: () => api.orders.getReview(resolvedParams.id),
    enabled: reviewable,
  })
  const [reviewRating, setReviewRating] = useState(0)
  const [reviewComment, setReviewComment] = useState("")
  const reviewMutation = useMutation({
    mutationFn: () =>
      api.orders.submitReview(
        resolvedParams.id,
        reviewRating,
        reviewComment.trim() || undefined,
      ),
    onSuccess: () => {
      toast.success("Thanks for your review")
      queryClient.invalidateQueries({
        queryKey: ["order-review", resolvedParams.id],
      })
    },
    onError: (e: Error) => toast.error(e.message || "Failed to submit review"),
  })

  const cancelMutation = useMutation({
    mutationFn: async () => {
      if (!cancellationPreview)
        throw new Error("Cancellation policy unavailable")
      const data = {
        reasonCode: cancelReason,
        note: cancelNote.trim() || undefined,
        expectedVersion: cancellationPreview.expectedVersion,
        idempotencyKey: `portal-${resolvedParams.id}-${cancellationPreview.expectedVersion}`,
      }
      if (cancellationPreview.action === "CANCEL_NOW") {
        return api.orders.cancel(resolvedParams.id, data)
      }
      if (cancellationPreview.action === "REQUEST_CANCELLATION") {
        return api.orders.requestCancellation(resolvedParams.id, data)
      }
      throw new Error(cancellationPreview.message)
    },
    onSuccess: () => {
      toast.success(
        cancellationPreview?.action === "REQUEST_CANCELLATION"
          ? "Cancellation request sent"
          : "Order cancelled and refund processed",
      )
      queryClient.invalidateQueries({ queryKey: ["order", resolvedParams.id] })
      queryClient.invalidateQueries({ queryKey: ["orders"] })
      setShowCancelDialog(false)
      setCancelNote("")
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to process cancellation")
    },
  })

  const respondToCancellationMutation = useMutation({
    mutationFn: (action: "ACCEPT" | "CONTEST") => {
      const request = cancellationPreview?.activeRequest
      if (!request) throw new Error("No active cancellation request")
      return api.orders.respondToCancellation(
        resolvedParams.id,
        request.id,
        action,
        cancellationResponseNote.trim() || undefined,
      )
    },
    onSuccess: (_data, action) => {
      toast.success(
        action === "ACCEPT"
          ? "Cancellation accepted; full wallet refund issued"
          : "Cancellation contested and sent for staff review",
      )
      setCancellationResponseNote("")
      queryClient.invalidateQueries({ queryKey: ["order", resolvedParams.id] })
      queryClient.invalidateQueries({
        queryKey: ["order-cancellation-preview", resolvedParams.id],
      })
    },
    onError: (error: Error) => toast.error(error.message || "Response failed"),
  })

  const supportMutation = useMutation({
    mutationFn: () =>
      api.support.createTicket({
        subject:
          supportSubject.trim() ||
          `Help with order #${resolvedParams.id.slice(0, 8)}`,
        message: supportMessage.trim(),
        orderId: resolvedParams.id,
      }),
    onSuccess: (t: any) => {
      toast.success("Support ticket created")
      setShowSupportDialog(false)
      setSupportSubject("")
      setSupportMessage("")
      if (t?.id) router.push(`/dashboard/support/${t.id}`)
    },
    onError: (err: Error) =>
      toast.error(err.message || "Failed to create ticket"),
  })

  const disputeMutation = useMutation({
    mutationFn: () =>
      api.orders.openDispute(resolvedParams.id, disputeReason.trim()),
    onSuccess: () => {
      toast.success("Dispute opened — our team will review it")
      queryClient.invalidateQueries({ queryKey: ["order", resolvedParams.id] })
      queryClient.invalidateQueries({ queryKey: ["orders"] })
      setShowDisputeDialog(false)
      setDisputeReason("")
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to open dispute")
    },
  })

  const refreshOrder = () => {
    queryClient.invalidateQueries({ queryKey: ["order", resolvedParams.id] })
    queryClient.invalidateQueries({
      queryKey: ["order-proof", resolvedParams.id],
    })
    queryClient.invalidateQueries({ queryKey: ["orders"] })
  }

  const approveContentMutation = useMutation({
    mutationFn: () => api.orders.approveContent(resolvedParams.id),
    onSuccess: () => {
      toast.success("Content approved — publisher can now publish")
      refreshOrder()
    },
    onError: (e: Error) =>
      toast.error(e.message || "Failed to approve content"),
  })

  const confirmDeliveryMutation = useMutation({
    mutationFn: () => api.orders.confirmDelivery(resolvedParams.id),
    onSuccess: () => {
      toast.success("Delivery confirmed — order complete")
      refreshOrder()
    },
    onError: (e: Error) =>
      toast.error(e.message || "Failed to confirm delivery"),
  })

  // Fallback: accept manually when the automated check could not verify.
  const acceptDeliveryMutation = useMutation({
    mutationFn: () => api.orders.acceptDelivery(resolvedParams.id),
    onSuccess: () => {
      toast.success("Delivery accepted — order complete")
      refreshOrder()
    },
    onError: (e: Error) =>
      toast.error(e.message || "Failed to accept delivery"),
  })

  const requestRevisionMutation = useMutation({
    mutationFn: () =>
      api.orders.requestRevision(resolvedParams.id, revisionMessage.trim()),
    onSuccess: () => {
      toast.success("Revision request submitted")
      refreshOrder()
      setShowRevisionDialog(false)
      setRevisionMessage("")
    },
    onError: () => {
      toast.error("Failed to submit revision request")
    },
  })

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/dashboard/orders">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Orders
          </Link>
        </Button>
        <OrderDetailSkeleton />
      </div>
    )
  }

  if (error) {
    return (
      <ErrorState
        title="Failed to load order"
        description={(error as Error).message}
        onRetry={() => refetch()}
      />
    )
  }

  if (!order) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <AlertCircle className="h-12 w-12 text-destructive" />
        <h2 className="mt-4 text-xl font-semibold">Order Not Found</h2>
        <p className="mt-2 text-muted-foreground">
          The order you&apos;re looking for doesn&apos;t exist or you don&apos;t
          have access to it.
        </p>
        <Button className="mt-4" asChild>
          <Link href="/dashboard/orders">View All Orders</Link>
        </Button>
      </div>
    )
  }

  const currentStatusConfig = statusConfig[order.status] || statusConfig.DRAFT
  const currentStatusIcon = currentStatusConfig.icon

  // Customer is reviewing the publisher's draft content
  // Draft orders only enter the publisher/ops queue after payment.
  const actorCanMutate = customerCanMutateOrder(order, user)
  const canPay =
    actorCanMutate &&
    (order.status === "DRAFT" || order.status === "PENDING_PAYMENT")
  const canApproveContent = actorCanMutate && order.status === "CUSTOMER_REVIEW"
  const _canRequestRevision = canApproveContent
  // Platform verified the live placement — customer confirms to complete + settle
  const canConfirmDelivery = actorCanMutate && order.status === "VERIFIED"
  // System check is primary; manual accept is the fallback only when the
  // automated check failed or needs review (and not already accepted).
  const autoUnverified =
    proof?.hasDelivery &&
    ["FAILED", "MANUAL_REVIEW"].includes(proof.verificationStatus) &&
    proof.interventionStatus === "NONE"
  const canManualAccept =
    actorCanMutate && order.status === "PUBLISHED" && autoUnverified
  const verifyInProgress =
    order.status === "PUBLISHED" &&
    proof?.hasDelivery &&
    ["PENDING", "RETRYING"].includes(proof.verificationStatus)
  const canCancel = Boolean(
    cancellationPreview?.actorCanMutate &&
      ["CANCEL_NOW", "REQUEST_CANCELLATION"].includes(
        cancellationPreview.action,
      ),
  )
  const canDispute = Boolean(
    cancellationPreview?.actorCanMutate &&
      cancellationPreview.action === "OPEN_DISPUTE",
  )
  const nextAction = getCustomerNextAction(order, user)
  const deadline = getCustomerOrderDeadline(order)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/dashboard/orders">
              <ArrowLeft className="h-5 w-5" />
            </Link>
          </Button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight">
                Order #{order.id.slice(0, 8)}
              </h1>
              <StatusBadge status={order.status} />
            </div>
            <p className="text-sm text-muted-foreground">
              Created {format(new Date(order.createdAt), "PPp")}
            </p>
          </div>
        </div>

        <div className="flex gap-3">
          {canDispute && (
            <Button
              variant="outline"
              onClick={() => setShowDisputeDialog(true)}
            >
              <AlertCircle className="mr-2 h-4 w-4" />
              Open Dispute
            </Button>
          )}
          <Button variant="outline" onClick={() => setShowSupportDialog(true)}>
            <LifeBuoy className="mr-2 h-4 w-4" />
            Get Help
          </Button>
          {canCancel && (
            <Button
              variant="destructive"
              onClick={() => setShowCancelDialog(true)}
            >
              <XCircle className="mr-2 h-4 w-4" />
              {cancellationPreview?.action === "REQUEST_CANCELLATION"
                ? "Request Cancellation"
                : "Cancel Order"}
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="rounded-2xl shadow-sm">
          <CardContent className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Order value
            </p>
            <p className="mt-1 text-xl font-bold tabular-nums">
              {formatCustomerMoney(order.totalAmount, order.currency)}
            </p>
          </CardContent>
        </Card>
        <Card className="rounded-2xl shadow-sm">
          <CardContent className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {deadline.kind}
            </p>
            <p
              className={`mt-1 text-sm font-semibold ${
                deadline.risk === "overdue"
                  ? "text-red-700"
                  : deadline.risk === "soon"
                    ? "text-amber-700"
                    : "text-foreground"
              }`}
            >
              {deadline.label}
            </p>
          </CardContent>
        </Card>
        <Card className="rounded-2xl shadow-sm">
          <CardContent className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Turnaround
            </p>
            <p className="mt-1 text-sm font-semibold">
              {order.turnaroundDays
                ? `${order.turnaroundDays} days`
                : "Not specified"}
            </p>
          </CardContent>
        </Card>
        <Card className="rounded-2xl border-primary/30 bg-primary/5 shadow-sm">
          <CardContent className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Next step
            </p>
            <p
              className={`mt-1 text-sm font-semibold ${
                nextAction.tone === "urgent" ? "text-amber-700" : "text-primary"
              }`}
            >
              {nextAction.label}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="pt-6">
          <OrderProgress status={order.status} />
        </CardContent>
      </Card>

      {cancellationPreview?.activeRequest?.status === "REQUESTED" &&
        cancellationPreview.activeRequest.requesterType !== "CUSTOMER" && (
          <Card className="border-amber-300 bg-amber-50/50">
            <CardHeader>
              <CardTitle className="text-base">
                Cancellation response needed
              </CardTitle>
              <CardDescription>
                The fulfiller requested cancellation for{" "}
                {cancellationPreview.activeRequest.reasonCode
                  .replaceAll("_", " ")
                  .toLowerCase()}
                . Accepting returns the full order amount to your wallet.
                Contesting sends the case to staff review.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {cancellationPreview.actorCanMutate ? (
                <>
                  <Textarea
                    value={cancellationResponseNote}
                    onChange={(event) =>
                      setCancellationResponseNote(event.target.value)
                    }
                    placeholder="Optional response details"
                    rows={3}
                    maxLength={2000}
                  />
                  <div className="flex gap-2">
                    <Button
                      onClick={() =>
                        respondToCancellationMutation.mutate("ACCEPT")
                      }
                      disabled={respondToCancellationMutation.isPending}
                    >
                      Accept and Refund
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() =>
                        respondToCancellationMutation.mutate("CONTEST")
                      }
                      disabled={respondToCancellationMutation.isPending}
                    >
                      Contest
                    </Button>
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Only the organization owner or original order creator can
                  respond.
                </p>
              )}
            </CardContent>
          </Card>
        )}

      {(canPay || canApproveContent || canConfirmDelivery) && (
        <Card className="border-primary/40 bg-primary/5">
          <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium">
                {canPay
                  ? "Complete payment to start your order"
                  : canConfirmDelivery
                    ? "Delivery verified — ready to confirm"
                    : "Content ready for your review"}
              </p>
              <p className="text-sm text-muted-foreground">
                {canPay
                  ? "Your order is in draft. Pay from your wallet to send it to the publisher."
                  : canConfirmDelivery
                    ? "Confirm the live placement to complete the order and release settlement to the publisher."
                    : "Approve to let the publisher publish, or request changes."}
              </p>
            </div>
            <div className="flex gap-2 shrink-0">
              {canPay && (
                <Button
                  onClick={() =>
                    router.push(
                      `/dashboard/orders/checkout/${resolvedParams.id}`,
                    )
                  }
                >
                  Complete Payment
                </Button>
              )}
              {canApproveContent && (
                <>
                  <Button
                    variant="outline"
                    onClick={() => setShowRevisionDialog(true)}
                  >
                    Request Revision
                  </Button>
                  <Button
                    onClick={() => approveContentMutation.mutate()}
                    disabled={approveContentMutation.isPending}
                  >
                    {approveContentMutation.isPending
                      ? "Approving..."
                      : "Approve Content"}
                  </Button>
                </>
              )}
              {canConfirmDelivery && (
                <>
                  <Button
                    variant="outline"
                    onClick={() => setShowDisputeDialog(true)}
                  >
                    Report Issue
                  </Button>
                  <Button
                    onClick={() => confirmDeliveryMutation.mutate()}
                    disabled={confirmDeliveryMutation.isPending}
                  >
                    {confirmDeliveryMutation.isPending
                      ? "Confirming..."
                      : "Confirm Delivery"}
                  </Button>
                </>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {verifyInProgress && (
        <Card>
          <CardContent className="flex items-center gap-3 pt-6 text-sm text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin" />
            Automated verification is running. We&apos;re checking the live
            placement — this usually takes a few minutes.
          </CardContent>
        </Card>
      )}

      {order.status === "VERIFIED" && order.autoAcceptAt && (
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Clock className="h-5 w-5 text-blue-600" />
                  <p className="font-medium">
                    Review window open until{" "}
                    {format(new Date(order.autoAcceptAt), "PPp")}
                  </p>
                </div>
                <p className="text-sm text-muted-foreground ml-7">
                  {(() => {
                    const remaining = Math.ceil(
                      (new Date(order.autoAcceptAt).getTime() - Date.now()) /
                        (1000 * 60 * 60 * 24),
                    )
                    if (remaining > 0) {
                      return `If you take no action, this order will be automatically accepted in ${remaining} day(s).`
                    }
                    return "Auto-accepting shortly — the review window has ended."
                  })()}
                </p>
              </div>
              <Button
                variant="outline"
                onClick={() => setShowDisputeDialog(true)}
              >
                Report Issue
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {canManualAccept && (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium text-amber-900">
                Automated check couldn&apos;t verify this delivery
              </p>
              <p className="text-sm text-amber-800">
                Our system couldn&apos;t confirm the live placement. Review the
                published page yourself — if it looks correct, accept it to
                complete the order. Otherwise open a dispute.
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              {proof?.publishedUrl && (
                <Button variant="outline" asChild>
                  <a
                    href={proof.publishedUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Review page
                  </a>
                </Button>
              )}
              <Button
                variant="outline"
                onClick={() => setShowDisputeDialog(true)}
              >
                Open Dispute
              </Button>
              <Button
                onClick={() => acceptDeliveryMutation.mutate()}
                disabled={acceptDeliveryMutation.isPending}
              >
                {acceptDeliveryMutation.isPending
                  ? "Accepting..."
                  : "Accept Delivery"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          {proof?.hasDelivery && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ShieldCheck className="h-5 w-5 text-green-600" /> Delivery
                  Proof
                </CardTitle>
                <CardDescription>
                  {proof.verifyMethod === "AUTO"
                    ? "Independently verified by the platform — no manual checking needed."
                    : proof.verifyMethod === "MANUAL_ADMIN"
                      ? "Verified by an admin reviewer."
                      : "Verified by customer confirmation."}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Published URL</p>
                  <a
                    href={proof.publishedUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-primary hover:underline break-all"
                  >
                    {proof.publishedUrl}
                  </a>
                </div>
                {proof.pageTitle && (
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">Page Title</p>
                    <p className="font-medium">{proof.pageTitle}</p>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">
                    Verification:
                  </span>
                  <StatusBadge
                    status={
                      proof.verificationStatus === "VERIFIED" ||
                      proof.interventionStatus === "APPROVED" ||
                      proof.interventionStatus === "OVERRIDDEN"
                        ? "VERIFIED"
                        : proof.verificationStatus
                    }
                  />
                  {proof.verifyMethod && (
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        proof.verifyMethod === "AUTO"
                          ? "bg-emerald-100 text-emerald-700"
                          : proof.verifyMethod === "MANUAL_ADMIN"
                            ? "bg-blue-100 text-blue-700"
                            : "bg-amber-100 text-amber-700"
                      }`}
                    >
                      {proof.verifyMethod === "AUTO"
                        ? "Auto"
                        : proof.verifyMethod === "MANUAL_ADMIN"
                          ? "Admin"
                          : "Customer"}
                    </span>
                  )}
                </div>
                {proof.results && (
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    {[
                      ["URL Reachable", proof.results.urlReachable],
                      ["Link Found", proof.results.linkFound],
                      ["Target URL Matched", proof.results.targetUrlMatched],
                      ["Anchor Verified", proof.results.anchorVerified],
                    ].map(([label, ok]) => (
                      <div
                        key={label as string}
                        className="flex items-center gap-2"
                      >
                        {ok ? (
                          <CheckCircle className="h-4 w-4 text-green-600" />
                        ) : (
                          <XCircle className="h-4 w-4 text-muted-foreground" />
                        )}
                        <span className={ok ? "" : "text-muted-foreground"}>
                          {label}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground pt-2">
                  <span>Delivered by: {proof.deliveredBy}</span>
                  {proof.submittedAt && (
                    <span>
                      Submitted: {format(new Date(proof.submittedAt), "PPp")}
                    </span>
                  )}
                  {proof.verifiedAt && (
                    <span>
                      Verified: {format(new Date(proof.verifiedAt), "PPp")}
                    </span>
                  )}
                  {proof.results?.checkedAt && (
                    <span>
                      Checked:{" "}
                      {format(new Date(proof.results.checkedAt), "PPp")}
                    </span>
                  )}
                </div>
                {proof.screenshotUrl && (
                  <a
                    href={proof.screenshotUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-primary hover:underline"
                  >
                    View screenshot
                  </a>
                )}
              </CardContent>
            </Card>
          )}
          {(() => {
            const sc = order.submittedContent
            const hasContent = sc && (sc.deliverable || sc.brief)
            const pubs = (order.items ?? [])
              .flatMap((i: any) => i.publications ?? [])
              .filter((p: any) => p.publishedUrl)
            const files = (order.revisions ?? []).flatMap((r: any) =>
              fileEntries(r.files),
            )
            if (!hasContent && pubs.length === 0 && files.length === 0)
              return null
            return (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <FileText className="h-5 w-5" /> Submitted Content
                  </CardTitle>
                  <CardDescription>
                    What the publisher submitted for this order.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {hasContent && (
                    <div className="space-y-1.5">
                      {sc?.title && <p className="font-medium">{sc?.title}</p>}
                      <SubmittedContentBody
                        content={(sc?.deliverable || sc?.brief)!}
                      />
                    </div>
                  )}
                  {pubs.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-sm font-medium">Published links</p>
                      {pubs.map((p: any) => (
                        <div
                          key={p.id}
                          className="flex flex-col gap-1 rounded-lg border p-3"
                        >
                          <a
                            href={p.publishedUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 break-all text-sm font-medium text-primary hover:underline"
                          >
                            {p.publishedUrl}{" "}
                            <ExternalLink className="h-3 w-3 shrink-0" />
                          </a>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            {p.anchorText && (
                              <span>
                                Anchor:{" "}
                                <span className="text-foreground">
                                  {p.anchorText}
                                </span>
                              </span>
                            )}
                            {p.targetUrl && (
                              <span className="break-all">→ {p.targetUrl}</span>
                            )}
                            {p.publicationDate && (
                              <span>
                                {format(new Date(p.publicationDate), "PP")}
                              </span>
                            )}
                          </div>
                          {p.screenshotUrl && (
                            <a
                              href={p.screenshotUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-primary hover:underline"
                            >
                              View screenshot
                            </a>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {files.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-sm font-medium">Files</p>
                      <div className="flex flex-col gap-1">
                        {files.map((f, i) => (
                          <a
                            key={i}
                            href={f.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-2 text-sm text-primary hover:underline"
                          >
                            <FileText className="h-3.5 w-3.5 shrink-0" />{" "}
                            {f.name}
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )
          })()}

          {reviewable && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Star className="h-5 w-5" /> Your Review
                </CardTitle>
                <CardDescription>
                  Rate this order — your feedback shapes the publisher&apos;s
                  trust rating.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {existingReview ? (
                  <div className="space-y-1">
                    <div className="flex gap-0.5">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <Star
                          key={n}
                          className={`h-5 w-5 ${n <= existingReview.rating ? "fill-amber-400 text-amber-400" : "text-muted-foreground/30"}`}
                        />
                      ))}
                    </div>
                    {existingReview.comment && (
                      <p className="text-sm text-muted-foreground">
                        {existingReview.comment}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Submitted{" "}
                      {format(new Date(existingReview.createdAt), "PP")} — you
                      can update it by rating again.
                    </p>
                  </div>
                ) : null}
                <div className="flex gap-1">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setReviewRating(n)}
                      aria-label={`${n} star`}
                    >
                      <Star
                        className={`h-7 w-7 transition-colors ${n <= (reviewRating || existingReview?.rating || 0) ? "fill-amber-400 text-amber-400" : "text-muted-foreground/40 hover:text-amber-300"}`}
                      />
                    </button>
                  ))}
                </div>
                <Textarea
                  rows={3}
                  placeholder="Optional: how was the placement quality, communication, turnaround?"
                  value={reviewComment}
                  onChange={(e) => setReviewComment(e.target.value)}
                  maxLength={2000}
                />
                <Button
                  onClick={() => reviewMutation.mutate()}
                  disabled={
                    reviewMutation.isPending ||
                    (reviewRating === 0 && !existingReview)
                  }
                >
                  {reviewMutation.isPending
                    ? "Submitting..."
                    : existingReview
                      ? "Update Review"
                      : "Submit Review"}
                </Button>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Order Details</CardTitle>
              <CardDescription>Details of your order</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Service Type</p>
                  <p className="font-medium capitalize">
                    {order.items?.[0]?.serviceType
                      ?.replace(/_/g, " ")
                      .toLowerCase() ?? "—"}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Website</p>
                  <p className="font-medium">
                    {order.items?.[0]?.website?.url ? (
                      <a
                        href={order.items[0].website.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-primary hover:underline"
                      >
                        {new URL(order.items[0].website.url).hostname}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      "—"
                    )}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Topic / Title</p>
                  <p className="font-medium">
                    {order.items?.[0]?.topic || "—"}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Total Amount</p>
                  <p className="font-medium font-mono">
                    {order.totalAmount
                      ? `$${order.totalAmount.toFixed(2)}`
                      : "—"}
                  </p>
                </div>
              </div>

              {order.items?.[0]?.instructions && (
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Instructions</p>
                  <p className="whitespace-pre-wrap text-sm">
                    {order.items[0].instructions}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {(order.items?.[0]?.instructions || (order as any).briefData) && (
            <Card>
              <CardHeader>
                <CardTitle>Content Brief</CardTitle>
                <CardDescription>Original content requirements</CardDescription>
              </CardHeader>
              <CardContent>
                {/* Phase 7.9 #29 — adopt shared <BriefRenderer> (was: inline
                    instructions text). The component falls back to the
                    legacy single-string display when briefData is NULL,
                    so this is a no-regression swap for existing orders. */}
                <BriefRenderer
                  serviceType={
                    (order.items?.[0] as any)?.serviceType ??
                    (order as any).type
                  }
                  briefData={(order as any).briefData}
                  fallback={{
                    title: (order.items?.[0] as any)?.title,
                    instructions: order.items?.[0]?.instructions,
                    targetUrl: (order.items?.[0] as any)?.targetUrl,
                    anchorText: (order.items?.[0] as any)?.anchorText,
                  }}
                />
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Order Status</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3">
                <div
                  className={`flex h-12 w-12 items-center justify-center rounded-full ${VARIANT_CIRCLE_BG[getOrderStatusPresentation(order.status as OrderStatus).variant]}`}
                >
                  {(() => {
                    const Icon = currentStatusIcon
                    return Icon ? <Icon className="h-6 w-6" /> : null
                  })()}
                </div>
                <div>
                  <p className="font-medium">
                    {currentStatusConfig.description}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Updated{" "}
                    {formatDistanceToNow(new Date(order.updatedAt), {
                      addSuffix: true,
                    })}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Timeline</CardTitle>
              <CardDescription>Order history and updates</CardDescription>
            </CardHeader>
            <CardContent>
              <OrderTimeline events={order.events || []} />
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={showRevisionDialog} onOpenChange={setShowRevisionDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request Revision</DialogTitle>
            <DialogDescription>
              Describe the changes you&apos;d like to the delivered content
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="revision-message">Revision Details</Label>
            <Textarea
              id="revision-message"
              rows={4}
              value={revisionMessage}
              onChange={(e) => setRevisionMessage(e.target.value)}
              placeholder="Please describe the changes needed..."
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowRevisionDialog(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={() => requestRevisionMutation.mutate()}
              disabled={
                !revisionMessage.trim() || requestRevisionMutation.isPending
              }
            >
              {requestRevisionMutation.isPending
                ? "Submitting..."
                : "Submit Revision"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel Order</DialogTitle>
            <DialogDescription>
              {cancellationPreviewLoading
                ? "Checking this order's cancellation policy…"
                : (cancellationPreview?.message ??
                  "Cancellation is not available for this order.")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Reason</Label>
              <Select
                value={cancelReason}
                onValueChange={(value) =>
                  setCancelReason(value as CancellationReasonCode)
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="CUSTOMER_CHANGED_MIND">
                    Changed my mind
                  </SelectItem>
                  <SelectItem value="CAMPAIGN_CHANGED">
                    Campaign changed
                  </SelectItem>
                  <SelectItem value="DUPLICATE_ORDER">
                    Duplicate order
                  </SelectItem>
                  <SelectItem value="MISSED_DEADLINE">
                    Deadline missed
                  </SelectItem>
                  <SelectItem value="QUALITY_FAILURE">
                    Quality problem
                  </SelectItem>
                  <SelectItem value="OTHER">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="cancel-note">Details</Label>
              <Textarea
                id="cancel-note"
                rows={3}
                value={cancelNote}
                onChange={(event) => setCancelNote(event.target.value)}
                placeholder="Add context for the other party or reviewer"
                maxLength={2000}
              />
            </div>
            {cancellationPreview?.refund.type === "FULL" && (
              <p className="rounded-md bg-muted p-3 text-sm">
                Full refund: {cancellationPreview.refund.amount.toFixed(2)}{" "}
                {cancellationPreview.refund.currency} to your wallet.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowCancelDialog(false)}
            >
              Keep Order
            </Button>
            <Button
              variant="destructive"
              onClick={() => cancelMutation.mutate()}
              disabled={cancelMutation.isPending || cancellationPreviewLoading}
            >
              {cancelMutation.isPending
                ? "Submitting…"
                : cancellationPreview?.action === "REQUEST_CANCELLATION"
                  ? "Send Cancellation Request"
                  : "Cancel Order"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SupportPanel
        tickets={orderTickets}
        isLoading={ticketsLoading}
        onOpenNew={() => setShowSupportDialog(true)}
        linkHref={(ticketId) => `/dashboard/support/${ticketId}`}
        actorScope="customer"
      />

      <Dialog open={showSupportDialog} onOpenChange={setShowSupportDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Get help with this order</DialogTitle>
            <DialogDescription>
              Opens a support ticket linked to order #
              {resolvedParams.id.slice(0, 8)}. Our team replies in the ticket
              thread.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label htmlFor="support-subject">Subject</Label>
              <Input
                id="support-subject"
                value={supportSubject}
                onChange={(e) => setSupportSubject(e.target.value)}
                placeholder={`Help with order #${resolvedParams.id.slice(0, 8)}`}
                maxLength={200}
              />
            </div>
            <div>
              <Label htmlFor="support-message">How can we help?</Label>
              <Textarea
                id="support-message"
                rows={4}
                value={supportMessage}
                onChange={(e) => setSupportMessage(e.target.value)}
                placeholder="Describe your issue (at least 10 characters)..."
                maxLength={5000}
              />
            </div>
            <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              Never include passwords, API keys, full card numbers, or other
              sensitive credentials in a support ticket.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowSupportDialog(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={() => supportMutation.mutate()}
              disabled={
                supportMutation.isPending || supportMessage.trim().length < 10
              }
            >
              {supportMutation.isPending ? "Creating..." : "Create Ticket"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showDisputeDialog} onOpenChange={setShowDisputeDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Open a Dispute</DialogTitle>
            <DialogDescription>
              Tell us what went wrong with this order. Our team reviews every
              dispute — settlement to the publisher is paused while a dispute is
              active.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="Describe the issue (at least 10 characters)..."
            value={disputeReason}
            onChange={(e) => setDisputeReason(e.target.value)}
            rows={4}
            maxLength={2000}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDisputeDialog(false)}
            >
              Back
            </Button>
            <Button
              variant="destructive"
              onClick={() => disputeMutation.mutate()}
              disabled={
                disputeMutation.isPending || disputeReason.trim().length < 10
              }
            >
              {disputeMutation.isPending ? "Submitting..." : "Open Dispute"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// Phase 7.9 #29 — OrderSupportPanel (hand-rolled in-component fetch +
// filter + render) replaced by shared <SupportPanel> from @guestpost/ui.
// Parent now owns the fetch via useQuery; SupportPanel stays
// presentational. See adoption-regression spec in packages/ui for the
// guard that prevents reintroduction.
