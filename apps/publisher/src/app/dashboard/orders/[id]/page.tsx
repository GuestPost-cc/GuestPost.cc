"use client"

import { useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { useParams, useRouter } from "next/navigation"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../../../lib/api"
import { toast } from "sonner"
import Link from "next/link"
import {
  ArrowLeft,
  FileText,
  Upload,
  Clock,
  CheckCircle,
  XCircle,
  Send,
  ExternalLink,
  Download,
  MessageSquare,
  Paperclip,
  ChevronRight,
} from "lucide-react"
import { Button } from "@guestpost/ui"
import { Badge } from "@guestpost/ui"
import { ErrorState } from "@guestpost/ui"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@guestpost/ui"
import { Input } from "@guestpost/ui"
import { Label } from "@guestpost/ui"
import { Textarea } from "@guestpost/ui"
import { Skeleton } from "@guestpost/ui"
import { Separator } from "@guestpost/ui"

const statusConfig: Record<
  string,
  { label: string; icon: React.ElementType; color: string }
> = {
  ORDER_CREATED: { label: "Order Created", icon: Clock, color: "text-muted-foreground" },
  PAYMENT_RECEIVED: { label: "Payment Received", icon: CheckCircle, color: "text-emerald-500" },
  ASSIGNED: { label: "Assigned to Publisher", icon: CheckCircle, color: "text-blue-500" },
  CONTENT_SUBMITTED: { label: "Content Submitted", icon: FileText, color: "text-blue-500" },
  CONTENT_APPROVED: { label: "Content Approved", icon: CheckCircle, color: "text-emerald-500" },
  PUBLISHED: { label: "Published", icon: ExternalLink, color: "text-emerald-500" },
  VERIFIED: { label: "Verified", icon: CheckCircle, color: "text-emerald-500" },
  UNDER_REVIEW: { label: "Under Review", icon: Clock, color: "text-amber-500" },
  CANCELLED: { label: "Cancelled", icon: XCircle, color: "text-destructive" },
  REJECTED: { label: "Rejected", icon: XCircle, color: "text-destructive" },
}

function TimelineItem({
  event,
  isLast,
}: {
  event: { id: string; eventType: string; createdAt: string }
  isLast: boolean
}) {
  const config = statusConfig[event.eventType] || {
    label: event.eventType.replace(/_/g, " "),
    icon: Clock,
    color: "text-muted-foreground",
  }
  const Icon = config.icon

  return (
    <div className="flex gap-4">
      <div className="flex flex-col items-center">
        <div
          className={`flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 ${config.color}`}
        >
          <Icon className="h-4 w-4" />
        </div>
        {!isLast && <div className="h-full w-px bg-border" />}
      </div>
      <div className="flex-1 pb-6">
        <p className="font-medium">{config.label}</p>
        <p className="text-sm text-muted-foreground">
          {new Date(event.createdAt).toLocaleString()}
        </p>
      </div>
    </div>
  )
}

export default function OrderDetailPage() {
  const params = useParams()
  const router = useRouter()
  const orderId = params.id as string
  const queryClient = useQueryClient()
  const [attachments, setAttachments] = useState<File[]>([])
  const [publishedUrl, setPublishedUrl] = useState("")

  const contentSchema = z.object({
    content: z.string().min(1, "Content is required"),
  })

  type ContentFormData = z.infer<typeof contentSchema>

  const {
    register,
    handleSubmit: handleFormSubmit,
    formState: { errors },
    reset,
  } = useForm<ContentFormData>({
    resolver: zodResolver(contentSchema),
  })

  const { data: order, isLoading, error } = useQuery({
    queryKey: ["order", orderId],
    queryFn: () => api.orders.getById(orderId),
  })

  const { data: events = [], error: eventsError } = useQuery({
    queryKey: ["order-events", orderId],
    queryFn: () => api.orders.getEvents(orderId),
  })

  const acceptMutation = useMutation({
    mutationFn: () => api.orders.accept(orderId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["order", orderId] })
      toast.success("Order accepted")
    },
    onError: () => {
      toast.error("Failed to accept order")
    },
  })

  const markPublishedMutation = useMutation({
    mutationFn: (url: string) => api.orders.markPublished(orderId, url),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["order", orderId] })
      toast.success("Order marked as published")
    },
    onError: () => {
      toast.error("Failed to mark as published")
    },
  })

  const contentSubmitMutation = useMutation({
    mutationFn: async (data: ContentFormData) => {
      await api.orders.submitContent(orderId, data.content)
      await api.orders.markContentReady(orderId)
      await api.orders.submitForReview(orderId)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["order", orderId] })
      toast.success("Content submitted successfully")
      reset()
      setAttachments([])
    },
    onError: () => {
      toast.error("Failed to submit content")
    },
  })

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setAttachments(Array.from(e.target.files))
    }
  }

  const handleContentSubmit = (data: ContentFormData) => {
    contentSubmitMutation.mutate(data)
  }

  const orderError = error ?? eventsError
  if (orderError)
    return (
      <ErrorState
        title="Failed to load order"
        description={(orderError as Error).message}
        onRetry={() => queryClient.invalidateQueries({ queryKey: ["order", orderId] })}
      />
    )

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-64" />
        <Skeleton className="h-32" />
      </div>
    )
  }

  if (!order) {
    return (
      <ErrorState
        title="Order not found"
        description="The requested order could not be found."
      />
    )
  }

  const currentStatus = order.status
  const canAccept = currentStatus === "SUBMITTED"
  const canSubmitContent = currentStatus === "ACCEPTED" || currentStatus === "CONTENT_REQUESTED"
  const canMarkPublished = currentStatus === "APPROVED"

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/dashboard/orders">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="flex-1">
          <h1 className="text-3xl font-bold tracking-tight">Order Details</h1>
          <p className="text-sm text-muted-foreground">
            Order ID: <span className="font-mono">{order.id}</span>
          </p>
        </div>
        <Badge
          variant={
            currentStatus === "PUBLISHED" || currentStatus === "VERIFIED"
              ? "success"
              : currentStatus === "CONTENT_CREATION"
              ? "info"
              : "secondary"
          }
          className="text-sm"
        >
          {currentStatus.replace(/_/g, " ")}
        </Badge>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Order Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="text-sm text-muted-foreground">Service Type</p>
                  <p className="font-medium">
                    {order.items[0]?.serviceType?.replace(/_/g, " ") ?? "—"}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Website</p>
                  <a
                    href={`https://${order.items[0]?.website?.url}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 font-medium text-primary hover:underline"
                  >
                    {order.items[0]?.website?.url ?? "—"}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Topic</p>
                  <p className="font-medium">{order.items[0]?.topic ?? "—"}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Price</p>
                  <p className="font-medium">
                    {order.totalAmount
                      ? `$${Number(order.totalAmount).toFixed(2)}`
                      : order.items[0]?.budget
                      ? `$${Number(order.items[0].budget).toFixed(2)}`
                      : "—"}
                  </p>
                </div>
              </div>

              <Separator />

              <div>
                <p className="text-sm text-muted-foreground">Instructions</p>
                <p className="mt-1 text-sm">
                  {order.items[0]?.instructions ?? "No instructions provided"}
                </p>
              </div>
            </CardContent>
          </Card>

          {canAccept && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Accept Order</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="mb-4 text-sm text-muted-foreground">
                  Accept this order to start working on the content.
                </p>
                <Button
                  onClick={() => acceptMutation.mutate()}
                  disabled={acceptMutation.isPending}
                >
                  <CheckCircle className="mr-2 h-4 w-4" />
                  {acceptMutation.isPending ? "Accepting..." : "Accept Order"}
                </Button>
              </CardContent>
            </Card>
          )}

          {canSubmitContent && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileText className="h-4 w-4" />
                  Submit Content
                </CardTitle>
                <CardDescription>
                  Submit your guest post content for review
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="content">Content</Label>
                  <Textarea
                    id="content"
                    rows={10}
                    placeholder="Paste your article content here..."
                    {...register("content")}
                  />
                  {errors.content && <p className="text-sm text-destructive">{errors.content.message}</p>}
                </div>

                <div className="space-y-2">
                  <Label>Attachments</Label>
                  <div className="flex items-center gap-4">
                    <label className="flex h-10 cursor-pointer items-center gap-2 rounded-md border bg-background px-4 text-sm hover:bg-accent">
                      <Upload className="h-4 w-4" />
                      Upload Files
                      <input
                        type="file"
                        multiple
                        className="hidden"
                        onChange={handleFileChange}
                      />
                    </label>
                    {attachments.length > 0 && (
                      <span className="text-sm text-muted-foreground">
                        {attachments.length} file(s) selected
                      </span>
                    )}
                  </div>
                </div>

                <Button
                  onClick={handleFormSubmit(handleContentSubmit)}
                  disabled={contentSubmitMutation.isPending}
                >
                  {contentSubmitMutation.isPending ? "Submitting..." : "Submit for Review"}
                </Button>
              </CardContent>
            </Card>
          )}

          {canMarkPublished && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Mark as Published</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Confirm that the guest post has been published on the target website.
                </p>
                <div className="space-y-2">
                  <Label htmlFor="publishedUrl">Published URL</Label>
                  <Input
                    id="publishedUrl"
                    type="url"
                    placeholder="https://example.com/your-guest-post"
                    value={publishedUrl}
                    onChange={(e) => setPublishedUrl(e.target.value)}
                  />
                </div>
                <Button
                  onClick={() => markPublishedMutation.mutate(publishedUrl)}
                  disabled={markPublishedMutation.isPending || !publishedUrl}
                >
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Mark as Published
                </Button>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Timeline</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-0">
                {(events.length > 0 ? events : order.events).map(
                  (event: any, index: number) => (
                    <TimelineItem
                      key={event.id}
                      event={event}
                      isLast={
                        index ===
                        ((events.length > 0 ? events : order.events).length - 1)
                      }
                    />
                  )
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Quick Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Button variant="outline" className="w-full justify-start" asChild>
                <Link href={`/dashboard/support?new=true&subject=Order%20${orderId}`}>
                  <MessageSquare className="mr-2 h-4 w-4" />
                  Contact Support
                </Link>
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start"
                onClick={() => {
                  const invoice = {
                    orderId,
                    amount: order?.totalAmount,
                    date: order?.createdAt,
                  }
                  const blob = new Blob([JSON.stringify(invoice, null, 2)], { type: "application/json" })
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement("a")
                  a.href = url
                  a.download = `invoice-${orderId.slice(0, 8)}.json`
                  a.click()
                  URL.revokeObjectURL(url)
                  toast.success("Invoice downloaded")
                }}
              >
                <Download className="mr-2 h-4 w-4" />
                Download Invoice
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}