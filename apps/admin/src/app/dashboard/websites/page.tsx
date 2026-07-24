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
  type AdminOpsStaffResponse,
  type AdminPlatformWebsiteResponse,
  ApiError,
  type Category,
} from "@guestpost/api-client"
import {
  LISTING_LINK_TYPE_LABELS,
  LISTING_LINK_TYPES,
  LISTING_LINK_VALIDITIES,
  LISTING_LINK_VALIDITY_LABELS,
  LISTING_TITLE_URL_WARNING,
  MARKETPLACE_CATEGORY_LIMIT,
  MARKETPLACE_LANGUAGES,
  validateWebsiteEnlistmentInput,
} from "@guestpost/shared"
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
  MultiSelect,
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
import {
  AdminEmptyState,
  AdminMetricCard,
  AdminPage,
  AdminPageHeader,
} from "../../../components/admin-workspace"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"
import { ForbiddenPage, useRequireRole } from "../../../lib/use-require-role"

const YES_NO_OPTIONS = [
  { value: "no", label: "No" },
  { value: "yes", label: "Yes" },
]

const EMPTY_CREATE_FORM = {
  url: "",
  name: "",
  listingTitle: "",
  description: "",
  categoryIds: [] as string[],
  language: "English",
  country: "",
  sportsGamingAllowed: false,
  pharmacyAllowed: false,
  cryptoAllowed: false,
  backlinkCount: "1",
  linkType: "DOFOLLOW",
  linkValidity: "PERMANENT",
  googleNews: false,
  markedSponsored: false,
  foreignLanguageAllowed: false,
  ahrefsOrganicTraffic: "",
  ahrefsTrafficAsOf: new Date().toISOString().slice(0, 10),
  mozDomainAuthority: "",
  mozDomainAuthorityAsOf: new Date().toISOString().slice(0, 10),
}

type CreateWebsiteField =
  | "url"
  | "name"
  | "listingTitle"
  | "description"
  | "categoryIds"
  | "language"
  | "country"
  | "ahrefsOrganicTraffic"
  | "ahrefsTrafficAsOf"
  | "mozDomainAuthority"
  | "mozDomainAuthorityAsOf"

type CreateWebsiteErrors = Partial<Record<CreateWebsiteField, string>>

function PolicySelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: readonly { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

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
  const [showCreate, setShowCreate] = useState(false)

  const websitesQ = useQuery({
    queryKey: ["admin", "platform-websites"],
    queryFn: () => api.admin.listPlatformWebsites(),
  })
  const categoriesQ = useQuery<Category[]>({
    queryKey: ["marketplace-categories"],
    queryFn: () => api.marketplace.getCategories(),
    enabled: showCreate,
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
  const [createForm, setCreateForm] = useState(EMPTY_CREATE_FORM)
  const [createErrors, setCreateErrors] = useState<CreateWebsiteErrors>({})
  const [createServerError, setCreateServerError] = useState<string | null>(
    null,
  )

  const clearCreateError = (field: CreateWebsiteField) => {
    setCreateErrors((current) => {
      if (!current[field]) return current
      const next = { ...current }
      delete next[field]
      return next
    })
    setCreateServerError(null)
  }

  const validateCreateForm = () => {
    const nextErrors: CreateWebsiteErrors = {}
    for (const issue of validateWebsiteEnlistmentInput(createForm)) {
      nextErrors[issue.field] = issue.message
    }

    if (
      createForm.categoryIds.length < 1 ||
      createForm.categoryIds.length > MARKETPLACE_CATEGORY_LIMIT ||
      new Set(createForm.categoryIds).size !== createForm.categoryIds.length
    ) {
      nextErrors.categoryIds = `Choose between 1 and ${MARKETPLACE_CATEGORY_LIMIT} unique categories.`
    }
    if (
      !MARKETPLACE_LANGUAGES.some(
        (language) => language === createForm.language,
      )
    ) {
      nextErrors.language = "Choose a supported primary language."
    }
    const traffic = Number(createForm.ahrefsOrganicTraffic)
    if (
      !Number.isSafeInteger(traffic) ||
      traffic < 0 ||
      traffic > 2_147_483_647
    ) {
      nextErrors.ahrefsOrganicTraffic =
        "Enter a whole number from 0 to 2,147,483,647."
    }
    const mozDa = Number(createForm.mozDomainAuthority)
    if (!Number.isInteger(mozDa) || mozDa < 0 || mozDa > 100) {
      nextErrors.mozDomainAuthority = "Enter a whole number from 0 to 100."
    }
    const today = new Date().toISOString().slice(0, 10)
    const freshAfter = new Date()
    freshAfter.setUTCDate(freshAfter.getUTCDate() - 90)
    const freshAfterValue = freshAfter.toISOString().slice(0, 10)
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(createForm.ahrefsTrafficAsOf) ||
      createForm.ahrefsTrafficAsOf > today ||
      createForm.ahrefsTrafficAsOf < freshAfterValue
    ) {
      nextErrors.ahrefsTrafficAsOf =
        "Choose a real date within the last 90 days."
    }
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(createForm.mozDomainAuthorityAsOf) ||
      createForm.mozDomainAuthorityAsOf > today ||
      createForm.mozDomainAuthorityAsOf < freshAfterValue
    ) {
      nextErrors.mozDomainAuthorityAsOf =
        "Choose a real date within the last 90 days."
    }

    return nextErrors
  }

  const createMut = useMutation({
    mutationFn: () =>
      api.admin.createPlatformWebsite({
        url: createForm.url.trim(),
        name: createForm.name.trim() || undefined,
        listingTitle: createForm.listingTitle.trim(),
        description: createForm.description.trim(),
        categoryIds: createForm.categoryIds,
        language: createForm.language,
        country: createForm.country.trim() || undefined,
        sportsGamingAllowed: createForm.sportsGamingAllowed,
        pharmacyAllowed: createForm.pharmacyAllowed,
        cryptoAllowed: createForm.cryptoAllowed,
        backlinkCount: Number(createForm.backlinkCount),
        linkType: createForm.linkType as
          | "DOFOLLOW"
          | "NOFOLLOW"
          | "SPONSORED"
          | "UGC",
        linkValidity: createForm.linkValidity as
          | "PERMANENT"
          | "FIVE_YEARS"
          | "ONE_YEAR"
          | "SIX_MONTHS"
          | "THREE_MONTHS",
        googleNews: createForm.googleNews,
        markedSponsored: createForm.markedSponsored,
        foreignLanguageAllowed: createForm.foreignLanguageAllowed,
        manualMetrics: {
          ahrefsOrganicTraffic: Number(createForm.ahrefsOrganicTraffic),
          ahrefsTrafficAsOf: createForm.ahrefsTrafficAsOf,
          mozDomainAuthority: Number(createForm.mozDomainAuthority),
          mozDomainAuthorityAsOf: createForm.mozDomainAuthorityAsOf,
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "platform-websites"] })
      toast.success("Platform website created")
      setShowCreate(false)
      setCreateForm(EMPTY_CREATE_FORM)
      setCreateErrors({})
      setCreateServerError(null)
    },
    onError: (error: Error) => {
      const requestId = error instanceof ApiError ? error.requestId : undefined
      const message = error.message || "Failed to create website"
      setCreateServerError(
        requestId ? `${message} Request ID: ${requestId}` : message,
      )
      toast.error(message, {
        description: requestId ? `Request ID: ${requestId}` : undefined,
      })
    },
  })

  const handleCreate = () => {
    const nextErrors = validateCreateForm()
    setCreateErrors(nextErrors)
    setCreateServerError(null)
    if (Object.keys(nextErrors).length > 0) {
      toast.error("Complete the highlighted required fields")
      return
    }
    createMut.mutate()
  }

  const closeCreateDialog = () => {
    setShowCreate(false)
    setCreateErrors({})
    setCreateServerError(null)
    createMut.reset()
  }
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
    <AdminPage>
      <AdminPageHeader
        title="Platform websites"
        description={
          isSuperAdmin
            ? "Create each domain once, manage its listing and services, connect Google data, and route new work to Operations."
            : "Create assigned platform websites, manage listing services and Google data, and receive their new orders automatically."
        }
        eyebrow="Owned inventory"
        icon={Globe2}
        actions={
          <Button onClick={() => setShowCreate(true)} className="gap-2">
            <Plus className="h-4 w-4" />
            Create website
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <AdminMetricCard
          label="Platform sites"
          value={websites.length}
          icon={Globe2}
          tone="info"
        />
        <AdminMetricCard
          label="Assigned"
          value={assignedCount}
          icon={UserRound}
          tone="success"
        />
        <AdminMetricCard
          label="Shared queue"
          value={unassignedCount}
          icon={Inbox}
          tone="warning"
        />
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
                    <TableCell colSpan={5} className="p-0">
                      <AdminEmptyState
                        title="No platform websites"
                        description="Create a platform-owned website to start managing inventory and routing work."
                      />
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
      <Dialog
        open={showCreate}
        onOpenChange={(open) =>
          open ? setShowCreate(true) : closeCreateDialog()
        }
      >
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
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
          <form
            onSubmit={(event) => {
              event.preventDefault()
              handleCreate()
            }}
            noValidate
            className="space-y-5"
          >
            {createServerError && (
              <div
                role="alert"
                className="flex gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="font-medium">Website could not be created</p>
                  <p className="mt-1 text-xs leading-5">{createServerError}</p>
                </div>
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="platform-website-url">Website URL *</Label>
              <Input
                id="platform-website-url"
                placeholder="https://example.com"
                autoComplete="url"
                value={createForm.url}
                aria-invalid={Boolean(createErrors.url)}
                className={createErrors.url ? "border-destructive" : undefined}
                onChange={(event) => {
                  setCreateForm({ ...createForm, url: event.target.value })
                  clearCreateError("url")
                }}
              />
              <p className="text-xs leading-5 text-muted-foreground">
                Use the public homepage only, for example https://example.com.
              </p>
              {createErrors.url && (
                <p className="text-xs text-destructive">{createErrors.url}</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="platform-website-name">Name</Label>
                <Input
                  id="platform-website-name"
                  placeholder="My Site"
                  maxLength={100}
                  value={createForm.name}
                  aria-invalid={Boolean(createErrors.name)}
                  className={
                    createErrors.name ? "border-destructive" : undefined
                  }
                  onChange={(event) => {
                    setCreateForm({ ...createForm, name: event.target.value })
                    clearCreateError("name")
                  }}
                />
                {createErrors.name && (
                  <p className="text-xs text-destructive">
                    {createErrors.name}
                  </p>
                )}
              </div>
              <div className="space-y-1">
                <Label htmlFor="platform-website-country">Country</Label>
                <Input
                  id="platform-website-country"
                  placeholder="US"
                  maxLength={100}
                  value={createForm.country}
                  aria-invalid={Boolean(createErrors.country)}
                  className={
                    createErrors.country ? "border-destructive" : undefined
                  }
                  onChange={(event) => {
                    setCreateForm({
                      ...createForm,
                      country: event.target.value,
                    })
                    clearCreateError("country")
                  }}
                />
                {createErrors.country && (
                  <p className="text-xs text-destructive">
                    {createErrors.country}
                  </p>
                )}
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="platform-listing-title">Listing title *</Label>
              <Input
                id="platform-listing-title"
                maxLength={200}
                placeholder="Technology guest posts on Example"
                value={createForm.listingTitle}
                aria-invalid={Boolean(createErrors.listingTitle)}
                className={
                  createErrors.listingTitle ? "border-destructive" : undefined
                }
                onChange={(event) => {
                  setCreateForm({
                    ...createForm,
                    listingTitle: event.target.value,
                  })
                  clearCreateError("listingTitle")
                }}
              />
              {!createErrors.listingTitle && (
                <p className="text-xs leading-5 text-muted-foreground">
                  {LISTING_TITLE_URL_WARNING}
                </p>
              )}
              {createErrors.listingTitle && (
                <p className="text-xs text-destructive">
                  {createErrors.listingTitle}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <div className="flex justify-between gap-3">
                <Label htmlFor="platform-listing-description">
                  Description *
                </Label>
                <span className="text-xs text-muted-foreground">
                  {createForm.description.length}/500
                </span>
              </div>
              <Textarea
                id="platform-listing-description"
                rows={4}
                maxLength={500}
                placeholder="Describe the audience, editorial focus, and publishing standards."
                value={createForm.description}
                aria-invalid={Boolean(createErrors.description)}
                className={
                  createErrors.description ? "border-destructive" : undefined
                }
                onChange={(event) => {
                  setCreateForm({
                    ...createForm,
                    description: event.target.value,
                  })
                  clearCreateError("description")
                }}
              />
              {createErrors.description && (
                <p className="text-xs text-destructive">
                  {createErrors.description}
                </p>
              )}
            </div>
            <div className="rounded-xl border bg-muted/20 p-4">
              <div className="mb-4">
                <p className="font-medium">Manual domain metrics *</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Enter current Ahrefs organic traffic and Moz Domain Authority.
                  Ahrefs DR and OpenPageRank are collected securely after the
                  website is created. Manual values expire after 90 days and
                  retain their source history.
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="platform-ahrefs-traffic">
                    Ahrefs organic traffic
                  </Label>
                  <Input
                    id="platform-ahrefs-traffic"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step={1}
                    value={createForm.ahrefsOrganicTraffic}
                    aria-invalid={Boolean(createErrors.ahrefsOrganicTraffic)}
                    onChange={(event) => {
                      setCreateForm({
                        ...createForm,
                        ahrefsOrganicTraffic: event.target.value,
                      })
                      clearCreateError("ahrefsOrganicTraffic")
                    }}
                  />
                  {createErrors.ahrefsOrganicTraffic ? (
                    <p className="text-xs text-destructive">
                      {createErrors.ahrefsOrganicTraffic}
                    </p>
                  ) : null}
                </div>
                <div className="space-y-1">
                  <Label htmlFor="platform-ahrefs-as-of">
                    Ahrefs measured on
                  </Label>
                  <Input
                    id="platform-ahrefs-as-of"
                    type="date"
                    max={new Date().toISOString().slice(0, 10)}
                    value={createForm.ahrefsTrafficAsOf}
                    aria-invalid={Boolean(createErrors.ahrefsTrafficAsOf)}
                    onChange={(event) => {
                      setCreateForm({
                        ...createForm,
                        ahrefsTrafficAsOf: event.target.value,
                      })
                      clearCreateError("ahrefsTrafficAsOf")
                    }}
                  />
                  {createErrors.ahrefsTrafficAsOf ? (
                    <p className="text-xs text-destructive">
                      {createErrors.ahrefsTrafficAsOf}
                    </p>
                  ) : null}
                </div>
                <div className="space-y-1">
                  <Label htmlFor="platform-moz-da">Moz Domain Authority</Label>
                  <Input
                    id="platform-moz-da"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={100}
                    step={1}
                    value={createForm.mozDomainAuthority}
                    aria-invalid={Boolean(createErrors.mozDomainAuthority)}
                    onChange={(event) => {
                      setCreateForm({
                        ...createForm,
                        mozDomainAuthority: event.target.value,
                      })
                      clearCreateError("mozDomainAuthority")
                    }}
                  />
                  {createErrors.mozDomainAuthority ? (
                    <p className="text-xs text-destructive">
                      {createErrors.mozDomainAuthority}
                    </p>
                  ) : null}
                </div>
                <div className="space-y-1">
                  <Label htmlFor="platform-moz-as-of">Moz measured on</Label>
                  <Input
                    id="platform-moz-as-of"
                    type="date"
                    max={new Date().toISOString().slice(0, 10)}
                    value={createForm.mozDomainAuthorityAsOf}
                    aria-invalid={Boolean(createErrors.mozDomainAuthorityAsOf)}
                    onChange={(event) => {
                      setCreateForm({
                        ...createForm,
                        mozDomainAuthorityAsOf: event.target.value,
                      })
                      clearCreateError("mozDomainAuthorityAsOf")
                    }}
                  />
                  {createErrors.mozDomainAuthorityAsOf ? (
                    <p className="text-xs text-destructive">
                      {createErrors.mozDomainAuthorityAsOf}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <Label>Categories *</Label>
                  <span className="text-xs text-muted-foreground">
                    {createForm.categoryIds.length}/{MARKETPLACE_CATEGORY_LIMIT}{" "}
                    selected
                  </span>
                </div>
                {categoriesQ.isLoading ? (
                  <Skeleton className="h-10 w-full" />
                ) : categoriesQ.isError ? (
                  <div
                    role="alert"
                    className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3"
                  >
                    <p className="text-xs text-destructive">
                      Categories could not be loaded.
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => categoriesQ.refetch()}
                    >
                      Retry
                    </Button>
                  </div>
                ) : (
                  <MultiSelect
                    options={(categoriesQ.data ?? []).map((category) => ({
                      value: category.id,
                      label: category.name,
                    }))}
                    value={createForm.categoryIds}
                    onValueChange={(categoryIds) => {
                      setCreateForm({ ...createForm, categoryIds })
                      clearCreateError("categoryIds")
                    }}
                    maxSelected={MARKETPLACE_CATEGORY_LIMIT}
                    placeholder="Choose 1–7 categories"
                    searchPlaceholder="Search categories..."
                    ariaLabel="Marketplace categories"
                    ariaInvalid={Boolean(createErrors.categoryIds)}
                    className={
                      createErrors.categoryIds
                        ? "border-destructive"
                        : undefined
                    }
                  />
                )}
                <p className="text-xs leading-5 text-muted-foreground">
                  Select at least one relevant niche and up to seven. Remove a
                  selection before choosing a replacement.
                </p>
                {createErrors.categoryIds && (
                  <p className="text-xs text-destructive">
                    {createErrors.categoryIds}
                  </p>
                )}
              </div>
              <div className="space-y-1">
                <Label htmlFor="platform-primary-language">
                  Primary language *
                </Label>
                <Select
                  value={createForm.language}
                  onValueChange={(language) => {
                    setCreateForm({ ...createForm, language })
                    clearCreateError("language")
                  }}
                >
                  <SelectTrigger
                    id="platform-primary-language"
                    aria-invalid={Boolean(createErrors.language)}
                    className={
                      createErrors.language ? "border-destructive" : undefined
                    }
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MARKETPLACE_LANGUAGES.map((language) => (
                      <SelectItem key={language} value={language}>
                        {language}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {createErrors.language && (
                  <p className="text-xs text-destructive">
                    {createErrors.language}
                  </p>
                )}
              </div>
            </div>
            <div className="rounded-xl border bg-muted/20 p-4">
              <p className="mb-3 font-medium">Placement policy</p>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <PolicySelect
                  label="Sports/Gaming allowed?"
                  value={createForm.sportsGamingAllowed ? "yes" : "no"}
                  options={YES_NO_OPTIONS}
                  onChange={(value) =>
                    setCreateForm({
                      ...createForm,
                      sportsGamingAllowed: value === "yes",
                    })
                  }
                />
                <PolicySelect
                  label="Pharmacy allowed?"
                  value={createForm.pharmacyAllowed ? "yes" : "no"}
                  options={YES_NO_OPTIONS}
                  onChange={(value) =>
                    setCreateForm({
                      ...createForm,
                      pharmacyAllowed: value === "yes",
                    })
                  }
                />
                <PolicySelect
                  label="Crypto allowed?"
                  value={createForm.cryptoAllowed ? "yes" : "no"}
                  options={YES_NO_OPTIONS}
                  onChange={(value) =>
                    setCreateForm({
                      ...createForm,
                      cryptoAllowed: value === "yes",
                    })
                  }
                />
                <PolicySelect
                  label="Number of backlinks"
                  value={createForm.backlinkCount}
                  options={[1, 2, 3].map((value) => ({
                    value: String(value),
                    label: String(value),
                  }))}
                  onChange={(backlinkCount) =>
                    setCreateForm({ ...createForm, backlinkCount })
                  }
                />
                <PolicySelect
                  label="Link type"
                  value={createForm.linkType}
                  options={LISTING_LINK_TYPES.map((value) => ({
                    value,
                    label: LISTING_LINK_TYPE_LABELS[value],
                  }))}
                  onChange={(linkType) =>
                    setCreateForm({ ...createForm, linkType })
                  }
                />
                <PolicySelect
                  label="Link validity"
                  value={createForm.linkValidity}
                  options={LISTING_LINK_VALIDITIES.map((value) => ({
                    value,
                    label: LISTING_LINK_VALIDITY_LABELS[value],
                  }))}
                  onChange={(linkValidity) =>
                    setCreateForm({ ...createForm, linkValidity })
                  }
                />
                <PolicySelect
                  label="Google News?"
                  value={createForm.googleNews ? "yes" : "no"}
                  options={YES_NO_OPTIONS}
                  onChange={(value) =>
                    setCreateForm({
                      ...createForm,
                      googleNews: value === "yes",
                    })
                  }
                />
                <PolicySelect
                  label="Marked as sponsored?"
                  value={createForm.markedSponsored ? "yes" : "no"}
                  options={YES_NO_OPTIONS}
                  onChange={(value) =>
                    setCreateForm({
                      ...createForm,
                      markedSponsored: value === "yes",
                    })
                  }
                />
                <PolicySelect
                  label="Foreign-language content allowed?"
                  value={createForm.foreignLanguageAllowed ? "yes" : "no"}
                  options={YES_NO_OPTIONS}
                  onChange={(value) =>
                    setCreateForm({
                      ...createForm,
                      foreignLanguageAllowed: value === "yes",
                    })
                  }
                />
              </div>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              Search and traffic metrics are imported from the GSC and GA4
              properties linked after creation; staff cannot self-report them.
            </p>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={closeCreateDialog}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  createMut.isPending ||
                  categoriesQ.isLoading ||
                  categoriesQ.isError
                }
              >
                {createMut.isPending ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </AdminPage>
  )
}
