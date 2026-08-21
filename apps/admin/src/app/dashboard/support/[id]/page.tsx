"use client"

import {
  type AdminOpsStaffResponse,
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FulfillmentChannelBadge,
  Label,
  mergeSupportConversationPages,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  SupportComposer,
  SupportConversation,
  Textarea,
} from "@guestpost/ui"
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { formatDistanceToNow } from "date-fns"
import {
  AlertCircle,
  ArrowLeft,
  ExternalLink,
  Info,
  RefreshCw,
  UserRoundCog,
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

const UNASSIGNED_OWNER_VALUE = "__unassigned__"
const UNSAFE_REASSIGNMENT_CHARACTERS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u

interface ReassignmentDraft {
  initialOwnerId: string | null | undefined
  initialOwnerName: string
  selectedOwnerId: string | null | undefined
  reason: string
}

function normalizeReassignmentReason(value: string): string {
  return value.normalize("NFC").replace(/\r\n?/g, "\n").trim()
}

function operationsMemberName(member: AdminOpsStaffResponse): string {
  return member.name?.trim() || member.email
}

function operationsMemberLabel(member: AdminOpsStaffResponse): string {
  const name = member.name?.trim()
  return name ? `${name} (${member.email})` : member.email
}

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
  const [reassignmentDraft, setReassignmentDraft] =
    useState<ReassignmentDraft | null>(null)
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

  const canLoadAssignmentCandidates = Boolean(
    reassignmentDraft && ticketQuery.data?.pages[0]?.capabilities.canReassign,
  )
  const assignmentCandidatesQuery = useQuery({
    queryKey: ["admin", "operations-staff"],
    queryFn: () => api.admin.listOpsStaff(),
    enabled: canLoadAssignmentCandidates,
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

  const reassignMutation = useMutation({
    mutationFn: (input: {
      assignedToUserId: string | null
      expectedAssignedToUserId: string | null
      reason: string
      orderId: string | null
    }) =>
      api.admin.reassignTicket(ticketId, {
        assignedToUserId: input.assignedToUserId,
        expectedAssignedToUserId: input.expectedAssignedToUserId,
        reason: input.reason,
      }),
    onSuccess: async (_, input) => {
      setReassignmentDraft(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: detailKey }),
        // This prefix includes the inbox and every order-scoped support panel.
        queryClient.invalidateQueries({ queryKey: listKey }),
        ...(input.orderId
          ? [
              queryClient.invalidateQueries({
                queryKey: ["admin", "order", input.orderId],
              }),
            ]
          : []),
      ])
      toast.success(
        input.assignedToUserId
          ? "Ticket reassigned"
          : "Ticket returned to the shared queue",
      )
    },
    onError: (error: Error) => {
      // A concurrent assignment or staff deactivation is expected to fail
      // closed server-side. Refresh both snapshots before allowing a retry.
      void Promise.all([
        ticketQuery.refetch(),
        assignmentCandidatesQuery.refetch(),
      ])
      toast.error(error.message || "The ticket could not be reassigned")
    },
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
  const currentOwnerId = ticket.assignedTo ? ticket.assignedTo.userId : null
  const assignmentCandidates = assignmentCandidatesQuery.data ?? []
  const candidateIds = new Set(
    assignmentCandidates.map((candidate) => candidate.id),
  )
  const selectedCandidate = assignmentCandidates.find(
    (candidate) => candidate.id === reassignmentDraft?.selectedOwnerId,
  )
  const normalizedReassignmentReason = normalizeReassignmentReason(
    reassignmentDraft?.reason ?? "",
  )
  const reasonHasUnsafeCharacters = UNSAFE_REASSIGNMENT_CHARACTERS.test(
    normalizedReassignmentReason,
  )
  const reasonIsValid =
    normalizedReassignmentReason.length >= 10 &&
    normalizedReassignmentReason.length <= 2_000 &&
    !reasonHasUnsafeCharacters
  const ownerChanged = Boolean(
    reassignmentDraft &&
      reassignmentDraft.selectedOwnerId !== reassignmentDraft.initialOwnerId,
  )
  const currentOwnerProjectionIncomplete = Boolean(
    reassignmentDraft && ticket.assignedTo && !ticket.assignedTo.userId,
  )
  const ticketAssignmentChanged = Boolean(
    reassignmentDraft && currentOwnerId !== reassignmentDraft.initialOwnerId,
  )
  const selectedOwnerIsStale = Boolean(
    reassignmentDraft &&
      assignmentCandidatesQuery.isSuccess &&
      reassignmentDraft.selectedOwnerId &&
      !candidateIds.has(reassignmentDraft.selectedOwnerId),
  )
  const reassignmentIsBlocked =
    !reassignmentDraft ||
    !ticket.capabilities.canReassign ||
    currentOwnerProjectionIncomplete ||
    ticketAssignmentChanged ||
    reassignmentDraft.selectedOwnerId === undefined ||
    !ownerChanged ||
    !reasonIsValid ||
    assignmentCandidatesQuery.isLoading ||
    assignmentCandidatesQuery.isFetching ||
    assignmentCandidatesQuery.isError ||
    selectedOwnerIsStale ||
    reassignMutation.isPending

  const openReassignmentDialog = () => {
    const initialOwnerId = ticket.assignedTo ? ticket.assignedTo.userId : null
    setReassignmentDraft({
      initialOwnerId,
      initialOwnerName: ticket.assignedTo?.displayName ?? "Shared Ops queue",
      selectedOwnerId: initialOwnerId,
      reason: "",
    })
    reassignMutation.reset()
  }

  const closeReassignmentDialog = () => {
    if (reassignMutation.isPending) return
    setReassignmentDraft(null)
    reassignMutation.reset()
  }

  const submitReassignment = () => {
    if (
      reassignmentIsBlocked ||
      !reassignmentDraft ||
      reassignmentDraft.selectedOwnerId === undefined ||
      reassignmentDraft.initialOwnerId === undefined
    ) {
      return
    }
    reassignMutation.mutate({
      assignedToUserId: reassignmentDraft.selectedOwnerId,
      expectedAssignedToUserId: reassignmentDraft.initialOwnerId,
      reason: normalizedReassignmentReason,
      orderId: ticket.order?.id ?? null,
    })
  }

  const selectedOwnerName =
    reassignmentDraft?.selectedOwnerId === null
      ? "Shared Ops queue"
      : selectedCandidate
        ? operationsMemberName(selectedCandidate)
        : reassignmentDraft?.selectedOwnerId ===
            reassignmentDraft?.initialOwnerId
          ? reassignmentDraft?.initialOwnerName
          : "Unavailable Operations staff"

  return (
    <AdminPage className="max-w-5xl">
      <AdminPageHeader
        title="Support ticket"
        description="Review the complete conversation, party identity, visibility, and server-authorized next action."
        eyebrow="Support operations"
        icon={Info}
        actions={
          <div className="flex flex-wrap gap-2">
            {ticket.capabilities.canReassign && (
              <Button
                size="sm"
                variant="outline"
                onClick={openReassignmentDialog}
              >
                <UserRoundCog className="mr-2 h-4 w-4" aria-hidden="true" />
                Reassign ticket
              </Button>
            )}
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

      <Dialog
        open={Boolean(reassignmentDraft)}
        onOpenChange={(open) => {
          if (!open) closeReassignmentDialog()
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Confirm ticket reassignment</DialogTitle>
            <DialogDescription>
              Change the Operations owner for this support conversation. For an
              order-linked ticket, this does not change the order&apos;s
              fulfillment assignment.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <div className="grid gap-3 rounded-lg border bg-muted/30 p-3 sm:grid-cols-2">
              <div className="min-w-0">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Current owner
                </p>
                <p
                  dir="auto"
                  className="mt-1 truncate text-sm font-medium [unicode-bidi:plaintext]"
                >
                  {reassignmentDraft?.initialOwnerName}
                </p>
              </div>
              <div className="min-w-0">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  New owner
                </p>
                <p
                  dir="auto"
                  className="mt-1 truncate text-sm font-medium [unicode-bidi:plaintext]"
                  aria-live="polite"
                >
                  {selectedOwnerName}
                </p>
              </div>
            </div>

            {!ticket.capabilities.canReassign && (
              <div
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/5 p-3"
              >
                <p className="text-sm font-medium">
                  Reassignment is no longer available
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  The server capability changed while this dialog was open.
                  Close and refresh the ticket before taking another action.
                </p>
              </div>
            )}

            {(currentOwnerProjectionIncomplete || ticketAssignmentChanged) && (
              <div
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/5 p-3"
              >
                <p className="text-sm font-medium">
                  Assignment information changed
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {currentOwnerProjectionIncomplete
                    ? "The current owner identifier is unavailable, so this action is blocked."
                    : "Another staff member changed this ticket while you were reviewing it."}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => {
                    closeReassignmentDialog()
                    void ticketQuery.refetch()
                  }}
                >
                  Close and reload
                </Button>
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="support-assignee">New Operations owner</Label>
                <span className="text-xs text-muted-foreground">
                  Active Operations staff only
                </span>
              </div>

              {assignmentCandidatesQuery.isLoading && (
                <div className="space-y-2" aria-busy="true">
                  <Skeleton className="h-10 w-full" />
                  <span className="sr-only">
                    Loading Operations assignment candidates
                  </span>
                </div>
              )}

              {assignmentCandidatesQuery.isError && (
                <div
                  role="alert"
                  className="rounded-md border border-destructive/30 bg-destructive/5 p-3"
                >
                  <p className="text-sm font-medium">
                    Could not load Operations staff
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {(assignmentCandidatesQuery.error as Error).message ||
                      "The assignment candidates are unavailable."}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => assignmentCandidatesQuery.refetch()}
                    disabled={assignmentCandidatesQuery.isFetching}
                  >
                    {assignmentCandidatesQuery.isFetching
                      ? "Retrying…"
                      : "Retry"}
                  </Button>
                </div>
              )}

              {assignmentCandidatesQuery.isSuccess && reassignmentDraft && (
                <>
                  <Select
                    value={
                      reassignmentDraft.selectedOwnerId === null
                        ? UNASSIGNED_OWNER_VALUE
                        : reassignmentDraft.selectedOwnerId
                    }
                    onValueChange={(value) => {
                      setReassignmentDraft((current) =>
                        current
                          ? {
                              ...current,
                              selectedOwnerId:
                                value === UNASSIGNED_OWNER_VALUE ? null : value,
                            }
                          : current,
                      )
                      reassignMutation.reset()
                    }}
                    disabled={
                      reassignMutation.isPending ||
                      assignmentCandidatesQuery.isFetching
                    }
                  >
                    <SelectTrigger id="support-assignee" className="w-full">
                      <SelectValue placeholder="Choose an owner" />
                    </SelectTrigger>
                    <SelectContent>
                      {assignmentCandidates.map((candidate) => (
                        <SelectItem key={candidate.id} value={candidate.id}>
                          <span dir="auto" className="[unicode-bidi:plaintext]">
                            {operationsMemberLabel(candidate)}
                          </span>
                        </SelectItem>
                      ))}
                      {reassignmentDraft.selectedOwnerId &&
                        !candidateIds.has(
                          reassignmentDraft.selectedOwnerId,
                        ) && (
                          <SelectItem
                            value={reassignmentDraft.selectedOwnerId}
                            disabled
                          >
                            {selectedOwnerName} (no longer active)
                          </SelectItem>
                        )}
                      <SelectItem value={UNASSIGNED_OWNER_VALUE}>
                        Shared Ops queue (unassigned)
                      </SelectItem>
                    </SelectContent>
                  </Select>

                  {assignmentCandidates.length === 0 && (
                    <div className="rounded-md border border-dashed p-3">
                      <p className="text-sm font-medium">
                        No active Operations staff are available
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        You can only return this ticket to the shared queue.
                      </p>
                    </div>
                  )}

                  {selectedOwnerIsStale && (
                    <div
                      role="alert"
                      className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3"
                    >
                      <p className="text-sm font-medium">
                        The selected owner is no longer active
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Choose another active operator or the shared queue.
                      </p>
                    </div>
                  )}

                  {assignmentCandidatesQuery.isFetching && (
                    <p className="text-xs text-muted-foreground" role="status">
                      Refreshing assignment candidates…
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="support-reassignment-reason">
                  Reason for audit log
                </Label>
                <span className="text-xs text-muted-foreground">
                  Required · {normalizedReassignmentReason.length}/2000
                </span>
              </div>
              <Textarea
                id="support-reassignment-reason"
                value={reassignmentDraft?.reason ?? ""}
                onChange={(event) => {
                  const reason = event.target.value
                  setReassignmentDraft((current) =>
                    current ? { ...current, reason } : current,
                  )
                  reassignMutation.reset()
                }}
                placeholder="Explain the operational reason for changing this owner."
                maxLength={2_000}
                rows={4}
                disabled={reassignMutation.isPending}
                aria-invalid={
                  Boolean(reassignmentDraft?.reason) && !reasonIsValid
                }
                aria-describedby="support-reassignment-reason-help"
                className="[unicode-bidi:plaintext]"
              />
              <p
                id="support-reassignment-reason-help"
                className={
                  reassignmentDraft?.reason && !reasonIsValid
                    ? "text-xs text-destructive"
                    : "text-xs text-muted-foreground"
                }
              >
                {reasonHasUnsafeCharacters
                  ? "Remove invisible or unsupported control characters."
                  : normalizedReassignmentReason.length > 0 &&
                      normalizedReassignmentReason.length < 10
                    ? "Use at least 10 characters so the audit reason is meaningful."
                    : "Use 10–2000 characters. Leading and trailing whitespace is removed."}
              </p>
            </div>

            {reassignMutation.isError && (
              <div
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/5 p-3"
              >
                <p className="text-sm font-medium">Assignment not saved</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {(reassignMutation.error as Error).message ||
                    "The ticket could not be reassigned."}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={submitReassignment}
                  disabled={reassignmentIsBlocked}
                >
                  Retry reassignment
                </Button>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={closeReassignmentDialog}
              disabled={reassignMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={submitReassignment}
              disabled={reassignmentIsBlocked}
            >
              {reassignMutation.isPending
                ? "Reassigning…"
                : ownerChanged
                  ? "Confirm reassignment"
                  : "Choose a different owner"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminPage>
  )
}
