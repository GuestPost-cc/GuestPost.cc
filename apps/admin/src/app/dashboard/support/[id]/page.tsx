"use client"

import { useState } from "react"
import { useParams, useRouter } from "next/navigation"
import Link from "next/link"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../../../lib/api"
import { Card, CardContent, CardHeader, CardTitle } from "@guestpost/ui"
import { Button } from "@guestpost/ui"
import { Badge } from "@guestpost/ui"
import { Skeleton } from "@guestpost/ui"
import { Textarea } from "@guestpost/ui"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@guestpost/ui"
import { ArrowLeft, Send, AlertCircle, RefreshCw, UserCheck, MessageSquare } from "lucide-react"
import { format, formatDistanceToNow } from "date-fns"
import { toast } from "sonner"

const STATUS_OPTIONS = ["OPEN", "IN_PROGRESS", "WAITING_ON_CUSTOMER", "RESOLVED", "CLOSED"]

export default function AdminTicketDetailPage() {
  const params = useParams()
  const router = useRouter()
  const queryClient = useQueryClient()
  const [replyContent, setReplyContent] = useState("")

  const { data: ticket, isLoading, error, refetch } = useQuery({
    queryKey: ["admin", "ticket", params.id],
    queryFn: () => api.admin.getTicketDetail(params.id as string),
    enabled: !!params.id,
  })

  const { mutate: updateStatus, isPending: updatingStatus } = useMutation({
    mutationFn: (status: string) => api.admin.updateTicketStatus(params.id as string, status as any),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "ticket", params.id] })
      queryClient.invalidateQueries({ queryKey: ["admin", "tickets"] })
      toast.success("Status updated")
    },
    onError: () => toast.error("Failed to update status"),
  })

  const { mutate: sendReply, isPending: sendingReply } = useMutation({
    mutationFn: () => api.admin.addTicketMessage(params.id as string, { content: replyContent }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "ticket", params.id] })
      setReplyContent("")
      toast.success("Reply sent")
    },
    onError: () => toast.error("Failed to send reply"),
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
        <p className="text-muted-foreground mb-4">{(error as Error)?.message || "This ticket doesn't exist."}</p>
        <Button onClick={() => refetch()}><RefreshCw className="mr-2 h-4 w-4" />Retry</Button>
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4 mr-2" />Back
        </Button>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <CardTitle className="text-xl">{ticket.subject}</CardTitle>
              <p className="text-sm text-muted-foreground">
                by {ticket.customer.name || ticket.customer.email} — Created {formatDistanceToNow(new Date(ticket.createdAt), { addSuffix: true })}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={ticket.priority === "HIGH" || ticket.priority === "URGENT" ? "destructive" : "secondary"}>
                {ticket.priority}
              </Badge>
              <Select defaultValue={ticket.status} onValueChange={(v) => updateStatus(v)}>
                <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {ticket.assignee && (
            <p className="text-sm text-muted-foreground flex items-center gap-1">
              <UserCheck className="h-3 w-3" /> Assigned to {ticket.assignee.name}
            </p>
          )}
        </CardHeader>
      </Card>

      <div className="space-y-4">
        {ticket.messages.map((msg: any) => (
          <div key={msg.id} className={`flex gap-3 ${msg.authorType === "STAFF" ? "flex-row-reverse" : ""}`}>
            <div className={`flex-1 rounded-lg border p-4 ${msg.authorType === "STAFF" ? "bg-primary/5" : ""}`}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">{msg.author}</span>
                <span className="text-xs text-muted-foreground">
                  {format(new Date(msg.createdAt), "MMM d, yyyy HH:mm")}
                </span>
              </div>
              <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
            </div>
          </div>
        ))}
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="space-y-4">
            <label className="text-sm font-medium">Reply as Staff</label>
            <Textarea
              placeholder="Type your reply..."
              value={replyContent}
              onChange={(e) => setReplyContent(e.target.value)}
              rows={4}
            />
            <div className="flex justify-end">
              <Button onClick={() => sendReply()} disabled={!replyContent.trim() || sendingReply}>
                <Send className="mr-2 h-4 w-4" />
                {sendingReply ? "Sending..." : "Send Reply"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
