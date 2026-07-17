"use client"

// Phase 6.5: platform-website ownership management page.
//
// Every platform-owned website has a `managedByUserId` — the OPERATIONS staff
// member who owns its orders + support tickets by default. A site without
// an owner falls back to the shared Ops queue. Admin can reassign at any
// time; in-flight orders are NOT migrated (per the security review — the
// existing FulfillmentAssignment row keeps its current owner). Only new
// orders + new tickets routed by `createTicket` route to the new owner.

import type {
  AdminOpsStaffResponse,
  AdminPlatformWebsiteResponse,
} from "@guestpost/api-client"
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
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@guestpost/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AlertCircle,
  Check,
  Globe2,
  Inbox,
  Plus,
  UserRound,
} from "lucide-react"
import Link from "next/link"
import { useState } from "react"
import { toast } from "sonner"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"
import { ForbiddenPage, useRequireRole } from "../../../lib/use-require-role"

export default function PlatformWebsitesPage() {
  const { allowed, loading } = useRequireRole("SUPER_ADMIN", "OPERATIONS")
  if (loading) return null
  if (!allowed) return <ForbiddenPage requires="Operations or Super Admin" />
  return <PlatformWebsitesPageInner />
}

function PlatformWebsitesPageInner() {
  const { user } = useAuth()
  const qc = useQueryClient()
  const isSuperAdmin = user?.staffRole === "SUPER_ADMIN"
  const [reassignFor, setReassignFor] =
    useState<AdminPlatformWebsiteResponse | null>(null)
  const [pickedOwnerId, setPickedOwnerId] = useState<string | null | undefined>(
    undefined,
  )
  const [reason, setReason] = useState("")

  const websitesQ = useQuery({
    queryKey: ["admin", "platform-websites"],
    queryFn: () => api.admin.listPlatformWebsites(),
  })

  // Ops staff for the picker — only loaded when the reassign dialog opens.
  const opsQ = useQuery({
    queryKey: ["admin", "operations-staff"],
    queryFn: () => api.admin.listOpsStaff(),
    enabled: isSuperAdmin && !!reassignFor,
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
      setPickedOwnerId(undefined)
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
  const websites = websitesQ.data ?? []
  const assignedCount = websites.filter((website) => website.managedBy).length
  const unassignedCount = websites.length - assignedCount
  const currentOwnerId = reassignFor?.managedByUserId ?? null
  const opsStaff = (opsQ.data ?? []) as AdminOpsStaffResponse[]
  const ownerChanged =
    pickedOwnerId !== undefined && pickedOwnerId !== currentOwnerId
  const normalizedReason = reason.trim()
  const reasonInvalid =
    normalizedReason.length > 0 && normalizedReason.length < 10

  const closeReassignDialog = () => {
    setReassignFor(null)
    setPickedOwnerId(undefined)
    setReason("")
    reassignMut.reset()
  }

  const openReassignDialog = (website: AdminPlatformWebsiteResponse) => {
    setReassignFor(website)
    setPickedOwnerId(website.managedByUserId ?? null)
    setReason("")
    reassignMut.reset()
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            Platform Websites
          </h1>
          <p className="mt-1 max-w-3xl text-muted-foreground">
            {isSuperAdmin
              ? "Create each domain once, manage its single listing and services, connect Google data, and route new work to Operations."
              : "Create platform websites assigned to you, manage their listing services and Google data, and receive their new orders automatically."}
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)} className="gap-2">
          <Plus className="h-4 w-4" />
          Create Website
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="flex items-center gap-3 p-5">
            <div className="rounded-lg bg-primary/10 p-2 text-primary">
              <Globe2 className="h-5 w-5" />
            </div>
            <div>
              <p className="text-2xl font-semibold">{websites.length}</p>
              <p className="text-sm text-muted-foreground">Platform sites</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-5">
            <div className="rounded-lg bg-emerald-500/10 p-2 text-emerald-600">
              <UserRound className="h-5 w-5" />
            </div>
            <div>
              <p className="text-2xl font-semibold">{assignedCount}</p>
              <p className="text-sm text-muted-foreground">Assigned</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-5">
            <div className="rounded-lg bg-amber-500/10 p-2 text-amber-600">
              <Inbox className="h-5 w-5" />
            </div>
            <div>
              <p className="text-2xl font-semibold">{unassignedCount}</p>
              <p className="text-sm text-muted-foreground">Shared queue</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Platform inventory</CardTitle>
          <CardDescription>
            One website owns one marketplace listing; all service offerings sit
            under that listing. Google integrations are data sources and do not
            require DNS verification.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {websitesQ.isLoading ? (
            <div className="p-4 space-y-2">
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : websitesQ.isError ? (
            <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
              <AlertCircle className="h-9 w-9 text-destructive" />
              <div>
                <p className="font-medium">Could not load platform websites</p>
                <p className="text-sm text-muted-foreground">
                  {(websitesQ.error as Error).message}
                </p>
              </div>
              <Button variant="outline" onClick={() => websitesQ.refetch()}>
                Try again
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Website</TableHead>
                  <TableHead>Listing</TableHead>
                  <TableHead>Google data</TableHead>
                  <TableHead>Managed by</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {websites.map((w) => (
                  <TableRow key={w.id}>
                    <TableCell>
                      <p className="font-medium">{w.url}</p>
                      {w.domain && (
                        <p className="text-xs text-muted-foreground">
                          {w.domain}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      {w.listing ? (
                        <div className="space-y-1">
                          <Badge variant="outline">{w.listing.status}</Badge>
                          <p className="text-xs text-muted-foreground">
                            {w.listing.services.length} service
                            {w.listing.services.length === 1 ? "" : "s"}
                          </p>
                        </div>
                      ) : (
                        <Badge variant="destructive">Missing listing</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {w.integrations.map((integration) => (
                          <Badge key={integration.id} variant="secondary">
                            {integration.provider === "GOOGLE_SEARCH_CONSOLE"
                              ? "GSC"
                              : integration.provider === "GOOGLE_ANALYTICS"
                                ? "GA4"
                                : integration.provider}
                          </Badge>
                        ))}
                        {w.integrations.length === 0 && (
                          <span className="text-xs text-muted-foreground">
                            Not linked
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      {w.managedBy ? (
                        <div>
                          <p className="text-sm font-medium">
                            {w.managedBy.name || w.managedBy.email}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {w.managedBy.email}
                          </p>
                        </div>
                      ) : (
                        <Badge variant="warning">Shared Ops queue</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        {isSuperAdmin && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openReassignDialog(w)}
                          >
                            Change owner
                          </Button>
                        )}
                        <Button asChild size="sm">
                          <Link href={`/dashboard/websites/${w.id}`}>
                            Manage
                          </Link>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {websites.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={5}
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
        onOpenChange={(open) => !open && closeReassignDialog()}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Change website owner</DialogTitle>
            <DialogDescription>
              Choose who receives new orders and support tickets for{" "}
              <span className="font-medium text-foreground">
                {reassignFor?.url}
              </span>
              . Existing assignments will not move.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Current routing owner
              </p>
              {reassignFor?.managedBy ? (
                <div className="mt-2 flex items-center gap-3">
                  <div className="rounded-full bg-primary/10 p-2 text-primary">
                    <UserRound className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">
                      {reassignFor.managedBy.name ||
                        reassignFor.managedBy.email}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {reassignFor.managedBy.email}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="mt-2 flex items-center gap-3">
                  <div className="rounded-full bg-amber-500/10 p-2 text-amber-600">
                    <Inbox className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">Shared Ops queue</p>
                    <p className="text-xs text-muted-foreground">
                      No individual owner is currently assigned.
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label id="new-owner-label">New owner</Label>
                <span className="text-xs text-muted-foreground">
                  Active Operations staff only
                </span>
              </div>
              <div
                role="radiogroup"
                aria-labelledby="new-owner-label"
                className="max-h-72 space-y-2 overflow-y-auto rounded-lg border p-2"
              >
                {opsQ.isLoading &&
                  [...Array(2)].map((_, index) => (
                    <Skeleton key={index} className="h-16 w-full" />
                  ))}

                {opsQ.isError && (
                  <div
                    role="alert"
                    className="rounded-md border border-destructive/30 bg-destructive/5 p-3"
                  >
                    <div className="flex items-start gap-2">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">
                          Could not load Operations staff
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {(opsQ.error as Error).message}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => opsQ.refetch()}
                      >
                        Retry
                      </Button>
                    </div>
                  </div>
                )}

                {!opsQ.isLoading && !opsQ.isError && opsStaff.length === 0 && (
                  <div className="rounded-md border border-dashed p-4 text-center">
                    <p className="text-sm font-medium">
                      No active Operations staff found
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Add an Operations staff role before assigning an
                      individual owner.
                    </p>
                  </div>
                )}

                {!opsQ.isLoading &&
                  !opsQ.isError &&
                  opsStaff.map((member) => {
                    const selected = pickedOwnerId === member.id
                    const current = currentOwnerId === member.id
                    return (
                      <button
                        key={member.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => setPickedOwnerId(member.id)}
                        className={
                          selected
                            ? "flex w-full items-center gap-3 rounded-md border border-primary bg-primary/5 p-3 text-left ring-1 ring-primary transition-colors"
                            : "flex w-full items-center gap-3 rounded-md border p-3 text-left transition-colors hover:border-primary/40 hover:bg-muted/50"
                        }
                      >
                        <div className="rounded-full bg-primary/10 p-2 text-primary">
                          <UserRound className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-sm font-medium">
                              {member.name || member.email}
                            </p>
                            {current && (
                              <Badge variant="secondary">Current</Badge>
                            )}
                          </div>
                          <p className="truncate text-xs text-muted-foreground">
                            {member.email}
                          </p>
                        </div>
                        {selected && <Check className="h-4 w-4 text-primary" />}
                      </button>
                    )
                  })}

                <button
                  type="button"
                  role="radio"
                  aria-checked={pickedOwnerId === null}
                  onClick={() => setPickedOwnerId(null)}
                  className={
                    pickedOwnerId === null
                      ? "flex w-full items-center gap-3 rounded-md border border-primary bg-primary/5 p-3 text-left ring-1 ring-primary transition-colors"
                      : "flex w-full items-center gap-3 rounded-md border p-3 text-left transition-colors hover:border-primary/40 hover:bg-muted/50"
                  }
                >
                  <div className="rounded-full bg-amber-500/10 p-2 text-amber-600">
                    <Inbox className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">Shared Ops queue</p>
                      {currentOwnerId === null && (
                        <Badge variant="secondary">Current</Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      New work remains unassigned for the team to claim.
                    </p>
                  </div>
                  {pickedOwnerId === null && (
                    <Check className="h-4 w-4 text-primary" />
                  )}
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="reassignment-reason">Reason (audit log)</Label>
                <span className="text-xs text-muted-foreground">
                  Optional · {normalizedReason.length}/200
                </span>
              </div>
              <Input
                id="reassignment-reason"
                placeholder="e.g. workload rebalance, vacation handoff"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={200}
                aria-invalid={reasonInvalid}
              />
              {reasonInvalid && (
                <p className="text-xs text-destructive">
                  Use at least 10 characters so the audit reason is meaningful.
                </p>
              )}
            </div>

            {reassignMut.isError && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <div>
                  <p className="text-sm font-medium">Assignment not saved</p>
                  <p className="text-xs text-muted-foreground">
                    {(reassignMut.error as Error).message}
                  </p>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeReassignDialog}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                reassignFor &&
                pickedOwnerId !== undefined &&
                reassignMut.mutate({
                  id: reassignFor.id,
                  managedByUserId: pickedOwnerId,
                  reason: normalizedReason,
                })
              }
              disabled={!ownerChanged || reasonInvalid || reassignMut.isPending}
            >
              {reassignMut.isPending ? "Saving..." : "Save assignment"}
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
              Add a platform-owned domain and its single draft listing in one
              transaction. DNS verification is not required; Google data can be
              linked after creation.
              {!isSuperAdmin &&
                " The site and every new order placed through it will be assigned to you automatically."}
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
