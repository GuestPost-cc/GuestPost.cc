"use client"

import { useState, useEffect } from "react"
import { useParams, useRouter } from "next/navigation"
import Link from "next/link"
import { api } from "../../../../lib/api"
import { Button } from "@guestpost/ui"
import { Skeleton } from "@guestpost/ui"
import { Badge } from "@guestpost/ui"
import { Separator } from "@guestpost/ui"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@guestpost/ui"
import { Avatar, AvatarFallback } from "@guestpost/ui"
import {
  Star,
  Check,
  Heart,
  Share2,
  Bookmark,
  ExternalLink,
  ArrowLeft,
  Clock,
  Globe,
  Languages,
  ShieldCheck,
  TrendingUp,
  AlertCircle,
} from "lucide-react"
import { useAuth } from "../../../../lib/auth"

interface Listing {
  id: string
  title: string
  slug: string
  description: string
  shortDescription?: string
  type: string
  status: string
  price: number
  currency: string
  priceType: string
  minPrice?: number
  maxPrice?: number
  domainRating?: number
  domainAuthority?: number
  traffic?: number
  referringDomains?: number
  spamScore?: number
  country?: string
  language?: string
  turnaroundDays?: number
  revisionRounds: number
  featured: boolean
  verified: boolean
  allowGuestPost: boolean
  allowNicheEdit: boolean
  doFollowOnly: boolean
  websiteUrl?: string
  sampleUrl?: string
  category?: { id: string; name: string; slug: string }
  tags: Array<{ id: string; name: string; slug: string }>
  images: Array<{ url: string; isPrimary: boolean }>
  pricingTiers: Array<{ name: string; price: number; description?: string }>
  reviews: Array<{ id: string; rating: number; title?: string; content: string; user: { name?: string; image?: string }; createdAt: string }>
  publisher?: { id: string; name: string; profile?: { rating?: number; totalReviews?: number; responseTime?: number } }
  avgRating?: number
  reviewCount: number
  isFavorited?: boolean
  relatedListings: any[]
}

export default function ListingDetailPage() {
  const params = useParams()
  const router = useRouter()
  const { user } = useAuth()
  const [listing, setListing] = useState<Listing | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeImage, setActiveImage] = useState(0)
  const [favoriting, setFavoriting] = useState(false)

  useEffect(() => {
    loadListing()
  }, [params.slug])

  async function loadListing() {
    setLoading(true)
    setError(null)
    try {
      const listing = await api.marketplace.getListing(params.slug as string, user?.id)
      setListing(listing as Listing)
    } catch (err: any) {
      setError(err.message || "Failed to load listing")
    } finally {
      setLoading(false)
    }
  }

  async function toggleFavorite() {
    if (!user || !listing) return
    setFavoriting(true)
    try {
      if (listing.isFavorited) {
        await api.marketplace.removeFavorite(user.id, listing.id)
      } else {
        await api.marketplace.addFavorite(user.id, listing.id)
      }
      setListing((l: any) => ({ ...l, isFavorited: !l.isFavorited }))
    } catch (err) {
      console.error("Failed to toggle favorite:", err)
    } finally {
      setFavoriting(false)
    }
  }

  function formatPrice(price: number, currency: string = "USD") {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(price)
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => router.back()}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <Skeleton className="h-10 w-64" />
        </div>
        <div className="grid lg:grid-cols-2 gap-8">
          <Skeleton className="h-96" />
          <div className="space-y-4">
            <Skeleton className="h-8 w-3/4" />
            <Skeleton className="h-6 w-1/4" />
            <Skeleton className="h-32 w-full" />
          </div>
        </div>
      </div>
    )
  }

  if (error || !listing) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <AlertCircle className="h-12 w-12 text-destructive mb-4" />
        <h2 className="text-xl font-semibold mb-2">Listing Not Found</h2>
        <p className="text-muted-foreground mb-4">{error || "This listing doesn't exist or has been removed."}</p>
        <Button asChild>
          <Link href="/dashboard/marketplace">Back to Marketplace</Link>
        </Button>
      </div>
    )
  }

  const images = listing.images.length > 0 ? listing.images : [{ url: "", isPrimary: true }]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Marketplace
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={toggleFavorite} disabled={favoriting}>
            <Heart className={`h-4 w-4 mr-2 ${listing.isFavorited ? "fill-red-500 text-red-500" : ""}`} />
            {listing.isFavorited ? "Saved" : "Save"}
          </Button>
          <Button variant="outline" size="sm">
            <Share2 className="h-4 w-4 mr-2" />
            Share
          </Button>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-8">
        <div className="space-y-4">
          <div className="relative aspect-[4/3] bg-muted rounded-lg overflow-hidden">
            {images[activeImage]?.url ? (
              <img
                src={images[activeImage].url}
                alt={listing.title}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <span className="text-6xl font-bold text-primary/20">{listing.title[0]}</span>
              </div>
            )}
            {listing.featured && (
              <span className="absolute top-4 left-4 px-3 py-1 text-sm font-medium bg-primary text-primary-foreground rounded-full">
                Featured
              </span>
            )}
          </div>
          {images.length > 1 && (
            <div className="flex gap-2 overflow-x-auto">
              {images.map((img, i) => (
                <button
                  key={i}
                  onClick={() => setActiveImage(i)}
                  className={`relative w-20 h-20 rounded-lg overflow-hidden border-2 ${
                    i === activeImage ? "border-primary" : "border-transparent"
                  }`}
                >
                  <img src={img.url} alt="" className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-6">
          <div>
            <div className="flex items-center gap-2 mb-2">
              {listing.category && (
                <Badge variant="secondary">{listing.category.name}</Badge>
              )}
              <Badge variant="outline">{listing.type.replace("_", " ")}</Badge>
              {listing.verified && (
                <span className="flex items-center gap-1 text-xs text-green-600">
                  <ShieldCheck className="h-4 w-4" /> Verified
                </span>
              )}
            </div>
            <h1 className="text-3xl font-bold mb-2">{listing.title}</h1>
            {listing.avgRating && (
              <div className="flex items-center gap-2">
                <div className="flex">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Star
                      key={i}
                      className={`h-5 w-5 ${
                        i < Math.round(listing.avgRating!)
                          ? "fill-yellow-400 text-yellow-400"
                          : "text-gray-300"
                      }`}
                    />
                  ))}
                </div>
                <span className="font-medium">{listing.avgRating.toFixed(1)}</span>
                <span className="text-muted-foreground">({listing.reviewCount} reviews)</span>
              </div>
            )}
          </div>

          <div className="p-6 border rounded-lg space-y-4">
            <div className="flex items-baseline justify-between">
              <span className="text-3xl font-bold">{formatPrice(listing.price, listing.currency)}</span>
              {listing.priceType !== "fixed" && (
                <span className="text-muted-foreground text-sm">
                  {listing.priceType === "starting_at" ? "Starting at" : listing.priceType}
                </span>
              )}
            </div>
            <div className="grid grid-cols-3 gap-4">
              {listing.domainRating && (
                <div className="text-center p-3 bg-muted rounded-lg">
                  <div className="text-2xl font-bold">{listing.domainRating}</div>
                  <div className="text-xs text-muted-foreground">Domain Rating</div>
                </div>
              )}
              {listing.traffic && (
                <div className="text-center p-3 bg-muted rounded-lg">
                  <div className="text-2xl font-bold">{listing.traffic.toLocaleString()}</div>
                  <div className="text-xs text-muted-foreground">Monthly Traffic</div>
                </div>
              )}
              {listing.referringDomains && (
                <div className="text-center p-3 bg-muted rounded-lg">
                  <div className="text-2xl font-bold">{listing.referringDomains.toLocaleString()}</div>
                  <div className="text-xs text-muted-foreground">Referring Domains</div>
                </div>
              )}
            </div>
            <Button className="w-full" size="lg">
              Order Now
            </Button>
            <Button variant="outline" className="w-full">
              Contact Publisher
            </Button>
          </div>

          <div className="space-y-3">
            {listing.turnaroundDays && (
              <div className="flex items-center gap-3 text-sm">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <span>{listing.turnaroundDays} days turnaround</span>
              </div>
            )}
            {listing.country && (
              <div className="flex items-center gap-3 text-sm">
                <Globe className="h-4 w-4 text-muted-foreground" />
                <span>{listing.country}</span>
              </div>
            )}
            {listing.language && (
              <div className="flex items-center gap-3 text-sm">
                <Languages className="h-4 w-4 text-muted-foreground" />
                <span>{listing.language}</span>
              </div>
            )}
            <div className="flex items-center gap-3 text-sm">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              <span>{listing.revisionRounds} revision rounds included</span>
            </div>
            {listing.websiteUrl && (
              <a
                href={listing.websiteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 text-sm text-primary hover:underline"
              >
                <ExternalLink className="h-4 w-4" />
                <span>Visit Website</span>
              </a>
            )}
          </div>

          {listing.publisher && (
            <div className="p-4 border rounded-lg">
              <div className="flex items-center gap-3">
                <Avatar>
                  <AvatarFallback>{listing.publisher.name[0]}</AvatarFallback>
                </Avatar>
                <div className="flex-1">
                  <div className="font-medium">{listing.publisher.name}</div>
                  {listing.publisher.profile && (
                    <div className="text-sm text-muted-foreground">
                      {listing.publisher.profile.rating && (
                        <span className="inline-flex items-center gap-1 mr-3">
                          <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" />
                          {listing.publisher.profile.rating.toFixed(1)}
                        </span>
                      )}
                      {listing.publisher.profile.totalReviews && (
                        <span>{listing.publisher.profile.totalReviews} reviews</span>
                      )}
                      {listing.publisher.profile.responseTime && (
                        <span className="ml-3">~{listing.publisher.profile.responseTime}h response</span>
                      )}
                    </div>
                  )}
                </div>
                <Button variant="outline" size="sm">View Profile</Button>
              </div>
            </div>
          )}
        </div>
      </div>

      <Tabs defaultValue="description" className="mt-8">
        <TabsList>
          <TabsTrigger value="description">Description</TabsTrigger>
          <TabsTrigger value="pricing">Pricing</TabsTrigger>
          <TabsTrigger value="reviews">Reviews ({listing.reviewCount})</TabsTrigger>
        </TabsList>
        <TabsContent value="description" className="mt-4 space-y-4">
          <div className="prose max-w-none">
            <p>{listing.description}</p>
          </div>
          {listing.tags.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-4">
              {listing.tags.map((tag) => (
                <Badge key={tag.id} variant="secondary">
                  {tag.name}
                </Badge>
              ))}
            </div>
          )}
        </TabsContent>
        <TabsContent value="pricing" className="mt-4">
          {listing.pricingTiers.length > 0 ? (
            <div className="grid md:grid-cols-3 gap-4">
              {listing.pricingTiers.map((tier, i) => (
                <div key={i} className="p-6 border rounded-lg">
                  <h3 className="font-semibold mb-2">{tier.name}</h3>
                  <div className="text-2xl font-bold mb-4">{formatPrice(tier.price, listing.currency)}</div>
                  {tier.description && <p className="text-sm text-muted-foreground">{tier.description}</p>}
                </div>
              ))}
            </div>
          ) : (
            <div className="p-6 border rounded-lg text-center">
              <p className="text-lg font-medium">{formatPrice(listing.price, listing.currency)}</p>
              <p className="text-muted-foreground">Fixed price</p>
            </div>
          )}
        </TabsContent>
        <TabsContent value="reviews" className="mt-4">
          {listing.reviews.length > 0 ? (
            <div className="space-y-4">
              {listing.reviews.map((review) => (
                <div key={review.id} className="p-4 border rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="flex">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Star
                          key={i}
                          className={`h-4 w-4 ${
                            i < review.rating ? "fill-yellow-400 text-yellow-400" : "text-gray-300"
                          }`}
                        />
                      ))}
                    </div>
                    {review.title && <span className="font-medium">{review.title}</span>}
                  </div>
                  <p className="text-sm text-muted-foreground">{review.content}</p>
                  <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                    <Avatar className="h-5 w-5">
                      <AvatarFallback className="text-[10px]">
                        {review.user.name?.[0] || "U"}
                      </AvatarFallback>
                    </Avatar>
                    <span>{review.user.name || "Anonymous"}</span>
                    <span>•</span>
                    <span>{new Date(review.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8">
              <p className="text-muted-foreground">No reviews yet</p>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}