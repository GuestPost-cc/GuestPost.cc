"use client"

import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  EmptyState,
  ErrorState,
  Input,
  Skeleton,
} from "@guestpost/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Bookmark, ExternalLink, Plus, Trash2 } from "lucide-react"
import Link from "next/link"
import { useEffect, useState } from "react"
import { api } from "../../../../lib/api"
import { useAuth } from "../../../../lib/auth"

interface SavedListItem {
  id: string
  listing: {
    id: string
    title: string
    slug: string
    // Phase 7: legacy listing-level columns; prefer priceFrom + serviceTypes.
    type?: string
    price?: number
    priceFrom?: number | null
    serviceTypes?: string[]
    currency: string
    domainRating?: number
    image?: string
    category?: { name: string }
    avgRating?: number
    reviewCount: number
  }
  note?: string
  addedAt: string
}

interface SavedList {
  id: string
  name: string
  slug: string
  isPublic: boolean
  items: SavedListItem[]
}

export default function SavedListsPage() {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [newListName, setNewListName] = useState("")
  const [selectedListId, setSelectedListId] = useState<string | null>(null)

  const {
    data: lists = [],
    isLoading,
    error,
    refetch,
  } = useQuery<SavedList[]>({
    queryKey: ["saved-lists", user?.id],
    queryFn: () => api.marketplace.getSavedLists(),
    enabled: !!user?.id,
  })

  useEffect(() => {
    if (lists.length > 0 && !selectedListId) {
      setSelectedListId(lists[0].id)
    }
  }, [lists, selectedListId])

  const selectedList = lists.find((l) => l.id === selectedListId) || null

  const { mutate: createList, isPending: creating } = useMutation({
    mutationFn: () =>
      api.marketplace.createSavedList({ name: newListName.trim() }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["saved-lists", user?.id] })
      setNewListName("")
      setCreateOpen(false)
    },
  })

  const { mutate: removeFromList } = useMutation({
    mutationFn: ({
      listId,
      listingId,
    }: {
      listId: string
      listingId: string
    }) => api.marketplace.removeFromSavedList(listId, listingId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["saved-lists", user?.id] }),
  })

  function formatPrice(price: number, currency: string = "USD") {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(price)
  }

  if (error)
    return (
      <ErrorState
        title="Failed to load saved lists"
        description={(error as Error).message}
        onRetry={() => refetch()}
      />
    )

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold tracking-tight">Saved Lists</h1>
        </div>
        <div className="grid lg:grid-cols-3 gap-6">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      </div>
    )
  }

  if (lists.length === 0) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Saved Lists</h1>
            <p className="text-muted-foreground">
              Organize your favorite listings into collections
            </p>
          </div>
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                New List
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create New List</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <Input
                  placeholder="List name"
                  value={newListName}
                  onChange={(e) => setNewListName(e.target.value)}
                  onKeyDown={(e) =>
                    e.key === "Enter" &&
                    !creating &&
                    newListName.trim() &&
                    createList()
                  }
                />
                <Button
                  onClick={() => createList()}
                  disabled={creating || !newListName.trim()}
                  className="w-full"
                >
                  {creating ? "Creating..." : "Create List"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
        <EmptyState
          icon={Bookmark}
          title="No saved lists yet"
          description="Create lists to organize your favorite marketplace listings"
          action={{
            label: "Create Your First List",
            onClick: () => setCreateOpen(true),
          }}
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Saved Lists</h1>
          <p className="text-muted-foreground">
            {lists.length} list{lists.length !== 1 ? "s" : ""}
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              New List
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create New List</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <Input
                placeholder="List name"
                value={newListName}
                onChange={(e) => setNewListName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && createList()}
              />
              <Button
                onClick={() => createList()}
                disabled={creating || !newListName.trim()}
                className="w-full"
              >
                {creating ? "Creating..." : "Create List"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="space-y-2">
          {lists.map((list) => (
            <div
              key={list.id}
              className={`p-4 border rounded-lg cursor-pointer transition-all ${
                selectedList?.id === list.id
                  ? "border-primary bg-primary/5"
                  : "hover:border-primary/50"
              }`}
              onClick={() => setSelectedListId(list.id)}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Bookmark className="h-4 w-4" />
                  <span className="font-medium">{list.name}</span>
                </div>
                <span className="text-sm text-muted-foreground">
                  {list.items.length}
                </span>
              </div>
              {list.isPublic && (
                <span className="text-xs text-muted-foreground mt-1 block">
                  Public
                </span>
              )}
            </div>
          ))}
        </div>

        <div className="lg:col-span-2">
          {selectedList ? (
            selectedList.items.length === 0 ? (
              <div className="border rounded-lg p-8 text-center">
                <p className="text-muted-foreground">This list is empty</p>
                <Button variant="outline" className="mt-4" asChild>
                  <Link href="/dashboard/marketplace">Browse Marketplace</Link>
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                {selectedList.items.map((item) => (
                  <div
                    key={item.id}
                    className="border rounded-lg p-4 flex gap-4 hover:shadow-md transition-shadow"
                  >
                    <Link
                      href={`/dashboard/marketplace/${item.listing.slug}`}
                      className="flex-shrink-0"
                    >
                      <div className="w-32 h-24 bg-muted rounded-lg overflow-hidden">
                        {item.listing.image ? (
                          <img
                            src={item.listing.image}
                            alt={item.listing.title}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center bg-primary/5">
                            <span className="text-2xl font-bold text-primary/20">
                              {item.listing.title[0]}
                            </span>
                          </div>
                        )}
                      </div>
                    </Link>
                    <div className="flex-1 min-w-0">
                      <Link
                        href={`/dashboard/marketplace/${item.listing.slug}`}
                      >
                        <h3 className="font-semibold hover:text-primary transition-colors">
                          {item.listing.title}
                        </h3>
                      </Link>
                      <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
                        {item.listing.category && (
                          <span>{item.listing.category.name}</span>
                        )}
                        {item.listing.domainRating && (
                          <>
                            <span>•</span>
                            <span>DR {item.listing.domainRating}</span>
                          </>
                        )}
                      </div>
                      {item.note && (
                        <p className="text-sm text-muted-foreground mt-2 line-clamp-2">
                          {item.note}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-col items-end justify-between">
                      {/* Phase 7: priceFrom + legacy fallback. */}
                      <span className="font-bold">
                        {formatPrice(
                          (item.listing as any).priceFrom ??
                            item.listing.price ??
                            0,
                          item.listing.currency,
                        )}
                      </span>
                      <div className="flex gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            removeFromList({
                              listId: selectedList.id,
                              listingId: item.listing.id,
                            })
                          }
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                        <Button size="sm" asChild>
                          <Link
                            href={`/dashboard/marketplace/${item.listing.slug}`}
                          >
                            View <ExternalLink className="h-3 w-3 ml-1" />
                          </Link>
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : (
            <div className="border rounded-lg p-8 text-center">
              <p className="text-muted-foreground">
                Select a list to view items
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
