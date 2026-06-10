"use client"

import { useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../../../../lib/api"
import { useAuth } from "../../../../../lib/auth"
import {
  Card, CardContent, CardHeader, CardTitle,
  Button, Input, Label,
  Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription,
  DialogFooter, DialogClose,
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
  Skeleton,
} from "@guestpost/ui"
import { ErrorState, EmptyState, LoadingState } from "@guestpost/ui"
import { toast } from "sonner"
import { Group, Plus, Trash2, Loader2, AlertTriangle, CalendarDays } from "lucide-react"

export default function OrgTeamsPage() {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const orgId = user?.organizationId
  const isOwner = user?.customerRole === "OWNER"

  const [createOpen, setCreateOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)

  const { data: teams, isLoading, error, refetch } = useQuery({
    queryKey: ["org-teams", orgId],
    queryFn: () => api.identity.listTeams(orgId!),
    enabled: !!orgId,
  })

  const createMutation = useMutation({
    mutationFn: (name: string) => api.identity.createTeam(orgId!, { name }),
    onSuccess: () => {
      toast.success("Team created")
      setCreateOpen(false)
      queryClient.invalidateQueries({ queryKey: ["org-teams", orgId] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const deleteMutation = useMutation({
    mutationFn: (teamId: string) => api.identity.deleteTeam(orgId!, teamId),
    onSuccess: () => {
      toast.success("Team deleted")
      setDeleteTarget(null)
      queryClient.invalidateQueries({ queryKey: ["org-teams", orgId] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  if (!orgId) {
    return <EmptyState icon={Group} title="No organization" description="You are not part of an organization." />
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">
            {teams ? `${teams.length} team${teams.length !== 1 ? "s" : ""}` : ""}
          </p>
        </div>
        {isOwner && (
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Create Team
              </Button>
            </DialogTrigger>
            <DialogContent>
              <CreateTeamForm
                onSubmit={(name) => createMutation.mutate(name)}
                isLoading={createMutation.isPending}
              />
            </DialogContent>
          </Dialog>
        )}
      </div>

      {isLoading ? (
        <LoadingState variant="table" />
      ) : error ? (
        <ErrorState title="Failed to load teams" onRetry={() => refetch()} />
      ) : !teams || teams.length === 0 ? (
        <EmptyState
          icon={Group}
          title="No teams yet"
          description="Teams help you organize your members into groups."
          action={isOwner ? { label: "Create Team", onClick: () => setCreateOpen(true) } : undefined}
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Team Name</TableHead>
                  <TableHead className="hidden sm:table-cell">Created</TableHead>
                  {isOwner && <TableHead className="w-20"></TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {teams.map((team) => (
                  <TableRow key={team.id}>
                    <TableCell className="font-medium">{team.name}</TableCell>
                    <TableCell className="hidden sm:table-cell text-muted-foreground text-sm">
                      <span className="inline-flex items-center gap-1.5">
                        <CalendarDays className="h-3.5 w-3.5" />
                        {new Date(team.createdAt).toLocaleDateString()}
                      </span>
                    </TableCell>
                    {isOwner && (
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={() => setDeleteTarget({ id: team.id, name: team.name })}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Team</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete <strong>{deleteTarget?.name}</strong>?
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-3 rounded-lg border bg-muted/50 p-4 text-sm">
            <AlertTriangle className="h-5 w-5 text-destructive shrink-0" />
            <p className="text-muted-foreground">
              The team will be permanently removed. Any members assigned to this team will be unlinked.
            </p>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete Team
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function CreateTeamForm({
  onSubmit,
  isLoading,
}: {
  onSubmit: (name: string) => void
  isLoading: boolean
}) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(
      z.object({
        name: z.string().min(1, "Name is required"),
      })
    ),
    defaultValues: { name: "" },
  })

  return (
    <form onSubmit={handleSubmit((data) => onSubmit(data.name.trim()))}>
      <DialogHeader className="mb-4">
        <DialogTitle>Create Team</DialogTitle>
        <DialogDescription>Add a new team to organize your members.</DialogDescription>
      </DialogHeader>
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="team-name">Team Name</Label>
          <Input
            id="team-name"
            placeholder="e.g. Outreach Team"
            {...register("name")}
            autoFocus
          />
        </div>
        {errors.name?.message && (
          <p className="text-sm text-destructive">{errors.name.message}</p>
        )}
      </div>
      <DialogFooter className="mt-6">
        <DialogClose asChild>
          <Button type="button" variant="outline">Cancel</Button>
        </DialogClose>
        <Button type="submit" disabled={isLoading}>
          {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Create Team
        </Button>
      </DialogFooter>
    </form>
  )
}
