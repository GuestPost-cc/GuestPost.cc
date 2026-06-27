"use client"

import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
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
} from "@guestpost/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { format } from "date-fns"
import {
  AlertCircle,
  Ban,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Search,
  Shield,
  User,
} from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"

interface AdminUser {
  id: string
  email: string
  name: string | null
  userType: string
  customerRole: string | null
  publisherRole: string | null
  staffRole: string | null
  banned: boolean
  createdAt: string
}

interface PaginatedResponse<T> {
  items: T[]
  total: number
  take: number
  skip: number
}

function RoleUpdateDialog({
  user,
  open,
  onOpenChange,
  onSuccess,
}: {
  user: AdminUser | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}) {
  const queryClient = useQueryClient()
  const [selectedRole, setSelectedRole] = useState("")

  const roleMutation = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: string }) => {
      if (user?.userType === "STAFF") {
        return api.admin.updateStaffRole(userId, role)
      }
      return api.admin.updateUserRole(userId, role)
    },
    onSuccess: () => {
      toast.success("Role updated successfully")
      queryClient.invalidateQueries({ queryKey: ["admin", "users"] })
      onSuccess()
    },
    onError: () => {
      toast.error("Failed to update role")
    },
  })

  const handleSave = () => {
    if (!user || !selectedRole) return
    roleMutation.mutate({ userId: user.id, role: selectedRole })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change Role — {user?.name ?? user?.email}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">Select Role</label>
            <Select value={selectedRole} onValueChange={setSelectedRole}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="Select role" />
              </SelectTrigger>
              <SelectContent>
                {user?.userType === "CUSTOMER" && (
                  <>
                    <SelectItem value="OWNER">Owner</SelectItem>
                    <SelectItem value="MEMBER">Member</SelectItem>
                  </>
                )}
                {user?.userType === "PUBLISHER" && (
                  <SelectItem value="PUBLISHER_OWNER">
                    Publisher Owner
                  </SelectItem>
                )}
                {user?.userType === "STAFF" && (
                  <>
                    <SelectItem value="SUPER_ADMIN">Super Admin</SelectItem>
                    <SelectItem value="OPERATIONS">Operations</SelectItem>
                    <SelectItem value="FINANCE">Finance</SelectItem>
                  </>
                )}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleSave}
              disabled={!selectedRole || roleMutation.isPending}
            >
              {roleMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function UserRoleBadge({ user }: { user: AdminUser }) {
  const role =
    user.userType === "STAFF"
      ? user.staffRole
      : user.userType === "PUBLISHER"
        ? user.publisherRole
        : user.customerRole

  const variant =
    user.userType === "STAFF"
      ? "default"
      : user.userType === "PUBLISHER"
        ? "secondary"
        : "outline"

  return (
    <Badge variant={variant} className="capitalize whitespace-nowrap">
      {role?.toLowerCase().replace(/_/g, " ") ?? user.userType.toLowerCase()}
    </Badge>
  )
}

function UserTypeBadge({ userType }: { userType: string }) {
  const styles: Record<string, string> = {
    STAFF:
      "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
    PUBLISHER:
      "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
    CUSTOMER:
      "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  }
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider ${styles[userType] ?? "bg-muted text-muted-foreground"}`}
    >
      {userType === "STAFF"
        ? "Staff"
        : userType === "PUBLISHER"
          ? "Publisher"
          : "Customer"}
    </span>
  )
}

const RoleGuard = ({ children }: { children: React.ReactNode }) => {
  const { user } = useAuth()
  if (
    !["SUPER_ADMIN", "OPERATIONS", "FINANCE"].includes(user?.staffRole ?? "")
  ) {
    return (
      <div className="flex min-h-[400px] flex-col items-center justify-center gap-4">
        <AlertCircle className="h-12 w-12 text-muted-foreground" />
        <div className="text-center">
          <h2 className="text-lg font-semibold">Access Restricted</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Only staff with appropriate permissions can access this page.
          </p>
        </div>
      </div>
    )
  }
  return <>{children}</>
}

const PAGE_SIZE = 20

function UsersPageContent() {
  const { user: currentUser } = useAuth()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState("")
  const [userTypeFilter, setUserTypeFilter] = useState<string>("all")
  const [roleFilter, setRoleFilter] = useState<string>("all")
  const [statusFilter, setStatusFilter] = useState<string>("all")
  const [page, setPage] = useState(1)
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null)
  const [roleDialogOpen, setRoleDialogOpen] = useState(false)

  const queryParams = {
    take: PAGE_SIZE,
    skip: (page - 1) * PAGE_SIZE,
    search: search || undefined,
    userType: userTypeFilter !== "all" ? userTypeFilter : undefined,
    role: roleFilter !== "all" ? roleFilter : undefined,
    status: statusFilter !== "all" ? statusFilter : undefined,
  }

  const { data, isLoading, error, refetch } = useQuery<
    PaginatedResponse<AdminUser>
  >({
    queryKey: ["admin", "users", queryParams],
    queryFn: () =>
      api.admin.listUsers(queryParams) as Promise<PaginatedResponse<AdminUser>>,
    retry: 1,
  })

  const isSuperAdmin = currentUser?.staffRole === "SUPER_ADMIN"
  const users = data?.items ?? []
  const totalUsers = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(totalUsers / PAGE_SIZE))

  const banMutation = useMutation({
    mutationFn: (userId: string) => api.admin.banUser(userId, true),
    onSuccess: () => {
      toast.success("User suspended")
      queryClient.invalidateQueries({ queryKey: ["admin", "users"] })
    },
    onError: () => toast.error("Failed to suspend user"),
  })

  const restoreMutation = useMutation({
    mutationFn: (userId: string) => api.admin.banUser(userId, false),
    onSuccess: () => {
      toast.success("User restored")
      queryClient.invalidateQueries({ queryKey: ["admin", "users"] })
    },
    onError: () => toast.error("Failed to restore user"),
  })

  const handleSearch = (value: string) => {
    setSearch(value)
    setPage(1)
  }

  const handleUserTypeChange = (value: string) => {
    setUserTypeFilter(value)
    setRoleFilter("all")
    setPage(1)
  }

  const handleRoleChange = (value: string) => {
    setRoleFilter(value)
    setUserTypeFilter("all")
    setPage(1)
  }

  const handleStatusChange = (value: string) => {
    setStatusFilter(value)
    setPage(1)
  }

  if (error) {
    return (
      <div className="flex min-h-[400px] flex-col items-center justify-center gap-4">
        <AlertCircle className="h-12 w-12 text-destructive" />
        <p className="text-destructive">{error.message}</p>
        <Button onClick={() => refetch()}>Retry</Button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Users</h1>
        <span className="text-sm text-muted-foreground">
          {isLoading
            ? "..."
            : `${totalUsers} user${totalUsers === 1 ? "" : "s"}`}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by name or email..."
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={userTypeFilter} onValueChange={handleUserTypeChange}>
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="User type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="CUSTOMER">Customer</SelectItem>
            <SelectItem value="PUBLISHER">Publisher</SelectItem>
            <SelectItem value="STAFF">Staff</SelectItem>
          </SelectContent>
        </Select>
        <Select value={roleFilter} onValueChange={handleRoleChange}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Role" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Roles</SelectItem>
            <SelectItem value="SUPER_ADMIN">Super Admin</SelectItem>
            <SelectItem value="OPERATIONS">Operations</SelectItem>
            <SelectItem value="FINANCE">Finance</SelectItem>
            <SelectItem value="PUBLISHER_OWNER">Publisher Owner</SelectItem>
            <SelectItem value="OWNER">Customer Owner</SelectItem>
            <SelectItem value="MEMBER">Customer Member</SelectItem>
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={handleStatusChange}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="suspended">Suspended</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : users.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <User className="h-10 w-10 text-muted-foreground" />
              <p className="text-muted-foreground">No users found</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  {isSuperAdmin && (
                    <TableHead className="w-[160px]">Actions</TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
                          <User className="h-4 w-4 text-primary" />
                        </div>
                        <span className="font-medium">{u.name ?? "—"}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="text-muted-foreground">{u.email}</span>
                    </TableCell>
                    <TableCell>
                      <UserTypeBadge userType={u.userType} />
                    </TableCell>
                    <TableCell>
                      <UserRoleBadge user={u} />
                    </TableCell>
                    <TableCell>
                      {u.banned ? (
                        <Badge variant="destructive">Suspended</Badge>
                      ) : (
                        <Badge variant="default" className="bg-emerald-500">
                          Active
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="text-muted-foreground whitespace-nowrap">
                        {format(new Date(u.createdAt), "MMM d, yyyy")}
                      </span>
                    </TableCell>
                    {isSuperAdmin && (
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setSelectedUser(u)
                              setRoleDialogOpen(true)
                            }}
                          >
                            <Shield className="mr-1 h-3 w-3" />
                            Role
                          </Button>
                          {u.banned ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => restoreMutation.mutate(u.id)}
                              disabled={restoreMutation.isPending}
                            >
                              <CheckCircle className="mr-1 h-3 w-3" />
                              Restore
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-destructive hover:text-destructive"
                              onClick={() => banMutation.mutate(u.id)}
                              disabled={
                                u.id === currentUser?.id ||
                                banMutation.isPending
                              }
                            >
                              <Ban className="mr-1 h-3 w-3" />
                              Suspend
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-4">
          <span className="text-sm text-muted-foreground">
            Showing {(page - 1) * PAGE_SIZE + 1}–
            {Math.min(page * PAGE_SIZE, totalUsers)} of {totalUsers}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
            >
              <ChevronLeft className="h-4 w-4" />
              Previous
            </Button>
            <span className="text-sm text-muted-foreground min-w-[80px] text-center">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {isSuperAdmin && (
        <RoleUpdateDialog
          user={selectedUser}
          open={roleDialogOpen}
          onOpenChange={setRoleDialogOpen}
          onSuccess={() => setRoleDialogOpen(false)}
        />
      )}
    </div>
  )
}

export default function UsersPage() {
  return (
    <RoleGuard>
      <UsersPageContent />
    </RoleGuard>
  )
}
