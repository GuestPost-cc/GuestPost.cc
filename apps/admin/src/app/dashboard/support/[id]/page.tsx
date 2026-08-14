"use client"

import {
  type StaffTicketDetail,
  supportKeys,
  type TicketMessageDto,
  type TicketMessageVisibility,
} from "@guestpost/api-client"
import type { TicketStatus } from "@guestpost/shared"
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  FulfillmentChannelBadge,
  mergeSupportConversationPages,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  SupportComposer,
  SupportConversation,
} from "@guestpost/ui"
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query"
import { formatDistanceToNow } from "date-fns"
import {
  AlertCircle,
  ArrowLeft,
  ExternalLink,
  Info,
  RefreshCw,
} from "lucide-react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import { useRef, useState } from "react"
import { toast } from "sonner"
import {
  AdminPage,
  AdminPageHeader,
} from "../../../../components/admin-workspace"
import { api } from "../../../../lib/api"

function statusLabel(status: string): string {
  return status.replaceAll("_", " ").toLowerCase()
}

function timeline(
  ticket: StaffTicketDetail,
  pages: readonly StaffTicketDetail[],
): TicketMessageDto[] {
  const messages = mergeSupportConversationPages(pages)
  return ticket.openingMessage ? [ticket.openingMessage, ...messages] : messages
}

export default function AdminTicketDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const queryClient = useQueryClient()
  const ticketId = params.id
  const [replyContent, setReplyContent] = useState("")
  const [visibility, setVisibility] =
    useState<TicketMessageVisibility>("PUBLIC")
  const replyIntentId = useRef<string | null>(null)
  const detailKey = supportKeys.detail("admin", ticketId)
  const listKey = supportKeys.lists("admin")

  // One query owns the full cursor chain so invalidation refetches pages in
  // sequence and recalculates every boundary after a new reply arrives.
  const ticketQuery = useInfiniteQuery({
    queryKey: detailKey,
    queryFn: ({ pageParam }) =>
      api.admin.getTicketDetail(
        ticketId,
        pageParam ? { messageCursor: pageParam } : undefined,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.messagePage?.nextCursor ?? null,
    enabled: Boolean(ticketId),
  })

  const statusMutation = useMutation({
    mutationFn: (status: TicketStatus) =>
      api.admin.updateTicketStatus(ticketId, status),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: detailKey }),
        queryClient.invalidateQueries({ queryKey: listKey }),
      ])
      toast.success("Status updated")
    },
    onError: (error: Error) =>
      toast.error(error.message || "The ticket status could not be updated"),
  })

  const claimMutation = useMutation({
    mutationFn: () => api.admin.claimTicket(ticketId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: detailKey }),
        queryClient.invalidateQueries({ queryKey: listKey }),
      ])
      toast.success("Ticket claimed")
    },
    onError: (error: Error) =>
      toast.error(error.message || "The ticket could not be claimed"),
  })

  const replyMutation = useMutation({
    mutationFn: (input: {
      content: string
      clientMessageId: string
      visibility: TicketMessageVisibility
    }) => api.admin.addTicketMessage(ticketId, input),
    onSuccess: async (_, input) => {
      replyIntentId.current = null
      setReplyContent("")
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: detailKey }),
        queryClient.invalidateQueries({ queryKey: listKey }),
      ])
      toast.success(
        input.visibility === "INTERNAL"
          ? "Internal note added"
          : "Public reply sent",
      )
    },
  })

  if (ticketQuery.isLoading) {
    return (
      <div className="space-y-6" aria-busy="true">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-32 w-full" />
        <span className="sr-only">Loading support ticket</span>
      </div>
    )
  }

  if (ticketQuery.error && !ticketQuery.data?.pages[0]) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <AlertCircle
          className="mb-4 h-12 w-12 text-destructive"
          aria-hidden="true"
        />
        <h1 className="mb-2 text-xl font-semibold">Ticket unavailable</h1>
        <p className="mb-4 max-w-md text-muted-foreground">
          {(ticketQuery.error as Error)?.message ||
            "This ticket does not exist or is outside your support scope."}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button
            variant="outline"
            onClick={() => router.push("/dashboard/support")}
          >
            <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
            Support inbox
          </Button>
          <Button onClick={() => ticketQuery.refetch()}>
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
            Retry
          </Button>
        </div>
      </div>
    )
  }

  const ticket = ticketQuery.data?.pages[0]
  if (!ticket) return null
  const messages = timeline(ticket, ticketQuery.data?.pages ?? [ticket])
  const allowedVisibilities = ticket.capabilities.allowedVisibilities
  const effectiveVisibility = allowedVisibilities.includes(visibility)
    ? visibility
    : (allowedVisibilities[0] ?? "PUBLIC")
  const statusOptions = Array.from(
    new Set<TicketStatus>([
      ticket.status as TicketStatus,
      ...(ticket.capabilities.allowedStatuses as TicketStatus[]),
    ]),
  )
  const canWrite = allowedVisibilities.length > 0
  const readOnlyReason =
    ticket.capabilities.readOnlyReason ??
    (canWrite ? null : "This ticket is read-only for your current assignment.")

  return (
    <AdminPage className="max-w-5xl">
      <AdminPageHeader
        title="Support ticket"
        description="Review the complete conversation, party identity, visibility, and server-authorized next action."
        eyebrow="Support operations"
        icon={Info}
        actions={
          <div className="flex flex-wrap gap-2">
            {ticketQuery.data?.pages[0]?.capabilities.canClaim && (
              <Button
                size="sm"
                onClick={() => claimMutation.mutate()}
                disabled={claimMutation.isPending}
              >
                {claimMutation.isPending ? "Claiming…" : "Claim ticket"}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => ticketQuery.refetch()}
              disabled={ticketQuery.isFetching}
            >
              <RefreshCw
                className={`mr-2 h-4 w-4 ${ticketQuery.isFetching ? "animate-spin" : ""}`}
                aria-hidden="true"
              />
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={() => router.back()}>
              <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
              Back
            </Button>
          </div>
        }
      />

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle
                  dir="auto"
                  className="break-words text-xl [overflow-wrap:anywhere] [unicode-bidi:plaintext]"
                >
                  {ticket.subject}
                </CardTitle>
                <FulfillmentChannelBadge channel={ticket.fulfillmentChannel} />
              </div>
              <p className="text-sm text-muted-foreground">
                Requested by <strong>{ticket.requester.displayName}</strong> ·{" "}
                {formatDistanceToNow(new Date(ticket.createdAt), {
                  addSuffix: true,
                })}
              </p>
              {ticket.organization && (
                <p className="text-sm text-muted-foreground">
                  Organization: {ticket.organization.name}
                </p>
              )}
              {ticket.fulfillmentChannel === "PLATFORM" && (
                <p className="text-sm text-muted-foreground">
                  Assigned Operations:{" "}
                  {ticket.assignedTo?.displayName ?? "Unassigned"}
                </p>
              )}
              {ticket.fulfillmentChannel === "PUBLISHER" && (
                <p className="text-sm text-muted-foreground">
                  Assigned publisher:{" "}
                  {ticket.assignedPublisher?.displayName ?? "Unassigned"}
                </p>
              )}
              {ticket.order && (
                <Link
                  href={`/dashboard/orders/${ticket.order.id}`}
                  className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                >
                  Open order #{ticket.order.id.slice(0, 8)}
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              )}
            </div>

            <div className="w-full sm:w-56">
              <label
                htmlFor="support-status"
                className="mb-1 block text-sm font-medium"
              >
                Ticket status
              </label>
              <Select
                value={ticket.status}
                onValueChange={(next) => {
                  if (next !== ticket.status)
                    statusMutation.mutate(next as TicketStatus)
                }}
                disabled={
                  ticket.capabilities.allowedStatuses.length === 0 ||
                  statusMutation.isPending
                }
              >
                <SelectTrigger
                  id="support-status"
                  className="w-full capitalize"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {statusOptions.map((status) => (
                    <SelectItem
                      key={status}
                      value={status}
                      className="capitalize"
                    >
                      {statusLabel(status)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {ticket.capabilities.allowedStatuses.length === 0 &&
                readOnlyReason && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {readOnlyReason}
                  </p>
                )}
            </div>
          </div>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Conversation</CardTitle>
          <p className="text-sm text-muted-foreground">
            Public replies are visible to ticket participants. Internal notes
            remain staff-only.
          </p>
        </CardHeader>
        <CardContent>
          <SupportConversation
            messages={messages}
            hasOlderMessages={Boolean(ticketQuery.hasNextPage)}
            isLoadingOlderMessages={ticketQuery.isFetchingNextPage}
            onLoadOlderMessages={() => ticketQuery.fetchNextPage()}
            olderMessagesError={
              ticketQuery.isFetchNextPageError
                ? (ticketQuery.error as Error).message ||
                  "Older messages could not be loaded."
                : null
            }
            showRoleDetails
            emptyMessage="No conversation entries have been recorded."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Respond</CardTitle>
        </CardHeader>
        <CardContent>
          <SupportComposer
            content={replyContent}
            onContentChange={(content) => {
              setReplyContent(content)
              if (replyMutation.error) {
                replyIntentId.current = null
                replyMutation.reset()
              }
            }}
            onSubmit={() => {
              replyIntentId.current ??= crypto.randomUUID()
              replyMutation.mutate({
                content: replyContent.trim(),
                clientMessageId: replyIntentId.current,
                visibility: effectiveVisibility,
              })
            }}
            visibility={effectiveVisibility}
            onVisibilityChange={(nextVisibility) => {
              setVisibility(nextVisibility)
              if (replyMutation.error) {
                replyIntentId.current = null
                replyMutation.reset()
              }
            }}
            allowedVisibilities={allowedVisibilities}
            isPending={replyMutation.isPending}
            disabled={!canWrite}
            disabledReason={readOnlyReason}
            error={
              replyMutation.error
                ? (replyMutation.error as Error).message ||
                  "The message could not be sent. Your draft has been kept."
                : null
            }
            maxLength={10_000}
          />
        </CardContent>
      </Card>
    </AdminPage>
  )
}
