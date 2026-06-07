"use client"

import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../../lib/api"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "sonner"
import {
  Globe,
  Plus,
  Pencil,
  Archive,
  Search,
  RefreshCw,
  Trash2,
  ExternalLink,
  Star,
  CheckCircle,
} from "lucide-react"
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@guestpost/ui"
import { Button } from "@guestpost/ui"
import { Input } from "@guestpost/ui"
import { Label } from "@guestpost/ui"
import { Badge } from "@guestpost/ui"
import { Skeleton } from "@guestpost/ui"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@guestpost/ui"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@guestpost/ui"

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
}

const mockWebsites: Website[] = [
  {
    id: "1",
    url: "techdaily.example.com",
    domainRating: 72,
    monthlyTraffic: 45000,
    country: "US",
    language: "English",
    price: 150,
    niche: "Technology",
    status: "ACTIVE",
  },
  {
    id: "2",
    url: "financeworld.example.com",
    domainRating: 65,
    monthlyTraffic: 32000,
    country: "UK",
    language: "English",
    price: 200,
    niche: "Finance",
    status: "ACTIVE",
  },
  {
    id: "3",
    url: "healthyliving.example.com",
    domainRating: 58,
    monthlyTraffic: 28000,
    country: "CA",
    language: "English",
    price: 120,
    niche: "Health",
    status: "ACTIVE",
  },
]

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
          <Input id="language" placeholder="English" {...register("language")} />
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
          {loading ? "Saving..." : defaultValues ? "Update Website" : "Add Website"}
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
  const [search, setSearch] = useState("")
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [editingWebsite, setEditingWebsite] = useState<Website | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const queryClient = useQueryClient()

  const { data: websites = [], isLoading } = useQuery({
    queryKey: ["publisher-websites"],
    queryFn: async () => {
      const sites = await api.publishers.getWebsites("current") as any[]
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
      })) as (Website & { marketplaceStatus: string })[]
    },
  })

  const addMutation = useMutation({
    mutationFn: async (data: WebsiteFormData) => {
      return api.publishers.addWebsite("current", {
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
      return api.publishers.updateWebsite("current", id, {
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
      return api.publishers.submitForReview("current", id)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["publisher-websites"] })
      toast.success("Website submitted for review")
    },
    onError: () => {
      toast.error("Failed to submit website")
    },
  })

  const archiveMutation = useMutation({
    mutationFn: async (id: string) => {
      return api.publishers.deleteWebsite("current", id)
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
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredWebsites.map((site) => (
                <TableRow key={site.id}>
                  <TableCell>
                    <div className="flex flex-col">
                      <a
                        href={`https://${site.url}`}
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
                  <TableCell>
                    {site.price ? `$${site.price}` : "—"}
                  </TableCell>
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
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      {site.marketplaceStatus === "DRAFT" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Submit for Review"
                          onClick={() => submitMutation.mutate(site.id)}
                        >
                          <CheckCircle className="h-4 w-4" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setEditingWebsite(site)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => archiveMutation.mutate(site.id)}
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
          editingWebsite && updateMutation.mutate({ id: editingWebsite.id, data })
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
    </div>
  )
}