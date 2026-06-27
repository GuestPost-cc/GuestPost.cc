"use client"

import {
  Badge,
  Button,
  Card,
  CardContent,
  Checkbox,
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
  Textarea,
} from "@guestpost/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertCircle, Edit3, Plus, RefreshCw, Store } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"

const SERVICE_TYPES = [
  "GUEST_POST",
  "NICHE_EDIT",
  "EDITORIAL_LINK",
  "OUTREACH_LINK",
  "LOCAL_CITATION",
  "FOUNDATION_LINK",
  "BLOG_ARTICLE",
  "SEO_CONTENT",
] as const

const STATUS_VARIANTS: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  APPROVED: "default",
  PENDING_REVIEW: "secondary",
  DRAFT: "outline",
  REJECTED: "destructive",
  PAUSED: "secondary",
  ARCHIVED: "outline",
}

// Services-tab state. A listing's services live on the listing row itself
// (response includes services[]); per-row writes go through the dedicated
// /listings/:id/services endpoints to avoid bulk-replacing.
type ServiceRow = {
  id: string
  serviceType: string
  price: number
  currency: string
  turnaroundDays: number
  revisionRounds: number
  warrantyDays?: number | null
  availability: "AVAILABLE" | "PAUSED" | "WAITLIST"
  version: number
}

export default function PublisherListingsPage() {
  const { user } = useAuth()
  const publisherId = (user as any)?.publisherId as string | undefined
  const queryClient = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [servicesForListing, setServicesForListing] = useState<{
    id: string
    title: string
    services: ServiceRow[]
  } | null>(null)
  const [editingListing, setEditingListing] = useState<{
    id: string
    title: string
    description: string
  } | null>(null)
  const [editingService, setEditingService] = useState<{
    listingId: string
    serviceId: string
    version: number
    price: string
    turnaroundDays: string
    revisionRounds: string
    warrantyDays: string
    currency: string
  } | null>(null)
  const [form, setForm] = useState({
    title: "",
    description: "",
    websiteId: "",
    addServiceNow: false,
  })
  const [initialService, setInitialService] = useState({
    serviceType: "GUEST_POST",
    price: "",
    turnaroundDays: "7",
    revisionRounds: "2",
  })
  const [newService, setNewService] = useState({
    serviceType: "GUEST_POST",
    price: "",
    turnaroundDays: "7",
    revisionRounds: "2",
    warrantyDays: "",
    currency: "USD",
  })

  const listingsQ = useQuery({
    queryKey: ["publisher-listings", publisherId],
    queryFn: () => api.marketplace.getPublisherListings(publisherId!),
    enabled: !!publisherId,
  })

  const websitesQ = useQuery({
    queryKey: ["publisher-websites", publisherId],
    queryFn: async () =>
      (await api.publishers.getWebsites(publisherId!)) as any[],
    enabled: !!publisherId && showCreate,
  })

  const createMutation = useMutation({
    mutationFn: () =>
      api.marketplace.createListing({
        title: form.title.trim(),
        description: form.description.trim(),
        websiteId: form.websiteId || undefined,
        // Phase 7: optionally create with the first service inline.
        services: form.addServiceNow
          ? [
              {
                serviceType: initialService.serviceType,
                price: Number(initialService.price),
                turnaroundDays: Number(initialService.turnaroundDays) || 7,
                revisionRounds: Number(initialService.revisionRounds) || 2,
              },
            ]
          : undefined,
      }),
    onSuccess: () => {
      toast.success("Listing created")
      queryClient.invalidateQueries({ queryKey: ["publisher-listings"] })
      setShowCreate(false)
      setForm({
        title: "",
        description: "",
        websiteId: "",
        addServiceNow: false,
      })
      setInitialService({
        serviceType: "GUEST_POST",
        price: "",
        turnaroundDays: "7",
        revisionRounds: "2",
      })
    },
    onError: (err: Error) =>
      toast.error(err.message || "Failed to create listing"),
  })

  // Service-management mutations (per-row endpoints). All three invalidate
  // the publisher-listings query so the table reflects new state.
  type AddServiceVars = {
    listingId: string
    data: {
      serviceType: string
      price: number
      turnaroundDays: number
      currency?: string
      revisionRounds?: number
      warrantyDays?: number
      availability?: "AVAILABLE" | "PAUSED" | "WAITLIST"
    }
  }
  type UpdateServiceVars = {
    listingId: string
    serviceId: string
    data: {
      version: number
      price?: number
      turnaroundDays?: number
      currency?: string
      revisionRounds?: number
      warrantyDays?: number
      availability?: "AVAILABLE" | "PAUSED" | "WAITLIST"
    }
  }
  const addServiceMut = useMutation({
    mutationFn: (vars: AddServiceVars) =>
      api.marketplace.addListingService(vars.listingId, vars.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["publisher-listings"] })
      setNewService({
        serviceType: "GUEST_POST",
        price: "",
        turnaroundDays: "7",
        revisionRounds: "2",
        warrantyDays: "",
        currency: "USD",
      })
      toast.success("Service added")
    },
    onError: (e: Error) => toast.error(e.message || "Failed to add service"),
  })
  const updateServiceMut = useMutation({
    mutationFn: (vars: UpdateServiceVars) =>
      api.marketplace.updateListingService(
        vars.listingId,
        vars.serviceId,
        vars.data,
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["publisher-listings"] }),
    onError: (e: Error) => toast.error(e.message || "Update failed"),
  })
  const pauseServiceMut = useMutation({
    mutationFn: (vars: { listingId: string; serviceId: string }) =>
      api.marketplace.pauseListingService(vars.listingId, vars.serviceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["publisher-listings"] })
      toast.success("Service paused")
    },
    onError: (e: Error) => toast.error(e.message || "Pause failed"),
  })

  // ── Phase 6 lifecycle mutations (publisher-side) ────────────────────────
  // Phase 7.9 #30 — inlined the 4 useMutation calls (was a
  // makeLifecycleMutation factory that wrapped useMutation inside a
  // regular function; technically functioned but violated the
  // rules-of-hooks because the hook is called via a non-hook helper).
  // Each transition refreshes the listings query so the phase badge moves
  // immediately. Errors surface with the server's friendly message
  // (NO_AVAILABLE_SERVICES, WEBSITE_NOT_VERIFIED, etc.).
  function lifecycleOpts(label: string) {
    return {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["publisher-listings"] })
        toast.success(label)
      },
      onError: (e: any) => toast.error(e?.message || `${label} failed`),
    }
  }
  const submitMut = useMutation({
    mutationFn: (id: string) => api.marketplace.submitListing(id),
    ...lifecycleOpts("Submitted for review"),
  })
  const pauseMut = useMutation({
    mutationFn: (id: string) => api.marketplace.pauseListing(id),
    ...lifecycleOpts("Listing paused"),
  })
  const unpauseMut = useMutation({
    mutationFn: (id: string) => api.marketplace.unpauseListing(id),
    ...lifecycleOpts("Listing unpaused"),
  })
  const archiveMut = useMutation({
    mutationFn: (id: string) => api.marketplace.archiveListing(id),
    ...lifecycleOpts("Listing archived"),
  })

  // ── Listing metadata edit ─────────────────────────────────────────────
  const updateListingMut = useMutation({
    mutationFn: (vars: { id: string; title: string; description: string }) =>
      api.marketplace.updateListing(vars.id, {
        title: vars.title.trim(),
        description: vars.description.trim(),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["publisher-listings"] })
      setEditingListing(null)
      toast.success("Listing updated")
    },
    onError: (e: Error) => toast.error(e.message || "Update failed"),
  })

  const listings = (listingsQ.data ?? []) as any[]
  const canSubmit =
    form.title.trim().length >= 3 && form.description.trim().length >= 1

  if (listingsQ.error) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <AlertCircle className="h-12 w-12 text-destructive mb-4" />
        <h2 className="text-xl font-semibold mb-2">Failed to load listings</h2>
        <p className="text-muted-foreground mb-4">
          {(listingsQ.error as Error).message}
        </p>
        <Button onClick={() => listingsQ.refetch()}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            Marketplace Listings
          </h1>
          <p className="text-muted-foreground">
            Your inventory on the marketplace. New listings are reviewed by
            staff before going live.
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New Listing
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {listingsQ.isLoading ? (
            <div className="p-4 space-y-3">
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : listings.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Store className="h-12 w-12 text-muted-foreground/50" />
              <h3 className="mt-4 text-lg font-medium">No listings yet</h3>
              <p className="text-sm text-muted-foreground">
                Create your first listing to start receiving orders
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Services</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {listings.map((l: any) => {
                  const services: ServiceRow[] =
                    (l.services as ServiceRow[] | undefined) ?? []
                  // Phase 6: lifecyclePhase comes from the server (computed
                  // from status + ownerType + website verification + service
                  // count). The phase decides which lifecycle CTAs render —
                  // the raw status badge below is kept for staff-visible
                  // back-compat but not the primary UI signal.
                  const phase: string = l.lifecyclePhase ?? l.status
                  return (
                    <TableRow key={l.id}>
                      <TableCell className="font-medium max-w-[320px] truncate">
                        {l.title}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {services.length === 0 ? (
                          <span className="italic">No services yet</span>
                        ) : (
                          services
                            .map(
                              (s) =>
                                `${s.serviceType.replace(/_/g, " ")} · $${Number(s.price).toFixed(0)} · ${s.turnaroundDays}d`,
                            )
                            .join(" • ")
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={STATUS_VARIANTS[l.status] ?? "secondary"}
                        >
                          {phase.replace(/_/g, " ")}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right space-x-1">
                        {phase === "READY_FOR_REVIEW" && (
                          <Button
                            size="sm"
                            onClick={() => submitMut.mutate(l.id)}
                            disabled={submitMut.isPending}
                          >
                            Submit for review
                          </Button>
                        )}
                        {phase === "PUBLISHED" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => pauseMut.mutate(l.id)}
                            disabled={pauseMut.isPending}
                          >
                            Pause
                          </Button>
                        )}
                        {phase === "PAUSED" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => unpauseMut.mutate(l.id)}
                            disabled={unpauseMut.isPending}
                          >
                            Unpause
                          </Button>
                        )}
                        {l.status === "REJECTED" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => submitMut.mutate(l.id)}
                            disabled={submitMut.isPending}
                          >
                            Resubmit for review
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setEditingListing({
                              id: l.id,
                              title: l.title,
                              description: l.description ?? "",
                            })
                          }
                        >
                          <Edit3 className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setServicesForListing({
                              id: l.id,
                              title: l.title,
                              services,
                            })
                          }
                        >
                          Services
                        </Button>
                        {phase !== "ARCHIVED" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              if (
                                confirm(
                                  "Archive this listing? Existing orders are untouched.",
                                )
                              )
                                archiveMut.mutate(l.id)
                            }}
                            disabled={archiveMut.isPending}
                          >
                            Archive
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Listing</DialogTitle>
            <DialogDescription>
              Create a listing to offer your services on the marketplace. You
              can add services after creation.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="l-title">Title</Label>
              <Input
                id="l-title"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="e.g. Guest post on example.com (DR 60)"
                maxLength={200}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="l-desc">Description</Label>
              <Textarea
                id="l-desc"
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
                placeholder="What the buyer gets, niche, link policy..."
                rows={3}
                maxLength={1000}
              />
            </div>
            <div className="space-y-2">
              <Label>Website</Label>
              <Select
                value={form.websiteId}
                onValueChange={(v) => setForm({ ...form, websiteId: v })}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      websitesQ.isLoading ? "Loading..." : "Select website"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {(websitesQ.data ?? []).map((w: any) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.url}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Orders for this listing will be fulfilled on the selected
                website.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="l-add-service"
                checked={form.addServiceNow}
                onCheckedChange={(v) =>
                  setForm({ ...form, addServiceNow: v === true })
                }
              />
              <Label htmlFor="l-add-service" className="text-sm font-normal">
                Add a service now
              </Label>
            </div>
            {form.addServiceNow && (
              <div className="border rounded-md p-3 space-y-3">
                <div className="text-sm font-medium">First Service</div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Type</Label>
                    <Select
                      value={initialService.serviceType}
                      onValueChange={(v) =>
                        setInitialService({ ...initialService, serviceType: v })
                      }
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SERVICE_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {t.replace(/_/g, " ")}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Price (USD)</Label>
                    <Input
                      type="number"
                      min={1}
                      step="0.01"
                      className="h-8"
                      value={initialService.price}
                      onChange={(e) =>
                        setInitialService({
                          ...initialService,
                          price: e.target.value,
                        })
                      }
                      placeholder="250"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">TAT (days)</Label>
                    <Input
                      type="number"
                      min={1}
                      className="h-8"
                      value={initialService.turnaroundDays}
                      onChange={(e) =>
                        setInitialService({
                          ...initialService,
                          turnaroundDays: e.target.value,
                        })
                      }
                      placeholder="7"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Revisions</Label>
                    <Input
                      type="number"
                      min={0}
                      className="h-8"
                      value={initialService.revisionRounds}
                      onChange={(e) =>
                        setInitialService({
                          ...initialService,
                          revisionRounds: e.target.value,
                        })
                      }
                      placeholder="2"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={!canSubmit || createMutation.isPending}
            >
              {createMutation.isPending
                ? "Creating..."
                : form.addServiceNow
                  ? "Create with service"
                  : "Create listing"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/*
        Edit listing dialog — title/description edits. Sends a PUT to
        /marketplace/listings/:id (backend updateListing).
      */}
      <Dialog
        open={!!editingListing}
        onOpenChange={(v) => {
          if (!v) setEditingListing(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Listing</DialogTitle>
          </DialogHeader>
          {editingListing && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Title</Label>
                <Input
                  value={editingListing.title}
                  onChange={(e) =>
                    setEditingListing({
                      ...editingListing,
                      title: e.target.value,
                    })
                  }
                  maxLength={200}
                />
              </div>
              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea
                  value={editingListing.description}
                  onChange={(e) =>
                    setEditingListing({
                      ...editingListing,
                      description: e.target.value,
                    })
                  }
                  rows={3}
                  maxLength={1000}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingListing(null)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                editingListing &&
                updateListingMut.mutate({
                  id: editingListing.id,
                  title: editingListing.title,
                  description: editingListing.description,
                })
              }
              disabled={updateListingMut.isPending}
            >
              {updateListingMut.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/*
        Services dialog — per-row management for a listing's ListingService
        children. Price/TAT/revisions edits go through a version-guarded
        PATCH; concurrent edits get a 409. Availability is set via dropdown.
      */}
      <Dialog
        open={!!servicesForListing}
        onOpenChange={(v) => {
          if (!v) {
            setServicesForListing(null)
            setEditingService(null)
          }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Services on “{servicesForListing?.title}”</DialogTitle>
            <DialogDescription>
              Each row is a separately purchasable offering. Buyers pick one at
              checkout — your edits here never affect in-flight orders.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Service</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>TAT</TableHead>
                  <TableHead>Revisions</TableHead>
                  <TableHead>Availability</TableHead>
                  <TableHead className="text-right"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {servicesForListing?.services.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="text-center text-muted-foreground py-6"
                    >
                      No services configured yet. Add the first one below.
                    </TableCell>
                  </TableRow>
                )}
                {servicesForListing?.services.map((s) => {
                  const isEditing =
                    editingService?.listingId === servicesForListing.id &&
                    editingService?.serviceId === s.id
                  return (
                    <TableRow key={s.id}>
                      {isEditing ? (
                        <>
                          <TableCell className="font-medium">
                            {s.serviceType.replace(/_/g, " ")}
                          </TableCell>
                          <TableCell>
                            <Input
                              type="number"
                              min={0}
                              step="0.01"
                              className="h-8 w-24"
                              value={editingService.price}
                              onChange={(e) =>
                                setEditingService({
                                  ...editingService!,
                                  price: e.target.value,
                                })
                              }
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              type="number"
                              min={1}
                              className="h-8 w-16"
                              value={editingService.turnaroundDays}
                              onChange={(e) =>
                                setEditingService({
                                  ...editingService!,
                                  turnaroundDays: e.target.value,
                                })
                              }
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              type="number"
                              min={0}
                              className="h-8 w-16"
                              value={editingService.revisionRounds}
                              onChange={(e) =>
                                setEditingService({
                                  ...editingService!,
                                  revisionRounds: e.target.value,
                                })
                              }
                            />
                          </TableCell>
                          <TableCell>
                            <Select
                              value={s.availability}
                              onValueChange={(v) =>
                                updateServiceMut.mutate({
                                  listingId: servicesForListing?.id,
                                  serviceId: s.id,
                                  data: {
                                    version: s.version,
                                    availability: v as
                                      | "AVAILABLE"
                                      | "PAUSED"
                                      | "WAITLIST",
                                  },
                                })
                              }
                            >
                              <SelectTrigger className="h-8 w-[110px]">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="AVAILABLE">
                                  Available
                                </SelectItem>
                                <SelectItem value="PAUSED">Paused</SelectItem>
                                <SelectItem value="WAITLIST">
                                  Waitlist
                                </SelectItem>
                              </SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell className="text-right space-x-1">
                            <Button
                              variant="default"
                              size="sm"
                              onClick={() => {
                                const p = editingService!
                                updateServiceMut.mutate({
                                  listingId: servicesForListing!.id,
                                  serviceId: s.id,
                                  data: {
                                    version: s.version,
                                    price: Number(p.price),
                                    turnaroundDays: Number(p.turnaroundDays),
                                    revisionRounds: Number(p.revisionRounds),
                                    warrantyDays: p.warrantyDays
                                      ? Number(p.warrantyDays)
                                      : undefined,
                                    currency: p.currency,
                                  },
                                })
                                setEditingService(null)
                              }}
                              disabled={updateServiceMut.isPending}
                            >
                              Save
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setEditingService(null)}
                            >
                              Cancel
                            </Button>
                          </TableCell>
                        </>
                      ) : (
                        <>
                          <TableCell className="font-medium">
                            {s.serviceType.replace(/_/g, " ")}
                          </TableCell>
                          <TableCell className="font-mono text-sm">
                            ${Number(s.price).toFixed(2)}
                          </TableCell>
                          <TableCell>{s.turnaroundDays}d</TableCell>
                          <TableCell>{s.revisionRounds}</TableCell>
                          <TableCell>
                            <Select
                              value={s.availability}
                              onValueChange={(v) =>
                                updateServiceMut.mutate({
                                  listingId: servicesForListing?.id,
                                  serviceId: s.id,
                                  data: {
                                    version: s.version,
                                    availability: v as
                                      | "AVAILABLE"
                                      | "PAUSED"
                                      | "WAITLIST",
                                  },
                                })
                              }
                            >
                              <SelectTrigger className="h-8 w-[110px]">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="AVAILABLE">
                                  Available
                                </SelectItem>
                                <SelectItem value="PAUSED">Paused</SelectItem>
                                <SelectItem value="WAITLIST">
                                  Waitlist
                                </SelectItem>
                              </SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                setEditingService({
                                  listingId: servicesForListing!.id,
                                  serviceId: s.id,
                                  version: s.version,
                                  price: String(s.price),
                                  turnaroundDays: String(s.turnaroundDays),
                                  revisionRounds: String(s.revisionRounds),
                                  warrantyDays:
                                    s.warrantyDays != null
                                      ? String(s.warrantyDays)
                                      : "",
                                  currency: s.currency ?? "USD",
                                })
                              }
                            >
                              <Edit3 className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </>
                      )}
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
            <div className="border-t pt-4 space-y-3">
              <div className="text-sm font-medium">Add a service</div>
              <div className="grid grid-cols-5 gap-3">
                <Select
                  value={newService.serviceType}
                  onValueChange={(v) =>
                    setNewService({ ...newService, serviceType: v })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Service" />
                  </SelectTrigger>
                  <SelectContent>
                    {SERVICE_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t.replace(/_/g, " ")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  min={1}
                  step="0.01"
                  placeholder="Price"
                  value={newService.price}
                  onChange={(e) =>
                    setNewService({ ...newService, price: e.target.value })
                  }
                />
                <Input
                  type="number"
                  min={1}
                  placeholder="TAT (days)"
                  value={newService.turnaroundDays}
                  onChange={(e) =>
                    setNewService({
                      ...newService,
                      turnaroundDays: e.target.value,
                    })
                  }
                />
                <Input
                  type="number"
                  min={0}
                  placeholder="Revisions"
                  value={newService.revisionRounds}
                  onChange={(e) =>
                    setNewService({
                      ...newService,
                      revisionRounds: e.target.value,
                    })
                  }
                />
                <Input
                  type="number"
                  min={0}
                  placeholder="Warranty (days)"
                  value={newService.warrantyDays}
                  onChange={(e) =>
                    setNewService({
                      ...newService,
                      warrantyDays: e.target.value,
                    })
                  }
                />
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Label className="text-xs">Currency</Label>
                  <Select
                    value={newService.currency}
                    onValueChange={(v) =>
                      setNewService({ ...newService, currency: v })
                    }
                  >
                    <SelectTrigger className="h-8 w-20">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="USD">USD</SelectItem>
                      <SelectItem value="EUR">EUR</SelectItem>
                      <SelectItem value="GBP">GBP</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  size="sm"
                  disabled={
                    !servicesForListing ||
                    !newService.price ||
                    Number(newService.price) <= 0 ||
                    addServiceMut.isPending
                  }
                  onClick={() => {
                    if (!servicesForListing) return
                    addServiceMut.mutate({
                      listingId: servicesForListing.id,
                      data: {
                        serviceType: newService.serviceType,
                        price: Number(newService.price),
                        turnaroundDays: Number(newService.turnaroundDays) || 7,
                        revisionRounds: Number(newService.revisionRounds) || 2,
                        warrantyDays: newService.warrantyDays
                          ? Number(newService.warrantyDays)
                          : undefined,
                        currency: newService.currency,
                      },
                    })
                  }}
                >
                  {addServiceMut.isPending ? "Adding..." : "Add service"}
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setServicesForListing(null)
                setEditingService(null)
              }}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
