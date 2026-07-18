import type { MarketplaceListing } from "@guestpost/api-client"
import {
  LISTING_LINK_TYPE_LABELS,
  LISTING_LINK_VALIDITY_LABELS,
} from "@guestpost/shared"
import { Badge } from "@guestpost/ui"
import {
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  Globe2,
  LockKeyhole,
  Star,
  TrendingUp,
} from "lucide-react"
import Image from "next/image"
import Link from "next/link"
import {
  availableServices,
  displayWebsiteHost,
  fastestTurnaround,
  formatCompactNumber,
  formatMoney,
  fulfillmentBadgeClass,
  fulfillmentLabel,
  listingImage,
  serviceShortLabel,
  startingPrice,
} from "./marketplace-ui"

export function MarketplaceListingCard({
  listing,
  canViewUrls,
  serviceTypeFilter,
}: {
  listing: MarketplaceListing
  canViewUrls: boolean
  serviceTypeFilter?: string
}) {
  const image = listingImage(listing)
  const services = availableServices(listing)
  const matchingService = serviceTypeFilter
    ? services.find((service) => service.serviceType === serviceTypeFilter)
    : undefined
  const visibleServices = matchingService
    ? [
        matchingService,
        ...services.filter((service) => service.id !== matchingService.id),
      ]
    : services
  const turnaround =
    matchingService?.turnaroundDays ?? fastestTurnaround(listing)
  const price = matchingService?.price ?? startingPrice(listing)
  const categories =
    listing.categories ?? (listing.category ? [listing.category] : [])

  return (
    <Link
      href={`/dashboard/marketplace/${listing.slug}`}
      aria-label={`View ${listing.title}`}
      className="group flex h-full flex-col overflow-hidden rounded-2xl border bg-card shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <div className="relative aspect-[16/9] overflow-hidden bg-muted">
        {image ? (
          <Image
            fill
            unoptimized
            src={image}
            alt={listing.title}
            className="object-cover transition duration-500 group-hover:scale-[1.03]"
            sizes="(max-width: 768px) 100vw, (max-width: 1280px) 50vw, 33vw"
          />
        ) : (
          <div className="flex h-full items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-slate-700 text-white">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/15 bg-white/10 backdrop-blur">
              <Globe2 className="h-7 w-7" />
            </div>
          </div>
        )}
        <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3">
          <div className="flex flex-wrap gap-1.5">
            {listing.featured && (
              <Badge className="border-0 bg-foreground text-background shadow-sm">
                Featured
              </Badge>
            )}
            <Badge
              variant="outline"
              className={`${fulfillmentBadgeClass(listing)} shadow-sm backdrop-blur`}
            >
              {fulfillmentLabel(listing)}
            </Badge>
          </div>
          {listing.verified && (
            <span
              className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500 text-white shadow-sm"
              title="Verified listing"
            >
              <CheckCircle2 className="h-4 w-4" />
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-1 flex-col p-5">
        <div className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-muted-foreground">
          {categories.slice(0, 2).map((category) => (
            <Badge
              key={category.id}
              variant="secondary"
              className="font-medium"
            >
              {category.name}
            </Badge>
          ))}
          {categories.length > 2 && (
            <Badge variant="outline">+{categories.length - 2}</Badge>
          )}
          {listing.language && (
            <Badge variant="outline">{listing.language}</Badge>
          )}
        </div>
        <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          {canViewUrls && listing.websiteUrl ? (
            <span className="min-w-0 truncate">
              {displayWebsiteHost(listing.websiteUrl)}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <LockKeyhole className="h-3 w-3" /> URL protected
            </span>
          )}
        </div>

        <h2 className="mt-2 line-clamp-2 text-lg font-semibold leading-snug tracking-tight transition-colors group-hover:text-primary">
          {listing.title}
        </h2>
        <p
          className="mt-2 line-clamp-2 overflow-hidden text-ellipsis text-sm leading-6 text-muted-foreground"
          title={listing.shortDescription || listing.description}
        >
          {listing.shortDescription || listing.description}
        </p>

        <dl className="mt-5 grid grid-cols-3 divide-x rounded-xl border bg-muted/30 py-3">
          <div className="px-3">
            <dt className="text-[11px] text-muted-foreground">Link type</dt>
            <dd className="mt-0.5 font-semibold">
              {listing.linkType
                ? LISTING_LINK_TYPE_LABELS[listing.linkType]
                : "—"}
            </dd>
          </div>
          <div className="px-3">
            <dt className="text-[11px] text-muted-foreground">GA4 sessions</dt>
            <dd className="mt-0.5 inline-flex items-center gap-1 font-semibold">
              <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
              {listing.traffic != null
                ? formatCompactNumber(listing.traffic)
                : "—"}
            </dd>
          </div>
          <div className="px-3">
            <dt className="text-[11px] text-muted-foreground">Fastest</dt>
            <dd className="mt-0.5 inline-flex items-center gap-1 font-semibold">
              <Clock3 className="h-3.5 w-3.5 text-muted-foreground" />
              {turnaround ? `${turnaround}d` : "—"}
            </dd>
          </div>
        </dl>

        {visibleServices.length > 0 && (
          <div
            role="list"
            className="mt-4 flex flex-wrap gap-1.5"
            aria-label="Available services"
          >
            {visibleServices.slice(0, 3).map((service) => (
              <span
                key={service.id}
                className="rounded-full bg-secondary px-2.5 py-1 text-[11px] font-medium text-secondary-foreground"
              >
                {serviceShortLabel(service.serviceType)}
              </span>
            ))}
            {visibleServices.length > 3 && (
              <span className="rounded-full border px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                +{visibleServices.length - 3} more
              </span>
            )}
          </div>
        )}

        {(listing.backlinkCount || listing.linkValidity) && (
          <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
            {listing.backlinkCount && (
              <span className="rounded-full border px-2.5 py-1">
                {listing.backlinkCount} backlink
                {listing.backlinkCount === 1 ? "" : "s"}
              </span>
            )}
            {listing.linkValidity && (
              <span className="rounded-full border px-2.5 py-1">
                {LISTING_LINK_VALIDITY_LABELS[listing.linkValidity]}
              </span>
            )}
            {listing.googleNews && (
              <span className="rounded-full border px-2.5 py-1">
                Google News
              </span>
            )}
          </div>
        )}

        <div className="mt-auto flex items-end justify-between gap-4 border-t pt-4 mt-5">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {matchingService
                ? serviceShortLabel(matchingService.serviceType)
                : "Starting at"}
            </p>
            <p className="mt-0.5 text-xl font-bold tracking-tight">
              {formatMoney(price, listing.currency)}
            </p>
          </div>
          <div className="text-right">
            {listing.avgRating != null && listing.reviewCount > 0 ? (
              <p className="mb-1 flex items-center justify-end gap-1 text-xs text-muted-foreground">
                <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
                <span className="font-semibold text-foreground">
                  {listing.avgRating.toFixed(1)}
                </span>
                ({listing.reviewCount})
              </p>
            ) : (
              <p className="mb-1 text-xs text-muted-foreground">New listing</p>
            )}
            <span className="inline-flex items-center gap-1 text-sm font-semibold">
              View options
              <ArrowUpRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
            </span>
          </div>
        </div>
      </div>
    </Link>
  )
}
