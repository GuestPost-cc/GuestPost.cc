"use client"

import { supportKeys } from "@guestpost/api-client"
import {
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
  getTicketStatusPresentation,
  Input,
  Label,
  mergeSupportTicketPages,
  Skeleton,
  StatusBadge,
  Textarea,
} from "@guestpost/ui"
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query"
import { formatDistanceToNow } from "date-fns"
import {
  ArrowRight,
  LifeBuoy,
  MessageSquarePlus,
  RefreshCw,
} from "lucide-react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Suspense, useRef, useState } from "react"
import { toast } from "sonner"
import { api } from "../../../lib/api"

function SupportSkeleton() {
  return (
    <div className="space-y-3">
      {[1, 2, 3].map((item) => (
        <Skeleton key={item} className="h-24 w-full rounded-2xl" />
      ))}
    </div>
  )
}

function SupportContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const queryClient = useQueryClient()
  const orderId = searchParams.get("orderId") ?? undefined
  const [open, setOpen] = useState(
    Boolean(orderId && searchParams.get("new") === "true"),
  )
  const [subject, setSubject] = useState(orderId ? "Help with this order" : "")
  const [message, setMessage] = useState("")
  const createIntentId = useRef<string | null>(null)

  const ticketsQuery = useInfiniteQuery({
    queryKey: supportKeys.list("publisher", { orderId, limit: 50 }),
    queryFn: ({ pageParam }) =>
      api.support.listTickets({
        orderId,
        cursor: pageParam ?? undefined,
        limit: 50,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  })
  const createTicket = useMutation({
    mutationFn: () =>
      api.support.createTicket({
        subject: subject.trim(),
        message: message.trim(),
        clientRequestId: (createIntentId.current ??= crypto.randomUUID()),
        orderId,
      }),
    onSuccess: (ticket) => {
      createIntentId.current = null
      toast.success("Support ticket created")
      setOpen(false)
      setSubject("")
      setMessage("")
      queryClient.invalidateQueries({
        queryKey: supportKeys.lists("publisher"),
      })
      router.push(`/dashboard/support/${ticket.id}`)
    },
    onError: (error: Error) =>
      toast.error(error.message || "Failed to create support ticket"),
  })

  const tickets = mergeSupportTicketPages(ticketsQuery.data?.pages)

  if (ticketsQuery.error && tickets.length === 0) {
    return (
      <ErrorState
        title="Failed to load support"
        description={(ticketsQuery.error as Error).message}
        onRetry={() => ticketsQuery.refetch()}
      />
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm font-medium text-muted-foreground">
            Publisher support
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight sm:text-4xl">
            Get help
          </h1>
          <p className="mt-2 text-sm text-muted-foreground sm:text-base">
            Read and reply to customer order-support threads. New publisher
            requests must start from the relevant order.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => ticketsQuery.refetch()}
            disabled={ticketsQuery.isFetching}
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${ticketsQuery.isFetching && !ticketsQuery.isFetchingNextPage ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
          {orderId && (
            <Button onClick={() => setOpen(true)}>
              <MessageSquarePlus className="mr-2 h-4 w-4" /> Open order ticket
            </Button>
          )}
        </div>
      </div>

      <Card className="rounded-2xl shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Assigned support threads</CardTitle>
          <CardDescription>
            {tickets.length} loaded customer thread
            {tickets.length === 1 ? "" : "s"}, limited to orders assigned to
            your publisher account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {ticketsQuery.isLoading ? (
            <SupportSkeleton />
          ) : tickets.length > 0 ? (
            <div className="divide-y rounded-xl border">
              {tickets.map((ticket) => {
                const status = getTicketStatusPresentation(ticket.status)
                return (
                  <Link
                    key={ticket.id}
                    href={`/dashboard/support/${ticket.id}`}
                    className="flex flex-col gap-3 p-4 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p
                          dir="auto"
                          className="truncate text-sm font-semibold [unicode-bidi:plaintext]"
                        >
                          {ticket.subject}
                        </p>
                        <StatusBadge variant={status.variant}>
                          {status.label}
                        </StatusBadge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Updated{" "}
                        {formatDistanceToNow(new Date(ticket.updatedAt), {
                          addSuffix: true,
                        })}
                        {ticket.order
                          ? ` · Order #${ticket.order.id.slice(0, 8)}`
                          : ""}
                      </p>
                    </div>
                    <span className="inline-flex items-center gap-1 text-sm font-medium text-primary">
                      View thread
                      <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    </span>
                  </Link>
                )
              })}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-14 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                <LifeBuoy className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="mt-4 font-semibold">No support requests</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Customer order-support threads assigned to you will appear here.
              </p>
            </div>
          )}
          {ticketsQuery.hasNextPage && (
            <div className="mt-4 flex justify-center border-t pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => ticketsQuery.fetchNextPage()}
                disabled={ticketsQuery.isFetchingNextPage}
              >
                {ticketsQuery.isFetchingNextPage
                  ? "Loading more…"
                  : "Load more tickets"}
              </Button>
            </div>
          )}
          {ticketsQuery.error && tickets.length > 0 && (
            <p
              role="alert"
              className="mt-3 text-center text-sm text-destructive"
            >
              {(ticketsQuery.error as Error).message ||
                "More tickets could not be loaded."}
            </p>
          )}
        </CardContent>
      </Card>

      {orderId && (
        <Dialog
          open={open}
          onOpenChange={(nextOpen) => {
            if (!nextOpen && createTicket.isPending) return
            if (!nextOpen) {
              createIntentId.current = null
              createTicket.reset()
            }
            setOpen(nextOpen)
          }}
        >
          <DialogContent>
            <form
              onSubmit={(event) => {
                event.preventDefault()
                createTicket.mutate()
              }}
            >
              <DialogHeader>
                <DialogTitle>Open order support ticket</DialogTitle>
                <DialogDescription>
                  Describe the order blocker. Never include passwords, API keys,
                  or full payout credentials.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="support-subject">Subject</Label>
                  <Input
                    id="support-subject"
                    value={subject}
                    onChange={(event) => {
                      setSubject(event.target.value)
                      createIntentId.current = null
                      if (createTicket.error) createTicket.reset()
                    }}
                    maxLength={200}
                    placeholder="What is blocking this order?"
                    required
                    dir="auto"
                    className="[unicode-bidi:plaintext]"
                    disabled={createTicket.isPending}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="support-message">Details</Label>
                  <Textarea
                    id="support-message"
                    value={message}
                    onChange={(event) => {
                      setMessage(event.target.value)
                      createIntentId.current = null
                      if (createTicket.error) createTicket.reset()
                    }}
                    rows={7}
                    maxLength={10_000}
                    placeholder="Include the order context and what is blocking you."
                    required
                    dir="auto"
                    className="[unicode-bidi:plaintext]"
                    disabled={createTicket.isPending}
                  />
                  <p className="text-right text-xs text-muted-foreground tabular-nums">
                    {message.length.toLocaleString()} / 10,000
                  </p>
                </div>
                <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                  This request will be linked to order #{orderId.slice(0, 8)}.
                  Access and routing are verified by the server. Public messages
                  are visible to the customer organization and authorized
                  support staff.
                </p>
                {createTicket.error && (
                  <p role="alert" className="text-sm text-destructive">
                    {(createTicket.error as Error).message ||
                      "The support ticket could not be created."}
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    createIntentId.current = null
                    createTicket.reset()
                    setOpen(false)
                  }}
                  disabled={createTicket.isPending}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={
                    createTicket.isPending ||
                    subject.trim().length < 3 ||
                    message.trim().length < 10
                  }
                >
                  {createTicket.isPending ? "Creating…" : "Create ticket"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

export default function SupportPage() {
  return (
    <Suspense fallback={<SupportSkeleton />}>
      <SupportContent />
    </Suspense>
  )
}
