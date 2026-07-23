"use client"

import type { Campaign } from "@guestpost/api-client"
import type { CampaignStatus } from "@guestpost/database"
import {
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ErrorState,
  getCampaignStatusPresentation,
  Input,
  Label,
  Skeleton,
  StatusBadge,
} from "@guestpost/ui"
import { zodResolver } from "@hookform/resolvers/zod"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { format } from "date-fns"
import {
  Edit,
  Eye,
  FolderOpen,
  Megaphone,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
} from "lucide-react"
import Link from "next/link"
import { useState } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"
import { api } from "../../../lib/api"

const createCampaignSchema = z.object({
  // Mirrors CreateCampaignDto (MinLength 3 / MaxLength 200) so users get an
  // inline message instead of a server 400
  name: z
    .string()
    .min(3, "Campaign name must be at least 3 characters")
    .max(200),
})

type CreateCampaignForm = z.infer<typeof createCampaignSchema>

function CampaignsTableSkeleton() {
  return (
    <div className="space-y-3">
      {[...Array(5)].map((_, i) => (
        <div key={i} className="flex items-center gap-4 rounded-lg border p-4">
          <Skeleton className="h-10 w-10 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-6 w-16 rounded-full" />
          <Skeleton className="h-8 w-8" />
        </div>
      ))}
    </div>
  )
}

export default function CampaignsPage() {
  const queryClient = useQueryClient()
  const [showCreateCampaign, setShowCreateCampaign] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(
    null,
  )
  const [editTarget, setEditTarget] = useState<Campaign | null>(null)
  const [editName, setEditName] = useState("")
  const [searchQuery, setSearchQuery] = useState("")

  const {
    data: campaignsData,
    isLoading,
    error: campaignsError,
    refetch: refetchCampaigns,
  } = useQuery({
    queryKey: ["campaigns"],
    queryFn: () => api.campaigns.listAllCampaigns(),
  })

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
  } = useForm<CreateCampaignForm>({
    resolver: zodResolver(createCampaignSchema),
  })

  const createMutation = useMutation({
    mutationFn: (data: { name: string }) => api.campaigns.createCampaign(data),
    onSuccess: () => {
      toast.success("Campaign created successfully")
      queryClient.invalidateQueries({ queryKey: ["campaigns"] })
      setShowCreateCampaign(false)
      reset()
    },
    onError: () => {
      toast.error("Failed to create campaign")
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.campaigns.deleteCampaign(id),
    onSuccess: () => {
      toast.success("Campaign deleted successfully")
      queryClient.invalidateQueries({ queryKey: ["campaigns"] })
      setShowDeleteConfirm(null)
    },
    onError: () => {
      toast.error("Failed to delete campaign")
    },
  })

  const onSubmit = async (data: CreateCampaignForm) => {
    await createMutation.mutateAsync({ name: data.name })
  }

  const updateMutation = useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string
      data: {
        name?: string
        status?: "ACTIVE" | "PAUSED" | "COMPLETED" | "ARCHIVED"
      }
    }) => api.campaigns.updateCampaign(id, data),
    // Optimistic status flip — safe: status is cosmetic for existing orders
    onMutate: async ({ id, data }) => {
      if (!data.status) return
      await queryClient.cancelQueries({ queryKey: ["campaigns"] })
      const prev = queryClient.getQueryData<Campaign[]>(["campaigns"])
      queryClient.setQueryData<Campaign[]>(["campaigns"], (old) =>
        (old ?? []).map((c) =>
          c.id === id ? { ...c, status: data.status! } : c,
        ),
      )
      return { prev }
    },
    onError: (err: Error, _vars, ctx: any) => {
      if (ctx?.prev) queryClient.setQueryData(["campaigns"], ctx.prev)
      toast.error(err.message || "Failed to update campaign")
    },
    onSuccess: () => {
      toast.success("Campaign updated")
      setEditTarget(null)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["campaigns"] }),
  })

  const duplicateMutation = useMutation({
    mutationFn: (c: Campaign) =>
      api.campaigns.createCampaign({ name: `${c.name} (copy)`.slice(0, 200) }),
    onSuccess: () => {
      toast.success("Campaign duplicated")
      queryClient.invalidateQueries({ queryKey: ["campaigns"] })
    },
    onError: (err: Error) =>
      toast.error(err.message || "Failed to duplicate campaign"),
  })

  const campaigns = campaignsData ?? []
  const filteredCampaigns = campaigns.filter((campaign: Campaign) =>
    campaign.name.toLowerCase().includes(searchQuery.toLowerCase()),
  )

  if (campaignsError) {
    return (
      <ErrorState
        title="Failed to load campaigns"
        description={(campaignsError as Error).message}
        onRetry={() => refetchCampaigns()}
      />
    )
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Campaigns</h1>
            <p className="text-muted-foreground">
              Manage your marketing campaigns
            </p>
          </div>
        </div>
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-32" />
          </CardHeader>
          <CardContent>
            <CampaignsTableSkeleton />
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Campaigns</h1>
          <p className="text-muted-foreground">
            Manage your marketing campaigns
          </p>
        </div>
        <Button onClick={() => setShowCreateCampaign(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New Campaign
        </Button>
      </div>

      <Card className="rounded-2xl shadow-sm">
        <CardHeader className="pb-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>All Campaigns</CardTitle>
              <CardDescription>
                {filteredCampaigns.length} campaign
                {filteredCampaigns.length !== 1 ? "s" : ""}
              </CardDescription>
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search campaigns..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 w-64"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {filteredCampaigns.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <FolderOpen className="h-12 w-12 text-muted-foreground/50" />
              <h3 className="mt-4 text-lg font-medium">No campaigns found</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {searchQuery
                  ? "Try adjusting your search"
                  : "Create your first campaign to get started"}
              </p>
              {!searchQuery && (
                <Button
                  className="mt-4"
                  onClick={() => setShowCreateCampaign(true)}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  New Campaign
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {filteredCampaigns.map((campaign) => (
                <div
                  key={campaign.id}
                  className="flex flex-col justify-between gap-4 rounded-2xl border p-4 transition-colors hover:bg-muted/50 sm:flex-row sm:items-center"
                >
                  <div className="flex items-center gap-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
                      <Megaphone className="h-6 w-6 text-primary" />
                    </div>
                    <div>
                      <Link
                        href={`/dashboard/campaigns/${campaign.id}`}
                        className="font-medium hover:text-primary transition-colors"
                      >
                        {campaign.name}
                      </Link>
                      <div className="flex items-center gap-3 mt-1">
                        <span className="text-sm text-muted-foreground">
                          {campaign.orderCount ?? 0} order
                          {(campaign.orderCount ?? 0) !== 1 ? "s" : ""}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          Created {format(new Date(campaign.createdAt), "PP")}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {(() => {
                      const p = getCampaignStatusPresentation(
                        campaign.status as CampaignStatus,
                      )
                      return (
                        <StatusBadge variant={p.variant}>{p.label}</StatusBadge>
                      )
                    })()}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild>
                          <Link href={`/dashboard/campaigns/${campaign.id}`}>
                            <Eye className="mr-2 h-4 w-4" />
                            View Details
                          </Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem asChild>
                          <Link
                            href={`/dashboard/marketplace?campaignId=${encodeURIComponent(campaign.id)}`}
                          >
                            <Plus className="mr-2 h-4 w-4" />
                            Add Order
                          </Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => {
                            setEditTarget(campaign)
                            setEditName(campaign.name)
                          }}
                        >
                          <Edit className="mr-2 h-4 w-4" />
                          Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => duplicateMutation.mutate(campaign)}
                        >
                          <Plus className="mr-2 h-4 w-4" />
                          Duplicate
                        </DropdownMenuItem>
                        {campaign.status === "ACTIVE" ? (
                          <DropdownMenuItem
                            onClick={() =>
                              updateMutation.mutate({
                                id: campaign.id,
                                data: { status: "PAUSED" },
                              })
                            }
                          >
                            Pause
                          </DropdownMenuItem>
                        ) : campaign.status === "PAUSED" ? (
                          <DropdownMenuItem
                            onClick={() =>
                              updateMutation.mutate({
                                id: campaign.id,
                                data: { status: "ACTIVE" },
                              })
                            }
                          >
                            Activate
                          </DropdownMenuItem>
                        ) : null}
                        {campaign.status !== "ARCHIVED" && (
                          <DropdownMenuItem
                            onClick={() =>
                              updateMutation.mutate({
                                id: campaign.id,
                                data: { status: "ARCHIVED" },
                              })
                            }
                          >
                            Archive
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive"
                          onClick={() => setShowDeleteConfirm(campaign.id)}
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={showCreateCampaign} onOpenChange={setShowCreateCampaign}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Campaign</DialogTitle>
            <DialogDescription>
              Create a new campaign to organize your orders
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="py-4">
              <Label htmlFor="name">Campaign Name *</Label>
              <Input
                id="name"
                {...register("name")}
                placeholder="e.g., Q1 SEO Campaign"
                className="mt-1.5"
              />
              {errors.name && (
                <p className="mt-1 text-sm text-destructive">
                  {errors.name.message}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowCreateCampaign(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? "Creating..." : "Create Campaign"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!showDeleteConfirm}
        onOpenChange={(open) => !open && setShowDeleteConfirm(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Campaign</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this campaign? Orders linked to
              this campaign will remain but will no longer be grouped. This
              action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setShowDeleteConfirm(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() =>
                showDeleteConfirm && deleteMutation.mutate(showDeleteConfirm)
              }
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete Campaign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!editTarget}
        onOpenChange={(open) => !open && setEditTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename Campaign</DialogTitle>
            <DialogDescription>
              Orders attached to this campaign are unaffected.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            maxLength={120}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                editTarget &&
                updateMutation.mutate({
                  id: editTarget.id,
                  data: { name: editName.trim() },
                })
              }
              disabled={updateMutation.isPending || editName.trim().length < 2}
            >
              {updateMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
