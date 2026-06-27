"use client"

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorState,
  Skeleton,
} from "@guestpost/ui"
import { useMutation, useQuery } from "@tanstack/react-query"
import {
  ArrowLeft,
  Check,
  DollarSign,
  Globe,
  Loader2,
  Send,
} from "lucide-react"
import Link from "next/link"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { BriefForm } from "../../../../../components/BriefForm"
import { api } from "../../../../../lib/api"

interface Listing {
  id: string
  title: string
  slug: string
  websiteUrl?: string
  websiteId?: string | null
  services?: Array<{
    id: string
    serviceType: string
    price: number
    currency: string
    turnaroundDays: number
    revisionRounds: number
    warrantyDays?: number | null
    availability: "AVAILABLE" | "PAUSED" | "WAITLIST"
  }>
  attribution?: { kind: "PUBLISHER" | "PLATFORM"; label: string }
  fulfillmentType?: string
  publisher?: { name: string }
}

function formatPrice(price: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(price)
}

export default function MarketplaceOrderPage() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const serviceId = searchParams?.get("service")

  const [briefData, setBriefData] = useState<Record<string, unknown>>({})
  const [campaignId, setCampaignId] = useState<string | null>(null)

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

  const services = listing?.services ?? []
  const selectedService = useMemo(
    () => services.find((s) => s.id === serviceId) ?? null,
    [services, serviceId],
  )

  const { data: campaigns } = useQuery({
    queryKey: ["campaigns"],
    queryFn: () => api.campaigns.listCampaigns() as Promise<any[]>,
  })

  const createMutation = useMutation({
    mutationFn: (data: any) => api.orders.create(data),
    onSuccess: (order: any) => {
      toast.success("Order created — complete payment to start fulfillment")
      if (order?.id) {
        router.push(`/dashboard/orders/checkout/${order.id}`)
      }
    },
    onError: (error: any) => {
      toast.error(error?.message || "Failed to create order")
    },
  })

  useEffect(() => {
    if (!serviceId && services.length > 0) {
      const first = services.find((s) => s.availability === "AVAILABLE")
      if (first && !selectedService) {
        const sp = new URLSearchParams(window.location.search)
        sp.set("service", first.id)
        router.replace(
          `/dashboard/marketplace/${params.slug}/order?${sp.toString()}`,
        )
      }
    }
  }, [serviceId, services, selectedService, params.slug, router])

  const handleSubmit = () => {
    if (!selectedService) {
      toast.error("No service selected")
      return
    }

    const derivedTitle =
      String(briefData.title ?? briefData.topic ?? "").slice(0, 100) ||
      "Untitled"
    const derivedTargetUrl = (briefData.targetUrl as string) ?? ""
    const derivedKeywords = Array.isArray(briefData.targetKeywords)
      ? (briefData.targetKeywords as string[]).join(", ")
      : ""
    const brief =
      typeof briefData.topic === "string"
        ? briefData.topic
        : typeof briefData.notes === "string"
          ? briefData.notes
          : ""

    createMutation.mutate({
      type: selectedService.serviceType as any,
      title: derivedTitle,
      instructions: [
        brief,
        derivedKeywords ? `Target keywords: ${derivedKeywords}` : "",
      ]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 5000),
      campaignId: campaignId || undefined,
      listingServiceId: selectedService.id,
      briefData,
      items: [
        {
          websiteId: listing?.websiteId || undefined,
          targetUrl: derivedTargetUrl || undefined,
        },
      ],
    })
  }

  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl space-y-6 py-8">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40" />
        <Skeleton className="h-64" />
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
      <div className="mx-auto max-w-3xl py-12 text-center">
        <h2 className="text-xl font-semibold">Select a service first</h2>
        <p className="mt-2 text-muted-foreground">
          Go back to the listing and choose a service to continue.
        </p>
        <Button className="mt-6" asChild>
          <Link href={`/dashboard/marketplace/${listing.slug}`}>
            Back to Listing
          </Link>
        </Button>
      </div>
    )
  }

  const attributionLabel =
    listing.attribution?.label ??
    (listing.fulfillmentType === "INTERNAL"
      ? "Platform"
      : (listing.publisher?.name ?? "Publisher"))

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/dashboard/marketplace/${listing.slug}`}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Listing
          </Link>
        </Button>
      </div>

      <div className="space-y-6">
        {/* Order Summary */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Order Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="font-medium">{listing.title}</p>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Globe className="h-3.5 w-3.5" />
                  {listing.websiteUrl ?? "—"}
                </div>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="rounded-lg bg-muted p-3">
                <p className="text-xs text-muted-foreground">Service</p>
                <p className="mt-1 font-medium">
                  {selectedService.serviceType.replace(/_/g, " ")}
                </p>
              </div>
              <div className="rounded-lg bg-muted p-3">
                <p className="text-xs text-muted-foreground">Turnaround</p>
                <p className="mt-1 font-medium">
                  {selectedService.turnaroundDays} days
                </p>
              </div>
              <div className="rounded-lg bg-muted p-3">
                <p className="text-xs text-muted-foreground">Price</p>
                <p className="mt-1 font-medium">
                  {formatPrice(selectedService.price, selectedService.currency)}
                </p>
              </div>
            </div>
            {selectedService.revisionRounds > 0 && (
              <p className="text-sm text-muted-foreground">
                Includes {selectedService.revisionRounds} revision
                {selectedService.revisionRounds > 1 ? "s" : ""}
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              Fulfilled by {attributionLabel}
            </p>
          </CardContent>
        </Card>

        {/* Content Brief */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Content Brief</CardTitle>
          </CardHeader>
          <CardContent>
            <BriefForm
              serviceType={selectedService.serviceType as any}
              value={briefData}
              onChange={setBriefData}
            />
          </CardContent>
        </Card>

        {/* Campaign */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Campaign</CardTitle>
          </CardHeader>
          <CardContent>
            {!campaigns || campaigns.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-4">
                <p className="text-sm text-muted-foreground">
                  No campaigns yet
                </p>
                <Button
                  variant="outline"
                  className="mt-4"
                  onClick={() => router.push("/dashboard/campaigns")}
                >
                  Create Campaign
                </Button>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {campaigns.map((campaign: any) => {
                  const isSelected = campaignId === campaign.id
                  return (
                    <button
                      key={campaign.id}
                      type="button"
                      className={`w-full text-left rounded-lg border p-4 transition-colors ${
                        isSelected
                          ? "border-primary bg-primary/5"
                          : "border-border hover:border-primary/50"
                      }`}
                      onClick={() =>
                        setCampaignId(isSelected ? null : campaign.id)
                      }
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-sm">
                          {campaign.name}
                        </span>
                        {isSelected && (
                          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-primary">
                            <Check className="h-3 w-3 text-primary-foreground" />
                          </div>
                        )}
                      </div>
                      {campaign.status && (
                        <Badge variant="secondary" className="mt-2 capitalize">
                          {campaign.status.toLowerCase()}
                        </Badge>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
            {!campaignId && (
              <p className="mt-3 text-xs text-muted-foreground">
                Optional — your order will not be linked to a campaign
              </p>
            )}
          </CardContent>
        </Card>

        {/* Pricing Summary */}
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="flex items-center justify-between py-4">
            <div className="flex items-center gap-2">
              <DollarSign className="h-5 w-5 text-primary" />
              <span className="font-medium">Total</span>
            </div>
            <span className="text-xl font-bold">
              {formatPrice(selectedService.price, selectedService.currency)}
            </span>
          </CardContent>
        </Card>

        {/* Submit */}
        <Button
          className="w-full"
          size="lg"
          onClick={handleSubmit}
          disabled={createMutation.isPending}
        >
          {createMutation.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Placing Order...
            </>
          ) : (
            <>
              <Send className="mr-2 h-4 w-4" />
              Place Order
            </>
          )}
        </Button>
      </div>
    </div>
  )
}
