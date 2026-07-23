"use client"

import { validateBrief } from "@guestpost/shared"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorState,
  Input,
  Label,
  Skeleton,
  Textarea,
} from "@guestpost/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AlertCircle,
  ArrowLeft,
  BookOpen,
  Check,
  Clock3,
  FileCheck2,
  FileText,
  Globe,
  Loader2,
  Lock,
  RefreshCw,
  Send,
  ShieldCheck,
} from "lucide-react"
import Link from "next/link"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { BriefForm } from "../../../../../components/BriefForm"
import { api } from "../../../../../lib/api"

interface ListingService {
  id: string
  serviceType: string
  price: number
  currency: string
  turnaroundDays: number
  revisionRounds: number
  warrantyDays?: number | null
  requirements?: unknown
  availability: "AVAILABLE" | "PAUSED" | "WAITLIST"
  version: number
}

interface Listing {
  id: string
  title: string
  slug: string
  websiteUrl?: string | null
  websiteId?: string | null
  websiteAccess?: {
    unlocked: boolean
    reason: "DEPOSIT_VERIFIED" | "FIRST_DEPOSIT_REQUIRED"
  }
  services?: ListingService[]
  attribution?: { kind: "PUBLISHER" | "PLATFORM"; label: string }
  fulfillmentType?: string
  publisher?: { name: string }
}

type ArticleMode = "FULFILLER" | "CUSTOMER"

function formatPrice(price: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(price)
}

function serviceLabel(value: string) {
  return value
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function requirementLines(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : []
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(
      ([key, item]) => {
        if (typeof item !== "string" && typeof item !== "number") return []
        return [`${serviceLabel(key)}: ${String(item)}`]
      },
    )
  }
  return []
}

export default function MarketplaceOrderPage() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const queryClient = useQueryClient()
  const serviceId = searchParams?.get("service")
  const idempotencyKey = useRef<string | null>(null)

  const [briefData, setBriefData] = useState<Record<string, unknown>>({})
  const [campaignId, setCampaignId] = useState<string | null>(
    () => searchParams?.get("campaignId") || null,
  )
  const [articleMode, setArticleMode] = useState<ArticleMode>("FULFILLER")
  const [articleTitle, setArticleTitle] = useState("")
  const [articleBody, setArticleBody] = useState("")
  const [formError, setFormError] = useState<string | null>(null)

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
        .then((response) => response as unknown as Listing),
    enabled: Boolean(params.slug),
  })

  const services = listing?.services ?? []
  const selectedService = useMemo(
    () => services.find((service) => service.id === serviceId) ?? null,
    [services, serviceId],
  )
  const requirements = requirementLines(selectedService?.requirements)
  const canSupplyArticle = selectedService?.serviceType === "GUEST_POST"
  const isOrderable = selectedService?.availability === "AVAILABLE"
  const articleWordCount = articleBody.trim()
    ? articleBody.trim().split(/\s+/).length
    : 0

  const { data: campaigns } = useQuery({
    queryKey: ["campaigns"],
    queryFn: () => api.campaigns.listCampaigns() as Promise<any[]>,
  })

  const createMutation = useMutation({
    mutationFn: (data: Parameters<typeof api.orders.create>[0]) =>
      api.orders.create(data),
    onSuccess: (order) => {
      toast.success("Order created. Complete payment to start fulfillment.")
      queryClient.invalidateQueries({ queryKey: ["customer-orders"] })
      if (order?.id) router.push(`/dashboard/orders/checkout/${order.id}`)
    },
    onError: (error: any) => {
      const code = error?.data?.code ?? error?.body?.code
      const message =
        error?.data?.message ??
        error?.body?.message ??
        error?.message ??
        "Failed to create order"
      setFormError(message)
      if (code === "REQUOTE_REQUIRED") {
        toast.error("The service terms changed. Refreshing your quote.")
        void refetch()
        return
      }
      toast.error(message)
    },
  })

  const selectService = (id: string) => {
    const query = new URLSearchParams(searchParams?.toString())
    query.set("service", id)
    router.replace(`/dashboard/marketplace/${params.slug}/order?${query}`)
  }

  const handleSubmit = () => {
    setFormError(null)
    if (!selectedService || !listing) {
      setFormError("Select an available service before placing the order.")
      return
    }
    if (!isOrderable) {
      setFormError("This service is not currently available to order.")
      return
    }

    try {
      validateBrief(selectedService.serviceType, briefData)
    } catch (error: any) {
      const issue = error?.issues?.[0]
      const message = issue?.message ?? "Complete the required brief fields."
      setFormError(message)
      toast.error(message)
      return
    }

    if (articleMode === "CUSTOMER") {
      if (!canSupplyArticle) {
        setFormError("Customer-supplied articles are not supported here.")
        return
      }
      if (!articleBody.trim()) {
        setFormError(
          "Add the article body or choose fulfiller-written content.",
        )
        return
      }
      if (articleBody.trim().length > 200_000) {
        setFormError("Article body must be 200,000 characters or fewer.")
        return
      }
    }

    const derivedTitle =
      String(briefData.title ?? briefData.topic ?? articleTitle).trim() ||
      `${serviceLabel(selectedService.serviceType)} order`
    const targetUrl =
      typeof briefData.targetUrl === "string" ? briefData.targetUrl : undefined
    const anchorText =
      typeof briefData.anchorText === "string"
        ? briefData.anchorText
        : undefined

    idempotencyKey.current ??= crypto.randomUUID()
    createMutation.mutate({
      type: selectedService.serviceType as any,
      title: derivedTitle.slice(0, 200),
      campaignId:
        campaignId &&
        Array.isArray(campaigns) &&
        campaigns.some((campaign) => campaign.id === campaignId)
          ? campaignId
          : undefined,
      idempotencyKey: idempotencyKey.current,
      listingServiceId: selectedService.id,
      expectedListingServiceVersion: selectedService.version,
      expectedPrice: selectedService.price,
      expectedCurrency: selectedService.currency,
      briefData,
      articleTitle:
        articleMode === "CUSTOMER"
          ? articleTitle.trim() || undefined
          : undefined,
      articleBody: articleMode === "CUSTOMER" ? articleBody.trim() : undefined,
      articleFormat: articleMode === "CUSTOMER" ? "MARKDOWN" : undefined,
      items: [
        {
          websiteId: listing.websiteId || undefined,
          targetUrl,
          anchorText,
        },
      ],
    })
  }

  if (isLoading) {
    return (
      <div className="mx-auto max-w-7xl space-y-6 py-8">
        <Skeleton className="h-10 w-64" />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <Skeleton className="h-[620px]" />
          <Skeleton className="h-[480px]" />
        </div>
      </div>
    )
  }

  if (error || !listing) {
    return (
      <ErrorState
        title="Failed to load listing"
        description={
          error instanceof Error ? error.message : "Listing not found"
        }
        onRetry={() => refetch()}
      />
    )
  }

  if (!selectedService) {
    return (
      <div className="mx-auto max-w-4xl py-10">
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/dashboard/marketplace/${listing.slug}`}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to listing
          </Link>
        </Button>
        <Card className="mt-6 overflow-hidden border-amber-200">
          <div className="h-2 bg-gradient-to-r from-amber-400 via-orange-400 to-rose-400" />
          <CardHeader>
            <CardTitle>Select the service contract</CardTitle>
            <p className="text-sm text-muted-foreground">
              The service in this link is unavailable or no longer exists.
              Choose a current option before preparing the order.
            </p>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            {services.map((service) => (
              <button
                key={service.id}
                type="button"
                disabled={service.availability !== "AVAILABLE"}
                className="rounded-xl border p-4 text-left transition hover:border-amber-500 disabled:cursor-not-allowed disabled:opacity-55"
                onClick={() => selectService(service.id)}
              >
                <div className="flex items-center justify-between gap-4">
                  <span className="font-semibold">
                    {serviceLabel(service.serviceType)}
                  </span>
                  <Badge variant="secondary">{service.availability}</Badge>
                </div>
                <p className="mt-3 text-lg font-bold">
                  {formatPrice(service.price, service.currency)}
                </p>
              </button>
            ))}
          </CardContent>
        </Card>
      </div>
    )
  }

  const attributionLabel =
    listing.attribution?.label ??
    (listing.fulfillmentType === "INTERNAL"
      ? "GuestPost.cc Operations"
      : (listing.publisher?.name ?? "Publisher"))

  return (
    <div className="mx-auto max-w-7xl pb-12">
      <div className="relative mb-7 overflow-hidden rounded-2xl border bg-[radial-gradient(circle_at_top_right,hsl(var(--primary)/0.13),transparent_42%),linear-gradient(135deg,hsl(var(--card)),hsl(var(--muted)/0.55))] px-5 py-6 sm:px-8">
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <Button variant="ghost" size="sm" className="-ml-3 mb-3" asChild>
              <Link href={`/dashboard/marketplace/${listing.slug}`}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to listing
              </Link>
            </Button>
            <Badge className="mb-3" variant="secondary">
              Secure order workspace
            </Badge>
            <h1 className="max-w-3xl text-2xl font-bold tracking-tight sm:text-3xl">
              Turn your placement into a clear fulfillment contract
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
              Define the link, editorial direction, and article responsibility.
              You will review payment separately before fulfillment begins.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center text-xs">
            {[
              ["1", "Brief"],
              ["2", "Review"],
              ["3", "Payment"],
            ].map(([number, label], index) => (
              <div
                key={number}
                className={`rounded-lg border px-3 py-2 ${
                  index === 0
                    ? "border-primary bg-primary/10"
                    : "bg-background/70"
                }`}
              >
                <span className="block font-bold">{number}</span>
                <span className="text-muted-foreground">{label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <main className="space-y-6">
          <Card>
            <CardHeader>
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-sky-100 p-2 text-sky-700">
                  <FileCheck2 className="h-5 w-5" />
                </div>
                <div>
                  <CardTitle className="text-lg">Placement brief</CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">
                    These structured fields become the canonical instructions
                    visible to the fulfiller and order history.
                  </p>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <BriefForm
                serviceType={selectedService.serviceType as any}
                value={briefData}
                onChange={setBriefData}
              />
            </CardContent>
          </Card>

          {canSupplyArticle && (
            <Card>
              <CardHeader>
                <div className="flex items-start gap-3">
                  <div className="rounded-lg bg-amber-100 p-2 text-amber-800">
                    <BookOpen className="h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">
                      Who supplies the article?
                    </CardTitle>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Your source article is stored separately from the
                      publisher or Operations final submission.
                    </p>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="grid gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    aria-pressed={articleMode === "FULFILLER"}
                    className={`rounded-xl border p-4 text-left transition ${
                      articleMode === "FULFILLER"
                        ? "border-primary bg-primary/5 ring-1 ring-primary"
                        : "hover:border-primary/50"
                    }`}
                    onClick={() => setArticleMode("FULFILLER")}
                  >
                    <FileText className="mb-3 h-5 w-5" />
                    <span className="block font-semibold">
                      Fulfiller writes it
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      The publisher or Operations prepares content from your
                      brief.
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-pressed={articleMode === "CUSTOMER"}
                    className={`rounded-xl border p-4 text-left transition ${
                      articleMode === "CUSTOMER"
                        ? "border-primary bg-primary/5 ring-1 ring-primary"
                        : "hover:border-primary/50"
                    }`}
                    onClick={() => setArticleMode("CUSTOMER")}
                  >
                    <BookOpen className="mb-3 h-5 w-5" />
                    <span className="block font-semibold">
                      I am supplying it
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      Submit a source article now for placement and editorial
                      review.
                    </span>
                  </button>
                </div>

                {articleMode === "CUSTOMER" && (
                  <div className="space-y-4 rounded-xl border bg-muted/25 p-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="article-title">Article title</Label>
                      <Input
                        id="article-title"
                        maxLength={200}
                        value={articleTitle}
                        placeholder="Optional working title"
                        onChange={(event) =>
                          setArticleTitle(event.target.value)
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between gap-3">
                        <Label htmlFor="article-body">Article body</Label>
                        <span className="text-xs text-muted-foreground">
                          {articleWordCount.toLocaleString()} words
                        </span>
                      </div>
                      <Textarea
                        id="article-body"
                        required
                        rows={16}
                        maxLength={200_000}
                        value={articleBody}
                        placeholder="Paste plain text or Markdown. Scripts and embedded HTML are not executed."
                        onChange={(event) => setArticleBody(event.target.value)}
                      />
                      <div className="flex justify-between gap-4 text-xs text-muted-foreground">
                        <span>
                          Stored as an immutable customer source version.
                        </span>
                        <span>
                          {articleBody.length.toLocaleString()}/200,000
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Campaign organization</CardTitle>
              <p className="text-sm text-muted-foreground">
                Optional. Campaign access is revalidated against your
                organization when the order is created.
              </p>
            </CardHeader>
            <CardContent>
              {!campaigns || campaigns.length === 0 ? (
                <div className="rounded-xl border border-dashed p-5 text-center">
                  <p className="text-sm text-muted-foreground">
                    No campaigns yet. You can place this order without one.
                  </p>
                  <Button variant="outline" className="mt-4" asChild>
                    <Link href="/dashboard/campaigns">Create campaign</Link>
                  </Button>
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {campaigns.map((campaign: any) => {
                    const selected = campaignId === campaign.id
                    return (
                      <button
                        key={campaign.id}
                        type="button"
                        aria-pressed={selected}
                        className={`rounded-xl border p-4 text-left transition ${
                          selected
                            ? "border-primary bg-primary/5"
                            : "hover:border-primary/50"
                        }`}
                        onClick={() =>
                          setCampaignId(selected ? null : campaign.id)
                        }
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm font-semibold">
                            {campaign.name}
                          </span>
                          {selected && (
                            <span className="rounded-full bg-primary p-1 text-primary-foreground">
                              <Check className="h-3 w-3" />
                            </span>
                          )}
                        </div>
                        {campaign.status && (
                          <Badge
                            variant="secondary"
                            className="mt-2 capitalize"
                          >
                            {String(campaign.status).toLowerCase()}
                          </Badge>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </main>

        <aside className="space-y-4 lg:sticky lg:top-6">
          <Card className="overflow-hidden">
            <div className="h-2 bg-gradient-to-r from-sky-500 via-teal-400 to-amber-400" />
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <Badge variant="secondary">
                  {serviceLabel(selectedService.serviceType)}
                </Badge>
                <Badge
                  variant={isOrderable ? "default" : "secondary"}
                  className="capitalize"
                >
                  {selectedService.availability.toLowerCase()}
                </Badge>
              </div>
              <CardTitle className="pt-2 text-xl">{listing.title}</CardTitle>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Globe className="h-4 w-4 shrink-0" />
                {listing.websiteAccess?.unlocked && listing.websiteUrl ? (
                  <span className="truncate">{listing.websiteUrl}</span>
                ) : (
                  <span className="flex items-center gap-1.5">
                    <Lock className="h-3.5 w-3.5" />
                    Website locked until your first successful deposit
                  </span>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-lg bg-muted p-3">
                  <Clock3 className="mb-2 h-4 w-4 text-muted-foreground" />
                  <span className="block text-xs text-muted-foreground">
                    Turnaround
                  </span>
                  <strong>{selectedService.turnaroundDays} days</strong>
                </div>
                <div className="rounded-lg bg-muted p-3">
                  <RefreshCw className="mb-2 h-4 w-4 text-muted-foreground" />
                  <span className="block text-xs text-muted-foreground">
                    Revisions
                  </span>
                  <strong>{selectedService.revisionRounds}</strong>
                </div>
              </div>

              <div className="space-y-2 border-t pt-4 text-sm">
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Fulfilled by</span>
                  <span className="text-right font-medium">
                    {attributionLabel}
                  </span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Warranty</span>
                  <span className="font-medium">
                    {selectedService.warrantyDays
                      ? `${selectedService.warrantyDays} days`
                      : "Not included"}
                  </span>
                </div>
              </div>

              {requirements.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-sm dark:bg-amber-950/20">
                  <p className="font-semibold text-amber-950 dark:text-amber-100">
                    Service requirements
                  </p>
                  <ul className="mt-2 space-y-1.5 text-amber-900 dark:text-amber-200">
                    {requirements.map((requirement) => (
                      <li key={requirement} className="flex gap-2">
                        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>{requirement}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="border-t pt-4">
                <div className="flex items-end justify-between gap-4">
                  <div>
                    <span className="text-sm text-muted-foreground">
                      Order total
                    </span>
                    <p className="text-xs text-muted-foreground">
                      Payment is reviewed next
                    </p>
                  </div>
                  <strong className="text-2xl tracking-tight">
                    {formatPrice(
                      selectedService.price,
                      selectedService.currency,
                    )}
                  </strong>
                </div>
              </div>

              {formError && (
                <div
                  role="alert"
                  className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{formError}</span>
                </div>
              )}

              <Button
                className="w-full"
                size="lg"
                onClick={handleSubmit}
                disabled={createMutation.isPending || !isOrderable}
              >
                {createMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Securing order...
                  </>
                ) : (
                  <>
                    <Send className="mr-2 h-4 w-4" />
                    Review and create order
                  </>
                )}
              </Button>
              {!isOrderable && (
                <p className="text-center text-xs text-muted-foreground">
                  This service cannot be ordered until availability changes.
                </p>
              )}
            </CardContent>
          </Card>

          <div className="flex gap-3 rounded-xl border bg-card p-4 text-sm">
            <ShieldCheck className="h-5 w-5 shrink-0 text-emerald-600" />
            <div>
              <p className="font-semibold">Protected order creation</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Website access, price, currency, campaign ownership, and brief
                fields are revalidated by the server. Retries reuse one
                idempotency key to prevent duplicate orders.
              </p>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
