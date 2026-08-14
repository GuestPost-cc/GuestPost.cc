"use client"

import { supportKeys } from "@guestpost/api-client"
import type { TicketStatus } from "@guestpost/shared"
import {
  Badge,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea,
} from "@guestpost/ui"
import { zodResolver } from "@hookform/resolvers/zod"
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query"
import { formatDistanceToNow } from "date-fns"
import {
  AlertCircle,
  CheckCircle,
  Clock,
  Eye,
  HeadphonesIcon,
  Plus,
  Search,
  ShieldAlert,
} from "lucide-react"
import Link from "next/link"
import { useRef, useState } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"
import { api } from "../../../lib/api"

const createTicketSchema = z.object({
  subject: z
    .string()
    .trim()
    .min(3, "Subject must be at least 3 characters")
    .max(200),
  message: z
    .string()
    .trim()
    .min(10, "Message must be at least 10 characters")
    .max(10_000),
})

type CreateTicketForm = z.infer<typeof createTicketSchema>

// Phase 7.9 #28 — color + label live in @guestpost/ui's STATUS_PRESENTATION
// (see getTicketStatusPresentation). This local map only keeps the page-
// specific icon choice. Per the table's header: icons stay local.
const ticketIcon: Record<TicketStatus, React.ElementType> = {
  OPEN: AlertCircle,
  IN_PROGRESS: Clock,
  WAITING_ON_CUSTOMER: Clock,
  RESOLVED: CheckCircle,
  CLOSED: CheckCircle,
}
const VARIANT_CIRCLE_BG: Record<string, string> = {
  default: "bg-primary/10 text-primary",
  success: "bg-emerald-100 text-emerald-700",
  warning: "bg-amber-100 text-amber-700",
  destructive: "bg-red-100 text-red-700",
  info: "bg-blue-100 text-blue-700",
  pending: "bg-gray-100 text-gray-700",
}

function TicketsTableSkeleton() {
  return (
    <div className="space-y-3">
      {[...Array(5)].map((_, i) => (
        <div key={i} className="flex items-center gap-4 rounded-lg border p-4">
          <Skeleton className="h-8 w-8 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-6 w-20 rounded-full" />
          <Skeleton className="h-8 w-8" />
        </div>
      ))}
    </div>
  )
}

function CreateTicketDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const createIntentId = useRef<string | null>(null)
  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
    watch,
  } = useForm<CreateTicketForm>({
    resolver: zodResolver(createTicketSchema),
  })
  const messageLength = (watch("message") ?? "").length

  const createMutation = useMutation({
    mutationFn: (data: { subject: string; message: string }) =>
      api.support.createTicket({
        ...data,
        clientRequestId: (createIntentId.current ??= crypto.randomUUID()),
      }),
    onSuccess: () => {
      createIntentId.current = null
      toast.success("Support ticket created successfully")
      queryClient.invalidateQueries({
        queryKey: supportKeys.lists("customer"),
      })
      onOpenChange(false)
      reset()
    },
    onError: () => {
      toast.error("Failed to create support ticket")
    },
  })

  const onSubmit = (data: CreateTicketForm) => {
    createMutation.mutate({
      subject: data.subject,
      message: data.message,
    })
  }

  const resetIntentAfterEdit = () => {
    createIntentId.current = null
    if (createMutation.error) createMutation.reset()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && createMutation.isPending) return
        if (!nextOpen) {
          createIntentId.current = null
          createMutation.reset()
          reset()
        }
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Create Support Ticket</DialogTitle>
          <DialogDescription>
            Submit a support request and our team will get back to you shortly
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="subject">Subject *</Label>
            <Input
              id="subject"
              {...register("subject", { onChange: resetIntentAfterEdit })}
              maxLength={200}
              placeholder="Brief description of your issue"
              dir="auto"
              className="[unicode-bidi:plaintext]"
              disabled={createMutation.isPending}
            />
            {errors.subject && (
              <p className="text-sm text-destructive">
                {errors.subject.message}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="message">Message *</Label>
            <Textarea
              id="message"
              rows={6}
              {...register("message", { onChange: resetIntentAfterEdit })}
              maxLength={10_000}
              placeholder="Describe your issue in detail..."
              dir="auto"
              className="[unicode-bidi:plaintext]"
              disabled={createMutation.isPending}
            />
            <p className="text-right text-xs tabular-nums text-muted-foreground">
              {messageLength.toLocaleString()} / 10,000
            </p>
            {errors.message && (
              <p className="text-sm text-destructive">
                {errors.message.message}
              </p>
            )}
          </div>

          <div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              Never include passwords, API keys, full card numbers, or other
              sensitive credentials in a support ticket.
            </p>
          </div>

          {createMutation.error && (
            <p role="alert" className="text-sm text-destructive">
              {(createMutation.error as Error).message ||
                "The support ticket could not be created."}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                createIntentId.current = null
                createMutation.reset()
                reset()
                onOpenChange(false)
              }}
              disabled={createMutation.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? "Creating…" : "Create Ticket"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default function SupportPage() {
  const [showCreateTicket, setShowCreateTicket] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState("")

  const ticketsQuery = useInfiniteQuery({
    queryKey: supportKeys.list("customer", { limit: 50 }),
    queryFn: ({ pageParam }) =>
      api.support.listTickets({
        cursor: pageParam ?? undefined,
        limit: 50,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  })
  const ticketsData = mergeSupportTicketPages(ticketsQuery.data?.pages)

  const filteredTickets = (ticketsData ?? [])
    .filter((ticket) => {
      if (
        statusFilter &&
        statusFilter !== "all" &&
        ticket.status !== statusFilter
      )
        return false
      if (searchQuery) {
        const query = searchQuery.toLowerCase()
        return (
          ticket.subject.toLowerCase().includes(query) ||
          ticket.id.toLowerCase().includes(query) ||
          ticket.order?.id.toLowerCase().includes(query)
        )
      }
      return true
    })
    .sort((left, right) => {
      const leftNeedsReply = left.status === "WAITING_ON_CUSTOMER" ? 0 : 1
      const rightNeedsReply = right.status === "WAITING_ON_CUSTOMER" ? 0 : 1
      if (leftNeedsReply !== rightNeedsReply)
        return leftNeedsReply - rightNeedsReply
      return (
        new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
      )
    })

  const openTickets = (ticketsData ?? []).filter((ticket) =>
    ["OPEN", "IN_PROGRESS"].includes(ticket.status),
  ).length
  const waitingTickets = (ticketsData ?? []).filter(
    (ticket) => ticket.status === "WAITING_ON_CUSTOMER",
  ).length

  if (ticketsQuery.error && ticketsData.length === 0)
    return (
      <ErrorState
        title="Failed to load support tickets"
        description={(ticketsQuery.error as Error).message}
        onRetry={() => ticketsQuery.refetch()}
      />
    )

  if (ticketsQuery.isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Support</h1>
            <p className="text-muted-foreground">Get help with your orders</p>
          </div>
        </div>
        <div className="grid gap-6 md:grid-cols-3">
          <Card className="rounded-2xl shadow-sm">
            <CardContent className="pt-6">
              <Skeleton className="h-16 w-full" />
            </CardContent>
          </Card>
          <Card className="rounded-2xl shadow-sm">
            <CardContent className="pt-6">
              <Skeleton className="h-16 w-full" />
            </CardContent>
          </Card>
          <Card className="rounded-2xl shadow-sm">
            <CardContent className="pt-6">
              <Skeleton className="h-16 w-full" />
            </CardContent>
          </Card>
        </div>
        <Card className="rounded-2xl shadow-sm">
          <CardHeader>
            <Skeleton className="h-6 w-32" />
          </CardHeader>
          <CardContent>
            <TicketsTableSkeleton />
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Support</h1>
          <p className="text-muted-foreground">Get help with your orders</p>
        </div>
        <Button onClick={() => setShowCreateTicket(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New Ticket
        </Button>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <Card className="rounded-2xl shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Loaded waiting on you
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-amber-700">
              {waitingTickets}
            </div>
          </CardContent>
        </Card>
        <Card className="rounded-2xl shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Loaded open tickets
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{openTickets}</div>
          </CardContent>
        </Card>
        <Card className="rounded-2xl shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Loaded resolved
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {
                ticketsData.filter(
                  (ticket) =>
                    ticket.status === "RESOLVED" || ticket.status === "CLOSED",
                ).length
              }
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="rounded-2xl shadow-sm">
        <CardHeader className="pb-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>Your Tickets</CardTitle>
              <CardDescription>
                {filteredTickets.length} matching of {ticketsData.length}{" "}
                loaded. Search and counts cover loaded tickets.
              </CardDescription>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label="Search support tickets"
                  placeholder="Search tickets..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9 w-64"
                />
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger
                  className="w-full sm:w-40"
                  aria-label="Filter tickets by status"
                >
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="OPEN">Open</SelectItem>
                  <SelectItem value="IN_PROGRESS">In Progress</SelectItem>
                  <SelectItem value="WAITING_ON_CUSTOMER">Waiting</SelectItem>
                  <SelectItem value="RESOLVED">Resolved</SelectItem>
                  <SelectItem value="CLOSED">Closed</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {filteredTickets.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <HeadphonesIcon className="h-12 w-12 text-muted-foreground/50" />
              <h3 className="mt-4 text-lg font-medium">No tickets found</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {searchQuery || (statusFilter && statusFilter !== "all")
                  ? "Try adjusting your filters"
                  : "Create a ticket to get support"}
              </p>
              {!searchQuery && (!statusFilter || statusFilter === "all") && (
                <Button
                  className="mt-4"
                  onClick={() => setShowCreateTicket(true)}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  New Ticket
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {filteredTickets.map((ticket) => {
                const p = getTicketStatusPresentation(
                  ticket.status as TicketStatus,
                )
                const StatusIcon =
                  ticketIcon[ticket.status as TicketStatus] || AlertCircle

                return (
                  <div
                    key={ticket.id}
                    className="flex flex-col justify-between gap-3 rounded-2xl border p-4 transition-colors hover:bg-muted/50 sm:flex-row sm:items-center"
                  >
                    <div className="flex items-center gap-4">
                      <div
                        className={`flex h-10 w-10 items-center justify-center rounded-full ${VARIANT_CIRCLE_BG[p.variant]}`}
                      >
                        <StatusIcon className="h-5 w-5" />
                      </div>
                      <div>
                        <p
                          dir="auto"
                          className="break-words font-medium [overflow-wrap:anywhere] [unicode-bidi:plaintext]"
                        >
                          {ticket.subject}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <span className="text-sm text-muted-foreground">
                            #{ticket.id.slice(0, 8)}
                          </span>
                          <span className="text-sm text-muted-foreground">
                            •
                          </span>
                          <span className="text-sm text-muted-foreground">
                            {formatDistanceToNow(new Date(ticket.createdAt), {
                              addSuffix: true,
                            })}
                          </span>
                          {ticket.order ? (
                            <>
                              <span className="text-sm text-muted-foreground">
                                •
                              </span>
                              <Link
                                href={`/dashboard/orders/${ticket.order.id}`}
                                className="text-sm font-medium text-primary hover:underline"
                              >
                                Order #{ticket.order.id.slice(0, 8)}
                              </Link>
                            </>
                          ) : null}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <Badge className={VARIANT_CIRCLE_BG[p.variant]}>
                        {p.label}
                      </Badge>
                      <Button variant="ghost" size="icon" asChild>
                        <Link
                          href={`/dashboard/support/${ticket.id}`}
                          aria-label={`View support ticket ${ticket.subject}`}
                        >
                          <Eye className="h-4 w-4" />
                        </Link>
                      </Button>
                    </div>
                  </div>
                )
              })}
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
          {ticketsQuery.error && ticketsData.length > 0 && (
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

      <Card className="rounded-2xl shadow-sm">
        <CardHeader>
          <CardTitle>FAQ</CardTitle>
          <CardDescription>Frequently asked questions</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border p-4">
            <h4 className="font-medium">How long does a guest post take?</h4>
            <p className="mt-1 text-sm text-muted-foreground">
              Guest posts typically take 5-14 days from order to publication,
              depending on the publisher&apos;s schedule and content
              requirements.
            </p>
          </div>
          <div className="rounded-lg border p-4">
            <h4 className="font-medium">What is your revision policy?</h4>
            <p className="mt-1 text-sm text-muted-foreground">
              We offer up to 2 rounds of revisions per order. Additional
              revisions may incur extra charges depending on the scope of
              changes.
            </p>
          </div>
          <div className="rounded-lg border p-4">
            <h4 className="font-medium">How do I track my order?</h4>
            <p className="mt-1 text-sm text-muted-foreground">
              You can track all your orders in the Orders section of your
              dashboard. You&apos;ll also receive email updates at each status
              change.
            </p>
          </div>
        </CardContent>
      </Card>

      <CreateTicketDialog
        open={showCreateTicket}
        onOpenChange={setShowCreateTicket}
      />
    </div>
  )
}
