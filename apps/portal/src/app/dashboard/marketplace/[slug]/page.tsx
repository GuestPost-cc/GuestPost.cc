"use client"

import type {
  ListingServiceOption,
  MarketplaceListing,
} from "@guestpost/api-client"
import {
  LISTING_LINK_TYPE_LABELS,
  LISTING_LINK_VALIDITY_LABELS,
} from "@guestpost/shared"
import {
  Avatar,
  AvatarFallback,
  Badge,
  Button,
  ErrorState,
  Skeleton,
} from "@guestpost/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Bell,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  ExternalLink,
  FileCheck2,
  Globe2,
  Heart,
  Languages,
  LockKeyhole,
  RefreshCcw,
  ShieldCheck,
  Star,
} from "lucide-react"
import Image from "next/image"
import Link from "next/link"
import { useParams, useSearchParams } from "next/navigation"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { MarketplaceListingCard } from "../../../../components/marketplace/marketplace-listing-card"
import {
  displayWebsiteHost,
  formatCompactNumber,
  formatMoney,
  fulfillmentBadgeClass,
  fulfillmentLabel,
  serviceDescription,
  serviceLabel,
} from "../../../../components/marketplace/marketplace-ui"
import { api } from "../../../../lib/api"
import { useCustomerAccess } from "../../../../lib/hooks/use-customer-access"

export default function ListingDetailPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const requestedService = searchParams?.get("service")
  const queryClient = useQueryClient()
  const [activeImage, setActiveImage] = useState(0)
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(
    null,
  )
  const [subscribedServices, setSubscribedServices] = useState<Set<string>>(
    new Set(),
  )

  const {
    data: listing,
    isLoading,
    error,
    refetch,
  } = useQuery<MarketplaceListing>({
    queryKey: ["listing", params.slug],
    queryFn: () => api.marketplace.getListing(params.slug as string),
    enabled: Boolean(params.slug),
  })

  const { canViewUrls } = useCustomerAccess()
  const services = listing?.services ?? []
  const orderableServices = useMemo(
    () => services.filter((service) => service.availability === "AVAILABLE"),
    [services],
  )
  const selectedService = useMemo(
    () =>
      orderableServices.find((service) => service.id === selectedServiceId) ??
      null,
    [orderableServices, selectedServiceId],
  )

  useEffect(() => {
    if (!listing || orderableServices.length === 0) return
    const fromUrl = requestedService
      ? orderableServices.find(
          (service) =>
            service.id === requestedService ||
            service.serviceType === requestedService,
        )
      : null
    setSelectedServiceId((current) => {
      if (fromUrl) return fromUrl.id
      if (
        current &&
        orderableServices.some((service) => service.id === current)
      ) {
        return current
      }
      return orderableServices[0].id
    })
  }, [listing, orderableServices, requestedService])

  const favoriteMut = useMutation({
    mutationFn: () => {
      if (!listing) throw new Error("Listing is unavailable")
      return listing.isFavorited
        ? api.marketplace.removeFavorite(listing.id)
        : api.marketplace.addFavorite(listing.id)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["listing", params.slug] })
      toast.success(
        listing?.isFavorited ? "Removed from favorites" : "Saved to favorites",
      )
    },
    onError: (mutationError: Error) => toast.error(mutationError.message),
  })

  const waitlistMut = useMutation({
    mutationFn: (serviceType: string) => {
      if (!listing) throw new Error("Listing is unavailable")
      return api.marketplace.addFavorite(listing.id, serviceType)
    },
    onSuccess: (_result, serviceType) => {
      setSubscribedServices((current) => new Set(current).add(serviceType))
      toast.success("You’ll be notified when this service is available")
    },
    onError: (mutationError: Error) => toast.error(mutationError.message),
  })

  if (isLoading) return <ListingDetailSkeleton />

  if (error) {
    return (
      <ErrorState
        title="This listing could not be loaded"
        description={(error as Error).message}
        onRetry={() => refetch()}
      />
    )
  }

  if (!listing) {
    return (
      <div className="mx-auto max-w-xl py-20 text-center">
        <AlertCircle className="mx-auto h-10 w-10 text-destructive" />
        <h1 className="mt-4 text-xl font-semibold">Listing not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          It may have been paused, archived, or removed from the marketplace.
        </p>
        <Button asChild className="mt-6">
          <Link href="/dashboard/marketplace">Browse marketplace</Link>
        </Button>
      </div>
    )
  }

  const images = (listing.images ?? []).filter((image) => Boolean(image.url))
  const relatedListings = listing.relatedListings ?? []
  const categories =
    listing.categories ?? (listing.category ? [listing.category] : [])
  const attribution =
    listing.attribution?.label ??
    (listing.ownerType === "PLATFORM"
      ? "GuestPost.cc"
      : (listing.publisher?.name ?? "Verified publisher"))

  return (
    <div className="mx-auto max-w-[1450px] space-y-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav
          aria-label="Breadcrumb"
          className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground"
        >
          <Link
            href="/dashboard/marketplace"
            className="inline-flex items-center gap-1.5 hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" /> Marketplace
          </Link>
          <ChevronRight className="h-3.5 w-3.5" />
          <span className="truncate">
            {categories[0]?.name ?? "Listing details"}
          </span>
        </nav>
        <Button
          variant="outline"
          size="sm"
          onClick={() => favoriteMut.mutate()}
          disabled={favoriteMut.isPending}
        >
          <Heart
            className={`mr-2 h-4 w-4 ${
              listing.isFavorited ? "fill-rose-500 text-rose-500" : ""
            }`}
          />
          {listing.isFavorited ? "Saved" : "Save listing"}
        </Button>
      </div>

      <header className="rounded-3xl border bg-card p-5 shadow-sm sm:p-7">
        <div className="flex flex-wrap items-center gap-2">
          {categories.map((category) => (
            <Badge key={category.id} variant="secondary">
              {category.name}
            </Badge>
          ))}
          <Badge variant="outline" className={fulfillmentBadgeClass(listing)}>
            {fulfillmentLabel(listing)}
          </Badge>
          {listing.verified && (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" /> Verified listing
            </span>
          )}
          {listing.featured && <Badge>Featured</Badge>}
        </div>
        <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div>
            <h1 className="max-w-4xl text-3xl font-bold leading-tight tracking-tight sm:text-4xl">
              {listing.title}
            </h1>
            <p className="mt-3 max-w-3xl text-base leading-7 text-muted-foreground">
              {listing.shortDescription || listing.description}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            {listing.avgRating != null && listing.reviewCount > 0 ? (
              <div className="flex items-center gap-2">
                <RatingStars rating={listing.avgRating} />
                <span className="font-semibold">
                  {listing.avgRating.toFixed(1)}
                </span>
                <span className="text-muted-foreground">
                  {listing.reviewCount} review
                  {listing.reviewCount === 1 ? "" : "s"}
                </span>
              </div>
            ) : (
              <span className="text-muted-foreground">
                New to the marketplace
              </span>
            )}
            <span className="hidden h-4 w-px bg-border sm:block" />
            <span className="text-muted-foreground">
              Fulfilled by{" "}
              <strong className="font-semibold text-foreground">
                {attribution}
              </strong>
            </span>
          </div>
        </div>
      </header>

      <div className="grid items-start gap-7 lg:grid-cols-[minmax(0,1fr)_390px]">
        <main className="min-w-0 space-y-7">
          <section aria-label="Listing media">
            <div className="relative aspect-[16/8.5] overflow-hidden rounded-3xl border bg-muted">
              {images[activeImage]?.url ? (
                <Image
                  fill
                  unoptimized
                  priority
                  src={images[activeImage].url}
                  alt={listing.title}
                  className="object-cover"
                  sizes="(max-width: 1024px) 100vw, 70vw"
                />
              ) : (
                <div className="flex h-full items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-slate-700 text-white">
                  <div className="text-center">
                    <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl border border-white/15 bg-white/10">
                      <Globe2 className="h-8 w-8" />
                    </div>
                    <p className="mt-4 text-sm font-medium text-slate-300">
                      Verified marketplace placement
                    </p>
                  </div>
                </div>
              )}
            </div>
            {images.length > 1 && (
              <div
                role="group"
                className="mt-3 flex gap-2 overflow-x-auto pb-1"
                aria-label="Listing images"
              >
                {images.map((image, index) => (
                  <button
                    key={image.url}
                    type="button"
                    onClick={() => setActiveImage(index)}
                    aria-label={`Show image ${index + 1}`}
                    aria-pressed={activeImage === index}
                    className={`relative h-16 w-20 shrink-0 overflow-hidden rounded-xl border-2 transition ${
                      activeImage === index
                        ? "border-foreground"
                        : "border-transparent opacity-70 hover:opacity-100"
                    }`}
                  >
                    <Image
                      fill
                      unoptimized
                      src={image.url}
                      alt=""
                      className="object-cover"
                      sizes="80px"
                    />
                  </button>
                ))}
              </div>
            )}
          </section>

          <WebsiteAccessCard listing={listing} canViewUrls={canViewUrls} />

          <section
            aria-labelledby="domain-metrics-heading"
            className="rounded-3xl border bg-card p-6"
          >
            <div>
              <h2
                id="domain-metrics-heading"
                className="text-xl font-semibold tracking-tight"
              >
                Domain metrics
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Source-specific authority and organic traffic signals.
              </p>
            </div>
            <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Metric
                label="Ahrefs DR"
                value={
                  listing.domainMetrics?.ahrefs.domainRating?.value != null
                    ? formatCompactNumber(
                        listing.domainMetrics.ahrefs.domainRating.value,
                      )
                    : "—"
                }
                note={
                  listing.domainMetrics?.ahrefs.domainRating?.status ??
                  "Unavailable"
                }
              />
              <Metric
                label="Ahrefs traffic"
                value={
                  listing.domainMetrics?.ahrefs.organicTraffic?.value != null
                    ? formatCompactNumber(
                        listing.domainMetrics.ahrefs.organicTraffic.value,
                      )
                    : "—"
                }
                note={
                  listing.domainMetrics?.ahrefs.organicTraffic?.status ??
                  "Unavailable"
                }
              />
              <Metric
                label="Moz DA"
                value={
                  listing.domainMetrics?.moz.domainAuthority?.value != null
                    ? formatCompactNumber(
                        listing.domainMetrics.moz.domainAuthority.value,
                      )
                    : "—"
                }
                note={
                  listing.domainMetrics?.moz.domainAuthority?.status ??
                  "Unavailable"
                }
              />
              <Metric
                label="Open PageRank"
                value={
                  listing.domainMetrics?.openPageRank.pageRank?.value != null
                    ? String(listing.domainMetrics.openPageRank.pageRank.value)
                    : "—"
                }
                note={
                  listing.domainMetrics?.openPageRank.pageRank?.status ??
                  "Unavailable"
                }
              />
            </dl>
            <p className="mt-4 text-xs text-muted-foreground">
              <a
                href="https://ahrefs.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2"
              >
                Domain Rating by Ahrefs
              </a>
              {" · "}
              <a
                href="https://openpagerank.keywordseverywhere.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2"
              >
                Open PageRank
              </a>
            </p>
          </section>

          {listing.siteMetrics && (
            <section
              aria-labelledby="performance-heading"
              className="rounded-3xl border bg-card p-6"
            >
              <div>
                <h2
                  id="performance-heading"
                  className="text-xl font-semibold tracking-tight"
                >
                  Connected Google performance
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  30-day signals shown only while the publisher has an active,
                  successfully synced property connection.
                </p>
              </div>
              <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {listing.siteMetrics.ga4 && (
                  <>
                    <Metric
                      label="GA4 sessions"
                      value={formatCompactNumber(
                        listing.siteMetrics.ga4.sessions,
                      )}
                      note="Last 30 days"
                    />
                    <Metric
                      label="GA4 pageviews"
                      value={formatCompactNumber(
                        listing.siteMetrics.ga4.pageviews,
                      )}
                      note="Last 30 days"
                    />
                  </>
                )}
                {listing.siteMetrics.gsc && (
                  <>
                    <Metric
                      label="GSC clicks"
                      value={formatCompactNumber(
                        listing.siteMetrics.gsc.clicks,
                      )}
                      note="Last 30 days"
                    />
                    <Metric
                      label="GSC impressions"
                      value={formatCompactNumber(
                        listing.siteMetrics.gsc.impressions,
                      )}
                      note="Last 30 days"
                    />
                  </>
                )}
              </dl>
            </section>
          )}

          <section
            aria-labelledby="about-heading"
            className="rounded-3xl border bg-card p-6 sm:p-7"
          >
            <h2
              id="about-heading"
              className="text-xl font-semibold tracking-tight"
            >
              About this placement
            </h2>
            <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-muted-foreground">
              {listing.description}
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              {listing.country && (
                <Badge variant="outline" className="gap-1.5">
                  <Globe2 className="h-3.5 w-3.5" /> {listing.country}
                </Badge>
              )}
              {listing.language && (
                <Badge variant="outline" className="gap-1.5">
                  <Languages className="h-3.5 w-3.5" /> {listing.language}
                </Badge>
              )}
              {listing.doFollowOnly && (
                <Badge variant="outline" className="gap-1.5">
                  <Check className="h-3.5 w-3.5" /> Do-follow only
                </Badge>
              )}
              {listing.linkType && (
                <Badge variant="outline">
                  {LISTING_LINK_TYPE_LABELS[listing.linkType]}
                </Badge>
              )}
              {listing.backlinkCount && (
                <Badge variant="outline">
                  {listing.backlinkCount} backlink
                  {listing.backlinkCount === 1 ? "" : "s"}
                </Badge>
              )}
              {listing.linkValidity && (
                <Badge variant="outline">
                  {LISTING_LINK_VALIDITY_LABELS[listing.linkValidity]}
                </Badge>
              )}
              {listing.googleNews && (
                <Badge variant="outline">Google News</Badge>
              )}
              {listing.markedSponsored && (
                <Badge variant="outline">Marked sponsored</Badge>
              )}
              {listing.foreignLanguageAllowed && (
                <Badge variant="outline">
                  Foreign-language content allowed
                </Badge>
              )}
              {listing.tags.map((tag) => (
                <Badge key={tag.id} variant="secondary">
                  {tag.name}
                </Badge>
              ))}
            </div>
          </section>

          {selectedService && (
            <SelectedServiceDetails service={selectedService} />
          )}

          <FulfillmentCard listing={listing} />

          <ReviewsSection listing={listing} />
        </main>

        <aside className="order-first lg:order-last lg:sticky lg:top-6">
          <div className="overflow-hidden rounded-3xl border bg-card shadow-lg shadow-slate-950/5">
            <div className="border-b bg-muted/30 p-5 sm:p-6">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Available services
              </p>
              <div className="mt-2 flex items-end justify-between gap-4">
                <div>
                  <p className="text-sm text-muted-foreground">Starting at</p>
                  <p className="text-3xl font-bold tracking-tight">
                    {formatMoney(
                      selectedService?.price ?? listing.priceFrom ?? 0,
                      selectedService?.currency ?? listing.currency,
                    )}
                  </p>
                </div>
                <Badge variant="outline">
                  {orderableServices.length} available
                </Badge>
              </div>
            </div>

            <div className="space-y-3 p-5 sm:p-6">
              {services.map((service) => {
                const selected = service.id === selectedServiceId
                const waitlisted = service.availability === "WAITLIST"
                if (waitlisted) {
                  const subscribed = subscribedServices.has(service.serviceType)
                  return (
                    <div
                      key={service.id}
                      className="rounded-2xl border border-dashed p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-semibold">
                            {serviceLabel(service.serviceType)}
                          </p>
                          <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            {serviceDescription(service.serviceType)}
                          </p>
                        </div>
                        <Badge variant="secondary">Waitlist</Badge>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-3 w-full"
                        disabled={subscribed || waitlistMut.isPending}
                        onClick={() => waitlistMut.mutate(service.serviceType)}
                      >
                        {subscribed ? (
                          <>
                            <Check className="mr-2 h-4 w-4" /> Notification set
                          </>
                        ) : (
                          <>
                            <Bell className="mr-2 h-4 w-4" /> Notify me
                          </>
                        )}
                      </Button>
                    </div>
                  )
                }

                return (
                  <button
                    key={service.id}
                    type="button"
                    onClick={() => setSelectedServiceId(service.id)}
                    aria-pressed={selected}
                    className={`w-full rounded-2xl border p-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      selected
                        ? "border-foreground bg-foreground text-background shadow-sm"
                        : "hover:border-foreground/30 hover:bg-muted/30"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-semibold">
                            {serviceLabel(service.serviceType)}
                          </p>
                          {selected && (
                            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-background text-foreground">
                              <Check className="h-3 w-3" />
                            </span>
                          )}
                        </div>
                        <p
                          className={`mt-1 text-xs leading-5 ${selected ? "text-background/70" : "text-muted-foreground"}`}
                        >
                          {service.turnaroundDays} days ·{" "}
                          {service.revisionRounds} revision
                          {service.revisionRounds === 1 ? "" : "s"}
                        </p>
                      </div>
                      <p className="shrink-0 font-bold">
                        {formatMoney(service.price, service.currency)}
                      </p>
                    </div>
                  </button>
                )
              })}

              {services.length === 0 && (
                <div className="rounded-2xl border border-dashed p-5 text-center">
                  <Clock3 className="mx-auto h-5 w-5 text-muted-foreground" />
                  <p className="mt-2 text-sm font-medium">
                    No service is available
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Check back later for new placement options.
                  </p>
                </div>
              )}

              {selectedService ? (
                <Button asChild size="lg" className="mt-2 w-full">
                  <Link
                    href={(() => {
                      const params = new URLSearchParams({
                        service: selectedService.id,
                      })
                      const campaignId = searchParams?.get("campaignId")
                      if (campaignId) {
                        params.set("campaignId", campaignId)
                      }
                      return `/dashboard/marketplace/${listing.slug}/order?${params.toString()}`
                    })()}
                  >
                    Continue with {serviceLabel(selectedService.serviceType)}
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Link>
                </Button>
              ) : (
                <Button size="lg" className="mt-2 w-full" disabled>
                  Select an available service
                </Button>
              )}

              <div className="space-y-2.5 border-t pt-4 text-xs text-muted-foreground">
                <p className="flex items-start gap-2">
                  <FileCheck2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  Review your campaign brief before payment.
                </p>
                <p className="flex items-start gap-2">
                  <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  Price and delivery terms are locked when the order is created.
                </p>
              </div>
            </div>
          </div>
        </aside>
      </div>

      {relatedListings.length > 0 && (
        <section aria-labelledby="related-heading" className="border-t pt-8">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2
                id="related-heading"
                className="text-2xl font-semibold tracking-tight"
              >
                Similar placements
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Compare other sites with related categories or services.
              </p>
            </div>
            <Button asChild variant="outline" className="hidden sm:inline-flex">
              <Link href="/dashboard/marketplace">
                View all <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </div>
          <div className="mt-5 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
            {relatedListings.map((related) => (
              <MarketplaceListingCard
                key={related.id}
                listing={related}
                canViewUrls={canViewUrls}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function WebsiteAccessCard({
  listing,
  canViewUrls,
}: {
  listing: MarketplaceListing
  canViewUrls: boolean
}) {
  if (!listing.websiteUrl) return null

  if (canViewUrls) {
    return (
      <div className="flex flex-col gap-4 rounded-2xl border border-emerald-200 bg-emerald-50/70 p-5 dark:border-emerald-900 dark:bg-emerald-950/20 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-emerald-100 p-2 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300">
            <Globe2 className="h-5 w-5" />
          </div>
          <div>
            <p className="font-semibold">Website address unlocked</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {displayWebsiteHost(listing.websiteUrl)}
            </p>
          </div>
        </div>
        <Button asChild variant="outline" className="bg-background">
          <a
            href={listing.websiteUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Visit website <ExternalLink className="ml-2 h-4 w-4" />
          </a>
        </Button>
      </div>
    )
  }

  return (
    <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50/70 p-5 dark:border-amber-900 dark:bg-amber-950/20">
      <div className="rounded-xl bg-amber-100 p-2 text-amber-700 dark:bg-amber-900 dark:text-amber-300">
        <LockKeyhole className="h-5 w-5" />
      </div>
      <div>
        <p className="font-semibold">Website address protected</p>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          Your organization can view publisher website addresses after its first
          successful deposit. All decision metrics and service terms remain
          visible now.
        </p>
      </div>
    </div>
  )
}

function Metric({
  label,
  value,
  note,
}: {
  label: string
  value: string
  note: string
}) {
  return (
    <div className="rounded-2xl border bg-muted/20 p-4">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-2 text-2xl font-bold tracking-tight">{value}</dd>
      <p className="mt-1 text-[11px] text-muted-foreground">{note}</p>
    </div>
  )
}

function SelectedServiceDetails({
  service,
}: {
  service: ListingServiceOption
}) {
  const facts = [
    {
      icon: Clock3,
      label: "Delivery estimate",
      value: `${service.turnaroundDays} days`,
    },
    {
      icon: RefreshCcw,
      label: "Included revisions",
      value: `${service.revisionRounds} round${service.revisionRounds === 1 ? "" : "s"}`,
    },
    ...(service.warrantyDays
      ? [
          {
            icon: ShieldCheck,
            label: "Placement warranty",
            value: `${service.warrantyDays} days`,
          },
        ]
      : []),
  ]

  return (
    <section
      aria-labelledby="selected-service-heading"
      className="rounded-3xl border bg-slate-950 p-6 text-white sm:p-7"
    >
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
        Selected service
      </p>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 id="selected-service-heading" className="text-2xl font-semibold">
            {serviceLabel(service.serviceType)}
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-6 text-slate-300">
            {serviceDescription(service.serviceType)}
          </p>
        </div>
        <p className="text-2xl font-bold">
          {formatMoney(service.price, service.currency)}
        </p>
      </div>
      <dl className="mt-6 grid gap-3 sm:grid-cols-3">
        {facts.map((fact) => {
          const Icon = fact.icon
          return (
            <div
              key={fact.label}
              className="rounded-2xl border border-white/10 bg-white/5 p-4"
            >
              <Icon className="h-4 w-4 text-slate-400" />
              <dt className="mt-3 text-xs text-slate-400">{fact.label}</dt>
              <dd className="mt-1 font-semibold">{fact.value}</dd>
            </div>
          )
        })}
      </dl>
    </section>
  )
}

function FulfillmentCard({ listing }: { listing: MarketplaceListing }) {
  const platformManaged =
    listing.ownerType === "PLATFORM" || listing.fulfillmentType === "INTERNAL"
  const name = platformManaged
    ? "GuestPost.cc fulfillment team"
    : (listing.publisher?.name ?? "Verified publisher")

  return (
    <section
      aria-labelledby="fulfillment-heading"
      className="rounded-3xl border bg-card p-6"
    >
      <div className="flex items-start gap-4">
        <Avatar className="h-12 w-12">
          <AvatarFallback>{platformManaged ? "GP" : name[0]}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="fulfillment-heading" className="font-semibold">
              {name}
            </h2>
            <Badge variant="outline" className={fulfillmentBadgeClass(listing)}>
              {platformManaged ? "Platform managed" : "Publisher managed"}
            </Badge>
          </div>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {platformManaged
              ? "GuestPost Operations manages the order, content handoff, publication, and delivery verification."
              : "The verified publisher manages content acceptance and publication, while GuestPost tracks the order and delivery workflow."}
          </p>
          {listing.publisher?.profile && (
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
              {listing.publisher.profile.rating != null && (
                <span className="inline-flex items-center gap-1">
                  <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
                  {listing.publisher.profile.rating.toFixed(1)} publisher rating
                </span>
              )}
              {listing.publisher.profile.responseTime != null && (
                <span>
                  Typically responds in {listing.publisher.profile.responseTime}
                  h
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function ReviewsSection({ listing }: { listing: MarketplaceListing }) {
  const reviews = listing.reviews ?? []
  return (
    <section
      aria-labelledby="reviews-heading"
      className="rounded-3xl border bg-card p-6 sm:p-7"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2
            id="reviews-heading"
            className="text-xl font-semibold tracking-tight"
          >
            Buyer reviews
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Feedback from completed and verified marketplace orders.
          </p>
        </div>
        {listing.avgRating != null && reviews.length > 0 && (
          <div className="flex items-center gap-2">
            <RatingStars rating={listing.avgRating} />
            <span className="font-semibold">
              {listing.avgRating.toFixed(1)}
            </span>
          </div>
        )}
      </div>

      {reviews.length > 0 ? (
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {reviews.map((review) => (
            <article
              key={review.id}
              className="rounded-2xl border bg-muted/20 p-5"
            >
              <div className="flex items-center gap-3">
                <Avatar className="h-9 w-9">
                  <AvatarFallback className="text-xs">
                    {review.user.name?.[0] || "B"}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">
                    {review.user.name || "Verified buyer"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(review.createdAt).toLocaleDateString(undefined, {
                      month: "short",
                      year: "numeric",
                    })}
                  </p>
                </div>
                <RatingStars rating={review.rating} compact />
              </div>
              {review.title && (
                <h3 className="mt-4 font-semibold">{review.title}</h3>
              )}
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {review.content}
              </p>
            </article>
          ))}
        </div>
      ) : (
        <div className="mt-6 rounded-2xl border border-dashed bg-muted/20 px-5 py-10 text-center">
          <Star className="mx-auto h-6 w-6 text-muted-foreground" />
          <p className="mt-3 font-medium">No buyer reviews yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Completed orders will build this listing’s review history.
          </p>
        </div>
      )}
    </section>
  )
}

function RatingStars({
  rating,
  compact = false,
}: {
  rating: number
  compact?: boolean
}) {
  return (
    <span
      role="img"
      className="flex"
      aria-label={`${rating.toFixed(1)} out of 5 stars`}
    >
      {Array.from({ length: 5 }).map((_, index) => (
        <Star
          key={index}
          className={`${compact ? "h-3 w-3" : "h-4 w-4"} ${
            index < Math.round(rating)
              ? "fill-amber-400 text-amber-400"
              : "text-muted-foreground/30"
          }`}
        />
      ))}
    </span>
  )
}

function ListingDetailSkeleton() {
  return (
    <div className="mx-auto max-w-[1450px] space-y-7">
      <Skeleton className="h-9 w-48" />
      <Skeleton className="h-44 rounded-3xl" />
      <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_390px]">
        <div className="space-y-6">
          <Skeleton className="aspect-[16/8.5] rounded-3xl" />
          <Skeleton className="h-32 rounded-3xl" />
          <Skeleton className="h-72 rounded-3xl" />
        </div>
        <Skeleton className="h-[620px] rounded-3xl" />
      </div>
    </div>
  )
}
