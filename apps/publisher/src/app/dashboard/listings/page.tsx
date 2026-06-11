"use client"

import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"
import {
  Button,
  Card,
  CardContent,
  Badge,
  Skeleton,
  Input,
  Label,
  Textarea,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@guestpost/ui"
import { Plus, Store, AlertCircle, RefreshCw } from "lucide-react"
import { toast } from "sonner"

const LISTING_TYPES = [
  "GUEST_POST",
  "NICHE_EDIT",
  "EDITORIAL_LINK",
  "OUTREACH_LINK",
  "LOCAL_CITATION",
  "FOUNDATION_LINK",
  "BLOG_ARTICLE",
  "SEO_CONTENT",
] as const

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  APPROVED: "default",
  PENDING_REVIEW: "secondary",
  DRAFT: "outline",
  REJECTED: "destructive",
  PAUSED: "secondary",
  ARCHIVED: "outline",
}

export default function PublisherListingsPage() {
  const { user } = useAuth()
  const publisherId = (user as any)?.publisherId as string | undefined
  const queryClient = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({
    title: "",
    description: "",
    type: "GUEST_POST",
    price: "",
    websiteId: "",
  })

  const listingsQ = useQuery({
    queryKey: ["publisher-listings", publisherId],
    queryFn: () => api.marketplace.getPublisherListings(publisherId!),
    enabled: !!publisherId,
  })

  const websitesQ = useQuery({
    queryKey: ["publisher-websites", publisherId],
    queryFn: async () => (await api.publishers.getWebsites(publisherId!)) as any[],
    enabled: !!publisherId && showCreate,
  })

  const createMutation = useMutation({
    mutationFn: () =>
      api.marketplace.createListing({
        title: form.title.trim(),
        description: form.description.trim(),
        type: form.type,
        price: Number(form.price),
        websiteId: form.websiteId || undefined,
        // Goes straight to the moderation queue — publishers cannot
        // self-approve inventory
        status: "PENDING_REVIEW",
      }),
    onSuccess: () => {
      toast.success("Listing submitted for review")
      queryClient.invalidateQueries({ queryKey: ["publisher-listings"] })
      setShowCreate(false)
      setForm({ title: "", description: "", type: "GUEST_POST", price: "", websiteId: "" })
    },
    onError: (err: Error) => toast.error(err.message || "Failed to create listing"),
  })

  const listings = (listingsQ.data ?? []) as any[]
  const canSubmit =
    form.title.trim().length >= 3 &&
    form.description.trim().length >= 1 &&
    Number(form.price) > 0

  if (listingsQ.error) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <AlertCircle className="h-12 w-12 text-destructive mb-4" />
        <h2 className="text-xl font-semibold mb-2">Failed to load listings</h2>
        <p className="text-muted-foreground mb-4">{(listingsQ.error as Error).message}</p>
        <Button onClick={() => listingsQ.refetch()}><RefreshCw className="mr-2 h-4 w-4" />Retry</Button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Marketplace Listings</h1>
          <p className="text-muted-foreground">
            Your inventory on the marketplace. New listings are reviewed by staff before going live.
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
              {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : listings.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Store className="h-12 w-12 text-muted-foreground/50" />
              <h3 className="mt-4 text-lg font-medium">No listings yet</h3>
              <p className="text-sm text-muted-foreground">Create your first listing to start receiving orders</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {listings.map((l: any) => (
                  <TableRow key={l.id}>
                    <TableCell className="font-medium max-w-[320px] truncate">{l.title}</TableCell>
                    <TableCell className="text-muted-foreground">{String(l.type ?? "").replace(/_/g, " ")}</TableCell>
                    <TableCell className="font-mono text-sm">${Number(l.price ?? 0).toFixed(2)}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANTS[l.status] ?? "secondary"}>
                        {String(l.status ?? "").replace(/_/g, " ")}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
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
              Submitted listings are reviewed by our team before they appear in the marketplace.
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
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="What the buyer gets, niche, link policy..."
                rows={3}
                maxLength={1000}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Type</Label>
                <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {LISTING_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>{t.replace(/_/g, " ")}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="l-price">Price (USD)</Label>
                <Input
                  id="l-price"
                  type="number"
                  min={1}
                  step="0.01"
                  value={form.price}
                  onChange={(e) => setForm({ ...form, price: e.target.value })}
                  placeholder="250"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Website</Label>
              <Select value={form.websiteId} onValueChange={(v) => setForm({ ...form, websiteId: v })}>
                <SelectTrigger>
                  <SelectValue placeholder={websitesQ.isLoading ? "Loading..." : "Select website"} />
                </SelectTrigger>
                <SelectContent>
                  {(websitesQ.data ?? []).map((w: any) => (
                    <SelectItem key={w.id} value={w.id}>{w.url}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Orders for this listing will be fulfilled on the selected website.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={() => createMutation.mutate()} disabled={!canSubmit || createMutation.isPending}>
              {createMutation.isPending ? "Submitting..." : "Submit for Review"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
