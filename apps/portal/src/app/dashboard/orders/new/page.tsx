"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../../../lib/api"
import { Button } from "@guestpost/ui"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@guestpost/ui"
import { Input } from "@guestpost/ui"
import { Label } from "@guestpost/ui"
import { Textarea } from "@guestpost/ui"
import { Badge } from "@guestpost/ui"
import { Skeleton, ErrorState } from "@guestpost/ui"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@guestpost/ui"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@guestpost/ui"
import {
  ChevronLeft,
  ChevronRight,
  Check,
  Loader2,
  Search,
  Globe,
  Star,
  DollarSign,
  FileText,
  Send,
  ArrowLeft,
} from "lucide-react"
import { useForm, Controller } from "react-hook-form"
import { z } from "zod"
import { zodResolver } from "@hookform/resolvers/zod"
import { toast } from "sonner"
import Link from "next/link"
import { format } from "date-fns"

const STORAGE_KEY = "guestpost-order-draft"

const serviceTypes = [
  {
    id: "GUEST_POST",
    name: "Guest Post",
    description: "High-quality guest post with contextual link",
    icon: FileText,
    priceRange: "$50 - $500+",
  },
  {
    id: "NICHE_EDIT",
    name: "Niche Edit",
    description: "Insert your link into existing high-authority content",
    icon: Globe,
    priceRange: "$30 - $300+",
  },
  {
    id: "EDITORIAL_LINK",
    name: "Editorial Link",
    description: "Permanent contextual link from editorial content",
    icon: Star,
    priceRange: "$100 - $1000+",
  },
]

const orderSchema = z.object({
  serviceType: z.string().min(1, "Please select a service type"),
  websiteId: z.string().min(1, "Please select a website"),
  campaignId: z.string().min(1, "Please select a campaign"),
  title: z.string().min(3, "Title must be at least 3 characters").max(100),
  brief: z.string().min(20, "Brief must be at least 20 characters").max(2000),
  targetKeywords: z.string().min(1, "Please add at least one target keyword"),
  targetUrl: z.string().url("Please enter a valid URL").or(z.literal("")),
  // Display-only: the selected site + its auto-derived fulfiller (for review).
  placementName: z.string().optional(),
  placementUrl: z.string().optional(),
  placementPrice: z.number().optional(),
  fulfilledByLabel: z.string().optional(),
})

type OrderFormData = z.infer<typeof orderSchema>

interface Placement {
  websiteId: string
  listingSlug: string
  name: string
  websiteUrl: string
  price: number
  currency: string
  domainRating: number
  traffic: number
  category?: string
  language?: string
  country?: string
  turnaroundDays?: number
  fulfilledBy: { kind: "PLATFORM" | "PUBLISHER"; name: string }
}

interface DraftData {
  step: number
  data: Partial<OrderFormData>
  savedAt: string
}

const STEPS = [
  { number: 1, title: "Service", description: "Select your service type" },
  { number: 2, title: "Website", description: "Choose a website" },
  { number: 3, title: "Content", description: "Content requirements" },
  { number: 4, title: "Review", description: "Review your order" },
  { number: 5, title: "Submit", description: "Confirmation" },
]

function StepIndicator({ currentStep }: { currentStep: number }) {
  return (
    <div className="flex items-center justify-center mb-8">
      {STEPS.map((step, index) => (
        <div key={step.number} className="flex items-center">
          <div className="flex flex-col items-center">
            <div
              className={`flex h-10 w-10 items-center justify-center rounded-full border-2 transition-all ${
                currentStep > step.number
                  ? "border-primary bg-primary text-primary-foreground"
                  : currentStep === step.number
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-muted bg-muted text-muted-foreground"
              }`}
            >
              {currentStep > step.number ? (
                <Check className="h-5 w-5" />
              ) : (
                <span className="text-sm font-semibold">{step.number}</span>
              )}
            </div>
            <span className={`mt-2 text-xs font-medium ${currentStep >= step.number ? "text-foreground" : "text-muted-foreground"}`}>
              {step.title}
            </span>
          </div>
          {index < STEPS.length - 1 && (
            <div
              className={`mx-2 h-0.5 w-12 transition-all ${
                currentStep > step.number ? "bg-primary" : "bg-muted"
              }`}
            />
          )}
        </div>
      ))}
    </div>
  )
}

function ServiceSelection({
  selected,
  onSelect,
}: {
  selected: string
  onSelect: (id: string) => void
}) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Select Service Type</h2>
        <p className="text-muted-foreground">Choose the type of link building service you need</p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {serviceTypes.map((service) => {
          const Icon = service.icon
          const isSelected = selected === service.id
          return (
            <Card
              key={service.id}
              className={`cursor-pointer transition-all hover:border-primary/50 ${
                isSelected ? "border-primary bg-primary/5" : ""
              }`}
              onClick={() => onSelect(service.id)}
            >
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                    <Icon className="h-5 w-5 text-primary" />
                  </div>
                  {isSelected && (
                    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary">
                      <Check className="h-4 w-4 text-primary-foreground" />
                    </div>
                  )}
                </div>
                <CardTitle className="mt-4 text-base">{service.name}</CardTitle>
                <CardDescription className="line-clamp-2">{service.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-1 text-sm text-muted-foreground">
                  <DollarSign className="h-4 w-4" />
                  {service.priceRange}
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {!selected && (
        <p className="text-sm text-muted-foreground text-center">
          Select a service type to continue
        </p>
      )}
    </div>
  )
}

function WebsiteSelection({
  selected,
  onSelect,
  serviceType,
}: {
  selected: string
  onSelect: (p: Placement) => void
  serviceType: string
}) {
  const [search, setSearch] = useState("")
  const [categoryFilter, setCategoryFilter] = useState("all")
  const [page, setPage] = useState(0)
  const pageSize = 6

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["placements", search, categoryFilter],
    queryFn: () => api.marketplace.searchPlacements({
      search: search || undefined,
      category: categoryFilter !== "all" ? categoryFilter : undefined,
    }) as Promise<Placement[]>,
  })

  if (error) {
    return <ErrorState title="Failed to load websites" description={(error as Error).message} onRetry={() => refetch()} />
  }

  const placements = data ?? []
  const totalPages = Math.ceil(placements.length / pageSize)
  const paginated = placements.slice(page * pageSize, (page + 1) * pageSize)

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Select a Website</h2>
        <p className="text-muted-foreground">
          Pick where your {serviceType.replace(/_/g, " ").toLowerCase()} goes. The fulfiller is set automatically from the site.
        </p>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search websites..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Category" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            <SelectItem value="technology">Technology</SelectItem>
            <SelectItem value="business">Business</SelectItem>
            <SelectItem value="finance">Finance</SelectItem>
            <SelectItem value="health">Health</SelectItem>
            <SelectItem value="lifestyle">Lifestyle</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[...Array(6)].map((_, i) => (
            <Card key={i}><CardHeader className="pb-2"><Skeleton className="h-5 w-32" /></CardHeader><CardContent><Skeleton className="h-4 w-full" /></CardContent></Card>
          ))}
        </div>
      ) : placements.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12">
          <Globe className="h-12 w-12 text-muted-foreground/50" />
          <h3 className="mt-4 text-lg font-medium">No websites found</h3>
          <p className="mt-1 text-sm text-muted-foreground">Try adjusting your search or filters</p>
        </div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {paginated.map((p) => {
              const isSelected = selected === p.websiteId
              const platform = p.fulfilledBy.kind === "PLATFORM"
              return (
                <Card
                  key={p.websiteId}
                  className={`cursor-pointer transition-all hover:border-primary/50 ${isSelected ? "border-primary bg-primary/5" : ""}`}
                  onClick={() => onSelect(p)}
                >
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted"><Globe className="h-5 w-5" /></div>
                      {isSelected && (
                        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary"><Check className="h-4 w-4 text-primary-foreground" /></div>
                      )}
                    </div>
                    <CardTitle className="mt-3 text-base">{p.name}</CardTitle>
                    <p className="truncate text-xs text-muted-foreground">{p.websiteUrl}</p>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-lg font-semibold">{p.currency} {p.price.toLocaleString()}</span>
                      <Badge variant="secondary">DR {p.domainRating}</Badge>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {p.traffic > 0 && <span>{p.traffic.toLocaleString()} traffic</span>}
                      {p.turnaroundDays ? <span>· {p.turnaroundDays}d turnaround</span> : null}
                    </div>
                    {/* Auto-derived fulfiller — never chosen by hand */}
                    <Badge className={platform ? "bg-indigo-100 text-indigo-700" : "bg-emerald-100 text-emerald-700"}>
                      {platform ? "Fulfilled by Platform" : `Fulfilled by ${p.fulfilledBy.name}`}
                    </Badge>
                  </CardContent>
                </Card>
              )
            })}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}><ChevronLeft className="h-4 w-4" /></Button>
              <span className="text-sm text-muted-foreground">Page {page + 1} of {totalPages}</span>
              <Button variant="outline" size="sm" onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}><ChevronRight className="h-4 w-4" /></Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ContentRequirements({ data, onUpdate }: { data: Partial<OrderFormData>; onUpdate: (data: Partial<OrderFormData>) => void }) {
  const { register, formState: { errors } } = useForm({
    defaultValues: {
      title: data.title || "",
      brief: data.brief || "",
      targetKeywords: data.targetKeywords || "",
      targetUrl: data.targetUrl || "",
    },
  })

  const updateField = (field: keyof OrderFormData, value: string) => {
    onUpdate({ ...data, [field]: value })
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Content Requirements</h2>
        <p className="text-muted-foreground">Provide details about your content needs</p>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="title">Article Title *</Label>
          <Input
            id="title"
            {...register("title")}
            onChange={(e) => updateField("title", e.target.value)}
            placeholder="e.g., The Ultimate Guide to SEO in 2024"
          />
          {errors.title && (
            <p className="text-sm text-destructive">{errors.title.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="brief">Content Brief *</Label>
          <Textarea
            id="brief"
            rows={6}
            {...register("brief")}
            onChange={(e) => updateField("brief", e.target.value)}
            placeholder="Describe the content you need. Include key points, tone, style, and any specific requirements..."
          />
          {errors.brief && (
            <p className="text-sm text-destructive">{errors.brief.message}</p>
          )}
          <p className="text-xs text-muted-foreground">
            {(data.brief || "").length} / 2000 characters
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="targetKeywords">Target Keywords *</Label>
          <Input
            id="targetKeywords"
            {...register("targetKeywords")}
            onChange={(e) => updateField("targetKeywords", e.target.value)}
            placeholder="e.g., best CRM software, CRM comparison, sales tools"
          />
          <p className="text-xs text-muted-foreground">
            Separate multiple keywords with commas
          </p>
          {errors.targetKeywords && (
            <p className="text-sm text-destructive">{errors.targetKeywords.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="targetUrl">Target URL</Label>
          <Input
            id="targetUrl"
            {...register("targetUrl")}
            onChange={(e) => updateField("targetUrl", e.target.value)}
            placeholder="https://yoursite.com/landing-page"
          />
          <p className="text-xs text-muted-foreground">
            The page on your website you want the link to point to
          </p>
          {errors.targetUrl && (
            <p className="text-sm text-destructive">{errors.targetUrl.message}</p>
          )}
        </div>
      </div>
    </div>
  )
}

function ReviewStep({ data }: { data: Partial<OrderFormData> }) {
  const { data: campaignsData, error: campaignsError, refetch: refetchCampaigns } = useQuery({
    queryKey: ["campaigns"],
    queryFn: () => api.campaigns.listCampaigns() as Promise<any[]>,
  })

  if (campaignsError) {
    return <ErrorState title="Failed to load campaigns" description={(campaignsError as Error).message} onRetry={() => refetchCampaigns()} />
  }

  const campaign = campaignsData?.find((c: any) => c.id === data.campaignId)

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Review Your Order</h2>
        <p className="text-muted-foreground">Please review all details before submitting</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Order Summary</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Service Type</p>
              <p className="font-medium">{data.serviceType?.replace(/_/g, " ")}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Campaign</p>
              <p className="font-medium">{campaign?.name ?? "—"}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Website</p>
              <p className="font-medium">{data.placementName ?? "—"}</p>
              {data.placementUrl && <p className="text-xs text-muted-foreground">{data.placementUrl}</p>}
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Fulfilled by</p>
              <p className="font-medium">{data.fulfilledByLabel ?? "—"}</p>
              {data.placementPrice != null && <p className="text-xs text-muted-foreground">Price: ${data.placementPrice.toLocaleString()}</p>}
            </div>
          </div>

          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">Article Title</p>
            <p className="font-medium">{data.title || "—"}</p>
          </div>

          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">Content Brief</p>
            <p className="text-sm whitespace-pre-wrap">{data.brief || "—"}</p>
          </div>

          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">Target Keywords</p>
            <div className="flex flex-wrap gap-2">
              {data.targetKeywords?.split(",").map((kw, i) => (
                <Badge key={i} variant="secondary">
                  {kw.trim()}
                </Badge>
              ))}
            </div>
          </div>

          {data.targetUrl && (
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Target URL</p>
              <p className="text-sm font-mono">{data.targetUrl}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="pt-6">
          <div className="flex items-center gap-2 text-sm text-primary">
            <FileText className="h-4 w-4" />
            <span>Your order will be reviewed and confirmed within 24 hours</span>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function SubmitStep({ data, isSubmitting, onSubmit }: { data: Partial<OrderFormData>; isSubmitting: boolean; onSubmit: () => void }) {
  return (
    <div className="space-y-6">
      <div className="text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
          <Send className="h-8 w-8 text-primary" />
        </div>
        <h2 className="mt-4 text-xl font-semibold">Submit Your Order</h2>
        <p className="mt-2 text-muted-foreground">
          Ready to submit your order? Click below to place your order.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="space-y-2 text-sm">
            <p className="text-muted-foreground">By submitting this order, you agree to our:</p>
            <ul className="list-inside list-disc space-y-1 text-muted-foreground">
              <li>Terms of Service</li>
              <li>Content Guidelines</li>
              <li>Revision Policy</li>
            </ul>
          </div>
        </CardContent>
      </Card>

      <Button
        className="w-full"
        size="lg"
        onClick={onSubmit}
        disabled={isSubmitting}
      >
        {isSubmitting ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Submitting...
          </>
        ) : (
          <>
            <Send className="mr-2 h-4 w-4" />
            Submit Order
          </>
        )}
      </Button>
    </div>
  )
}

export default function NewOrderPage() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [currentStep, setCurrentStep] = useState(1)
  const [formData, setFormData] = useState<Partial<OrderFormData>>({})
  const [submitSuccess, setSubmitSuccess] = useState(false)
  const [submitError, setSubmitError] = useState("")

  const { data: campaignsData, error: campaignsError, refetch: refetchCampaigns } = useQuery({
    queryKey: ["campaigns"],
    queryFn: () => api.campaigns.listCampaigns(),
  })

  const createMutation = useMutation({
    mutationFn: (data: any) => api.orders.create(data),
    onSuccess: (order: any) => {
      toast.success("Order created — complete payment to start fulfillment")
      queryClient.invalidateQueries({ queryKey: ["orders"] })
      localStorage.removeItem(STORAGE_KEY)
      // Draft orders only start fulfillment after payment — go straight to checkout.
      if (order?.id) {
        router.push(`/dashboard/orders/checkout/${order.id}`)
      } else {
        setSubmitSuccess(true)
      }
    },
    onError: (error: any) => {
      toast.error(error?.message || "Failed to create order")
      setSubmitError(error?.message || "Something went wrong")
    },
  })

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      try {
        const draft: DraftData = JSON.parse(saved)
        if (draft.data && Date.now() - new Date(draft.savedAt).getTime() < 24 * 60 * 60 * 1000) {
          setFormData(draft.data)
          setCurrentStep(draft.step)
        }
      } catch (e) {
        // Ignore invalid draft
      }
    }
  }, [])

  useEffect(() => {
    if (currentStep < 5) {
      const draft: DraftData = {
        step: currentStep,
        data: formData,
        savedAt: new Date().toISOString(),
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(draft))
    }
  }, [currentStep, formData])

  // Prefill when arriving from a marketplace listing's "Order Now" — the site +
  // its auto-derived fulfiller are carried in the query string. Reading
  // location avoids the useSearchParams Suspense requirement.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search)
    const websiteId = sp.get("websiteId")
    if (!websiteId) return
    setFormData((prev) => ({
      ...prev,
      websiteId,
      serviceType: sp.get("type") || prev.serviceType,
      placementName: sp.get("name") || prev.placementName,
      placementUrl: sp.get("url") || prev.placementUrl,
      placementPrice: sp.get("price") ? Number(sp.get("price")) : prev.placementPrice,
      fulfilledByLabel: sp.get("fulfilledBy") || prev.fulfilledByLabel,
    }))
    setCurrentStep((s) => (s < 2 ? 2 : s))
  }, [])

  const updateFormData = (data: Partial<OrderFormData>) => {
    setFormData((prev) => ({ ...prev, ...data }))
  }

  const canProceed = () => {
    switch (currentStep) {
      case 1:
        return !!formData.serviceType
      case 2:
        return !!formData.websiteId
      case 3:
        return !!formData.title && !!formData.brief && !!formData.targetKeywords
      case 4:
        return !!formData.campaignId
      default:
        return true
    }
  }

  const handleNext = () => {
    if (canProceed() && currentStep < 5) {
      setCurrentStep((s) => s + 1)
    }
  }

  const handleBack = () => {
    if (currentStep > 1) {
      setCurrentStep((s) => s - 1)
    }
  }

  const handleSubmit = async () => {
    if (!formData.campaignId) {
      toast.error("Please select a campaign")
      return
    }

    // Shape mirrors CreateOrderDto: service type/title/brief live on the
    // order; items carry only website + link targeting. Keywords are folded
    // into instructions so the publisher sees them.
    createMutation.mutate({
      type: formData.serviceType as any,
      title: formData.title,
      instructions: [formData.brief, formData.targetKeywords ? `Target keywords: ${formData.targetKeywords}` : ""]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 5000),
      campaignId: formData.campaignId,
      items: [{
        websiteId: formData.websiteId || undefined,
        targetUrl: formData.targetUrl || undefined,
      }],
    })
  }

  if (campaignsError) {
    return <ErrorState title="Failed to load campaigns" description={(campaignsError as Error).message} onRetry={() => refetchCampaigns()} />
  }

  if (submitSuccess) {
    return (
      <div className="mx-auto max-w-md py-12 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
          <Check className="h-8 w-8 text-green-600" />
        </div>
        <h2 className="mt-4 text-2xl font-semibold">Order Submitted!</h2>
        <p className="mt-2 text-muted-foreground">
          Your order has been submitted successfully. You&apos;ll receive a confirmation email shortly.
        </p>
        <div className="mt-6 flex flex-col gap-3">
          <Button onClick={() => router.push("/dashboard/orders")}>
            View My Orders
          </Button>
          <Button variant="outline" onClick={() => router.push("/dashboard")}>
            Back to Dashboard
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/dashboard/orders">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Orders
          </Link>
        </Button>
      </div>

      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">New Order</h1>
        <p className="text-muted-foreground">Create a new guest post order</p>
      </div>

      <StepIndicator currentStep={currentStep} />

      <Card>
        <CardContent className="pt-6">
          {currentStep === 1 && (
            <ServiceSelection
              selected={formData.serviceType || ""}
              onSelect={(id) => updateFormData({ serviceType: id })}
            />
          )}

          {currentStep === 2 && (
            <WebsiteSelection
              selected={formData.websiteId || ""}
              onSelect={(p) => updateFormData({
                websiteId: p.websiteId,
                placementName: p.name,
                placementUrl: p.websiteUrl,
                placementPrice: p.price,
                fulfilledByLabel: p.fulfilledBy.kind === "PLATFORM" ? "Platform" : p.fulfilledBy.name,
              })}
              serviceType={formData.serviceType || ""}
            />
          )}

          {currentStep === 3 && (
            <ContentRequirements
              data={formData}
              onUpdate={updateFormData}
            />
          )}

          {currentStep === 4 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-semibold">Select Campaign</h2>
                <p className="text-muted-foreground">Choose which campaign to add this order to</p>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                {campaignsData?.map((campaign: any) => (
                  <Card
                    key={campaign.id}
                    className={`cursor-pointer transition-all hover:border-primary/50 ${
                      formData.campaignId === campaign.id ? "border-primary bg-primary/5" : ""
                    }`}
                    onClick={() => updateFormData({ campaignId: campaign.id })}
                  >
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-base">{campaign.name}</CardTitle>
                        {formData.campaignId === campaign.id && (
                          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary">
                            <Check className="h-4 w-4 text-primary-foreground" />
                          </div>
                        )}
                      </div>
                    </CardHeader>
                    <CardContent>
                      <Badge variant="secondary" className="capitalize">
                        {campaign.status?.toLowerCase() ?? "active"}
                      </Badge>
                    </CardContent>
                  </Card>
                ))}

                {(!campaignsData || campaignsData.length === 0) && (
                  <Card className="col-span-2">
                    <CardContent className="flex flex-col items-center justify-center py-8">
                      <p className="text-muted-foreground">No campaigns yet</p>
                      <Button
                        variant="outline"
                        className="mt-4"
                        onClick={() => router.push("/dashboard/campaigns")}
                      >
                        Create Campaign
                      </Button>
                    </CardContent>
                  </Card>
                )}
              </div>

              <ReviewStep data={formData} />
            </div>
          )}

          {currentStep === 5 && (
            <SubmitStep
              data={formData}
              isSubmitting={createMutation.isPending}
              onSubmit={handleSubmit}
            />
          )}
        </CardContent>
      </Card>

      {currentStep < 5 && (
        <div className="mt-6 flex justify-between">
          <Button
            variant="outline"
            onClick={handleBack}
            disabled={currentStep === 1}
          >
            <ChevronLeft className="mr-2 h-4 w-4" />
            Back
          </Button>

          {currentStep < 4 && (
            <Button onClick={handleNext} disabled={!canProceed()}>
              Continue
              <ChevronRight className="ml-2 h-4 w-4" />
            </Button>
          )}

          {currentStep === 4 && (
            <Button onClick={handleNext} disabled={!canProceed()}>
              Continue to Submit
              <ChevronRight className="ml-2 h-4 w-4" />
            </Button>
          )}
        </div>
      )}
    </div>
  )
}