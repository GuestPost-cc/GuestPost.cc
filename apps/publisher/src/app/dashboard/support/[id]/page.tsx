"use client"

import {
  supportKeys,
  type TicketDetail,
  type TicketMessageDto,
} from "@guestpost/api-client"
import type { TicketStatus } from "@guestpost/shared"
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorState,
  getTicketStatusPresentation,
  mergeSupportConversationPages,
  Skeleton,
  StatusBadge,
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
  ArrowLeft,
  CheckCircle,
  ExternalLink,
  RefreshCw,
  RotateCcw,
} from "lucide-react"
import Link from "next/link"
import { use, useRef, useState } from "react"
import { toast } from "sonner"
import { api } from "../../../../lib/api"

function timeline(
  ticket: TicketDetail,
  pages: readonly TicketDetail[],
): TicketMessageDto[] {
  const messages = mergeSupportConversationPages(pages)
  return ticket.openingMessage ? [ticket.openingMessage, ...messages] : messages
}

export default function PublisherSupportTicketPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const queryClient = useQueryClient()
  const [replyContent, setReplyContent] = useState("")
  const replyIntentId = useRef<string | null>(null)
  const detailKey = supportKeys.detail("publisher", id)
  const listKey = supportKeys.lists("publisher")

  // One query owns the full cursor chain so invalidation refetches pages in
  // sequence and recalculates every boundary after a new reply arrives.
  const ticketQuery = useInfiniteQuery({
    queryKey: detailKey,
    queryFn: ({ pageParam }) =>
      api.support.getTicket(
        id,
        pageParam ? { messageCursor: pageParam } : undefined,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.messagePage?.nextCursor ?? null,
  })

  const replyMutation = useMutation({
    mutationFn: (input: { content: string; clientMessageId: string }) =>
      api.support.addMessage(id, {
        content: input.content,
        clientMessageId: input.clientMessageId,
        visibility: "PUBLIC",
      }),
    onSuccess: async () => {
      replyIntentId.current = null
      setReplyContent("")
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: detailKey }),
        queryClient.invalidateQueries({ queryKey: listKey }),
      ])
      toast.success("Reply sent")
    },
  })

  const statusMutation = useMutation({
    mutationFn: (status: "OPEN" | "CLOSED") =>
      api.support.updateTicketStatus(id, status),
    onSuccess: async (_, status) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: detailKey }),
        queryClient.invalidateQueries({ queryKey: listKey }),
      ])
      toast.success(status === "CLOSED" ? "Ticket closed" : "Ticket reopened")
    },
    onError: (error: Error) =>
      toast.error(error.message || "The ticket status could not be updated"),
  })

  if (ticketQuery.isLoading) {
    return (
      <div className="space-y-6" aria-busy="true">
        <Skeleton className="h-10 w-64 max-w-[80vw]" />
        <Skeleton className="h-80 w-full rounded-2xl" />
        <span className="sr-only">Loading support ticket</span>
      </div>
    )
  }

  if (ticketQuery.error && !ticketQuery.data?.pages[0]) {
    return (
      <ErrorState
        title="Failed to load support ticket"
        description={(ticketQuery.error as Error).message}
        onRetry={() => ticketQuery.refetch()}
      />
    )
  }

  const ticket = ticketQuery.data?.pages[0]
  if (!ticket) {
    return (
      <ErrorState
        title="Ticket not found"
        description="This ticket is not assigned to your publisher account or no longer exists."
      />
    )
  }

  const status = getTicketStatusPresentation(ticket.status as TicketStatus)
  const messages = timeline(ticket, ticketQuery.data?.pages ?? [ticket])
  const readOnlyReason =
    ticket.capabilities.readOnlyReason ??
    (ticket.capabilities.canReply
      ? null
      : "This conversation is read-only right now.")

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <Button variant="ghost" size="icon" asChild className="shrink-0">
            <Link
              href="/dashboard/support"
              aria-label="Back to Publisher support"
            >
              <ArrowLeft className="h-5 w-5" aria-hidden="true" />
            </Link>
          </Button>
          <div className="min-w-0">
            <p className="text-sm font-medium text-muted-foreground">
              Publisher support
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <h1
                dir="auto"
                className="break-words text-2xl font-bold tracking-tight [overflow-wrap:anywhere] [unicode-bidi:plaintext]"
              >
                {ticket.subject}
              </h1>
              <StatusBadge variant={status.variant}>{status.label}</StatusBadge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Updated{" "}
              {formatDistanceToNow(new Date(ticket.updatedAt), {
                addSuffix: true,
              })}
            </p>
            {ticket.order && (
              <Link
                href={`/dashboard/orders/${ticket.order.id}`}
                className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
              >
                Order #{ticket.order.id.slice(0, 8)}
                {ticket.order.title ? (
                  <>
                    {" — "}
                    <bdi className="break-words [overflow-wrap:anywhere]">
                      {ticket.order.title}
                    </bdi>
                  </>
                ) : null}
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2 sm:justify-end">
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
          {ticket.capabilities.canClose && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => statusMutation.mutate("CLOSED")}
              disabled={statusMutation.isPending}
            >
              <CheckCircle className="mr-2 h-4 w-4" aria-hidden="true" />
              Close ticket
            </Button>
          )}
          {ticket.capabilities.canReopen && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => statusMutation.mutate("OPEN")}
              disabled={statusMutation.isPending}
            >
              <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
              Reopen ticket
            </Button>
          )}
        </div>
      </header>

      <Card className="rounded-2xl shadow-sm">
        <CardHeader>
          <CardTitle>Conversation</CardTitle>
          <p className="text-sm text-muted-foreground">
            Customer-visible order support. Internal staff notes are never
            included here.
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
            emptyMessage="No public messages have been posted yet."
          />
        </CardContent>
      </Card>

      <Card className="rounded-2xl shadow-sm">
        <CardHeader>
          <CardTitle className="text-base">Reply to this thread</CardTitle>
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
              })
            }}
            allowedVisibilities={ticket.capabilities.canReply ? ["PUBLIC"] : []}
            isPending={replyMutation.isPending}
            disabled={!ticket.capabilities.canReply}
            disabledReason={readOnlyReason}
            error={
              replyMutation.error
                ? (replyMutation.error as Error).message ||
                  "The reply could not be sent. Your draft has been kept."
                : null
            }
            maxLength={10_000}
          />
        </CardContent>
      </Card>
    </div>
  )
}
