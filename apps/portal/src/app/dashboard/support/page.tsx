"use client"

import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../../lib/api"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@guestpost/ui"
import { Button } from "@guestpost/ui"
import { Input } from "@guestpost/ui"
import { Label } from "@guestpost/ui"
import { Textarea } from "@guestpost/ui"
import { Badge, getTicketStatusPresentation } from "@guestpost/ui"
import type { TicketStatus } from "@guestpost/database"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@guestpost/ui"
import { Skeleton, ErrorState } from "@guestpost/ui"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@guestpost/ui"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@guestpost/ui"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@guestpost/ui"
import {
  HeadphonesIcon,
  Plus,
  MoreHorizontal,
  MessageSquare,
  Clock,
  CheckCircle,
  AlertCircle,
  Search,
  Eye,
  Send,
} from "lucide-react"
import { format, formatDistanceToNow } from "date-fns"
import { toast } from "sonner"
import { useForm } from "react-hook-form"
import { z } from "zod"
import { zodResolver } from "@hookform/resolvers/zod"
import Link from "next/link"

const createTicketSchema = z.object({
  subject: z.string().min(1, "Subject is required").max(200),
  message: z.string().min(10, "Message must be at least 10 characters").max(5000),
  priority: z.string().optional(),
})

type CreateTicketForm = z.infer<typeof createTicketSchema>

interface Ticket {
  id: string
  subject: string
  status: string
  priority?: string
  createdAt: string
  updatedAt: string
  messages?: Array<{
    id: string
    content: string
    author: string
    createdAt: string
  }>
}

// Phase 7.9 #28 — color + label live in @guestpost/ui's STATUS_PRESENTATION
// (see getTicketStatusPresentation). This local map only keeps the page-
// specific icon choice. Per the table's header: icons stay local.
const ticketIcon: Record<TicketStatus, React.ElementType> = {
  OPEN:                AlertCircle,
  IN_PROGRESS:         Clock,
  WAITING_ON_CUSTOMER: Clock,
  RESOLVED:            CheckCircle,
  CLOSED:              CheckCircle,
}
const VARIANT_CIRCLE_BG: Record<string, string> = {
  default:     "bg-primary/10 text-primary",
  success:     "bg-emerald-100 text-emerald-700",
  warning:     "bg-amber-100 text-amber-700",
  destructive: "bg-red-100 text-red-700",
  info:        "bg-blue-100 text-blue-700",
  pending:     "bg-gray-100 text-gray-700",
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
  const { register, handleSubmit, formState: { errors, isSubmitting }, reset, watch, setValue } = useForm<CreateTicketForm>({
    resolver: zodResolver(createTicketSchema),
  })

  const createMutation = useMutation({
    mutationFn: (data: { subject: string; message: string; priority?: string }) => 
      api.support.createTicket(data),
    onSuccess: () => {
      toast.success("Support ticket created successfully")
      queryClient.invalidateQueries({ queryKey: ["tickets"] })
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
      priority: data.priority,
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
              {...register("subject")}
              placeholder="Brief description of your issue"
            />
            {errors.subject && (
              <p className="text-sm text-destructive">{errors.subject.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="message">Message *</Label>
            <Textarea
              id="message"
              rows={6}
              {...register("message")}
              placeholder="Describe your issue in detail..."
            />
            {errors.message && (
              <p className="text-sm text-destructive">{errors.message.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="priority">Priority (Optional)</Label>
            <Select
              value={watch("priority") || ""}
              onValueChange={(value) => setValue("priority", value)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select priority" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="LOW">Low</SelectItem>
                <SelectItem value="MEDIUM">Medium</SelectItem>
                <SelectItem value="HIGH">High</SelectItem>
                <SelectItem value="URGENT">Urgent</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Creating..." : "Create Ticket"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default function SupportPage() {
  const queryClient = useQueryClient()
  const [showCreateTicket, setShowCreateTicket] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState("")

  const { data: ticketsData, isLoading, error, refetch } = useQuery<Ticket[]>({
    queryKey: ["tickets"],
    queryFn: () => api.support.listTickets() as Promise<Ticket[]>,
  })

  const filteredTickets = (ticketsData ?? []).filter((ticket: Ticket) => {
    if (statusFilter && statusFilter !== "all" && ticket.status !== statusFilter) return false
    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      return (
        ticket.subject.toLowerCase().includes(query) ||
        ticket.id.toLowerCase().includes(query)
      )
    }
    return true
  })

  const openTickets = (ticketsData ?? []).filter((t: Ticket) => 
    ["OPEN", "IN_PROGRESS", "WAITING_ON_CUSTOMER"].includes(t.status)
  ).length

  if (error) return <ErrorState title="Failed to load support tickets" description={(error as Error).message} onRetry={() => refetch()} />

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Support</h1>
            <p className="text-muted-foreground">Get help with your orders</p>
          </div>
        </div>
        <div className="grid gap-6 md:grid-cols-3">
          <Card><CardContent className="pt-6"><Skeleton className="h-16 w-full" /></CardContent></Card>
          <Card><CardContent className="pt-6"><Skeleton className="h-16 w-full" /></CardContent></Card>
          <Card><CardContent className="pt-6"><Skeleton className="h-16 w-full" /></CardContent></Card>
        </div>
        <Card>
          <CardHeader><Skeleton className="h-6 w-32" /></CardHeader>
          <CardContent><TicketsTableSkeleton /></CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
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
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Tickets</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{ticketsData?.length ?? 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Open Tickets</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{openTickets}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Resolved</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {(ticketsData ?? []).filter((t: Ticket) => t.status === "RESOLVED" || t.status === "CLOSED").length}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>Your Tickets</CardTitle>
              <CardDescription>
                {filteredTickets.length} ticket{filteredTickets.length !== 1 ? "s" : ""}
              </CardDescription>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search tickets..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9 w-64"
                />
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-40">
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
                {searchQuery || statusFilter
                  ? "Try adjusting your filters"
                  : "Create a ticket to get support"}
              </p>
              {!searchQuery && !statusFilter && (
                <Button className="mt-4" onClick={() => setShowCreateTicket(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  New Ticket
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {filteredTickets.map((ticket: Ticket) => {
                const p = getTicketStatusPresentation(ticket.status as TicketStatus)
                const StatusIcon = ticketIcon[ticket.status as TicketStatus] || AlertCircle

                return (
                  <div
                    key={ticket.id}
                    className="flex items-center justify-between rounded-lg border p-4 hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-center gap-4">
                      <div className={`flex h-10 w-10 items-center justify-center rounded-full ${VARIANT_CIRCLE_BG[p.variant]}`}>
                        <StatusIcon className="h-5 w-5" />
                      </div>
                      <div>
                        <p className="font-medium">{ticket.subject}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <span className="text-sm text-muted-foreground">
                            #{ticket.id.slice(0, 8)}
                          </span>
                          <span className="text-sm text-muted-foreground">•</span>
                          <span className="text-sm text-muted-foreground">
                            {formatDistanceToNow(new Date(ticket.createdAt), { addSuffix: true })}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <Badge className={VARIANT_CIRCLE_BG[p.variant]}>
                        {p.label}
                      </Badge>
                      <Button variant="ghost" size="icon" asChild>
                        <Link href={`/dashboard/support/${ticket.id}`}>
                          <Eye className="h-4 w-4" />
                        </Link>
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>FAQ</CardTitle>
          <CardDescription>Frequently asked questions</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border p-4">
            <h4 className="font-medium">How long does a guest post take?</h4>
            <p className="mt-1 text-sm text-muted-foreground">
              Guest posts typically take 5-14 days from order to publication, depending on the publisher&apos;s schedule and content requirements.
            </p>
          </div>
          <div className="rounded-lg border p-4">
            <h4 className="font-medium">What is your revision policy?</h4>
            <p className="mt-1 text-sm text-muted-foreground">
              We offer up to 2 rounds of revisions per order. Additional revisions may incur extra charges depending on the scope of changes.
            </p>
          </div>
          <div className="rounded-lg border p-4">
            <h4 className="font-medium">How do I track my order?</h4>
            <p className="mt-1 text-sm text-muted-foreground">
              You can track all your orders in the Orders section of your dashboard. You&apos;ll also receive email updates at each status change.
            </p>
          </div>
        </CardContent>
      </Card>

      <CreateTicketDialog open={showCreateTicket} onOpenChange={setShowCreateTicket} />
    </div>
  )
}