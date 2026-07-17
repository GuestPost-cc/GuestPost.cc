"use client"

import type {
  Category,
  PublisherWebsiteListing,
  PublisherWebsiteService,
} from "@guestpost/api-client"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea,
} from "@guestpost/ui"
import { useMutation, useQuery } from "@tanstack/react-query"
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  DollarSign,
  Edit3,
  Layers3,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  Send,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { api } from "../../lib/api"

const SERVICE_TYPES = [
  ["GUEST_POST", "Guest post"],
  ["NICHE_EDIT", "Niche edit"],
  ["EDITORIAL_LINK", "Editorial link"],
  ["OUTREACH_LINK", "Outreach link"],
  ["LOCAL_CITATION", "Local citation"],
  ["FOUNDATION_LINK", "Foundation link"],
  ["BLOG_ARTICLE", "Blog article"],
  ["SEO_CONTENT", "SEO content"],
] as const

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  PENDING_REVIEW: "In review",
  APPROVED: "Live",
  REJECTED: "Needs changes",
  PAUSED: "Paused",
  ARCHIVED: "Archived",
}

function serviceLabel(value: string) {
  return (
    SERVICE_TYPES.find(([serviceType]) => serviceType === value)?.[1] ??
    value.replace(/_/g, " ").toLowerCase()
  )
}

function money(value: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(Number(value))
}

export function PublisherListingManager({
  listing,
  verificationStatus,
  onChanged,
}: {
  listing: PublisherWebsiteListing
  verificationStatus: string
  onChanged: () => void
}) {
  const [details, setDetails] = useState({
    title: listing.title,
    description: listing.description,
    categoryId: listing.category?.id ?? "",
  })
  const [editingService, setEditingService] =
    useState<PublisherWebsiteService | null>(null)
  const [serviceDraft, setServiceDraft] = useState({
    price: "",
    currency: "USD",
    turnaroundDays: "7",
    revisionRounds: "2",
    warrantyDays: "",
  })
  const [newService, setNewService] = useState({
    serviceType: "GUEST_POST",
    price: "",
    currency: "USD",
    turnaroundDays: "7",
    revisionRounds: "2",
    warrantyDays: "",
  })

  useEffect(() => {
    setDetails({
      title: listing.title,
      description: listing.description,
      categoryId: listing.category?.id ?? "",
    })
  }, [listing.category?.id, listing.description, listing.title])

  const categoriesQ = useQuery<Category[]>({
    queryKey: ["marketplace-categories"],
    queryFn: () => api.marketplace.getCategories(),
  })

  const availableServices = listing.services.filter(
    (service) => service.availability === "AVAILABLE",
  )
  const existingTypes = useMemo(
    () => new Set(listing.services.map((service) => service.serviceType)),
    [listing.services],
  )
  const unusedServiceTypes = SERVICE_TYPES.filter(
    ([serviceType]) => !existingTypes.has(serviceType),
  )
  const selectedNewServiceType = unusedServiceTypes.some(
    ([serviceType]) => serviceType === newService.serviceType,
  )
    ? newService.serviceType
    : unusedServiceTypes[0]?.[0]
  const metadataReady =
    details.title.trim().length >= 3 &&
    details.description.trim().length > 0 &&
    details.description.length <= 500 &&
    !!details.categoryId
  const readyForReview =
    metadataReady &&
    verificationStatus === "VERIFIED" &&
    availableServices.length > 0
  const detailsChanged =
    details.title.trim() !== listing.title ||
    details.description.trim() !== listing.description ||
    details.categoryId !== (listing.category?.id ?? "")

  const updateDetailsMut = useMutation({
    mutationFn: () =>
      api.marketplace.updateListing(listing.id, {
        title: details.title.trim(),
        description: details.description.trim(),
        categoryId: details.categoryId,
      }),
    onSuccess: () => {
      onChanged()
      toast.success("Listing details updated")
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const addServiceMut = useMutation({
    mutationFn: () =>
      api.marketplace.addListingService(listing.id, {
        serviceType: selectedNewServiceType!,
        price: Number(newService.price),
        currency: newService.currency,
        turnaroundDays: Number(newService.turnaroundDays),
        revisionRounds: Number(newService.revisionRounds),
        warrantyDays: newService.warrantyDays
          ? Number(newService.warrantyDays)
          : undefined,
      }),
    onSuccess: () => {
      setNewService({
        serviceType: "GUEST_POST",
        price: "",
        currency: "USD",
        turnaroundDays: "7",
        revisionRounds: "2",
        warrantyDays: "",
      })
      onChanged()
      toast.success("Service added")
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const updateServiceMut = useMutation({
    mutationFn: ({
      service,
      data,
    }: {
      service: PublisherWebsiteService
      data: {
        price?: number
        currency?: string
        turnaroundDays?: number
        revisionRounds?: number
        warrantyDays?: number
        availability?: "AVAILABLE" | "PAUSED" | "WAITLIST"
      }
    }) =>
      api.marketplace.updateListingService(listing.id, service.id, {
        version: service.version,
        ...data,
      }),
    onSuccess: () => {
      setEditingService(null)
      onChanged()
      toast.success("Service updated")
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const lifecycleMut = useMutation({
    mutationFn: (action: "submit" | "pause" | "unpause" | "archive") => {
      if (action === "submit") return api.marketplace.submitListing(listing.id)
      if (action === "pause") return api.marketplace.pauseListing(listing.id)
      if (action === "unpause")
        return api.marketplace.unpauseListing(listing.id)
      return api.marketplace.archiveListing(listing.id)
    },
    onSuccess: (_, action) => {
      onChanged()
      toast.success(
        action === "submit"
          ? "Listing submitted for review"
          : action === "pause"
            ? "Listing paused"
            : action === "unpause"
              ? "Listing is live again"
              : "Listing archived",
      )
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const startEditingService = (service: PublisherWebsiteService) => {
    setEditingService(service)
    setServiceDraft({
      price: String(service.price),
      currency: service.currency,
      turnaroundDays: String(service.turnaroundDays),
      revisionRounds: String(service.revisionRounds),
      warrantyDays:
        service.warrantyDays == null ? "" : String(service.warrantyDays),
    })
  }

  return (
    <div id="marketplace" className="scroll-mt-6 space-y-6">
      <Card className="overflow-hidden">
        <CardHeader className="border-b bg-blue-50/50 dark:bg-blue-950/10">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>Marketplace listing</CardTitle>
                <Badge className="border-blue-200 bg-blue-100 text-blue-700 hover:bg-blue-100 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300">
                  Publisher managed
                </Badge>
                <Badge variant="outline">
                  {STATUS_LABELS[listing.status] ?? listing.status}
                </Badge>
              </div>
              <CardDescription className="mt-2 max-w-3xl">
                This is the website&apos;s only listing. Update the buyer-facing
                category and description here, then manage each orderable
                service below.
              </CardDescription>
            </div>
            <LifecycleActions
              status={listing.status}
              readyForReview={readyForReview}
              pending={lifecycleMut.isPending}
              onAction={(action) => lifecycleMut.mutate(action)}
            />
          </div>
        </CardHeader>
        <CardContent className="grid gap-6 pt-6 lg:grid-cols-[minmax(0,1fr)_260px]">
          <div className="space-y-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Listing title">
                <Input
                  maxLength={200}
                  value={details.title}
                  onChange={(event) =>
                    setDetails((current) => ({
                      ...current,
                      title: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field label="Category">
                {categoriesQ.isLoading ? (
                  <Skeleton className="h-10 w-full" />
                ) : (
                  <Select
                    value={details.categoryId}
                    onValueChange={(categoryId) =>
                      setDetails((current) => ({ ...current, categoryId }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Choose a category" />
                    </SelectTrigger>
                    <SelectContent>
                      {(categoriesQ.data ?? []).map((category) => (
                        <SelectItem key={category.id} value={category.id}>
                          {category.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
            </div>
            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="publisher-listing-description">
                  Buyer description
                </Label>
                <span
                  className={
                    "text-xs " +
                    (details.description.length > 450
                      ? "text-amber-600"
                      : "text-muted-foreground")
                  }
                >
                  {details.description.length}/500
                </span>
              </div>
              <Textarea
                id="publisher-listing-description"
                rows={6}
                maxLength={500}
                value={details.description}
                onChange={(event) =>
                  setDetails((current) => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
              />
              <p className="text-xs leading-5 text-muted-foreground">
                The card preview is limited to two lines. Buyers see this full
                description on the listing detail page.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => updateDetailsMut.mutate()}
                disabled={
                  !detailsChanged ||
                  !metadataReady ||
                  updateDetailsMut.isPending ||
                  categoriesQ.isError
                }
              >
                {updateDetailsMut.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Save className="mr-2 h-4 w-4" />
                )}
                Save listing details
              </Button>
              {detailsChanged && (
                <Button
                  variant="ghost"
                  onClick={() =>
                    setDetails({
                      title: listing.title,
                      description: listing.description,
                      categoryId: listing.category?.id ?? "",
                    })
                  }
                >
                  <RotateCcw className="mr-2 h-4 w-4" /> Reset
                </Button>
              )}
            </div>
          </div>

          <ReadinessPanel
            metadataReady={metadataReady}
            verificationStatus={verificationStatus}
            availableServiceCount={availableServices.length}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle>Services</CardTitle>
              <CardDescription className="mt-1.5">
                Each service has its own price, delivery promise, revisions, and
                availability. Existing orders keep their original terms.
              </CardDescription>
            </div>
            <Badge variant="secondary">
              {availableServices.length} available · {listing.services.length}{" "}
              total
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {listing.services.length === 0 ? (
            <div className="rounded-xl border border-dashed px-6 py-10 text-center">
              <Layers3 className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="mt-3 font-medium">No services configured</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Add the first service below before submitting for review.
              </p>
            </div>
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              {listing.services.map((service) => (
                <ServiceCard
                  key={service.id}
                  service={service}
                  editing={editingService?.id === service.id}
                  draft={serviceDraft}
                  pending={updateServiceMut.isPending}
                  onDraftChange={setServiceDraft}
                  onEdit={() => startEditingService(service)}
                  onCancel={() => setEditingService(null)}
                  onSave={() =>
                    updateServiceMut.mutate({
                      service,
                      data: {
                        price: Number(serviceDraft.price),
                        currency: serviceDraft.currency,
                        turnaroundDays: Number(serviceDraft.turnaroundDays),
                        revisionRounds: Number(serviceDraft.revisionRounds),
                        warrantyDays: serviceDraft.warrantyDays
                          ? Number(serviceDraft.warrantyDays)
                          : 0,
                      },
                    })
                  }
                  onAvailabilityChange={(availability) =>
                    updateServiceMut.mutate({
                      service,
                      data: { availability },
                    })
                  }
                />
              ))}
            </div>
          )}

          {unusedServiceTypes.length > 0 && (
            <div className="rounded-xl border border-dashed bg-muted/15 p-5">
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-blue-100 p-2 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                  <Plus className="h-4 w-4" />
                </div>
                <div>
                  <p className="font-medium">Add another service</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    A service type can appear only once on this listing.
                  </p>
                </div>
              </div>
              <div className="mt-5 grid gap-4 md:grid-cols-3 xl:grid-cols-6">
                <Field label="Service">
                  <Select
                    value={selectedNewServiceType}
                    onValueChange={(serviceType) =>
                      setNewService((current) => ({
                        ...current,
                        serviceType,
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {unusedServiceTypes.map(([serviceType, label]) => (
                        <SelectItem key={serviceType} value={serviceType}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Price">
                  <Input
                    type="number"
                    min={0.01}
                    step="0.01"
                    placeholder="USD"
                    value={newService.price}
                    onChange={(event) =>
                      setNewService((current) => ({
                        ...current,
                        price: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field label="Turnaround">
                  <Input
                    type="number"
                    min={1}
                    value={newService.turnaroundDays}
                    onChange={(event) =>
                      setNewService((current) => ({
                        ...current,
                        turnaroundDays: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field label="Revisions">
                  <Input
                    type="number"
                    min={0}
                    value={newService.revisionRounds}
                    onChange={(event) =>
                      setNewService((current) => ({
                        ...current,
                        revisionRounds: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field label="Warranty">
                  <Input
                    type="number"
                    min={0}
                    placeholder="Days"
                    value={newService.warrantyDays}
                    onChange={(event) =>
                      setNewService((current) => ({
                        ...current,
                        warrantyDays: event.target.value,
                      }))
                    }
                  />
                </Field>
                <div className="flex items-end">
                  <Button
                    className="w-full"
                    disabled={
                      !newService.price ||
                      Number(newService.price) <= 0 ||
                      Number(newService.turnaroundDays) < 1 ||
                      addServiceMut.isPending
                    }
                    onClick={() => {
                      addServiceMut.mutate()
                    }}
                  >
                    {addServiceMut.isPending ? "Adding…" : "Add service"}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2.5">
      <Label>{label}</Label>
      {children}
    </div>
  )
}

function LifecycleActions({
  status,
  readyForReview,
  pending,
  onAction,
}: {
  status: string
  readyForReview: boolean
  pending: boolean
  onAction: (action: "submit" | "pause" | "unpause" | "archive") => void
}) {
  if (status === "PENDING_REVIEW") {
    return <Badge variant="secondary">Moderation in progress</Badge>
  }
  return (
    <div className="flex flex-wrap gap-2">
      {["DRAFT", "REJECTED", "ARCHIVED"].includes(status) && (
        <Button
          size="sm"
          disabled={!readyForReview || pending}
          onClick={() => onAction("submit")}
        >
          <Send className="mr-2 h-4 w-4" />
          {status === "REJECTED" ? "Resubmit" : "Submit for review"}
        </Button>
      )}
      {status === "APPROVED" && (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => onAction("pause")}
        >
          Pause listing
        </Button>
      )}
      {status === "PAUSED" && (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => onAction("unpause")}
        >
          Resume listing
        </Button>
      )}
    </div>
  )
}

function ReadinessPanel({
  metadataReady,
  verificationStatus,
  availableServiceCount,
}: {
  metadataReady: boolean
  verificationStatus: string
  availableServiceCount: number
}) {
  const checks = [
    {
      ready: metadataReady,
      label: "Listing details",
      hint: "Title, category, and description",
    },
    {
      ready: verificationStatus === "VERIFIED",
      label: "Domain ownership",
      hint:
        verificationStatus === "VERIFIED"
          ? "DNS verified"
          : "DNS verification required",
    },
    {
      ready: availableServiceCount > 0,
      label: "Available service",
      hint:
        availableServiceCount > 0
          ? `${availableServiceCount} available`
          : "Add at least one service",
    },
  ]
  return (
    <aside className="rounded-xl border bg-muted/20 p-4">
      <p className="font-medium">Review readiness</p>
      <div className="mt-4 space-y-4">
        {checks.map((check) => (
          <div key={check.label} className="flex gap-3">
            {check.ready ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600" />
            ) : (
              <AlertCircle className="mt-0.5 h-4 w-4 text-amber-600" />
            )}
            <div>
              <p className="text-sm font-medium">{check.label}</p>
              <p className="text-xs text-muted-foreground">{check.hint}</p>
            </div>
          </div>
        ))}
      </div>
    </aside>
  )
}

function ServiceCard({
  service,
  editing,
  draft,
  pending,
  onDraftChange,
  onEdit,
  onCancel,
  onSave,
  onAvailabilityChange,
}: {
  service: PublisherWebsiteService
  editing: boolean
  draft: {
    price: string
    currency: string
    turnaroundDays: string
    revisionRounds: string
    warrantyDays: string
  }
  pending: boolean
  onDraftChange: (value: typeof draft) => void
  onEdit: () => void
  onCancel: () => void
  onSave: () => void
  onAvailabilityChange: (
    availability: "AVAILABLE" | "PAUSED" | "WAITLIST",
  ) => void
}) {
  if (editing) {
    return (
      <div className="space-y-4 rounded-xl border border-blue-200 bg-blue-50/40 p-4 dark:border-blue-950 dark:bg-blue-950/10">
        <div className="flex items-center justify-between">
          <p className="font-medium">{serviceLabel(service.serviceType)}</p>
          <Badge variant="outline">Version {service.version}</Badge>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={`Price (${draft.currency})`}>
            <Input
              type="number"
              min={0.01}
              step="0.01"
              value={draft.price}
              onChange={(event) =>
                onDraftChange({ ...draft, price: event.target.value })
              }
            />
          </Field>
          <Field label="Turnaround days">
            <Input
              type="number"
              min={1}
              value={draft.turnaroundDays}
              onChange={(event) =>
                onDraftChange({
                  ...draft,
                  turnaroundDays: event.target.value,
                })
              }
            />
          </Field>
          <Field label="Revision rounds">
            <Input
              type="number"
              min={0}
              value={draft.revisionRounds}
              onChange={(event) =>
                onDraftChange({
                  ...draft,
                  revisionRounds: event.target.value,
                })
              }
            />
          </Field>
          <Field label="Warranty days">
            <Input
              type="number"
              min={0}
              value={draft.warrantyDays}
              onChange={(event) =>
                onDraftChange({ ...draft, warrantyDays: event.target.value })
              }
            />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={
              pending ||
              Number(draft.price) <= 0 ||
              Number(draft.turnaroundDays) < 1 ||
              Number(draft.revisionRounds) < 0
            }
            onClick={onSave}
          >
            Save changes
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-xl border p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium">{serviceLabel(service.serviceType)}</p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <DollarSign className="h-3.5 w-3.5" />
              {money(service.price, service.currency)}
            </span>
            <span className="inline-flex items-center gap-1">
              <Clock3 className="h-3.5 w-3.5" />
              {service.turnaroundDays} days
            </span>
            <span>{service.revisionRounds} revisions</span>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <Edit3 className="mr-2 h-3.5 w-3.5" /> Edit
        </Button>
      </div>
      <div className="mt-4 border-t pt-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            Buyer availability
          </span>
          <Select
            value={service.availability}
            onValueChange={(value) =>
              onAvailabilityChange(value as "AVAILABLE" | "PAUSED" | "WAITLIST")
            }
            disabled={pending}
          >
            <SelectTrigger className="h-8 w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="AVAILABLE">Available</SelectItem>
              <SelectItem value="WAITLIST">Waitlist</SelectItem>
              <SelectItem value="PAUSED">Paused</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  )
}
