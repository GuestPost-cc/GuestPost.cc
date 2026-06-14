"use client"

// Phase 6.5: platform-website ownership management page.
//
// Every platform-owned website has a `managedByUserId` — the OPERATIONS staff
// member who owns its orders + support tickets by default. A site without
// an owner falls back to the shared Ops queue. Admin can reassign at any
// time; in-flight orders are NOT migrated (per the security review — the
// existing FulfillmentAssignment row keeps its current owner). Only new
// orders + new tickets routed by `createTicket` route to the new owner.

import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../../lib/api"
import {
  Button, Card, CardContent, CardHeader, CardTitle, CardDescription,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
  Badge, Skeleton,
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Input, Label,
} from "@guestpost/ui"
import { toast } from "sonner"

interface PlatformWebsiteRow {
  id: string
  url: string
  domain: string | null
  ownershipType: "PLATFORM" | "PUBLISHER"
  managedByUserId: string | null
  managedBy?: { id: string; name: string | null } | null
}

export default function PlatformWebsitesPage() {
  const qc = useQueryClient()
  const [reassignFor, setReassignFor] = useState<PlatformWebsiteRow | null>(null)
  const [pickedOwnerId, setPickedOwnerId] = useState<string>("")
  const [reason, setReason] = useState("")

  const websitesQ = useQuery({
    queryKey: ["admin", "platform-websites"],
    queryFn: () => api.admin.listPlatformWebsites() as Promise<PlatformWebsiteRow[]>,
  })

  // Ops staff for the picker — only loaded when the reassign dialog opens.
  const opsQ = useQuery({
    queryKey: ["admin", "ops-staff"],
    queryFn: () => api.admin.listOpsStaff(),
    enabled: !!reassignFor,
  })

  const reassignMut = useMutation({
    mutationFn: (vars: { id: string; managedByUserId: string | null; reason: string }) =>
      api.admin.assignWebsite(vars.id, { managedByUserId: vars.managedByUserId, reason: vars.reason || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "platform-websites"] })
      toast.success("Owner updated")
      setReassignFor(null)
      setPickedOwnerId("")
      setReason("")
    },
    onError: (e: Error) => toast.error(e.message || "Failed to reassign"),
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Platform Websites</h1>
        <p className="text-muted-foreground">
          Reassign platform sites between Operations staff. In-flight orders are not migrated; new orders + tickets route to the new owner.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Ownership map</CardTitle>
          <CardDescription>Click <strong>Reassign</strong> to change a site&apos;s manager. Unassigned sites fall back to the shared Operations queue.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {websitesQ.isLoading ? (
            <div className="p-4 space-y-2">
              {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Website</TableHead>
                  <TableHead>Managed by</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {((websitesQ.data ?? []) as PlatformWebsiteRow[]).map(w => (
                  <TableRow key={w.id}>
                    <TableCell className="font-medium">{w.url}</TableCell>
                    <TableCell>
                      {w.managedBy
                        ? <span className="text-sm">{w.managedBy.name || w.managedBy.id}</span>
                        : <Badge variant="outline">Unassigned</Badge>}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => { setReassignFor(w); setPickedOwnerId(w.managedByUserId ?? "") }}
                      >
                        Reassign
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {(websitesQ.data ?? []).length === 0 && (
                  <TableRow><TableCell colSpan={3} className="text-center text-muted-foreground py-6">No platform websites.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!reassignFor} onOpenChange={(v) => !v && setReassignFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reassign “{reassignFor?.url}”</DialogTitle>
            <DialogDescription>
              The new owner sees new orders on this site in their inbox automatically and is the default support assignee for new tickets.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>New owner</Label>
              <Select value={pickedOwnerId} onValueChange={setPickedOwnerId}>
                <SelectTrigger><SelectValue placeholder={opsQ.isLoading ? "Loading…" : "Pick an Ops member"} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__unassigned__">— Unassigned (shared queue) —</SelectItem>
                  {(opsQ.data ?? []).map(o => (
                    <SelectItem key={o.id} value={o.id}>{o.name || o.email}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Reason (audit log)</Label>
              <Input placeholder="e.g. workload rebalance, vacation handoff" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReassignFor(null)}>Cancel</Button>
            <Button
              onClick={() => reassignFor && reassignMut.mutate({
                id: reassignFor.id,
                managedByUserId: pickedOwnerId === "__unassigned__" ? null : pickedOwnerId,
                reason,
              })}
              disabled={!pickedOwnerId || reassignMut.isPending}
            >
              {reassignMut.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
