"use client"

import type { Category } from "@guestpost/api-client"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea,
} from "@guestpost/ui"
import { zodResolver } from "@hookform/resolvers/zod"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Globe2,
  Layers3,
  ShieldCheck,
  Store,
} from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Controller, useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"
import { api } from "../../../../lib/api"
import { useAuth } from "../../../../lib/auth"

const SERVICE_TYPES = [
  ["GUEST_POST", "Guest post"],
  ["NICHE_EDIT", "Niche edit"],
  ["EDITORIAL_LINK", "Editorial link"],
  ["OUTREACH_LINK", "Outreach link"],
  ["LOCAL_CITATION", "Local citation"],
  ["FOUNDATION_LINK", "Foundation link"],
  ["BLOG_ARTICLE", "Blog article"],
  ["SEO_CONTENT", "SEO content"],
] as const

const COUNTRIES = [
  ["US", "United States"],
  ["UK", "United Kingdom"],
  ["CA", "Canada"],
  ["AU", "Australia"],
  ["DE", "Germany"],
  ["FR", "France"],
  ["IN", "India"],
  ["OTHER", "Other"],
] as const

const LANGUAGES = [
  "English",
  "Spanish",
  "French",
  "German",
  "Portuguese",
  "Dutch",
  "Other",
] as const

const optionalNumber = (minimum: number) =>
  z.preprocess(
    (value) => (value === "" || value == null ? undefined : value),
    z.coerce.number().min(minimum).optional(),
  )

const websiteSchema = z
  .object({
    url: z.string().url("Enter a complete URL, including https://"),
    country: z.string().min(1, "Country is required"),
    language: z.string().min(1, "Language is required"),
    domainRating: optionalNumber(0).refine(
      (value) => value == null || value <= 100,
      "Domain rating cannot exceed 100",
    ),
    monthlyTraffic: optionalNumber(0),
    listingTitle: z.string().trim().min(3).max(200),
    categoryId: z.string().min(1, "Choose a marketplace category"),
    description: z
      .string()
      .trim()
      .min(20, "Give buyers at least 20 characters of useful context")
      .max(500, "Description must be 500 characters or fewer"),
    addInitialService: z.boolean(),
    serviceType: z.string(),
    price: optionalNumber(0.01),
    turnaroundDays: z.coerce.number().int().min(1),
    revisionRounds: z.coerce.number().int().min(0),
    warrantyDays: optionalNumber(0),
  })
  .superRefine((value, context) => {
    if (value.addInitialService && value.price == null) {
      context.addIssue({
        code: "custom",
        path: ["price"],
        message: "Enter a price for the initial service",
      })
    }
  })

type WebsiteFormData = z.infer<typeof websiteSchema>

export default function NewWebsitePage() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const publisherId = user?.publisherId ?? "current"
  const categoriesQ = useQuery<Category[]>({
    queryKey: ["marketplace-categories"],
    queryFn: () => api.marketplace.getCategories(),
  })
  const {
    register,
    handleSubmit,
    control,
    watch,
    formState: { errors },
  } = useForm<WebsiteFormData>({
    resolver: zodResolver(websiteSchema),
    defaultValues: {
      country: "US",
      language: "English",
      listingTitle: "",
      categoryId: "",
      description: "",
      addInitialService: true,
      serviceType: "GUEST_POST",
      turnaroundDays: 7,
      revisionRounds: 2,
    },
  })
  const description = watch("description") ?? ""
  const addInitialService = watch("addInitialService")

  const addMutation = useMutation({
    mutationFn: (data: WebsiteFormData) =>
      api.publishers.addWebsite(publisherId, {
        url: data.url,
        country: data.country,
        language: data.language,
        categoryId: data.categoryId,
        listingTitle: data.listingTitle.trim(),
        description: data.description.trim(),
        domainRating: data.domainRating,
        monthlyTraffic: data.monthlyTraffic,
        initialService:
          data.addInitialService && data.price != null
            ? {
                serviceType: data.serviceType,
                price: data.price,
                currency: "USD",
                turnaroundDays: data.turnaroundDays,
                revisionRounds: data.revisionRounds,
                warrantyDays: data.warrantyDays,
              }
            : undefined,
      }),
    onSuccess: (website) => {
      queryClient.invalidateQueries({ queryKey: ["publisher-websites"] })
      queryClient.invalidateQueries({ queryKey: ["publisher-listings"] })
      toast.success("Website enlisted with its marketplace listing")
      router.push(`/dashboard/websites/${website.id}#marketplace`)
    },
    onError: (error: Error) =>
      toast.error(error.message || "Website could not be enlisted"),
  })

  return (
    <div className="mx-auto max-w-6xl space-y-7">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-3 mb-2">
          <Link href="/dashboard/websites">
            <ArrowLeft className="mr-2 h-4 w-4" /> Websites
          </Link>
        </Button>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-medium text-blue-600 dark:text-blue-400">
              Publisher inventory
            </p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight">
              Enlist a website
            </h1>
            <p className="mt-2 max-w-2xl text-muted-foreground">
              Add the domain and its single marketplace listing together. Then
              verify ownership and manage every service from the website page.
            </p>
          </div>
          <Badge className="w-fit border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-50 dark:border-blue-900 dark:bg-blue-950/50 dark:text-blue-300">
            Publisher managed
          </Badge>
        </div>
      </div>

      <form
        onSubmit={handleSubmit((data) => addMutation.mutate(data))}
        className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]"
      >
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Globe2 className="h-5 w-5 text-blue-600" /> Website identity
              </CardTitle>
              <CardDescription>
                The domain is globally unique and requires DNS ownership
                verification before marketplace review.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <Field label="Website URL" required error={errors.url?.message}>
                <Input
                  placeholder="https://example.com"
                  autoComplete="url"
                  {...register("url")}
                />
              </Field>
              <div className="grid gap-5 sm:grid-cols-2">
                <SelectField
                  label="Primary country"
                  name="country"
                  control={control}
                  options={COUNTRIES.map(([value, label]) => ({
                    value,
                    label,
                  }))}
                  error={errors.country?.message}
                />
                <SelectField
                  label="Primary language"
                  name="language"
                  control={control}
                  options={LANGUAGES.map((value) => ({ value, label: value }))}
                  error={errors.language?.message}
                />
              </div>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field
                  label="Domain rating"
                  hint="Optional · 0–100"
                  error={errors.domainRating?.message}
                >
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    placeholder="e.g. 52"
                    {...register("domainRating")}
                  />
                </Field>
                <Field
                  label="Monthly organic traffic"
                  hint="Optional estimate"
                  error={errors.monthlyTraffic?.message}
                >
                  <Input
                    type="number"
                    min={0}
                    placeholder="e.g. 25000"
                    {...register("monthlyTraffic")}
                  />
                </Field>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Store className="h-5 w-5 text-blue-600" /> Marketplace listing
              </CardTitle>
              <CardDescription>
                This buyer-facing information belongs to the domain&apos;s only
                listing and can be updated later.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <Field
                label="Listing title"
                required
                error={errors.listingTitle?.message}
              >
                <Input
                  placeholder="Technology guest posts on Example"
                  maxLength={200}
                  {...register("listingTitle")}
                />
              </Field>
              <div className="space-y-2.5">
                <Label>
                  Category <span className="text-destructive">*</span>
                </Label>
                {categoriesQ.isLoading ? (
                  <Skeleton className="h-10 w-full" />
                ) : categoriesQ.isError ? (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
                    Categories could not be loaded.{" "}
                    <button
                      type="button"
                      className="font-medium text-destructive underline"
                      onClick={() => categoriesQ.refetch()}
                    >
                      Try again
                    </button>
                  </div>
                ) : (
                  <Controller
                    name="categoryId"
                    control={control}
                    render={({ field }) => (
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Choose the closest category" />
                        </SelectTrigger>
                        <SelectContent>
                          {(categoriesQ.data ?? []).map((category) => (
                            <SelectItem key={category.id} value={category.id}>
                              {category.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                )}
                {errors.categoryId && (
                  <p className="text-xs text-destructive">
                    {errors.categoryId.message}
                  </p>
                )}
              </div>
              <div className="space-y-2.5">
                <div className="flex items-end justify-between gap-3">
                  <Label htmlFor="description">
                    Buyer description{" "}
                    <span className="text-destructive">*</span>
                  </Label>
                  <span
                    className={
                      "text-xs " +
                      (description.length > 450
                        ? "text-amber-600"
                        : "text-muted-foreground")
                    }
                  >
                    {description.length}/500
                  </span>
                </div>
                <Textarea
                  id="description"
                  rows={6}
                  maxLength={500}
                  placeholder="Explain the audience, editorial focus, content standards, and what makes this placement useful to buyers."
                  {...register("description")}
                />
                <p className="text-xs leading-5 text-muted-foreground">
                  Marketplace cards show the first two lines; buyers see the
                  complete description on the listing page.
                </p>
                {errors.description && (
                  <p className="text-xs text-destructive">
                    {errors.description.message}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Layers3 className="h-5 w-5 text-blue-600" /> First service
                  </CardTitle>
                  <CardDescription className="mt-1.5">
                    Add one orderable service now, or configure services from
                    the website page before review.
                  </CardDescription>
                </div>
                <Controller
                  name="addInitialService"
                  control={control}
                  render={({ field }) => (
                    <Checkbox
                      checked={field.value}
                      onCheckedChange={(value) =>
                        field.onChange(value === true)
                      }
                      aria-label="Add an initial service"
                    />
                  )}
                />
              </div>
            </CardHeader>
            {addInitialService && (
              <CardContent className="space-y-5">
                <SelectField
                  label="Service type"
                  name="serviceType"
                  control={control}
                  options={SERVICE_TYPES.map(([value, label]) => ({
                    value,
                    label,
                  }))}
                />
                <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
                  <Field
                    label="Price (USD)"
                    required
                    error={errors.price?.message}
                  >
                    <Input
                      type="number"
                      min={0.01}
                      step="0.01"
                      placeholder="150"
                      {...register("price")}
                    />
                  </Field>
                  <Field
                    label="Turnaround"
                    hint="Days"
                    error={errors.turnaroundDays?.message}
                  >
                    <Input
                      type="number"
                      min={1}
                      {...register("turnaroundDays")}
                    />
                  </Field>
                  <Field
                    label="Revisions"
                    hint="Included rounds"
                    error={errors.revisionRounds?.message}
                  >
                    <Input
                      type="number"
                      min={0}
                      {...register("revisionRounds")}
                    />
                  </Field>
                  <Field
                    label="Warranty"
                    hint="Optional days"
                    error={errors.warrantyDays?.message}
                  >
                    <Input
                      type="number"
                      min={0}
                      {...register("warrantyDays")}
                    />
                  </Field>
                </div>
              </CardContent>
            )}
          </Card>

          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" asChild>
              <Link href="/dashboard/websites">Cancel</Link>
            </Button>
            <Button
              type="submit"
              disabled={addMutation.isPending || categoriesQ.isError}
            >
              {addMutation.isPending ? "Enlisting website…" : "Enlist website"}
              {!addMutation.isPending && (
                <ArrowRight className="ml-2 h-4 w-4" />
              )}
            </Button>
          </div>
        </div>

        <aside className="sticky top-6 space-y-4">
          <Card className="border-blue-200 bg-blue-50/60 dark:border-blue-950 dark:bg-blue-950/20">
            <CardHeader>
              <CardTitle className="text-base">What happens next</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <ReadinessItem
                Icon={CheckCircle2}
                title="One site, one listing"
                description="The listing is created atomically with this website."
              />
              <ReadinessItem
                Icon={ShieldCheck}
                title="Verify domain ownership"
                description="Add the DNS TXT record from the website detail page."
              />
              <ReadinessItem
                Icon={Layers3}
                title="Complete services"
                description="At least one available service is required for review."
              />
              <ReadinessItem
                Icon={Store}
                title="Submit for moderation"
                description="GuestPost reviews the listing before buyers can see it."
              />
            </CardContent>
          </Card>
          <p className="px-1 text-xs leading-5 text-muted-foreground">
            Existing orders always keep the service terms captured at checkout,
            even when you update pricing later.
          </p>
        </aside>
      </form>
    </div>
  )
}

function Field({
  label,
  required,
  hint,
  error,
  children,
}: {
  label: string
  required?: boolean
  hint?: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <Label>
          {label} {required && <span className="text-destructive">*</span>}
        </Label>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

function SelectField({
  label,
  name,
  control,
  options,
  error,
}: {
  label: string
  name: "country" | "language" | "serviceType"
  control: any
  options: Array<{ value: string; label: string }>
  error?: string
}) {
  return (
    <div className="space-y-2.5">
      <Label>{label}</Label>
      <Controller
        name={name}
        control={control}
        render={({ field }) => (
          <Select value={field.value} onValueChange={field.onChange}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

function ReadinessItem({
  Icon,
  title,
  description,
}: {
  Icon: typeof CheckCircle2
  title: string
  description: string
}) {
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 rounded-full bg-blue-100 p-1.5 text-blue-700 dark:bg-blue-900/60 dark:text-blue-300">
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div>
        <p className="font-medium">{title}</p>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      </div>
    </div>
  )
}
