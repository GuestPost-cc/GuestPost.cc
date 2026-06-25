"use client"

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ErrorState,
  Label,
  Skeleton,
  Textarea,
} from "@guestpost/ui"
import { zodResolver } from "@hookform/resolvers/zod"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { format, formatDistanceToNow } from "date-fns"
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle,
  Clock,
  Loader2,
  Mail,
  MessageSquare,
  Send,
  User,
} from "lucide-react"
import Link from "next/link"
import { use } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"
import { api } from "../../../../lib/api"
import { useAuth } from "../../../../lib/auth"

interface TicketMessage {
  id: string
  content: string
  createdAt: string
  author: string
}

interface TicketDetail {
  id: string
  subject: string
  description?: string | null
  status: string
  // Phase 7.1 sibling fix — `priority` is not on the api-client TicketDetail
  // shape (audit §11 noted this as "pre-existing priority type drift").
  // Optional here so the cast resolves; UI already handles undefined via
  // `ticket.priority?.toLowerCase()`.
  priority?: string | null
  createdAt: string
  updatedAt: string
  order?: { id: string; title: string | null; status: string } | null
  messages: TicketMessage[]
}

const statusConfig: Record<
  string,
  { color: string; icon: React.ElementType; description: string }
> = {
  OPEN: {
    color: "bg-blue-100 text-blue-700",
    icon: AlertCircle,
    description: "Ticket is open and awaiting response",
  },
  IN_PROGRESS: {
    color: "bg-amber-100 text-amber-700",
    icon: Clock,
    description: "Our team is working on this",
  },
  WAITING_ON_CUSTOMER: {
    color: "bg-purple-100 text-purple-700",
    icon: Clock,
    description: "Waiting for your response",
  },
  RESOLVED: {
    color: "bg-green-100 text-green-700",
    icon: CheckCircle,
    description: "This issue has been resolved",
  },
  CLOSED: {
    color: "bg-gray-100 text-gray-500",
    icon: CheckCircle,
    description: "This ticket is closed",
  },
}

function TicketDetailSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Skeleton className="h-10 w-10" />
        <Skeleton className="h-8 w-64" />
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardContent className="pt-6">
              <Skeleton className="h-48 w-full" />
            </CardContent>
          </Card>
        </div>
        <Card>
          <CardContent className="pt-6">
            <Skeleton className="h-32 w-full" />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

export default function TicketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const resolvedParams = use(params)
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(
      z.object({
        content: z.string().min(1, "Message is required"),
      }),
    ),
    defaultValues: { content: "" },
  })

  const {
    data: ticket,
    isLoading,
    error,
    refetch,
  } = useQuery<TicketDetail>({
    queryKey: ["ticket", resolvedParams.id],
    // Phase 7.1 sibling fix — api-client TicketDetail diverges from this local
    // shape (audit §11 "pre-existing priority type drift"). Cast via unknown
    // per TS's own remediation; reconciling the two shapes is its own follow-up.
    queryFn: () =>
      api.support.getTicket(
        resolvedParams.id,
      ) as unknown as Promise<TicketDetail>,
  })

  const addMessageMutation = useMutation({
    mutationFn: (data: { content: string }) =>
      api.support.addMessage(resolvedParams.id, data),
    onSuccess: () => {
      toast.success("Reply sent successfully")
      queryClient.invalidateQueries({ queryKey: ["ticket", resolvedParams.id] })
      queryClient.invalidateQueries({ queryKey: ["tickets"] })
      reset()
    },
    onError: () => {
      toast.error("Failed to send reply")
    },
  })

  const updateStatusMutation = useMutation({
    mutationFn: (status: string) =>
      api.support.updateTicketStatus(resolvedParams.id, status as any),
    onSuccess: () => {
      toast.success("Ticket status updated")
      queryClient.invalidateQueries({ queryKey: ["ticket", resolvedParams.id] })
      queryClient.invalidateQueries({ queryKey: ["tickets"] })
    },
    onError: () => {
      toast.error("Failed to update status")
    },
  })

  const handleCloseTicket = () => {
    updateStatusMutation.mutate("CLOSED")
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/dashboard/support">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Support
          </Link>
        </Button>
        <TicketDetailSkeleton />
      </div>
    )
  }

  if (error) {
    return (
      <ErrorState
        title="Failed to load ticket"
        description={(error as Error).message}
        onRetry={() => refetch()}
      />
    )
  }

  if (!ticket) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <AlertCircle className="h-12 w-12 text-destructive" />
        <h2 className="mt-4 text-xl font-semibold">Ticket Not Found</h2>
        <p className="mt-2 text-muted-foreground">
          The ticket you&apos;re looking for doesn&apos;t exist or you
          don&apos;t have access to it.
        </p>
        <Button className="mt-4" asChild>
          <Link href="/dashboard/support">View All Tickets</Link>
        </Button>
      </div>
    )
  }

  const currentStatusConfig = statusConfig[ticket.status] || statusConfig.OPEN
  const StatusIcon = currentStatusConfig.icon

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/dashboard/support">
              <ArrowLeft className="h-5 w-5" />
            </Link>
          </Button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight">
                {ticket.subject}
              </h1>
              <Badge className={`${currentStatusConfig.color} capitalize`}>
                <StatusIcon className="mr-1 h-3 w-3" />
                {ticket.status.replace(/_/g, " ").toLowerCase()}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              #{ticket.id} • Created {format(new Date(ticket.createdAt), "PPp")}
            </p>
            {ticket.order && (
              <Link
                href={`/dashboard/orders/${ticket.order.id}`}
                className="mt-1 inline-flex items-center gap-1 text-sm text-primary hover:underline"
              >
                Order #{ticket.order.id.slice(0, 8)}
                {ticket.order.title ? ` — ${ticket.order.title}` : ""}
              </Link>
            )}
          </div>
        </div>

        {ticket.status !== "CLOSED" && ticket.status !== "RESOLVED" && (
          <Button
            variant="outline"
            onClick={handleCloseTicket}
            disabled={updateStatusMutation.isPending}
          >
            <CheckCircle className="mr-2 h-4 w-4" />
            Close Ticket
          </Button>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Conversation</CardTitle>
              <CardDescription>
                {ticket.messages.length} message
                {ticket.messages.length !== 1 ? "s" : ""}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Opening request (ticket body) always shown as the first post */}
              {ticket.description && (
                <div className="rounded-lg border bg-muted/30 p-4">
                  <p className="mb-1 text-xs font-medium text-muted-foreground">
                    Original request
                  </p>
                  <p className="whitespace-pre-wrap text-sm">
                    {ticket.description}
                  </p>
                </div>
              )}
              {ticket.messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-6 text-center">
                  <MessageSquare className="h-8 w-8 text-muted-foreground/50" />
                  <p className="mt-2 text-sm text-muted-foreground">
                    No replies yet — our team will respond here.
                  </p>
                </div>
              ) : (
                <div className="space-y-6">
                  {ticket.messages.map((message) => {
                    const isOwn = message.author === user?.email

                    return (
                      <div
                        key={message.id}
                        className={`flex gap-3 ${isOwn ? "flex-row-reverse" : ""}`}
                      >
                        <div
                          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
                            isOwn ? "bg-primary/10" : "bg-muted"
                          }`}
                        >
                          {isOwn ? (
                            <User className="h-5 w-5 text-primary" />
                          ) : (
                            <Mail className="h-5 w-5 text-muted-foreground" />
                          )}
                        </div>
                        <div
                          className={`flex flex-col gap-1 ${isOwn ? "items-end" : ""}`}
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">
                              {message.author}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {formatDistanceToNow(
                                new Date(message.createdAt),
                                { addSuffix: true },
                              )}
                            </span>
                          </div>
                          <div
                            className={`rounded-lg p-4 ${
                              isOwn
                                ? "bg-primary text-primary-foreground"
                                : "bg-muted"
                            }`}
                          >
                            <p className="whitespace-pre-wrap text-sm">
                              {message.content}
                            </p>
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {format(new Date(message.createdAt), "PPp")}
                          </span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {ticket.status !== "CLOSED" && ticket.status !== "RESOLVED" && (
                <div className="mt-6 border-t pt-6">
                  <form
                    onSubmit={handleSubmit((data) =>
                      addMessageMutation.mutate(data),
                    )}
                  >
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <Label htmlFor="reply">Your Reply</Label>
                        <Textarea
                          id="reply"
                          rows={4}
                          {...register("content")}
                          placeholder="Type your message here..."
                        />
                        {errors.content?.message && (
                          <p className="text-sm text-destructive">
                            {errors.content.message}
                          </p>
                        )}
                      </div>
                      <div className="flex justify-end">
                        <Button
                          type="submit"
                          disabled={addMessageMutation.isPending}
                        >
                          {addMessageMutation.isPending && (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          )}
                          <Send className="mr-2 h-4 w-4" />
                          Send Reply
                        </Button>
                      </div>
                    </div>
                  </form>
                </div>
              )}

              {(ticket.status === "CLOSED" || ticket.status === "RESOLVED") && (
                <div className="mt-6 border-t pt-6">
                  <div className="rounded-lg bg-muted/50 p-4 text-center">
                    <p className="text-sm text-muted-foreground">
                      This ticket is {ticket.status.toLowerCase()}.{" "}
                      <button
                        onClick={() => updateStatusMutation.mutate("OPEN")}
                        className="text-primary hover:underline"
                      >
                        Reopen ticket
                      </button>
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Ticket Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Status</p>
                <div className="flex items-center gap-2">
                  <Badge className={`${currentStatusConfig.color} capitalize`}>
                    {ticket.status.replace(/_/g, " ").toLowerCase()}
                  </Badge>
                </div>
              </div>

              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Priority</p>
                <p className="font-medium capitalize">
                  {ticket.priority?.toLowerCase() || "Not set"}
                </p>
              </div>

              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Created</p>
                <p className="font-medium">
                  {format(new Date(ticket.createdAt), "PPp")}
                </p>
              </div>

              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Last Updated</p>
                <p className="font-medium">
                  {formatDistanceToNow(new Date(ticket.updatedAt), {
                    addSuffix: true,
                  })}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Quick Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {ticket.status !== "CLOSED" && ticket.status !== "RESOLVED" && (
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={handleCloseTicket}
                  disabled={updateStatusMutation.isPending}
                >
                  <CheckCircle className="mr-2 h-4 w-4" />
                  Close Ticket
                </Button>
              )}
              <Button
                variant="outline"
                className="w-full justify-start"
                onClick={() => {
                  navigator.clipboard.writeText(window.location.href)
                  toast.success("Link copied to clipboard")
                }}
              >
                <LinkIcon className="mr-2 h-4 w-4" />
                Copy Ticket Link
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

function LinkIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  )
}
