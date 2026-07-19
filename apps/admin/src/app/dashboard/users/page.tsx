"use client"

import type {
  AccountSuspensionReason,
  AdminStaffPerformanceItem,
  AdminUserResponse,
} from "@guestpost/api-client"
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ErrorState,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@guestpost/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { format } from "date-fns"
import {
  Activity,
  Ban,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Eye,
  KeyRound,
  MoreHorizontal,
  Plus,
  Search,
  Shield,
  UserCog,
  Users,
  WalletCards,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"
import { ForbiddenPage, useRequireRole } from "../../../lib/use-require-role"

type DirectoryTab = "staff" | "publishers" | "customers"
type StaffRole = "SUPER_ADMIN" | "OPERATIONS" | "FINANCE"

const PAGE_SIZE = 20

function formatMoney(values?: Record<string, number>) {
  const entries = Object.entries(values ?? {})
  if (entries.length === 0) return "$0.00"
  return entries
    .map(([currency, amount]) =>
      new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
        amount,
      ),
    )
    .join(" + ")
}

function StaffRoleBadge({ role }: { role: StaffRole | null }) {
  const classes: Record<StaffRole, string> = {
    SUPER_ADMIN:
      "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300",
    OPERATIONS:
      "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300",
    FINANCE:
      "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300",
  }
  if (!role) return <Badge variant="outline">No role</Badge>
  return (
    <Badge variant="outline" className={classes[role]}>
      {role.replaceAll("_", " ")}
    </Badge>
  )
}

function StatusBadge({
  banned,
  banExpires,
}: {
  banned: boolean
  banExpires?: string | null
}) {
  return banned ? (
    <Badge variant="destructive">
      {banExpires ? "Temporarily suspended" : "Suspended"}
    </Badge>
  ) : (
    <Badge variant="outline" className="border-emerald-300 text-emerald-700">
      Active
    </Badge>
  )
}

type SuspensionTarget = {
  id: string
  email: string
  name: string | null
  userType: string
  banned: boolean
  banReasonCode: AccountSuspensionReason | null
  banExpires: string | null
  suspendedAt: string | null
}

const suspensionReasonLabels: Record<
  Exclude<AccountSuspensionReason, "LEGACY">,
  string
> = {
  SECURITY_RISK: "Security risk",
  FRAUD_OR_ABUSE: "Fraud or abuse",
  TERMS_VIOLATION: "Terms violation",
  PAYMENT_RISK: "Payment risk",
  COMPLIANCE: "Compliance",
  STAFF_ACCESS_REMOVAL: "Staff access removal",
  OTHER: "Other",
}

function SuspensionDetails({
  userId,
  banned,
}: {
  userId: string
  banned: boolean
}) {
  const detail = useQuery({
    queryKey: ["admin", "users", userId, "detail"],
    queryFn: () => api.admin.getUser(userId),
    enabled: banned,
  })
  if (!banned) return null
  if (detail.isLoading) return <Skeleton className="h-24 w-full" />
  if (!detail.data) return null
  const suspension = detail.data
  return (
    <div className="rounded-xl border border-destructive/25 bg-destructive/5 p-4 text-sm">
      <div className="font-semibold text-destructive">Suspension record</div>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">Reason</dt>
          <dd className="mt-1">
            {suspension.banReasonCode
              ? (suspensionReasonLabels[
                  suspension.banReasonCode as Exclude<
                    AccountSuspensionReason,
                    "LEGACY"
                  >
                ] ?? "Legacy suspension")
              : "Not recorded"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Suspended by</dt>
          <dd className="mt-1">
            {suspension.suspendedBy?.name ??
              suspension.suspendedBy?.email ??
              "Legacy / system action"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Started</dt>
          <dd className="mt-1">
            {suspension.suspendedAt
              ? format(new Date(suspension.suspendedAt), "MMM d, yyyy, p")
              : "Not recorded"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Expires</dt>
          <dd className="mt-1">
            {suspension.banExpires
              ? format(new Date(suspension.banExpires), "MMM d, yyyy, p")
              : "Until manually restored"}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted-foreground">Internal note</dt>
          <dd className="mt-1 whitespace-pre-wrap">
            {suspension.banReason ?? "No legacy note was recorded."}
          </dd>
        </div>
      </dl>
    </div>
  )
}

function SuspensionDialog({
  target,
  open,
  onOpenChange,
}: {
  target: SuspensionTarget | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [reasonCode, setReasonCode] =
    useState<Exclude<AccountSuspensionReason, "LEGACY">>("SECURITY_RISK")
  const [internalNote, setInternalNote] = useState("")
  const [expiresAt, setExpiresAt] = useState("")
  const restoring = target?.banned === true

  useEffect(() => {
    if (!open) return
    setReasonCode(
      target?.userType === "STAFF" ? "STAFF_ACCESS_REMOVAL" : "SECURITY_RISK",
    )
    setInternalNote("")
    setExpiresAt("")
  }, [open, target?.userType])

  const mutation = useMutation({
    mutationFn: async () => {
      if (!target) throw new Error("Choose an account")
      if (restoring)
        return api.admin.restoreUser(target.id, internalNote.trim())
      return api.admin.suspendUser(target.id, {
        reasonCode,
        internalNote: internalNote.trim(),
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      })
    },
    onSuccess: async (result) => {
      if (restoring) {
        toast.success("Account restored. A fresh login is required.")
      } else {
        toast.success(
          `Account suspended and ${result.sessionsRevoked ?? 0} active session${result.sessionsRevoked === 1 ? "" : "s"} revoked.`,
        )
      }
      onOpenChange(false)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin", "staff"] }),
        queryClient.invalidateQueries({ queryKey: ["admin", "users"] }),
      ])
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const valid = internalNote.trim().length >= 10
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {restoring ? "Restore account access" : "Suspend account"}
          </DialogTitle>
          <DialogDescription>
            {target?.name ?? target?.email}
            {target?.name ? ` — ${target.email}` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-sm text-muted-foreground">
            {restoring
              ? "Restoring access does not recreate old sessions. The user must complete a fresh login."
              : "Suspension takes effect immediately, revokes every active session, and blocks email and Google login. Internal notes are never shown to the user."}
          </div>
          {!restoring && (
            <>
              <div>
                <Label>Reason category</Label>
                <Select
                  value={reasonCode}
                  onValueChange={(value) =>
                    setReasonCode(
                      value as Exclude<AccountSuspensionReason, "LEGACY">,
                    )
                  }
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(suspensionReasonLabels).map(
                      ([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="suspension-expiry">Expiry (optional)</Label>
                <Input
                  id="suspension-expiry"
                  type="datetime-local"
                  value={expiresAt}
                  min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)}
                  onChange={(event) => setExpiresAt(event.target.value)}
                  className="mt-1"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Leave blank to require manual restoration.
                </p>
              </div>
            </>
          )}
          <div>
            <Label htmlFor="suspension-note">
              {restoring ? "Restore note" : "Internal security note"}
            </Label>
            <Textarea
              id="suspension-note"
              value={internalNote}
              onChange={(event) => setInternalNote(event.target.value)}
              maxLength={2_000}
              rows={4}
              className="mt-1"
              placeholder="Record the evidence and operational context (minimum 10 characters)."
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={restoring ? "default" : "destructive"}
            onClick={() => mutation.mutate()}
            disabled={!valid || mutation.isPending}
          >
            {mutation.isPending
              ? "Saving…"
              : restoring
                ? "Restore access"
                : "Suspend and revoke sessions"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CreateStaffDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<StaffRole>("OPERATIONS")
  const [password, setPassword] = useState("")
  const create = useMutation({
    mutationFn: () =>
      api.admin.createStaff({
        name: name.trim(),
        email: email.trim(),
        role,
        password,
      }),
    onSuccess: async () => {
      toast.success("Staff account created")
      setName("")
      setEmail("")
      setRole("OPERATIONS")
      setPassword("")
      onOpenChange(false)
      await queryClient.invalidateQueries({ queryKey: ["admin", "staff"] })
      await queryClient.invalidateQueries({ queryKey: ["admin", "users"] })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const valid =
    name.trim().length >= 2 && email.includes("@") && password.length >= 12

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create staff account</DialogTitle>
          <DialogDescription>
            Create a Super Admin, Operations, or Finance credential account.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="staff-name">Name</Label>
            <Input
              id="staff-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="staff-email">Email</Label>
            <Input
              id="staff-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              maxLength={254}
              className="mt-1"
            />
          </div>
          <div>
            <Label>Role</Label>
            <Select
              value={role}
              onValueChange={(value) => setRole(value as StaffRole)}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="OPERATIONS">Operations</SelectItem>
                <SelectItem value="FINANCE">Finance</SelectItem>
                <SelectItem value="SUPER_ADMIN">Super Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="staff-password">Temporary password</Label>
            <Input
              id="staff-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              maxLength={128}
              className="mt-1"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              At least 12 characters with uppercase, lowercase, number, and
              symbol.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={!valid || create.isPending}
          >
            <Plus className="h-4 w-4" />
            {create.isPending ? "Creating..." : "Create staff"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function StaffDetailsDialog({
  member,
  open,
  onOpenChange,
}: {
  member: AdminStaffPerformanceItem | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  if (!member) return null
  const operations = member.staffRole === "OPERATIONS"
  const finance = member.staffRole === "FINANCE"
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{member.name ?? member.email}</DialogTitle>
          <DialogDescription>{member.email}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <StaffRoleBadge role={member.staffRole} />
          <StatusBadge banned={member.banned} banExpires={member.banExpires} />
          <span className="text-xs text-muted-foreground">
            Joined {format(new Date(member.createdAt), "MMM d, yyyy")}
          </span>
        </div>
        <SuspensionDetails userId={member.id} banned={member.banned} />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardContent className="p-4">
              <div className="text-xs text-muted-foreground">
                Active assigned
              </div>
              <div className="mt-1 text-2xl font-semibold">
                {member.metrics.activeAssigned}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-xs text-muted-foreground">Self-claimed</div>
              <div className="mt-1 text-2xl font-semibold">
                {member.metrics.claimed}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-xs text-muted-foreground">
                {finance ? "Finance approvals" : "Completed"}
              </div>
              <div className="mt-1 text-2xl font-semibold">
                {finance
                  ? member.metrics.financeApprovals
                  : member.metrics.completed}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-xs text-muted-foreground">
                {finance ? "Handled volume" : "Delivered sales"}
              </div>
              <div className="mt-1 text-lg font-semibold">
                {formatMoney(
                  finance
                    ? member.metrics.financeVolumeByCurrency
                    : member.metrics.salesByCurrency,
                )}
              </div>
            </CardContent>
          </Card>
        </div>
        <div className="grid gap-3 border-t pt-4 text-sm sm:grid-cols-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Total assignments</span>
            <span>
              {operations ? member.metrics.totalAssigned : "Not applicable"}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Withdrawals approved</span>
            <span>{member.metrics.withdrawalsApproved}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Audited actions</span>
            <span>{member.metrics.auditActions}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Last activity</span>
            <span>
              {member.metrics.lastActivityAt
                ? format(
                    new Date(member.metrics.lastActivityAt),
                    "MMM d, yyyy, p",
                  )
                : "No activity"}
            </span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function RoleDialog({
  member,
  open,
  onOpenChange,
}: {
  member: AdminStaffPerformanceItem | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [role, setRole] = useState<StaffRole | "">("")
  const mutation = useMutation({
    mutationFn: () => api.admin.updateStaffRole(member?.id ?? "", role),
    onSuccess: async () => {
      toast.success("Staff role updated")
      onOpenChange(false)
      setRole("")
      await queryClient.invalidateQueries({ queryKey: ["admin", "staff"] })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change staff role</DialogTitle>
          <DialogDescription>{member?.email}</DialogDescription>
        </DialogHeader>
        <Select
          value={role}
          onValueChange={(value) => setRole(value as StaffRole)}
        >
          <SelectTrigger>
            <SelectValue
              placeholder={member?.staffRole?.replaceAll("_", " ")}
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="SUPER_ADMIN">Super Admin</SelectItem>
            <SelectItem value="OPERATIONS">Operations</SelectItem>
            <SelectItem value="FINANCE">Finance</SelectItem>
          </SelectContent>
        </Select>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!role || role === member?.staffRole || mutation.isPending}
          >
            {mutation.isPending ? "Saving..." : "Save role"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function StaffDirectory() {
  const { user: currentUser } = useAuth()
  const [search, setSearch] = useState("")
  const [role, setRole] = useState<StaffRole | "all">("all")
  const [selected, setSelected] = useState<AdminStaffPerformanceItem | null>(
    null,
  )
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [roleOpen, setRoleOpen] = useState(false)
  const [suspensionTarget, setSuspensionTarget] =
    useState<SuspensionTarget | null>(null)
  const query = useQuery({
    queryKey: ["admin", "staff", "performance"],
    queryFn: () => api.admin.staffPerformance(),
    refetchInterval: 30_000,
  })
  const items = useMemo(() => {
    const term = search.trim().toLowerCase()
    return (query.data?.items ?? []).filter(
      (member) =>
        (role === "all" || member.staffRole === role) &&
        (!term ||
          member.email.toLowerCase().includes(term) ||
          member.name?.toLowerCase().includes(term)),
    )
  }, [query.data, role, search])
  if (query.error) {
    return (
      <ErrorState
        title="Failed to load staff"
        description={query.error.message}
        onRetry={() => query.refetch()}
      />
    )
  }
  const summary = query.data?.summary
  const summaryCards = [
    ["Active staff", summary?.activeStaff ?? 0, Users],
    ["Suspended", summary?.suspendedStaff ?? 0, Ban],
    ["Operations", summary?.operations ?? 0, UserCog],
    ["Active assigned", summary?.activeAssignments ?? 0, Activity],
    ["Self-claimed", summary?.totalClaimed ?? 0, CheckCircle2],
    [
      "Delivered sales",
      formatMoney(summary?.salesByCurrency),
      CircleDollarSign,
    ],
    ["Finance staff", summary?.finance ?? 0, WalletCards],
  ] as const

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-7">
        {summaryCards.map(([label, value, Icon]) => (
          <Card key={label}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
                {label}
                <Icon className="h-4 w-4" />
              </div>
              {query.isLoading ? (
                <Skeleton className="mt-2 h-7 w-16" />
              ) : (
                <div className="mt-1 text-xl font-semibold">{value}</div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search staff"
            className="pl-9"
          />
        </div>
        <Select
          value={role}
          onValueChange={(value) => setRole(value as StaffRole | "all")}
        >
          <SelectTrigger className="w-full sm:w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All staff roles</SelectItem>
            <SelectItem value="SUPER_ADMIN">Super Admin</SelectItem>
            <SelectItem value="OPERATIONS">Operations</SelectItem>
            <SelectItem value="FINANCE">Finance</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {query.isLoading ? (
            <div className="space-y-3 p-6">
              {Array.from({ length: 6 }).map((_, index) => (
                <Skeleton key={index} className="h-14 w-full" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              No staff members found.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Staff member</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Assigned</TableHead>
                  <TableHead>Claimed</TableHead>
                  <TableHead>Completed</TableHead>
                  <TableHead>Sales / volume</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((member) => {
                  const finance = member.staffRole === "FINANCE"
                  return (
                    <TableRow key={member.id}>
                      <TableCell>
                        <div className="font-medium">
                          {member.name ?? "No name"}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {member.email}
                        </div>
                      </TableCell>
                      <TableCell>
                        <StaffRoleBadge role={member.staffRole} />
                      </TableCell>
                      <TableCell>
                        {member.metrics.activeAssigned} active
                        <div className="text-xs text-muted-foreground">
                          {member.metrics.totalAssigned} lifetime
                        </div>
                      </TableCell>
                      <TableCell>{member.metrics.claimed}</TableCell>
                      <TableCell>
                        {finance
                          ? `${member.metrics.financeApprovals} approvals`
                          : member.metrics.completed}
                      </TableCell>
                      <TableCell>
                        {formatMoney(
                          finance
                            ? member.metrics.financeVolumeByCurrency
                            : member.metrics.salesByCurrency,
                        )}
                      </TableCell>
                      <TableCell>
                        <StatusBadge
                          banned={member.banned}
                          banExpires={member.banExpires}
                        />
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Staff actions"
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() => {
                                setSelected(member)
                                setDetailsOpen(true)
                              }}
                            >
                              <Eye className="h-4 w-4" /> View details
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={member.id === currentUser?.id}
                              onClick={() => {
                                setSelected(member)
                                setRoleOpen(true)
                              }}
                            >
                              <KeyRound className="h-4 w-4" /> Change role
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              disabled={member.id === currentUser?.id}
                              className={
                                member.banned ? "" : "text-destructive"
                              }
                              onClick={() => {
                                setSuspensionTarget({
                                  id: member.id,
                                  email: member.email,
                                  name: member.name,
                                  userType: "STAFF",
                                  banned: member.banned,
                                  banReasonCode: member.banReasonCode,
                                  banExpires: member.banExpires,
                                  suspendedAt: member.suspendedAt,
                                })
                              }}
                            >
                              {member.banned ? (
                                <CheckCircle2 className="h-4 w-4" />
                              ) : (
                                <Ban className="h-4 w-4" />
                              )}
                              {member.banned
                                ? "Restore account"
                                : "Suspend account"}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <StaffDetailsDialog
        member={selected}
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
      />
      <RoleDialog
        member={selected}
        open={roleOpen}
        onOpenChange={setRoleOpen}
      />
      <SuspensionDialog
        target={suspensionTarget}
        open={Boolean(suspensionTarget)}
        onOpenChange={(open) => !open && setSuspensionTarget(null)}
      />
    </div>
  )
}

function ExternalUserDirectory({ type }: { type: "PUBLISHER" | "CUSTOMER" }) {
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<
    "all" | "active" | "suspended"
  >("all")
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<AdminUserResponse | null>(null)
  const [suspensionTarget, setSuspensionTarget] =
    useState<SuspensionTarget | null>(null)
  const query = useQuery({
    queryKey: ["admin", "users", type, search, statusFilter, page],
    queryFn: () =>
      api.admin.listUsers({
        userType: type,
        search: search.trim() || undefined,
        status: statusFilter === "all" ? undefined : statusFilter,
        take: PAGE_SIZE,
        skip: (page - 1) * PAGE_SIZE,
      }),
  })
  if (query.error) {
    return (
      <ErrorState
        title={`Failed to load ${type.toLowerCase()}s`}
        description={query.error.message}
        onRetry={() => query.refetch()}
      />
    )
  }
  const users = query.data?.items ?? []
  const total = query.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              setPage(1)
            }}
            placeholder={`Search ${type.toLowerCase()}s`}
            className="pl-9"
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={(value) => {
            setStatusFilter(value as typeof statusFilter)
            setPage(1)
          }}
        >
          <SelectTrigger className="w-full sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="suspended">Suspended</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Card>
        <CardContent className="p-0">
          {query.isLoading ? (
            <div className="space-y-3 p-6">
              {Array.from({ length: 6 }).map((_, index) => (
                <Skeleton key={index} className="h-14 w-full" />
              ))}
            </div>
          ) : users.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              No users found.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="font-medium">
                      {user.name ?? "No name"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {user.email}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {(type === "PUBLISHER"
                          ? user.publisherRole
                          : user.customerRole
                        )?.replaceAll("_", " ") ?? type}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {format(new Date(user.createdAt), "MMM d, yyyy")}
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        banned={user.banned}
                        banExpires={user.banExpires}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          title="View user"
                          onClick={() => setSelected(user)}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title={user.banned ? "Restore user" : "Suspend user"}
                          className={user.banned ? "" : "text-destructive"}
                          onClick={() => setSuspensionTarget(user)}
                        >
                          {user.banned ? (
                            <CheckCircle2 className="h-4 w-4" />
                          ) : (
                            <Ban className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          {total} {type.toLowerCase()}
          {total === 1 ? "" : "s"}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            title="Previous page"
            onClick={() => setPage((value) => Math.max(1, value - 1))}
            disabled={page === 1}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-20 text-center text-sm text-muted-foreground">
            {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="icon"
            title="Next page"
            onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
            disabled={page === totalPages}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => !open && setSelected(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{selected?.name ?? "User details"}</DialogTitle>
            <DialogDescription>{selected?.email}</DialogDescription>
          </DialogHeader>
          {selected && (
            <div className="grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <div className="text-xs text-muted-foreground">
                  Account type
                </div>
                <div className="mt-1">{selected.userType}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Role</div>
                <div className="mt-1">
                  {selected.publisherRole ?? selected.customerRole ?? "Not set"}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Status</div>
                <div className="mt-1">
                  <StatusBadge
                    banned={selected.banned}
                    banExpires={selected.banExpires}
                  />
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Joined</div>
                <div className="mt-1">
                  {format(new Date(selected.createdAt), "MMM d, yyyy, p")}
                </div>
              </div>
              {selected.banned && (
                <div className="sm:col-span-2">
                  <SuspensionDetails
                    userId={selected.id}
                    banned={selected.banned}
                  />
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
      <SuspensionDialog
        target={suspensionTarget}
        open={Boolean(suspensionTarget)}
        onOpenChange={(open) => !open && setSuspensionTarget(null)}
      />
    </div>
  )
}

export default function UsersPage() {
  const { allowed, loading } = useRequireRole("SUPER_ADMIN")
  const [tab, setTab] = useState<DirectoryTab>("staff")
  const [createOpen, setCreateOpen] = useState(false)
  if (loading) return null
  if (!allowed) return <ForbiddenPage requires="Super Admin" />
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-3xl font-bold">
            <Shield className="h-7 w-7" />
            Users & Staff
          </h1>
          <p className="mt-1 text-muted-foreground">
            Staff access, workload, financial activity, and account oversight.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          Create staff
        </Button>
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as DirectoryTab)}
      >
        <TabsList>
          <TabsTrigger value="staff">Staff</TabsTrigger>
          <TabsTrigger value="publishers">Publishers</TabsTrigger>
          <TabsTrigger value="customers">Customers</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === "staff" && <StaffDirectory />}
      {tab === "publishers" && <ExternalUserDirectory type="PUBLISHER" />}
      {tab === "customers" && <ExternalUserDirectory type="CUSTOMER" />}

      <CreateStaffDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  )
}
