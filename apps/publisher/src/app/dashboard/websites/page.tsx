"use client"

import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorState,
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
import { zodResolver } from "@hookform/resolvers/zod"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Archive,
  CheckCircle,
  Copy,
  ExternalLink,
  Globe,
  Pencil,
  Plus,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Star,
} from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"

const websiteSchema = z.object({
  url: z.string().url("Must be a valid URL"),
  domainRating: z.coerce.number().min(0).max(100).optional(),
  monthlyTraffic: z.coerce.number().min(0).optional(),
  country: z.string().optional(),
  language: z.string().optional(),
  price: z.coerce.number().min(0).optional(),
  niche: z.string().optional(),
})

type WebsiteFormData = z.infer<typeof websiteSchema>

interface Website {
  id: string
  url: string
  domainRating?: number
  monthlyTraffic?: number
  country?: string
  language?: string
  price?: number
  niche?: string
  status: "ACTIVE" | "ARCHIVED" | "PENDING"
  verificationStatus?:
    | "PENDING_VERIFICATION"
    | "VERIFIED"
    | "VERIFICATION_FAILED"
    | "REVOKED"
  verifiedAt?: string | null
  verificationFailureReason?: string | null
}

interface VerifyInstructions {
  type: string
  host: string
  value: string
  note?: string
}

const VERIFY_BADGE: Record<string, { label: string; variant: any; Icon: any }> =
  {
    VERIFIED: { label: "Verified", variant: "success", Icon: ShieldCheck },
    PENDING_VERIFICATION: {
      label: "Pending",
      variant: "warning",
      Icon: ShieldAlert,
    },
    VERIFICATION_FAILED: {
      label: "Failed",
      variant: "destructive",
      Icon: ShieldX,
    },
    REVOKED: { label: "Revoked", variant: "destructive", Icon: ShieldX },
  }

function WebsiteForm({
  onSubmit,
  defaultValues,
  onCancel,
  loading,
}: {
  onSubmit: (data: WebsiteFormData) => void
  defaultValues?: Partial<WebsiteFormData>
  onCancel?: () => void
  loading?: boolean
}) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<WebsiteFormData>({
    resolver: zodResolver(websiteSchema),
    defaultValues,
  })

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="url">Website URL *</Label>
        <Input
          id="url"
          placeholder="https://example.com"
          {...register("url")}
        />
        {errors.url && (
          <p className="text-xs text-destructive">{errors.url.message}</p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="domainRating">Domain Rating (DA)</Label>
          <Input
            id="domainRating"
            type="number"
            placeholder="50"
            {...register("domainRating")}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="monthlyTraffic">Monthly Traffic</Label>
          <Input
            id="monthlyTraffic"
            type="number"
            placeholder="10000"
            {...register("monthlyTraffic")}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="country">Country</Label>
          <Input id="country" placeholder="US" {...register("country")} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="language">Language</Label>
          <Input
            id="language"
            placeholder="English"
            {...register("language")}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="price">Price (USD)</Label>
          <Input
            id="price"
            type="number"
            placeholder="100"
            {...register("price")}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="niche">Niche</Label>
          <Input id="niche" placeholder="Technology" {...register("niche")} />
        </div>
      </div>

      <DialogFooter className="pt-4">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={loading}>
          {loading
            ? "Saving..."
            : defaultValues
              ? "Update Website"
              : "Add Website"}
        </Button>
      </DialogFooter>
    </form>
  )
}

function WebsiteDialog({
  open,
  onOpenChange,
  onSubmit,
  defaultValues,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (data: WebsiteFormData) => void
  defaultValues?: Partial<WebsiteFormData>
}) {
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (data: WebsiteFormData) => {
    setLoading(true)
    try {
      await onSubmit(data)
      onOpenChange(false)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {defaultValues ? "Edit Website" : "Add New Website"}
          </DialogTitle>
        </DialogHeader>
        <WebsiteForm
          onSubmit={handleSubmit}
          defaultValues={defaultValues}
          onCancel={() => onOpenChange(false)}
          loading={loading}
        />
      </DialogContent>
    </Dialog>
  )
}

export default function WebsitesPage() {
  const router = useRouter()
  const [search, setSearch] = useState("")
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [editingWebsite, setEditingWebsite] = useState<Website | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [verifyTarget, setVerifyTarget] = useState<Website | null>(null)
  const [verifyInstructions, setVerifyInstructions] =
    useState<VerifyInstructions | null>(null)
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const publisherId = user?.publisherId

  const {
    data: websites = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["publisher-websites", publisherId],
    queryFn: async () => {
      if (!publisherId) return []
      const sites = (await api.publishers.getWebsites(publisherId)) as any[]
      return sites.map((s: any) => ({
        id: s.id,
        url: s.url || "",
        domainRating: s.metrics?.dr || 0,
        monthlyTraffic: s.metrics?.traffic || 0,
        country: s.country || "",
        language: s.language || "",
        price: s.marketplaceListings?.[0]?.price || 0,
        niche: s.category || "",
        status: s.isActive ? "ACTIVE" : "ARCHIVED",
        marketplaceStatus: s.marketplaceListings?.[0]?.status || "PENDING",
        verificationStatus: s.verificationStatus || "PENDING_VERIFICATION",
        verifiedAt: s.verifiedAt || null,
        verificationFailureReason: s.verificationFailureReason || null,
      })) as (Website & { marketplaceStatus: string })[]
    },
  })

  const addMutation = useMutation({
    mutationFn: async (data: WebsiteFormData) => {
      if (!publisherId) throw new Error("Not authenticated")
      return api.publishers.addWebsite(publisherId, {
        url: data.url,
        category: data.niche,
        language: data.language,
        country: data.country,
        domainRating: data.domainRating,
        monthlyTraffic: data.monthlyTraffic,
        price: data.price,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["publisher-websites"] })
      toast.success("Website added successfully")
    },
    onError: () => {
      toast.error("Failed to add website")
    },
  })

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: WebsiteFormData }) => {
      if (!publisherId) throw new Error("Not authenticated")
      return api.publishers.updateWebsite(publisherId, id, {
        url: data.url,
        category: data.niche,
        language: data.language,
        country: data.country,
        domainRating: data.domainRating,
        monthlyTraffic: data.monthlyTraffic,
        price: data.price,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["publisher-websites"] })
      toast.success("Website updated successfully")
      setEditingWebsite(null)
    },
    onError: () => {
      toast.error("Failed to update website")
    },
  })

  const submitMutation = useMutation({
    mutationFn: async (id: string) => {
      if (!publisherId) throw new Error("Not authenticated")
      return api.publishers.submitForReview(publisherId, id)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["publisher-websites"] })
      toast.success("Website submitted for review")
    },
    onError: () => {
      toast.error("Failed to submit website")
    },
  })

  const verifyMutation = useMutation({
    mutationFn: async (site: Website) => {
      if (!publisherId) throw new Error("Not authenticated")
      const res = await api.publishers.verifyWebsite(publisherId, site.id)
      return res as { instructions: VerifyInstructions }
    },
    onSuccess: (res, site) => {
      setVerifyTarget(site)
      setVerifyInstructions(res.instructions)
      queryClient.invalidateQueries({ queryKey: ["publisher-websites"] })
      toast.success(
        "Verification queued — add the TXT record below, then check back shortly",
      )
    },
    onError: (err: any) => {
      toast.error(err?.message || "Failed to start verification")
    },
  })

  const archiveMutation = useMutation({
    mutationFn: async (id: string) => {
      if (!publisherId) throw new Error("Not authenticated")
      return api.publishers.deleteWebsite(publisherId, id)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["publisher-websites"] })
      toast.success("Website archived")
    },
    onError: () => {
      toast.error("Failed to archive website")
    },
  })

  const filteredWebsites = websites.filter((site) => {
    const matchesSearch =
      site.url.toLowerCase().includes(search.toLowerCase()) ||
      site.niche?.toLowerCase().includes(search.toLowerCase())
    const matchesArchived = showArchived ? true : site.status === "ACTIVE"
    return matchesSearch && matchesArchived
  })

  if (error)
    return (
      <ErrorState
        title="Failed to load websites"
        description={(error as Error).message}
        onRetry={() =>
          queryClient.invalidateQueries({ queryKey: ["publisher-websites"] })
        }
      />
    )

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Websites</h1>
            <p className="text-sm text-muted-foreground">
              Manage your website inventory
            </p>
          </div>
        </div>
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Websites</h1>
          <p className="text-sm text-muted-foreground">
            Manage your website inventory for guest posting
          </p>
        </div>
        <Button onClick={() => setShowAddDialog(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add Website
        </Button>
      </div>

      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search websites..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>
        <Button
          variant={showArchived ? "secondary" : "outline"}
          onClick={() => setShowArchived(!showArchived)}
        >
          <Archive className="mr-2 h-4 w-4" />
          {showArchived ? "Showing All" : "Show Archived"}
        </Button>
      </div>

      {filteredWebsites.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border py-16 text-center">
          <Globe className="mb-3 h-10 w-10 text-muted-foreground/50" />
          <p className="font-medium">No websites found</p>
          <p className="text-sm text-muted-foreground">
            {search
              ? "Try a different search term"
              : "Add your first website to get started"}
          </p>
          {!search && (
            <Button className="mt-4" onClick={() => setShowAddDialog(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Add Website
            </Button>
          )}
        </div>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Website</TableHead>
                <TableHead>DR</TableHead>
                <TableHead>Traffic</TableHead>
                <TableHead>Country</TableHead>
                <TableHead>Language</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Verification</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredWebsites.map((site) => (
                <TableRow
                  key={site.id}
                  className="cursor-pointer"
                  onClick={() => router.push(`/dashboard/websites/${site.id}`)}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      router.push(`/dashboard/websites/${site.id}`)
                    }
                  }}
                >
                  <TableCell>
                    <div className="flex flex-col">
                      <a
                        href={
                          site.url.startsWith("http")
                            ? site.url
                            : `https://${site.url}`
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 font-medium hover:underline"
                      >
                        {site.url}
                        <ExternalLink className="h-3 w-3 text-muted-foreground" />
                      </a>
                      <span className="text-xs text-muted-foreground">
                        {site.niche}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Star className="h-3 w-3 text-amber-500" />
                      {site.domainRating ?? "—"}
                    </div>
                  </TableCell>
                  <TableCell>
                    {site.monthlyTraffic
                      ? site.monthlyTraffic.toLocaleString()
                      : "—"}
                  </TableCell>
                  <TableCell>{site.country ?? "—"}</TableCell>
                  <TableCell>{site.language ?? "—"}</TableCell>
                  <TableCell>{site.price ? `$${site.price}` : "—"}</TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        site.status === "ACTIVE"
                          ? "success"
                          : site.status === "ARCHIVED"
                            ? "secondary"
                            : "warning"
                      }
                    >
                      {site.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {(() => {
                      const v =
                        VERIFY_BADGE[
                          site.verificationStatus ?? "PENDING_VERIFICATION"
                        ]
                      return (
                        <Badge
                          variant={v.variant}
                          className="gap-1"
                          title={site.verificationFailureReason ?? undefined}
                        >
                          <v.Icon className="h-3 w-3" />
                          {v.label}
                        </Badge>
                      )
                    })()}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      {site.verificationStatus !== "VERIFIED" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Verify domain ownership (DNS TXT)"
                          disabled={verifyMutation.isPending}
                          onClick={(e) => {
                            e.stopPropagation()
                            verifyMutation.mutate(site)
                          }}
                        >
                          <ShieldCheck className="h-4 w-4" />
                        </Button>
                      )}
                      {site.marketplaceStatus === "DRAFT" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Submit for Review"
                          onClick={(e) => {
                            e.stopPropagation()
                            submitMutation.mutate(site.id)
                          }}
                        >
                          <CheckCircle className="h-4 w-4" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation()
                          setEditingWebsite(site)
                        }}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation()
                          archiveMutation.mutate(site.id)
                        }}
                      >
                        <Archive className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <WebsiteDialog
        open={showAddDialog}
        onOpenChange={setShowAddDialog}
        onSubmit={(data) => addMutation.mutate(data)}
      />

      <WebsiteDialog
        open={!!editingWebsite}
        onOpenChange={(open) => !open && setEditingWebsite(null)}
        onSubmit={(data) =>
          editingWebsite &&
          updateMutation.mutate({ id: editingWebsite.id, data })
        }
        defaultValues={
          editingWebsite
            ? {
                url: editingWebsite.url,
                domainRating: editingWebsite.domainRating,
                monthlyTraffic: editingWebsite.monthlyTraffic,
                country: editingWebsite.country,
                language: editingWebsite.language,
                price: editingWebsite.price,
                niche: editingWebsite.niche,
              }
            : undefined
        }
      />

      <Dialog
        open={!!verifyInstructions}
        onOpenChange={(open) => {
          if (!open) {
            setVerifyInstructions(null)
            setVerifyTarget(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Verify domain ownership</DialogTitle>
          </DialogHeader>
          {verifyInstructions && (
            <div className="space-y-4 text-sm">
              <p className="text-muted-foreground">
                Prove you control{" "}
                <span className="font-medium text-foreground">
                  {verifyTarget?.url}
                </span>{" "}
                by adding this DNS{" "}
                <span className="font-medium text-foreground">TXT</span> record
                at your domain registrar.
              </p>
              <div className="space-y-2 rounded-lg border bg-muted/40 p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">
                    Type
                  </span>
                  <code className="font-mono">{verifyInstructions.type}</code>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">
                    Host / Name
                  </span>
                  <code className="font-mono">{verifyInstructions.host}</code>
                </div>
                <div className="flex items-start justify-between gap-2">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">
                    Value
                  </span>
                  <div className="flex items-center gap-2">
                    <code className="break-all font-mono text-right">
                      {verifyInstructions.value}
                    </code>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Copy value"
                      onClick={() => {
                        navigator.clipboard.writeText(verifyInstructions.value)
                        toast.success("Copied TXT value")
                      }}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {verifyInstructions.note ??
                  "DNS changes can take up to 48 hours to propagate. We re-check automatically when you click Verify."}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setVerifyInstructions(null)
                setVerifyTarget(null)
              }}
            >
              Close
            </Button>
            {verifyTarget && (
              <Button
                disabled={verifyMutation.isPending}
                onClick={() => verifyMutation.mutate(verifyTarget)}
              >
                Re-check now
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
