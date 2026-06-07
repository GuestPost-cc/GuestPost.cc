"use client"

import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@guestpost/ui"
import { Button } from "@guestpost/ui"
import { Input } from "@guestpost/ui"
import { Label } from "@guestpost/ui"
import { Badge } from "@guestpost/ui"
import { Skeleton } from "@guestpost/ui"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@guestpost/ui"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@guestpost/ui"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@guestpost/ui"
import {
  Plus,
  MoreHorizontal,
  Eye,
  Edit,
  Trash2,
  Megaphone,
  FolderOpen,
  ArrowRight,
  Search,
} from "lucide-react"
import { format } from "date-fns"
import Link from "next/link"
import { toast } from "sonner"
import { useForm } from "react-hook-form"
import { z } from "zod"
import { zodResolver } from "@hookform/resolvers/zod"

const createCampaignSchema = z.object({
  name: z.string().min(1, "Campaign name is required").max(100),
})

type CreateCampaignForm = z.infer<typeof createCampaignSchema>

interface Campaign {
  id: string
  name: string
  status: string
  createdAt: string
  updatedAt: string
}

const statusColors: Record<string, string> = {
  ACTIVE: "bg-green-100 text-green-700",
  PAUSED: "bg-amber-100 text-amber-700",
  COMPLETED: "bg-blue-100 text-blue-700",
  ARCHIVED: "bg-gray-100 text-gray-500",
}

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
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const [showCreateCampaign, setShowCreateCampaign] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")

  const { data: campaignsData, isLoading } = useQuery<Campaign[]>({
    queryKey: ["campaigns"],
    queryFn: () => api.campaigns.listCampaigns() as Promise<Campaign[]>,
  })

  const { data: ordersData } = useQuery({
    queryKey: ["orders"],
    queryFn: () => api.orders.list() as Promise<any[]>,
  })

  const { register, handleSubmit, formState: { errors, isSubmitting }, reset } = useForm<CreateCampaignForm>({
    resolver: zodResolver(createCampaignSchema),
  })

  const createMutation = useMutation({
    mutationFn: (data: { name: string }) => api.campaigns.createCampaign({ ...data, organizationId: user?.organizationId || "" }),
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

  const onSubmit = (data: CreateCampaignForm) => {
    createMutation.mutate({ name: data.name })
  }

  const campaigns = campaignsData ?? []
  const filteredCampaigns = campaigns.filter((campaign: Campaign) =>
    campaign.name.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const getOrderCount = (campaignId: string) => {
    return ordersData?.filter((order: any) => order.campaignId === campaignId).length ?? 0
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Campaigns</h1>
            <p className="text-muted-foreground">Manage your marketing campaigns</p>
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
          <p className="text-muted-foreground">Manage your marketing campaigns</p>
        </div>
        <Button onClick={() => setShowCreateCampaign(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New Campaign
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>All Campaigns</CardTitle>
              <CardDescription>
                {filteredCampaigns.length} campaign{filteredCampaigns.length !== 1 ? "s" : ""}
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
                <Button className="mt-4" onClick={() => setShowCreateCampaign(true)}>
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
                  className="flex items-center justify-between rounded-lg border p-4 hover:bg-muted/50 transition-colors"
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
                          {getOrderCount(campaign.id)} order{getOrderCount(campaign.id) !== 1 ? "s" : ""}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          Created {format(new Date(campaign.createdAt), "PP")}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge className={`${statusColors[campaign.status] || "bg-gray-100 text-gray-700"} capitalize`}>
                      {campaign.status.toLowerCase()}
                    </Badge>
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
                          <Link href={`/dashboard/orders/new?campaign=${campaign.id}`}>
                            <Plus className="mr-2 h-4 w-4" />
                            Add Order
                          </Link>
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-destructive">
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
                <p className="mt-1 text-sm text-destructive">{errors.name.message}</p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowCreateCampaign(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Creating..." : "Create Campaign"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}