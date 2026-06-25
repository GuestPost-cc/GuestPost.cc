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
import { zodResolver } from "@hookform/resolvers/zod"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  type ColumnDef,
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table"
import { format } from "date-fns"
import {
  AlertCircle,
  Ban,
  CheckCircle,
  Search,
  Shield,
  User,
} from "lucide-react"
import { useMemo, useState } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"
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

const roleUpdateSchema = z.object({
  role: z.string(),
})

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
  const { handleSubmit, register, setValue, watch } = useForm({
    resolver: zodResolver(roleUpdateSchema),
    defaultValues: { role: "" },
  })

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

  const onSubmit = (data: z.infer<typeof roleUpdateSchema>) => {
    if (!user) return
    roleMutation.mutate({ userId: user.id, role: data.role })
  }

  const selectedRole = watch("role")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change Role — {user?.name ?? user?.email}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <label className="text-sm font-medium">Select Role</label>
            <Select
              value={selectedRole}
              onValueChange={(v) => setValue("role", v)}
            >
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
            <Button type="submit" disabled={roleMutation.isPending}>
              {roleMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const columnHelper = createColumnHelper<AdminUser>()

const RoleGuard = ({ children }: { children: React.ReactNode }) => {
  const { user } = useAuth()
  if (user?.staffRole !== "SUPER_ADMIN") {
    return (
      <div className="flex min-h-[400px] flex-col items-center justify-center gap-4">
        <AlertCircle className="h-12 w-12 text-muted-foreground" />
        <div className="text-center">
          <h2 className="text-lg font-semibold">Access Restricted</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Only Super Admins can access the user management page.
          </p>
        </div>
      </div>
    )
  }
  return <>{children}</>
}

function UsersPageContent() {
  const { user: currentUser } = useAuth()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState("")
  const [roleFilter, setRoleFilter] = useState<string>("all")
  const [statusFilter, setStatusFilter] = useState<string>("all")
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null)
  const [roleDialogOpen, setRoleDialogOpen] = useState(false)

  const {
    data: users = [],
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => api.admin.listUsers(),
    retry: 1,
  })

  const banMutation = useMutation({
    mutationFn: async (userId: string) => {
      const { getToken, getApiUrl } = await import("../../../lib/api")
      const token = getToken()
      const res = await fetch(`${getApiUrl()}/admin/users/${userId}/ban`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ banned: true }),
        credentials: "include",
      })
      if (!res.ok) {
        const fallback = await fetch(`${getApiUrl()}/admin/users/${userId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ banned: true }),
          credentials: "include",
        })
        if (!fallback.ok) throw new Error(await fallback.text())
      }
    },
    onSuccess: () => {
      toast.success("User suspended")
      queryClient.invalidateQueries({ queryKey: ["admin", "users"] })
    },
    onError: () => toast.error("Failed to suspend user"),
  })

  const restoreMutation = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: string }) => {
      const { getToken, getApiUrl } = await import("../../../lib/api")
      const token = getToken()
      const res = await fetch(`${getApiUrl()}/admin/users/${userId}/ban`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ banned: false }),
        credentials: "include",
      })
      if (!res.ok) {
        const fallback = await fetch(`${getApiUrl()}/admin/users/${userId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ banned: false }),
          credentials: "include",
        })
        if (!fallback.ok) throw new Error(await fallback.text())
      }
    },
    onSuccess: () => {
      toast.success("User restored")
      queryClient.invalidateQueries({ queryKey: ["admin", "users"] })
    },
    onError: () => toast.error("Failed to restore user"),
  })

  const columns = useMemo<ColumnDef<AdminUser, any>[]>(
    () => [
      columnHelper.accessor("name", {
        header: "Name",
        cell: (info) => (
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
              <User className="h-4 w-4 text-primary" />
            </div>
            <span className="font-medium">{info.getValue() ?? "—"}</span>
          </div>
        ),
      }),
      columnHelper.accessor("email", {
        header: "Email",
        cell: (info) => (
          <span className="text-muted-foreground">{info.getValue()}</span>
        ),
      }),
      columnHelper.accessor("userType", {
        header: "Role",
        cell: (info) => {
          const user = info.row.original
          const role =
            user.userType === "STAFF"
              ? user.staffRole
              : user.userType === "PUBLISHER"
                ? user.publisherRole
                : user.customerRole
          return (
            <Badge variant="outline" className="capitalize">
              {role?.toLowerCase().replace(/_/g, " ") ??
                user.userType.toLowerCase()}
            </Badge>
          )
        },
      }),
      columnHelper.accessor("banned", {
        header: "Status",
        cell: (info) =>
          info.getValue() ? (
            <Badge variant="destructive">Suspended</Badge>
          ) : (
            <Badge variant="default" className="bg-emerald-500">
              Active
            </Badge>
          ),
      }),
      columnHelper.accessor("createdAt", {
        header: "Created",
        cell: (info) => (
          <span className="text-muted-foreground">
            {format(new Date(info.getValue()), "PP")}
          </span>
        ),
      }),
      columnHelper.display({
        id: "actions",
        cell: (info) => {
          const user = info.row.original
          return (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSelectedUser(user)
                  setRoleDialogOpen(true)
                }}
              >
                <Shield className="mr-1 h-3 w-3" />
                Role
              </Button>
              {user.banned ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    restoreMutation.mutate({
                      userId: user.id,
                      role:
                        user.userType === "CUSTOMER"
                          ? "OWNER"
                          : "PUBLISHER_OWNER",
                    })
                  }
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
                  onClick={() => banMutation.mutate(user.id)}
                  disabled={
                    user.id === currentUser?.id || banMutation.isPending
                  }
                >
                  <Ban className="mr-1 h-3 w-3" />
                  Suspend
                </Button>
              )}
            </div>
          )
        },
      }),
    ],
    [banMutation, restoreMutation, currentUser?.id],
  )

  const filteredUsers = useMemo(() => {
    return users.filter((u) => {
      const matchesSearch =
        search === "" ||
        u.name?.toLowerCase().includes(search.toLowerCase()) ||
        u.email.toLowerCase().includes(search.toLowerCase())
      const matchesRole =
        roleFilter === "all" ||
        u.userType === roleFilter ||
        u.staffRole === roleFilter ||
        u.customerRole === roleFilter ||
        u.publisherRole === roleFilter
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "active" && !u.banned) ||
        (statusFilter === "suspended" && u.banned)
      return matchesSearch && matchesRole && matchesStatus
    })
  }, [users, search, roleFilter, statusFilter])

  const table = useReactTable({
    data: filteredUsers,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    state: { pagination: { pageIndex: 0, pageSize: 20 } },
  })

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
          {isLoading ? "..." : `${filteredUsers.length} users`}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by name or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={roleFilter} onValueChange={setRoleFilter}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Role" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Roles</SelectItem>
            <SelectItem value="CUSTOMER">Customer</SelectItem>
            <SelectItem value="PUBLISHER">Publisher</SelectItem>
            <SelectItem value="STAFF">Staff</SelectItem>
            <SelectItem value="SUPER_ADMIN">Super Admin</SelectItem>
            <SelectItem value="OPERATIONS">Operations</SelectItem>
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
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
          ) : filteredUsers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <User className="h-10 w-10 text-muted-foreground" />
              <p className="text-muted-foreground">No users found</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map((hg) => (
                  <TableRow key={hg.id}>
                    {hg.headers.map((h) => (
                      <TableHead key={h.id}>
                        {h.isPlaceholder
                          ? null
                          : flexRender(
                              h.column.columnDef.header,
                              h.getContext(),
                            )}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        {typeof cell.column.columnDef.cell === "function"
                          ? cell.column.columnDef.cell(cell.getContext())
                          : null}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {filteredUsers.length > 20 && (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {table.getState().pagination.pageIndex + 1} of{" "}
            {table.getPageCount()}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            Next
          </Button>
        </div>
      )}

      <RoleUpdateDialog
        user={selectedUser}
        open={roleDialogOpen}
        onOpenChange={setRoleDialogOpen}
        onSuccess={() => setRoleDialogOpen(false)}
      />
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
