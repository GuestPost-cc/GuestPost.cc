"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../../../lib/api"
import { useAuth } from "../../../../lib/auth"
import { Button } from "@guestpost/ui"
import { Skeleton, ErrorState } from "@guestpost/ui"
import { EmptyState } from "@guestpost/ui"
import { Heart, Star, ExternalLink } from "lucide-react"

interface FavoriteListing {
  id: string
  listing: {
    id: string
    title: string
    slug: string
    type: string
    price: number
    currency: string
    domainRating?: number
    traffic?: number
    image?: string
    category?: { name: string }
    avgRating?: number
    reviewCount: number
  }
  addedAt: string
}

export default function FavoritesPage() {
  const { user } = useAuth()
  const router = useRouter()
  const queryClient = useQueryClient()

  const { data: favorites = [], isLoading, error, refetch } = useQuery<FavoriteListing[]>({
    queryKey: ["favorites"],
    queryFn: () => api.marketplace.getFavorites(),
    enabled: !!user?.id,
  })

  const { mutate: removeFavorite } = useMutation({
    mutationFn: (listingId: string) => api.marketplace.removeFavorite(listingId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["favorites"] }),
  })

  function formatPrice(price: number, currency: string = "USD") {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(price)
  }

  if (error) return <ErrorState title="Failed to load favorites" description={(error as Error).message} onRetry={() => refetch()} />

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">My Favorites</h1>
          <p className="text-muted-foreground">Listings you've saved</p>
        </div>
        <div className="grid gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="border rounded-lg p-4 flex gap-4">
              <Skeleton className="h-24 w-32" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-6 w-64" />
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-48" />
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (favorites.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">My Favorites</h1>
          <p className="text-muted-foreground">Listings you've saved</p>
        </div>
        <EmptyState
          icon={Heart}
          title="No favorites yet"
          description="Start exploring the marketplace and save listings you like"
          action={{
            label: "Explore Marketplace",
            onClick: () => router.push("/dashboard/marketplace"),
          }}
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">My Favorites</h1>
        <p className="text-muted-foreground">{favorites.length} saved listing{favorites.length !== 1 ? "s" : ""}</p>
      </div>

      <div className="space-y-4">
        {favorites.map((fav) => (
          <div key={fav.id} className="border rounded-lg p-4 flex gap-4 hover:shadow-md transition-shadow">
            <Link href={`/dashboard/marketplace/${fav.listing.slug}`} className="flex-shrink-0">
              <div className="w-32 h-24 bg-muted rounded-lg overflow-hidden">
                {fav.listing.image ? (
                  <img src={fav.listing.image} alt={fav.listing.title} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center bg-primary/5">
                    <span className="text-2xl font-bold text-primary/20">{fav.listing.title[0]}</span>
                  </div>
                )}
              </div>
            </Link>
            <div className="flex-1 min-w-0">
              <Link href={`/dashboard/marketplace/${fav.listing.slug}`}>
                <h3 className="font-semibold hover:text-primary transition-colors">{fav.listing.title}</h3>
              </Link>
              <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
                {fav.listing.category && <span>{fav.listing.category.name}</span>}
                <span>•</span>
                <span>{fav.listing.type.replace("_", " ")}</span>
                {fav.listing.domainRating && (
                  <>
                    <span>•</span>
                    <span>DR {fav.listing.domainRating}</span>
                  </>
                )}
              </div>
              <div className="flex items-center gap-4 mt-2">
                {fav.listing.avgRating && (
                  <div className="flex items-center gap-1 text-sm">
                    <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
                    <span>{fav.listing.avgRating.toFixed(1)}</span>
                    <span className="text-muted-foreground">({fav.listing.reviewCount})</span>
                  </div>
                )}
                {fav.listing.traffic && (
                  <span className="text-sm text-muted-foreground">
                    {fav.listing.traffic.toLocaleString()} visitors/mo
                  </span>
                )}
              </div>
            </div>
            <div className="flex flex-col items-end justify-between">
              <span className="font-bold text-lg">{formatPrice(fav.listing.price, fav.listing.currency)}</span>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => removeFavorite(fav.listing.id)}>
                  Remove
                </Button>
                <Button size="sm" asChild>
                  <Link href={`/dashboard/marketplace/${fav.listing.slug}`}>
                    View <ExternalLink className="h-3 w-3 ml-1" />
                  </Link>
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}