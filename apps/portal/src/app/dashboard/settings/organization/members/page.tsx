"use client"

import { useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../../../../lib/api"
import { useAuth } from "../../../../../lib/auth"
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
  Input, Button, Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
  Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription,
  DialogFooter, DialogClose, Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
  Label,
} from "@guestpost/ui"
import {
  Skeleton, ErrorState, EmptyState, LoadingState,
} from "@guestpost/ui"
import { RoleBadge } from "../../../../../components/RoleBadge"
import { toast } from "sonner"
import { Search, Users, UserPlus, UserMinus, Loader2, Mail, ShieldAlert } from "lucide-react"

export default function OrgMembersPage() {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const orgId = user?.organizationId
  const isOwner = user?.customerRole === "OWNER"

  const [search, setSearch] = useState("")
  const [inviteOpen, setInviteOpen] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string | null; email: string } | null>(null)

  const { data: members, isLoading, error, refetch } = useQuery({
    queryKey: ["org-members", orgId],
    queryFn: () => api.identity.listMembers(orgId!),
    enabled: !!orgId,
  })

  const inviteMutation = useMutation({
    mutationFn: (data: { email: string; role: string }) => api.identity.inviteMember(orgId!, data),
    onSuccess: () => {
      toast.success("Member invited successfully")
      setInviteOpen(false)
      queryClient.invalidateQueries({ queryKey: ["org-members", orgId] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const removeMutation = useMutation({
    mutationFn: (targetUserId: string) => api.identity.removeMember(orgId!, targetUserId),
    onSuccess: () => {
      toast.success("Member removed")
      setRemoveTarget(null)
      queryClient.invalidateQueries({ queryKey: ["org-members", orgId] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const filtered = members?.filter((m) => {
    if (!search) return true
    const q = search.toLowerCase()
    return m.name?.toLowerCase().includes(q) || m.email.toLowerCase().includes(q)
  })

  if (!orgId) {
    return <EmptyState icon={Users} title="No organization" description="You are not part of an organization." />
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search members..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        {isOwner && (
          <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
            <DialogTrigger asChild>
              <Button>
                <UserPlus className="mr-2 h-4 w-4" />
                Invite Member
              </Button>
            </DialogTrigger>
            <DialogContent>
              <InviteMemberForm
                onSubmit={(data) => inviteMutation.mutate(data)}
                isLoading={inviteMutation.isPending}
              />
            </DialogContent>
          </Dialog>
        )}
      </div>

      {isLoading ? (
        <LoadingState variant="table" />
      ) : error ? (
        <ErrorState title="Failed to load members" description={(error as Error).message} onRetry={() => refetch()} />
      ) : !filtered || filtered.length === 0 ? (
        <EmptyState
          icon={Users}
          title={search ? "No members match your search" : "No members yet"}
          description={search ? "Try a different search term." : "Invite members to collaborate on campaigns."}
          action={isOwner && !search ? { label: "Invite Member", onClick: () => setInviteOpen(true) } : undefined}
        />
      ) : (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{filtered.length} member{filtered.length !== 1 ? "s" : ""}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="hidden md:table-cell">Joined</TableHead>
                  <TableHead className="w-20"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="font-medium">{m.name || "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{m.email}</TableCell>
                    <TableCell><RoleBadge role={m.role} /></TableCell>
                    <TableCell className="hidden md:table-cell text-muted-foreground text-sm">
                      {new Date(m.joinedAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      {isOwner && m.role !== "OWNER" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={() => setRemoveTarget({ id: m.userId, name: m.name, email: m.email })}
                        >
                          <UserMinus className="h-4 w-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Dialog open={!!removeTarget} onOpenChange={(open) => { if (!open) setRemoveTarget(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove Member</DialogTitle>
            <DialogDescription>
              This will remove <strong>{removeTarget?.name || removeTarget?.email}</strong> from the organization.
              They will lose access to all organization resources.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-3 rounded-lg border bg-muted/50 p-4 text-sm">
            <ShieldAlert className="h-5 w-5 text-destructive shrink-0" />
            <p className="text-muted-foreground">
              This action cannot be undone. The member will need a new invitation to rejoin.
            </p>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => removeTarget && removeMutation.mutate(removeTarget.id)}
              disabled={removeMutation.isPending}
            >
              {removeMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Remove Member
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function InviteMemberForm({
  onSubmit,
  isLoading,
}: {
  onSubmit: (data: { email: string; role: string }) => void
  isLoading: boolean
}) {
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(
      z.object({
        email: z.string().email("Invalid email address"),
        role: z.string().min(1, "Role is required"),
      })
    ),
    defaultValues: { email: "", role: "MEMBER" },
  })

  return (
    <form onSubmit={handleSubmit((data) => onSubmit({ email: data.email.trim(), role: data.role }))}>
      <DialogHeader className="mb-4">
        <DialogTitle>Invite Member</DialogTitle>
        <DialogDescription>Send an invitation to join this organization.</DialogDescription>
      </DialogHeader>
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              id="email"
              type="email"
              placeholder="colleague@example.com"
              {...register("email")}
              className="pl-9"
              autoFocus
            />
          </div>
          {errors.email?.message && (
            <p className="text-sm text-destructive">{errors.email.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="role">Role</Label>
          <Select value={watch("role")} onValueChange={(v) => setValue("role", v)}>
            <SelectTrigger id="role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="OWNER">Owner</SelectItem>
              <SelectItem value="MEMBER">Member</SelectItem>
            </SelectContent>
          </Select>
          {errors.role?.message && (
            <p className="text-sm text-destructive">{errors.role.message}</p>
          )}
        </div>
      </div>
      <DialogFooter className="mt-6">
        <DialogClose asChild>
          <Button type="button" variant="outline">Cancel</Button>
        </DialogClose>
        <Button type="submit" disabled={isLoading}>
          {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Send Invitation
        </Button>
      </DialogFooter>
    </form>
  )
}
