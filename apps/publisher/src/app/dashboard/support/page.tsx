"use client"

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
  Skeleton,
  StatusBadge,
  Textarea,
} from "@guestpost/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { formatDistanceToNow } from "date-fns"
import { LifeBuoy, MessageSquarePlus, RefreshCw } from "lucide-react"
import { useSearchParams } from "next/navigation"
import { Suspense, useState } from "react"
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
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(searchParams.get("new") === "true")
  const [subject, setSubject] = useState(searchParams.get("subject") ?? "")
  const [message, setMessage] = useState("")
  const orderId = searchParams.get("orderId") ?? undefined

  const ticketsQuery = useQuery({
    queryKey: ["publisher-support-tickets"],
    queryFn: () => api.support.listTickets(),
  })
  const createTicket = useMutation({
    mutationFn: () =>
      api.support.createTicket({
        subject: subject.trim(),
        message: message.trim(),
        orderId,
      }),
    onSuccess: () => {
      toast.success("Support ticket created")
      setOpen(false)
      setSubject("")
      setMessage("")
      queryClient.invalidateQueries({ queryKey: ["publisher-support-tickets"] })
    },
    onError: (error: Error) =>
      toast.error(error.message || "Failed to create support ticket"),
  })

  if (ticketsQuery.error) {
    return (
      <ErrorState
        title="Failed to load support"
        description={(ticketsQuery.error as Error).message}
        onRetry={() => ticketsQuery.refetch()}
      />
    )
  }

  const tickets = ticketsQuery.data ?? []

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
            Open an order-linked request without sharing account or payment
            credentials.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => ticketsQuery.refetch()}
            disabled={ticketsQuery.isFetching}
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${ticketsQuery.isFetching ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
          <Button onClick={() => setOpen(true)}>
            <MessageSquarePlus className="mr-2 h-4 w-4" /> Open ticket
          </Button>
        </div>
      </div>

      <Card className="rounded-2xl shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Your support requests</CardTitle>
          <CardDescription>
            Ticket visibility is scoped to your authenticated publisher account.
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
                  <div
                    key={ticket.id}
                    className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-semibold">
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
                  </div>
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
                If an order is blocked, open a ticket from its order workspace.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Open support ticket</DialogTitle>
            <DialogDescription>
              Describe the blocker. Never include passwords, API keys, or full
              payout credentials.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="support-subject">Subject</Label>
              <Input
                id="support-subject"
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                maxLength={160}
                placeholder="What do you need help with?"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="support-message">Details</Label>
              <Textarea
                id="support-message"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                rows={7}
                maxLength={5000}
                placeholder="Include the order context and what is blocking you."
              />
            </div>
            {orderId && (
              <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                This request will be linked to order #{orderId.slice(0, 8)}.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createTicket.mutate()}
              disabled={
                createTicket.isPending ||
                subject.trim().length < 3 ||
                message.trim().length < 10
              }
            >
              {createTicket.isPending ? "Creating…" : "Create ticket"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
