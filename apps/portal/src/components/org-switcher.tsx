"use client"

import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  Badge,
} from "@guestpost/ui"
import { Building2, Check, ChevronsUpDown, Mail } from "lucide-react"
import { toast } from "sonner"
import { api } from "../lib/api"
import { useAuth } from "../lib/auth"

// Org switcher + pending-invite acceptance. Each org is a separate workspace
// (wallet, campaigns, orders are scoped to the active org server-side), so
// switching reloads the dashboard data for the chosen org.
export function OrgSwitcher() {
  const { user, refresh } = useAuth()
  const queryClient = useQueryClient()
  const router = useRouter()
  const [open, setOpen] = useState(false)

  const orgsQ = useQuery({
    queryKey: ["identity", "organizations"],
    queryFn: () => api.identity.listOrganizations(),
  })
  const invitesQ = useQuery({
    queryKey: ["identity", "invites"],
    queryFn: () => api.identity.listInvites(),
    refetchInterval: 60_000,
  })

  const switchMutation = useMutation({
    mutationFn: (organizationId: string) => api.identity.switchOrganization(organizationId),
    onSuccess: async () => {
      await refresh()
      // Every workspace query is org-scoped — clear so the new org's data loads
      queryClient.clear()
      router.refresh()
      toast.success("Switched organization")
    },
    onError: (e: Error) => toast.error(e.message || "Failed to switch"),
  })

  const acceptMutation = useMutation({
    mutationFn: (membershipId: string) => api.identity.acceptInvite(membershipId),
    onSuccess: () => {
      toast.success("Invitation accepted")
      queryClient.invalidateQueries({ queryKey: ["identity"] })
    },
    onError: (e: Error) => toast.error(e.message || "Failed to accept"),
  })
  const declineMutation = useMutation({
    mutationFn: (membershipId: string) => api.identity.declineInvite(membershipId),
    onSuccess: () => {
      toast.success("Invitation declined")
      queryClient.invalidateQueries({ queryKey: ["identity", "invites"] })
    },
    onError: (e: Error) => toast.error(e.message || "Failed to decline"),
  })

  const orgs = orgsQ.data ?? []
  const invites = invitesQ.data ?? []
  const activeOrg = orgs.find((o) => o.isActive) ?? orgs[0]

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button className="flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-accent">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <div className="min-w-0 flex-1 text-left">
            <p className="truncate font-medium">{activeOrg?.name ?? "No organization"}</p>
            {activeOrg && <p className="text-xs text-muted-foreground capitalize">{activeOrg.role.toLowerCase()}</p>}
          </div>
          {invites.length > 0 && (
            <Badge variant="destructive" className="h-5 px-1.5 text-[10px]">{invites.length}</Badge>
          )}
          <ChevronsUpDown className="h-4 w-4 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Organizations</DropdownMenuLabel>
        {orgs.length === 0 && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">No organizations yet</div>
        )}
        {orgs.map((o) => (
          <DropdownMenuItem
            key={o.id}
            onClick={() => !o.isActive && switchMutation.mutate(o.id)}
            className="flex items-center gap-2"
          >
            <Building2 className="h-4 w-4 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{o.name}</p>
              <p className="text-xs text-muted-foreground capitalize">{o.role.toLowerCase()}</p>
            </div>
            {o.isActive && <Check className="h-4 w-4 text-primary" />}
          </DropdownMenuItem>
        ))}

        {invites.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="flex items-center gap-1.5">
              <Mail className="h-3.5 w-3.5" /> Pending invitations
            </DropdownMenuLabel>
            {invites.map((inv) => (
              <div key={inv.membershipId} className="px-2 py-2">
                <p className="truncate text-sm font-medium">{inv.organizationName}</p>
                <p className="mb-2 text-xs text-muted-foreground capitalize">invited as {inv.role.toLowerCase()}</p>
                <div className="flex gap-2">
                  <button
                    className="flex-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                    onClick={() => acceptMutation.mutate(inv.membershipId)}
                    disabled={acceptMutation.isPending}
                  >
                    Accept
                  </button>
                  <button
                    className="flex-1 rounded-md border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                    onClick={() => declineMutation.mutate(inv.membershipId)}
                    disabled={declineMutation.isPending}
                  >
                    Decline
                  </button>
                </div>
              </div>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
