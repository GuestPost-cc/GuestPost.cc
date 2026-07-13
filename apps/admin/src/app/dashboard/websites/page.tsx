"use client"

// Phase 6.5: platform-website ownership management page.
//
// Every platform-owned website has a `managedByUserId` — the OPERATIONS staff
// member who owns its orders + support tickets by default. A site without
// an owner falls back to the shared Ops queue. Admin can reassign at any
// time; in-flight orders are NOT migrated (per the security review — the
// existing FulfillmentAssignment row keeps its current owner). Only new
// orders + new tickets routed by `createTicket` route to the new owner.

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
} from "@guestpost/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { api } from "../../../lib/api"

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
  const [reassignFor, setReassignFor] = useState<PlatformWebsiteRow | null>(
    null,
  )
  const [pickedOwnerId, setPickedOwnerId] = useState<string>("")
  const [reason, setReason] = useState("")

  const websitesQ = useQuery({
    queryKey: ["admin", "platform-websites"],
    queryFn: () =>
      api.admin.listPlatformWebsites() as Promise<PlatformWebsiteRow[]>,
  })

  // Ops staff for the picker — only loaded when the reassign dialog opens.
  const opsQ = useQuery({
    queryKey: ["admin", "ops-staff"],
    queryFn: () => api.admin.listOpsStaff(),
    enabled: !!reassignFor,
  })

  const reassignMut = useMutation({
    mutationFn: (vars: {
      id: string
      managedByUserId: string | null
      reason: string
    }) =>
      api.admin.assignWebsite(vars.id, {
        managedByUserId: vars.managedByUserId,
        reason: vars.reason || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "platform-websites"] })
      toast.success("Owner updated")
      setReassignFor(null)
      setPickedOwnerId("")
      setReason("")
    },
    onError: (e: Error) => toast.error(e.message || "Failed to reassign"),
  })

  // ── Create platform website state ──
  const [showCreate, setShowCreate] = useState(false)
  const [createForm, setCreateForm] = useState({
    url: "",
    name: "",
    category: "",
    language: "",
    country: "",
    domainRating: "",
    monthlyTraffic: "",
  })

  const createMut = useMutation({
    mutationFn: () =>
      api.admin.createPlatformWebsite({
        url: createForm.url.trim(),
        name: createForm.name.trim() || undefined,
        category: createForm.category.trim() || undefined,
        language: createForm.language.trim() || undefined,
        country: createForm.country.trim() || undefined,
        domainRating: createForm.domainRating
          ? Number(createForm.domainRating)
          : undefined,
        monthlyTraffic: createForm.monthlyTraffic
          ? Number(createForm.monthlyTraffic)
          : undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "platform-websites"] })
      toast.success("Platform website created")
      setShowCreate(false)
      setCreateForm({
        url: "",
        name: "",
        category: "",
        language: "",
        country: "",
        domainRating: "",
        monthlyTraffic: "",
      })
    },
    onError: (e: Error) => toast.error(e.message || "Failed to create website"),
  })

  const canCreate = createForm.url.trim().length > 0

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Platform Websites</h1>
        <p className="text-muted-foreground">
          Reassign platform sites between Operations staff. In-flight orders are
          not migrated; new orders + tickets route to the new owner.
        </p>
      </div>

      <div className="flex items-center justify-end">
        <Button onClick={() => setShowCreate(true)} className="gap-2">
          <Plus className="h-4 w-4" />
          Create Website
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Ownership map</CardTitle>
          <CardDescription>
            Click <strong>Reassign</strong> to change a site&apos;s manager.
            Unassigned sites fall back to the shared Operations queue.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {websitesQ.isLoading ? (
            <div className="p-4 space-y-2">
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
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
                {((websitesQ.data ?? []) as PlatformWebsiteRow[]).map((w) => (
                  <TableRow key={w.id}>
                    <TableCell className="font-medium">{w.url}</TableCell>
                    <TableCell>
                      {w.managedBy ? (
                        <span className="text-sm">
                          {w.managedBy.name || w.managedBy.id}
                        </span>
                      ) : (
                        <Badge variant="outline">Unassigned</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setReassignFor(w)
                          setPickedOwnerId(w.managedByUserId ?? "")
                        }}
                      >
                        Reassign
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {(websitesQ.data ?? []).length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={3}
                      className="text-center text-muted-foreground py-6"
                    >
                      No platform websites.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={!!reassignFor}
        onOpenChange={(v) => !v && setReassignFor(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reassign “{reassignFor?.url}”</DialogTitle>
            <DialogDescription>
              The new owner sees new orders on this site in their inbox
              automatically and is the default support assignee for new tickets.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>New owner</Label>
              <Select value={pickedOwnerId} onValueChange={setPickedOwnerId}>
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      opsQ.isLoading ? "Loading…" : "Pick an Ops member"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__unassigned__">
                    — Unassigned (shared queue) —
                  </SelectItem>
                  {(opsQ.data ?? []).map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.name || o.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Reason (audit log)</Label>
              <Input
                placeholder="e.g. workload rebalance, vacation handoff"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={200}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReassignFor(null)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                reassignFor &&
                reassignMut.mutate({
                  id: reassignFor.id,
                  managedByUserId:
                    pickedOwnerId === "__unassigned__" ? null : pickedOwnerId,
                  reason,
                })
              }
              disabled={!pickedOwnerId || reassignMut.isPending}
            >
              {reassignMut.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create platform website dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Platform Website</DialogTitle>
            <DialogDescription>
              Add a website the platform owns. DNS verification is automatic for
              platform-owned sites.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>Website URL *</Label>
              <Input
                placeholder="https://example.com"
                value={createForm.url}
                onChange={(e) =>
                  setCreateForm({ ...createForm, url: e.target.value })
                }
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>Name</Label>
                <Input
                  placeholder="My Site"
                  value={createForm.name}
                  onChange={(e) =>
                    setCreateForm({ ...createForm, name: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label>Category</Label>
                <Input
                  placeholder="Technology"
                  value={createForm.category}
                  onChange={(e) =>
                    setCreateForm({ ...createForm, category: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label>Language</Label>
                <Input
                  placeholder="en"
                  value={createForm.language}
                  onChange={(e) =>
                    setCreateForm({ ...createForm, language: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label>Country</Label>
                <Input
                  placeholder="US"
                  value={createForm.country}
                  onChange={(e) =>
                    setCreateForm({ ...createForm, country: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label>Domain Rating</Label>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  placeholder="60"
                  value={createForm.domainRating}
                  onChange={(e) =>
                    setCreateForm({
                      ...createForm,
                      domainRating: e.target.value,
                    })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label>Monthly Traffic</Label>
                <Input
                  type="number"
                  min={0}
                  placeholder="10000"
                  value={createForm.monthlyTraffic}
                  onChange={(e) =>
                    setCreateForm({
                      ...createForm,
                      monthlyTraffic: e.target.value,
                    })
                  }
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createMut.mutate()}
              disabled={!canCreate || createMut.isPending}
            >
              {createMut.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
