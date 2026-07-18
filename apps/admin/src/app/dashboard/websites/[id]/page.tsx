"use client"

import type {
  AdminPlatformListingServiceResponse,
  AdminPlatformWebsiteResponse,
  Category,
  IntegrationListResponse,
} from "@guestpost/api-client"
import {
  LISTING_LINK_TYPE_LABELS,
  LISTING_LINK_TYPES,
  LISTING_LINK_VALIDITIES,
  LISTING_LINK_VALIDITY_LABELS,
  MARKETPLACE_CATEGORY_LIMIT,
  MARKETPLACE_LANGUAGES,
} from "@guestpost/shared"
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
  ArrowLeft,
  BarChart3,
  ExternalLink,
  Link2,
  RefreshCw,
  SearchCheck,
  Unlink,
} from "lucide-react"
import Link from "next/link"
import { use, useEffect, useState } from "react"
import { toast } from "sonner"
import { api } from "../../../../lib/api"
import { useAuth } from "../../../../lib/auth"
import { ForbiddenPage, useRequireRole } from "../../../../lib/use-require-role"

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

type GoogleProvider = "GOOGLE_SEARCH_CONSOLE" | "GOOGLE_ANALYTICS"
type PlatformIntegrationSummary = { id: string; provider: string }

function platformListingDetails(
  listing: NonNullable<AdminPlatformWebsiteResponse["listing"]>,
) {
  return {
    title: listing.title,
    description: listing.description,
    categoryIds:
      listing.categories?.map((category) => category.id) ??
      (listing.category ? [listing.category.id] : []),
    language: listing.language ?? "English",
    sportsGamingAllowed: listing.sportsGamingAllowed ?? false,
    pharmacyAllowed: listing.pharmacyAllowed ?? false,
    cryptoAllowed: listing.cryptoAllowed ?? false,
    backlinkCount: listing.backlinkCount ?? 1,
    linkType: listing.linkType ?? ("DOFOLLOW" as const),
    linkValidity: listing.linkValidity ?? ("PERMANENT" as const),
    googleNews: listing.googleNews ?? false,
    markedSponsored: listing.markedSponsored ?? false,
    foreignLanguageAllowed: listing.foreignLanguageAllowed ?? false,
  }
}

const YES_NO_OPTIONS = [
  { value: "no", label: "No" },
  { value: "yes", label: "Yes" },
]

function MetadataField({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  )
}

function MetadataSelect({
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
    <MetadataField label={label}>
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
    </MetadataField>
  )
}

function BooleanMetadataSelect({
  label,
  value,
  onChange,
}: {
  label: string
  value: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <MetadataSelect
      label={label}
      value={value ? "yes" : "no"}
      options={YES_NO_OPTIONS}
      onChange={(next) => onChange(next === "yes")}
    />
  )
}

export default function PlatformWebsiteDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { allowed, loading } = useRequireRole("SUPER_ADMIN", "OPERATIONS")
  if (loading) return null
  if (!allowed) return <ForbiddenPage requires="Operations or Super Admin" />
  return <PlatformWebsiteDetailPageInner params={params} />
}

function PlatformWebsiteDetailPageInner({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const isSuperAdmin = user?.staffRole === "SUPER_ADMIN"
  const canManageAssignedSite = isSuperAdmin || user?.staffRole === "OPERATIONS"

  const websiteQ = useQuery({
    queryKey: ["admin", "platform-website", id],
    queryFn: () => api.admin.getPlatformWebsite(id),
  })
  const integrationsQ = useQuery<IntegrationListResponse>({
    queryKey: ["admin", "platform-integrations", id],
    queryFn: () =>
      api.integrations.list({ pageSize: 100, platformWebsiteId: id }),
    enabled: canManageAssignedSite,
  })

  const invalidateWebsite = () => {
    queryClient.invalidateQueries({
      queryKey: ["admin", "platform-website", id],
    })
    queryClient.invalidateQueries({ queryKey: ["admin", "platform-websites"] })
    queryClient.invalidateQueries({ queryKey: ["admin-marketplace-listings"] })
  }

  if (websiteQ.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-80" />
        <Skeleton className="h-44 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    )
  }
  if (websiteQ.isError || !websiteQ.data) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <p className="font-medium">Platform website could not be loaded</p>
          <p className="text-sm text-muted-foreground">
            {(websiteQ.error as Error)?.message ?? "Website not found"}
          </p>
          <Button variant="outline" onClick={() => websiteQ.refetch()}>
            Try again
          </Button>
        </CardContent>
      </Card>
    )
  }

  const website = websiteQ.data
  const integrations: PlatformIntegrationSummary[] = (
    integrationsQ.data?.data ?? []
  ).flatMap((integration) =>
    integration.id && integration.provider
      ? [{ id: integration.id, provider: integration.provider }]
      : [],
  )

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Button variant="ghost" size="sm" asChild className="-ml-3 mb-2">
            <Link href="/dashboard/websites">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Platform Websites
            </Link>
          </Button>
          <h1 className="text-3xl font-bold tracking-tight">
            {website.name || website.domain || website.url}
          </h1>
          <a
            href={website.url}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            {website.url}
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
        <div className="flex gap-2">
          <Badge variant={website.isActive ? "success" : "secondary"}>
            {website.isActive ? "Active website" : "Paused website"}
          </Badge>
          <Badge variant="outline">DNS not required</Badge>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Marketplace listing</CardTitle>
          <CardDescription>
            This is the domain&apos;s only listing. Every sellable offering is a
            service below it. Super Admin and the assigned Operations owner can
            manage services; listing status changes remain moderated.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {website.listing ? (
            <PlatformListingManager
              website={website}
              canEditServices={canManageAssignedSite}
              canEditMetadata={isSuperAdmin}
              onChanged={invalidateWebsite}
            />
          ) : (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
              This website is missing its atomic listing. Creation is blocked
              here so a second listing cannot be introduced; repair this data
              before publishing the site.
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Google performance data</CardTitle>
          <CardDescription>
            Search Console and GA4 are OAuth data sources, not ownership
            verification. The Google account can differ from the signed-in
            GuestPost account.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-2">
          {(["GOOGLE_SEARCH_CONSOLE", "GOOGLE_ANALYTICS"] as const).map(
            (provider) => (
              <GoogleIntegrationPanel
                key={provider}
                provider={provider}
                website={website}
                integration={integrations.find(
                  (candidate) => candidate.provider === provider,
                )}
                canConfigure={canManageAssignedSite}
                integrationsLoading={integrationsQ.isLoading}
                onChanged={() => {
                  invalidateWebsite()
                  queryClient.invalidateQueries({
                    queryKey: ["admin", "platform-integrations", id],
                  })
                }}
              />
            ),
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function PlatformListingManager({
  website,
  canEditServices,
  canEditMetadata,
  onChanged,
}: {
  website: AdminPlatformWebsiteResponse
  canEditServices: boolean
  canEditMetadata: boolean
  onChanged: () => void
}) {
  const listing = website.listing!
  const [details, setDetails] = useState(() => platformListingDetails(listing))
  const [newService, setNewService] = useState({
    serviceType: "GUEST_POST",
    price: "",
    turnaroundDays: "7",
    revisionRounds: "2",
  })
  const [editingService, setEditingService] =
    useState<AdminPlatformListingServiceResponse | null>(null)
  const [editService, setEditService] = useState({
    price: "",
    turnaroundDays: "",
    revisionRounds: "",
  })

  useEffect(() => setDetails(platformListingDetails(listing)), [listing])

  const categoriesQ = useQuery<Category[]>({
    queryKey: ["marketplace-categories"],
    queryFn: () => api.marketplace.getCategories(),
    enabled: canEditMetadata,
  })

  const updateDetailsMut = useMutation({
    mutationFn: () =>
      api.admin.updatePlatformWebsite(website.id, {
        listingTitle: details.title.trim(),
        description: details.description.trim(),
        categoryIds: details.categoryIds,
        language: details.language,
        sportsGamingAllowed: details.sportsGamingAllowed,
        pharmacyAllowed: details.pharmacyAllowed,
        cryptoAllowed: details.cryptoAllowed,
        backlinkCount: details.backlinkCount,
        linkType: details.linkType,
        linkValidity: details.linkValidity,
        googleNews: details.googleNews,
        markedSponsored: details.markedSponsored,
        foreignLanguageAllowed: details.foreignLanguageAllowed,
      }),
    onSuccess: () => {
      onChanged()
      toast.success("Listing details updated")
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const startEditing = (service: AdminPlatformListingServiceResponse) => {
    setEditingService(service)
    setEditService({
      price: String(service.price),
      turnaroundDays: String(service.turnaroundDays),
      revisionRounds: String(service.revisionRounds),
    })
  }

  const statusMut = useMutation({
    mutationFn: (status: string) =>
      api.admin.updateListingStatus(listing.id, status),
    onSuccess: () => {
      onChanged()
      toast.success("Listing status updated")
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const addMut = useMutation({
    mutationFn: () =>
      api.admin.addPlatformListingService(listing.id, {
        serviceType: newService.serviceType,
        price: Number(newService.price),
        turnaroundDays: Number(newService.turnaroundDays),
        revisionRounds: Number(newService.revisionRounds),
      }),
    onSuccess: () => {
      setNewService({
        serviceType: "GUEST_POST",
        price: "",
        turnaroundDays: "7",
        revisionRounds: "2",
      })
      onChanged()
      toast.success("Service added")
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const updateMut = useMutation({
    mutationFn: ({
      service,
      availability,
    }: {
      service: AdminPlatformListingServiceResponse
      availability: string
    }) =>
      api.admin.updatePlatformListingService(listing.id, service.id, {
        version: service.version,
        availability,
      }),
    onSuccess: onChanged,
    onError: (error: Error) => toast.error(error.message),
  })
  const editMut = useMutation({
    mutationFn: () =>
      api.admin.updatePlatformListingService(listing.id, editingService!.id, {
        version: editingService!.version,
        price: Number(editService.price),
        turnaroundDays: Number(editService.turnaroundDays),
        revisionRounds: Number(editService.revisionRounds),
      }),
    onSuccess: () => {
      setEditingService(null)
      onChanged()
      toast.success("Service updated")
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const pauseMut = useMutation({
    mutationFn: (serviceId: string) =>
      api.admin.pausePlatformListingService(listing.id, serviceId),
    onSuccess: () => {
      onChanged()
      toast.success("Service paused")
    },
    onError: (error: Error) => toast.error(error.message),
  })

  return (
    <div className="space-y-5">
      <div className="space-y-4 rounded-xl border bg-muted/20 p-4">
        <div>
          <p className="font-medium">Listing details & placement policy</p>
          <p className="mt-1 text-xs text-muted-foreground">
            One primary language and policy value per listing; choose 1–7
            categories. Metrics come from linked GSC/GA4 properties.
          </p>
        </div>
        {canEditMetadata ? (
          <>
            <div className="grid gap-4 md:grid-cols-2">
              <MetadataField label="Listing title">
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
              </MetadataField>
              <MetadataField label="Categories">
                <MultiSelect
                  options={(categoriesQ.data ?? []).map((category) => ({
                    value: category.id,
                    label: category.name,
                  }))}
                  value={details.categoryIds}
                  onValueChange={(categoryIds) =>
                    setDetails((current) => ({ ...current, categoryIds }))
                  }
                  maxSelected={MARKETPLACE_CATEGORY_LIMIT}
                  placeholder="Choose 1–7 categories"
                  searchPlaceholder="Search categories..."
                  disabled={categoriesQ.isLoading || categoriesQ.isError}
                />
              </MetadataField>
            </div>
            <MetadataField label="Buyer description">
              <Textarea
                rows={4}
                maxLength={500}
                value={details.description}
                onChange={(event) =>
                  setDetails((current) => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
              />
            </MetadataField>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <MetadataSelect
                label="Primary language"
                value={details.language}
                options={MARKETPLACE_LANGUAGES.map((value) => ({
                  value,
                  label: value,
                }))}
                onChange={(language) =>
                  setDetails((current) => ({ ...current, language }))
                }
              />
              <BooleanMetadataSelect
                label="Sports/Gaming allowed?"
                value={details.sportsGamingAllowed}
                onChange={(sportsGamingAllowed) =>
                  setDetails((current) => ({
                    ...current,
                    sportsGamingAllowed,
                  }))
                }
              />
              <BooleanMetadataSelect
                label="Pharmacy allowed?"
                value={details.pharmacyAllowed}
                onChange={(pharmacyAllowed) =>
                  setDetails((current) => ({ ...current, pharmacyAllowed }))
                }
              />
              <BooleanMetadataSelect
                label="Crypto allowed?"
                value={details.cryptoAllowed}
                onChange={(cryptoAllowed) =>
                  setDetails((current) => ({ ...current, cryptoAllowed }))
                }
              />
              <MetadataSelect
                label="Number of backlinks"
                value={String(details.backlinkCount)}
                options={[1, 2, 3].map((value) => ({
                  value: String(value),
                  label: String(value),
                }))}
                onChange={(value) =>
                  setDetails((current) => ({
                    ...current,
                    backlinkCount: Number(value),
                  }))
                }
              />
              <MetadataSelect
                label="Link type"
                value={details.linkType}
                options={LISTING_LINK_TYPES.map((value) => ({
                  value,
                  label: LISTING_LINK_TYPE_LABELS[value],
                }))}
                onChange={(value) =>
                  setDetails((current) => ({
                    ...current,
                    linkType: value as typeof current.linkType,
                  }))
                }
              />
              <MetadataSelect
                label="Link validity"
                value={details.linkValidity}
                options={LISTING_LINK_VALIDITIES.map((value) => ({
                  value,
                  label: LISTING_LINK_VALIDITY_LABELS[value],
                }))}
                onChange={(value) =>
                  setDetails((current) => ({
                    ...current,
                    linkValidity: value as typeof current.linkValidity,
                  }))
                }
              />
              <BooleanMetadataSelect
                label="Google News?"
                value={details.googleNews}
                onChange={(googleNews) =>
                  setDetails((current) => ({ ...current, googleNews }))
                }
              />
              <BooleanMetadataSelect
                label="Marked as sponsored?"
                value={details.markedSponsored}
                onChange={(markedSponsored) =>
                  setDetails((current) => ({ ...current, markedSponsored }))
                }
              />
              <BooleanMetadataSelect
                label="Foreign-language content allowed?"
                value={details.foreignLanguageAllowed}
                onChange={(foreignLanguageAllowed) =>
                  setDetails((current) => ({
                    ...current,
                    foreignLanguageAllowed,
                  }))
                }
              />
            </div>
            <Button
              onClick={() => updateDetailsMut.mutate()}
              disabled={
                updateDetailsMut.isPending ||
                details.title.trim().length < 3 ||
                details.description.trim().length < 1 ||
                details.description.length > 500 ||
                details.categoryIds.length < 1 ||
                details.categoryIds.length > MARKETPLACE_CATEGORY_LIMIT ||
                categoriesQ.isError
              }
            >
              {updateDetailsMut.isPending
                ? "Saving..."
                : "Save listing details"}
            </Button>
          </>
        ) : (
          <div className="flex flex-wrap gap-2 text-sm">
            {(listing.categories ?? []).map((category) => (
              <Badge key={category.id} variant="secondary">
                {category.name}
              </Badge>
            ))}
            <Badge variant="outline">
              {listing.language ?? "Language missing"}
            </Badge>
            <Badge variant="outline">
              {listing.linkType ?? "Link type missing"}
            </Badge>
            <Badge variant="outline">
              {listing.backlinkCount ?? "—"} backlink(s)
            </Badge>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
        <div>
          <p className="font-medium">{listing.title}</p>
          <p className="text-sm text-muted-foreground">/{listing.slug}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{listing.status}</Badge>
          {listing.status !== "APPROVED" && listing.status !== "ARCHIVED" && (
            <Button
              size="sm"
              onClick={() => statusMut.mutate("APPROVED")}
              disabled={listing.services.length === 0 || statusMut.isPending}
            >
              Approve listing
            </Button>
          )}
          {listing.status !== "REJECTED" &&
            listing.status !== "APPROVED" &&
            listing.status !== "ARCHIVED" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => statusMut.mutate("REJECTED")}
                disabled={statusMut.isPending}
              >
                Reject listing
              </Button>
            )}
          {listing.status === "APPROVED" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => statusMut.mutate("PAUSED")}
              disabled={statusMut.isPending}
            >
              Pause listing
            </Button>
          )}
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Service</TableHead>
            <TableHead>Price</TableHead>
            <TableHead>Turnaround</TableHead>
            <TableHead>Availability</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {listing.services.map((service) => (
            <TableRow key={service.id}>
              <TableCell className="font-medium">
                {service.serviceType.replace(/_/g, " ")}
              </TableCell>
              <TableCell>
                {new Intl.NumberFormat("en-US", {
                  style: "currency",
                  currency: service.currency,
                }).format(Number(service.price))}
              </TableCell>
              <TableCell>{service.turnaroundDays} days</TableCell>
              <TableCell>
                {canEditServices ? (
                  <Select
                    value={service.availability}
                    onValueChange={(availability) =>
                      updateMut.mutate({ service, availability })
                    }
                  >
                    <SelectTrigger className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="AVAILABLE">Available</SelectItem>
                      <SelectItem value="WAITLIST">Waitlist</SelectItem>
                      <SelectItem value="PAUSED">Paused</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <Badge variant="secondary">{service.availability}</Badge>
                )}
              </TableCell>
              <TableCell className="text-right">
                {canEditServices ? (
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => startEditing(service)}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={service.availability === "PAUSED"}
                      onClick={() => pauseMut.mutate(service.id)}
                    >
                      Pause
                    </Button>
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    View only
                  </span>
                )}
              </TableCell>
            </TableRow>
          ))}
          {listing.services.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={5}
                className="py-8 text-center text-muted-foreground"
              >
                No services yet. The listing cannot be published.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      {canEditServices && editingService && (
        <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
          <div>
            <p className="font-medium">
              Edit {editingService.serviceType.replace(/_/g, " ")}
            </p>
            <p className="text-xs text-muted-foreground">
              Concurrent changes are protected by the service version; reload
              and retry if another staff member saved first.
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Price ({editingService.currency})</Label>
              <Input
                type="number"
                min={0.01}
                step="0.01"
                value={editService.price}
                onChange={(event) =>
                  setEditService((current) => ({
                    ...current,
                    price: event.target.value,
                  }))
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label>Turnaround days</Label>
              <Input
                type="number"
                min={1}
                value={editService.turnaroundDays}
                onChange={(event) =>
                  setEditService((current) => ({
                    ...current,
                    turnaroundDays: event.target.value,
                  }))
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label>Revision rounds</Label>
              <Input
                type="number"
                min={0}
                value={editService.revisionRounds}
                onChange={(event) =>
                  setEditService((current) => ({
                    ...current,
                    revisionRounds: event.target.value,
                  }))
                }
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              onClick={() => editMut.mutate()}
              disabled={
                Number(editService.price) <= 0 ||
                Number(editService.turnaroundDays) < 1 ||
                Number(editService.revisionRounds) < 0 ||
                editMut.isPending
              }
            >
              {editMut.isPending ? "Saving..." : "Save changes"}
            </Button>
            <Button
              variant="outline"
              onClick={() => setEditingService(null)}
              disabled={editMut.isPending}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {canEditServices && (
        <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
          <p className="font-medium">Add service to this listing</p>
          <div className="grid gap-3 md:grid-cols-4">
            <Select
              value={newService.serviceType}
              onValueChange={(serviceType) =>
                setNewService((current) => ({ ...current, serviceType }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SERVICE_TYPES.map((serviceType) => (
                  <SelectItem key={serviceType} value={serviceType}>
                    {serviceType.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              type="number"
              min={0}
              step="0.01"
              placeholder="Price (USD)"
              value={newService.price}
              onChange={(event) =>
                setNewService((current) => ({
                  ...current,
                  price: event.target.value,
                }))
              }
            />
            <Input
              type="number"
              min={1}
              placeholder="Turnaround days"
              value={newService.turnaroundDays}
              onChange={(event) =>
                setNewService((current) => ({
                  ...current,
                  turnaroundDays: event.target.value,
                }))
              }
            />
            <Input
              type="number"
              min={0}
              placeholder="Revision rounds"
              value={newService.revisionRounds}
              onChange={(event) =>
                setNewService((current) => ({
                  ...current,
                  revisionRounds: event.target.value,
                }))
              }
            />
          </div>
          <Button
            onClick={() => addMut.mutate()}
            disabled={
              Number(newService.price) < 0 ||
              !newService.price ||
              Number(newService.turnaroundDays) < 1 ||
              addMut.isPending
            }
          >
            {addMut.isPending ? "Adding..." : "Add service"}
          </Button>
        </div>
      )}
    </div>
  )
}

function GoogleIntegrationPanel({
  provider,
  website,
  integration,
  canConfigure,
  integrationsLoading,
  onChanged,
}: {
  provider: GoogleProvider
  website: AdminPlatformWebsiteResponse
  integration: PlatformIntegrationSummary | undefined
  canConfigure: boolean
  integrationsLoading: boolean
  onChanged: () => void
}) {
  const [selectedResource, setSelectedResource] = useState("")
  const linked = website.integrations.find((item) => item.provider === provider)
  const resourcesQ = useQuery({
    queryKey: [
      "admin",
      "platform-integration-resources",
      website.id,
      integration?.id,
    ],
    queryFn: () => api.integrations.listResources(integration!.id, website.id),
    enabled: canConfigure && !!integration && !linked,
  })

  const connectMut = useMutation({
    mutationFn: () =>
      api.integrations.connect(
        "GOOGLE_SEARCH_CONSOLE",
        `/dashboard/websites/${website.id}`,
        website.id,
      ),
    onSuccess: (result) => {
      if (!result.authorizationUrl) {
        toast.error("Google authorization URL was not returned")
        return
      }
      window.location.assign(result.authorizationUrl)
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const discoverMut = useMutation({
    mutationFn: () =>
      api.integrations.discoverResources(integration!.id, website.id),
    onSuccess: () => {
      toast.success("Google property discovery queued")
      onChanged()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const linkMut = useMutation({
    mutationFn: () =>
      api.integrations.linkProperty(
        integration!.id,
        website.id,
        selectedResource,
      ),
    onSuccess: () => {
      setSelectedResource("")
      onChanged()
      toast.success("Google property linked")
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const unlinkMut = useMutation({
    mutationFn: () =>
      api.integrations.unlinkProperty(integration!.id, linked!.id, website.id),
    onSuccess: () => {
      onChanged()
      toast.success("Google property unlinked")
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const syncMut = useMutation({
    mutationFn: () =>
      api.integrations.triggerSync(integration!.id, {
        websiteIntegrationId: linked!.id,
        platformWebsiteId: website.id,
      }),
    onSuccess: () => {
      onChanged()
      toast.success("Data sync queued")
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const title =
    provider === "GOOGLE_SEARCH_CONSOLE"
      ? "Google Search Console"
      : "Google Analytics 4"
  const Icon = provider === "GOOGLE_SEARCH_CONSOLE" ? SearchCheck : BarChart3

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex gap-3">
          <div className="rounded-lg bg-primary/10 p-2 text-primary">
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <p className="font-medium">{title}</p>
            <p className="text-xs text-muted-foreground">
              {linked
                ? linked.externalResourceName || linked.externalResourceId
                : "No property linked"}
            </p>
          </div>
        </div>
        <Badge variant={linked ? "success" : "secondary"}>
          {linked?.status ?? "Not linked"}
        </Badge>
      </div>

      {!canConfigure ? (
        <p className="text-sm text-muted-foreground">
          Only Super Admin or the assigned Operations owner can configure this
          site&apos;s integrations.
        </p>
      ) : integrationsLoading ? (
        <Skeleton className="h-9 w-full" />
      ) : !integration ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Connect Google and choose any Google account that owns the needed
            properties; it does not have to match your GuestPost login.
          </p>
          {provider === "GOOGLE_SEARCH_CONSOLE" ? (
            <Button
              onClick={() => connectMut.mutate()}
              disabled={connectMut.isPending}
            >
              <Link2 className="mr-2 h-4 w-4" />
              Connect Google account
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">
              Connect Google through Search Console once; the same consent
              includes GA4 access and creates both provider integrations.
            </p>
          )}
        </div>
      ) : linked ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => syncMut.mutate()}
            disabled={syncMut.isPending}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Sync now
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => unlinkMut.mutate()}
            disabled={unlinkMut.isPending}
          >
            <Unlink className="mr-2 h-4 w-4" />
            Unlink
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Google property</Label>
            <Select
              value={selectedResource}
              onValueChange={setSelectedResource}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    resourcesQ.isLoading
                      ? "Loading properties..."
                      : "Select a property"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {(resourcesQ.data?.resources ?? [])
                  .filter(
                    (
                      resource,
                    ): resource is typeof resource & {
                      externalResourceId: string
                    } => !!resource.externalResourceId,
                  )
                  .map((resource) => (
                    <SelectItem
                      key={resource.externalResourceId}
                      value={resource.externalResourceId}
                    >
                      {resource.externalResourceName ||
                        resource.externalResourceId}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => linkMut.mutate()}
              disabled={!selectedResource || linkMut.isPending}
            >
              Link property
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => discoverMut.mutate()}
              disabled={discoverMut.isPending}
            >
              Rediscover
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
