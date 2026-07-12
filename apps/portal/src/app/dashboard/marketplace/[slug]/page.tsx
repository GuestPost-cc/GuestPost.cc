"use client"

import {
  Avatar,
  AvatarFallback,
  Badge,
  Button,
  Card,
  CardContent,
  ErrorState,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@guestpost/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AlertCircle,
  ArrowLeft,
  Clock,
  ExternalLink,
  Globe,
  Heart,
  Languages,
  Lock,
  ShieldCheck,
  Star,
  TrendingUp,
} from "lucide-react"
import Image from "next/image"
import Link from "next/link"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { useEffect, useMemo, useState } from "react"
import { api } from "../../../../lib/api"
import { useAuth } from "../../../../lib/auth"
import { useCustomerAccess } from "../../../../lib/hooks/use-customer-access"

interface Listing {
  id: string
  title: string
  slug: string
  description: string
  shortDescription?: string
  type?: string
  status: string
  price?: number
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
  revisionRounds?: number
  featured: boolean
  verified: boolean
  fulfillmentType?: "INTERNAL" | "PUBLISHER" | "HYBRID"
  doFollowOnly: boolean
  websiteUrl?: string
  websiteId?: string | null
  sampleUrl?: string
  category?: { id: string; name: string; slug: string }
  tags: Array<{ id: string; name: string; slug: string }>
  images: Array<{ url: string; isPrimary: boolean }>
  reviews: Array<{
    id: string
    rating: number
    title?: string
    content: string
    user: { name?: string; image?: string }
    createdAt: string
  }>
  publisher?: {
    id: string
    name: string
    profile?: { rating?: number; totalReviews?: number; responseTime?: number }
  }
  avgRating?: number
  reviewCount: number
  isFavorited?: boolean
  relatedListings: any[]
  ownerType?: "PUBLISHER" | "PLATFORM"
  attribution?: { kind: "PUBLISHER" | "PLATFORM"; label: string }
  services?: Array<{
    id: string
    serviceType: string
    price: number
    currency: string
    turnaroundDays: number
    revisionRounds: number
    warrantyDays?: number | null
    requirements?: Record<string, unknown> | null
    availability: "AVAILABLE" | "PAUSED" | "WAITLIST"
  }>
}

export default function ListingDetailPage() {
  const params = useParams()
  const router = useRouter()
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const [activeImage, setActiveImage] = useState(0)
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(
    null,
  )

  const {
    data: listing,
    isLoading,
    error,
    refetch,
  } = useQuery<Listing>({
    queryKey: ["listing", params.slug],
    queryFn: () =>
      api.marketplace
        .getListing(params.slug as string)
        .then((r) => r as unknown as Listing),
    enabled: !!params.slug,
  })

  // URL visibility: blurred for customers with no balance, deposits, or orders
  const { canViewUrls: canViewUrl } = useCustomerAccess()

  const searchParams = useSearchParams()
  const services = listing?.services ?? []
  const orderableServices = useMemo(
    () => services.filter((s) => s.availability === "AVAILABLE"),
    [services],
  )
  const selectedService = useMemo(
    () => services.find((s) => s.id === selectedServiceId) ?? null,
    [services, selectedServiceId],
  )

  useEffect(() => {
    if (!listing || services.length === 0) return
    const requested = searchParams?.get("service")
    if (selectedServiceId && services.some((s) => s.id === selectedServiceId)) {
      if (!requested || selectedService?.serviceType === requested) return
    }
    const fromUrl = requested
      ? services.find(
          (s) => s.serviceType === requested && s.availability === "AVAILABLE",
        )
      : null
    const fallback = orderableServices[0] ?? null
    const picked = fromUrl ?? fallback
    if (picked) setSelectedServiceId(picked.id)
  }, [
    listing,
    services,
    orderableServices,
    searchParams,
    selectedServiceId,
    selectedService,
  ])

  const { mutate: toggleFavorite, isPending: favoriting } = useMutation({
    mutationFn: () => {
      if (!listing) throw new Error("No listing loaded")
      return listing.isFavorited
        ? api.marketplace.removeFavorite(listing.id)
        : api.marketplace.addFavorite(listing.id)
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["listing", params.slug] }),
  })

  function formatPrice(price: number, currency: string = "USD") {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(price)
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-40" />
        <div className="grid lg:grid-cols-2 gap-8">
          <Skeleton className="aspect-[4/3] rounded-xl" />
          <div className="space-y-4">
            <Skeleton className="h-8 w-3/4" />
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-28 w-full rounded-xl" />
          </div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <ErrorState
        title="Failed to load listing"
        description={(error as Error).message}
        onRetry={() => refetch()}
      />
    )
  }

  if (!listing) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <AlertCircle className="h-12 w-12 text-destructive mb-4" />
        <h2 className="text-xl font-semibold mb-2">Listing Not Found</h2>
        <p className="text-muted-foreground mb-5">
          This listing doesn't exist or has been removed.
        </p>
        <Button asChild>
          <Link href="/dashboard/marketplace">Back to Marketplace</Link>
        </Button>
      </div>
    )
  }

  const images =
    listing.images.length > 0 ? listing.images : [{ url: "", isPrimary: true }]

  return (
    <div className="space-y-6">
      {/* Top bar */}
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4 mr-1.5" />
          Back
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => toggleFavorite()}
          disabled={favoriting}
          className="gap-1.5"
        >
          <Heart
            className={`h-4 w-4 ${listing.isFavorited ? "fill-red-500 text-red-500" : ""}`}
          />
          {listing.isFavorited ? "Saved" : "Save"}
        </Button>
      </div>

      {/* Main content grid */}
      <div className="grid lg:grid-cols-5 gap-8">
        {/* Left: Image gallery */}
        <div className="lg:col-span-3 space-y-3">
          <div className="relative aspect-[16/10] bg-muted rounded-xl overflow-hidden">
            {images[activeImage]?.url ? (
              <Image
                fill
                unoptimized
                priority
                src={images[activeImage].url}
                alt={listing.title}
                className="object-cover"
                sizes="(max-width: 768px) 100vw, 60vw"
              />
            ) : (
              <div className="flex h-full items-center justify-center bg-gradient-to-br from-primary/5 to-primary/10">
                <span className="text-6xl font-bold text-primary/15">
                  {listing.title[0]}
                </span>
              </div>
            )}
            {listing.featured && (
              <span className="absolute left-4 top-4 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground shadow-sm">
                Featured
              </span>
            )}
          </div>
          {images.length > 1 && (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {images.map((img, i) => (
                <button
                  key={i}
                  onClick={() => setActiveImage(i)}
                  className={`relative h-16 w-16 flex-shrink-0 rounded-lg overflow-hidden border-2 transition-colors ${
                    i === activeImage
                      ? "border-primary"
                      : "border-transparent hover:border-muted-foreground/30"
                  }`}
                >
                  <Image
                    fill
                    unoptimized
                    src={img.url}
                    alt=""
                    className="object-cover"
                    sizes="64px"
                  />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Right: Purchase panel */}
        <div className="lg:col-span-2 space-y-4">
          {/* Title + badges */}
          <div>
            <div className="flex flex-wrap items-center gap-2 mb-3">
              {listing.category && (
                <Badge variant="secondary" className="text-xs">
                  {listing.category.name}
                </Badge>
              )}
              {listing.fulfillmentType && (
                <Badge variant="outline" className="text-xs">
                  {listing.fulfillmentType === "INTERNAL"
                    ? "Platform"
                    : listing.fulfillmentType === "HYBRID"
                      ? "Hybrid"
                      : "Publisher"}
                </Badge>
              )}
              {listing.verified && (
                <span className="flex items-center gap-1 text-xs font-medium text-green-600">
                  <ShieldCheck className="h-3.5 w-3.5" /> Verified
                </span>
              )}
            </div>
            <h1 className="text-2xl font-bold leading-tight">
              {listing.title}
            </h1>

            {/* Rating */}
            {listing.avgRating && (
              <div className="mt-2 flex items-center gap-2">
                <div className="flex">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Star
                      key={i}
                      className={`h-4 w-4 ${
                        i < Math.round(listing.avgRating!)
                          ? "fill-yellow-400 text-yellow-400"
                          : "text-gray-300"
                      }`}
                    />
                  ))}
                </div>
                <span className="text-sm font-medium">
                  {listing.avgRating.toFixed(1)}
                </span>
                <span className="text-sm text-muted-foreground">
                  ({listing.reviewCount} reviews)
                </span>
              </div>
            )}
          </div>

          {/* Pricing card with stats + service picker */}
          <Card>
            <CardContent className="p-5 space-y-4">
              {/* Price */}
              <div className="flex items-baseline justify-between">
                <span className="text-3xl font-bold">
                  {formatPrice(
                    selectedService?.price ??
                      (listing as any).priceFrom ??
                      listing.price ??
                      0,
                    listing.currency,
                  )}
                </span>
                {(listing as any).priceFrom != null && !selectedService && (
                  <span className="text-sm text-muted-foreground">
                    starting at
                  </span>
                )}
              </div>

              {/* Quick stats */}
              <div className="grid grid-cols-3 gap-2">
                {listing.domainRating && (
                  <div className="rounded-lg bg-muted p-2.5 text-center">
                    <div className="text-xl font-bold">
                      {listing.domainRating}
                    </div>
                    <div className="text-[10px] text-muted-foreground">DR</div>
                  </div>
                )}
                {listing.traffic && (
                  <div className="rounded-lg bg-muted p-2.5 text-center">
                    <div className="text-xl font-bold">
                      {listing.traffic.toLocaleString()}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      Traffic / mo
                    </div>
                  </div>
                )}
                {listing.referringDomains && (
                  <div className="rounded-lg bg-muted p-2.5 text-center">
                    <div className="text-xl font-bold">
                      {listing.referringDomains.toLocaleString()}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      Ref domains
                    </div>
                  </div>
                )}
              </div>

              {/* Service picker */}
              {services.length > 0 && (
                <div
                  className="space-y-1.5"
                  role="radiogroup"
                  aria-label="Choose a service"
                >
                  <div className="text-sm font-medium">Choose a service</div>
                  {services.map((svc) => {
                    const isSelected = svc.id === selectedServiceId
                    const isWaitlist = svc.availability === "WAITLIST"
                    return (
                      <button
                        key={svc.id}
                        role="radio"
                        aria-checked={isSelected}
                        disabled={isWaitlist}
                        onClick={() => setSelectedServiceId(svc.id)}
                        className={`w-full text-left p-3 border rounded-lg transition-colors ${isSelected ? "border-primary ring-1 ring-primary bg-primary/5" : "border-border hover:border-primary/50"} ${isWaitlist ? "opacity-60 cursor-not-allowed" : ""}`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-sm font-medium">
                              {svc.serviceType.replace(/_/g, " ")}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {svc.turnaroundDays}d · {svc.revisionRounds}{" "}
                              revisions
                              {isWaitlist && (
                                <span className="ml-1.5 text-amber-600">
                                  · Waitlist
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="font-semibold">
                            {formatPrice(svc.price, svc.currency)}
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}

              {/* Order CTA */}
              <Button
                className="w-full"
                size="lg"
                disabled={services.length > 0 && !selectedService}
                asChild
              >
                <Link
                  href={
                    selectedService
                      ? `/dashboard/marketplace/${listing?.slug}/order?service=${selectedService.id}`
                      : "#"
                  }
                >
                  {services.length > 0 && !selectedService
                    ? "Select a service to continue"
                    : "Order Now"}
                </Link>
              </Button>
            </CardContent>
          </Card>

          {/* Info row */}
          <div className="space-y-2.5 rounded-xl border p-4">
            {(() => {
              const td =
                selectedService?.turnaroundDays ??
                services.find((s) => s.availability === "AVAILABLE")
                  ?.turnaroundDays ??
                listing.turnaroundDays
              return td ? (
                <div className="flex items-center gap-2.5 text-sm">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  <span>{td} days turnaround</span>
                </div>
              ) : null
            })()}
            {listing.country && (
              <div className="flex items-center gap-2.5 text-sm">
                <Globe className="h-4 w-4 text-muted-foreground" />
                <span>{listing.country}</span>
              </div>
            )}
            {listing.language && (
              <div className="flex items-center gap-2.5 text-sm">
                <Languages className="h-4 w-4 text-muted-foreground" />
                <span>{listing.language}</span>
              </div>
            )}
            {(() => {
              const rr =
                selectedService?.revisionRounds ??
                services.find((s) => s.availability === "AVAILABLE")
                  ?.revisionRounds ??
                listing.revisionRounds
              return rr != null ? (
                <div className="flex items-center gap-2.5 text-sm">
                  <TrendingUp className="h-4 w-4 text-muted-foreground" />
                  <span>{rr} revision rounds included</span>
                </div>
              ) : null
            })()}
            {listing.websiteUrl && canViewUrl ? (
              <a
                href={listing.websiteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2.5 text-sm text-primary hover:underline"
              >
                <ExternalLink className="h-4 w-4" />
                <span className="truncate">{listing.websiteUrl}</span>
              </a>
            ) : listing.websiteUrl ? (
              <div
                className="group relative"
                title="Deposit funds or place an order to reveal the site URL"
              >
                <div className="flex items-center gap-2.5 text-sm text-muted-foreground blur-sm">
                  <ExternalLink className="h-4 w-4" />
                  <span>{listing.websiteUrl}</span>
                </div>
                <div className="absolute inset-0 flex items-center gap-1.5">
                  <Lock className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">
                    Deposit to reveal URL
                  </span>
                </div>
              </div>
            ) : null}
          </div>

          {/* Publisher card */}
          {listing.publisher && (
            <div className="flex items-center gap-3 rounded-xl border p-4">
              <Avatar>
                <AvatarFallback>{listing.publisher.name[0]}</AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <div className="truncate font-medium">
                  {listing.publisher.name}
                </div>
                {listing.publisher.profile && (
                  <div className="text-sm text-muted-foreground">
                    {listing.publisher.profile.rating && (
                      <span className="inline-flex items-center gap-1 mr-3">
                        <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" />
                        {listing.publisher.profile.rating.toFixed(1)}
                      </span>
                    )}
                    {listing.publisher.profile.totalReviews && (
                      <span>
                        {listing.publisher.profile.totalReviews} reviews
                      </span>
                    )}
                    {listing.publisher.profile.responseTime && (
                      <span className="ml-3">
                        ~{listing.publisher.profile.responseTime}h response
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Tabs: Description, Pricing, Reviews */}
      <Tabs defaultValue="description" className="mt-6">
        <TabsList>
          <TabsTrigger value="description">Description</TabsTrigger>
          <TabsTrigger value="pricing">Pricing</TabsTrigger>
          <TabsTrigger value="reviews">
            Reviews ({listing.reviewCount})
          </TabsTrigger>
        </TabsList>

        {/* Description tab */}
        <TabsContent value="description" className="mt-4 space-y-4">
          <div className="prose prose-sm max-w-none dark:prose-invert">
            <p>{listing.description}</p>
          </div>
          {listing.tags.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-2">
              {listing.tags.map((tag) => (
                <Badge key={tag.id} variant="secondary">
                  {tag.name}
                </Badge>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Pricing tab */}
        <TabsContent value="pricing" className="mt-4">
          {services.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {services.map((svc) => (
                <div
                  key={svc.id}
                  className="rounded-xl border p-5 transition-colors hover:border-primary/30"
                >
                  <h3 className="font-semibold capitalize">
                    {svc.serviceType.replace(/_/g, " ")}
                  </h3>
                  <div className="mt-2 text-2xl font-bold">
                    {formatPrice(svc.price, svc.currency)}
                  </div>
                  <p className="mt-1.5 text-sm text-muted-foreground">
                    {svc.turnaroundDays}d turnaround · {svc.revisionRounds}{" "}
                    revisions
                  </p>
                  {svc.availability === "WAITLIST" && (
                    <p className="mt-2 text-xs text-amber-600">
                      Currently waitlisted
                    </p>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border p-6 text-center">
              <p className="text-lg font-medium">
                {formatPrice(listing.price ?? 0, listing.currency)}
              </p>
              <p className="text-muted-foreground">Fixed price</p>
            </div>
          )}
        </TabsContent>

        {/* Reviews tab */}
        <TabsContent value="reviews" className="mt-4">
          {listing.reviews.length > 0 ? (
            <div className="space-y-4">
              {/* Rating Summary */}
              {listing.avgRating && (
                <div className="flex items-center gap-4 rounded-xl border p-4">
                  <div className="text-center">
                    <div className="text-4xl font-bold">
                      {listing.avgRating.toFixed(1)}
                    </div>
                    <div className="mt-1 flex justify-center">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Star
                          key={i}
                          className={`h-4 w-4 ${
                            i < Math.round(listing.avgRating!)
                              ? "fill-yellow-400 text-yellow-400"
                              : "text-gray-300"
                          }`}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="h-12 w-px bg-border" />
                  <div>
                    <div className="text-sm font-medium">
                      {listing.reviewCount} review
                      {listing.reviewCount !== 1 ? "s" : ""}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      Based on verified orders
                    </div>
                  </div>
                </div>
              )}

              {/* Individual reviews */}
              {listing.reviews.map((review) => (
                <div key={review.id} className="rounded-xl border p-4">
                  <div className="flex items-center gap-3 mb-3">
                    <Avatar className="h-8 w-8">
                      <AvatarFallback className="text-xs">
                        {review.user.name?.[0] || "U"}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1">
                      <div className="text-sm font-medium">
                        {review.user.name || "Anonymous"}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(review.createdAt).toLocaleDateString()}
                      </div>
                    </div>
                    <div className="flex">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Star
                          key={i}
                          className={`h-3.5 w-3.5 ${
                            i < review.rating
                              ? "fill-yellow-400 text-yellow-400"
                              : "text-gray-300"
                          }`}
                        />
                      ))}
                    </div>
                  </div>
                  {review.title && (
                    <h4 className="font-medium mb-1">{review.title}</h4>
                  )}
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {review.content}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="rounded-full bg-muted p-3 mb-3">
                <Star className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="text-sm font-semibold">No reviews yet</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Reviews appear after verified orders are completed.
              </p>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
