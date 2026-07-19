"use client"

import { ApiError, type Category } from "@guestpost/api-client"
import {
  LISTING_LINK_TYPE_LABELS,
  LISTING_LINK_TYPES,
  LISTING_LINK_VALIDITIES,
  LISTING_LINK_VALIDITY_LABELS,
  LISTING_TITLE_URL_WARNING,
  MARKETPLACE_CATEGORY_LIMIT,
  MARKETPLACE_LANGUAGES,
  validateWebsiteEnlistmentInput,
} from "@guestpost/shared"
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
  MultiSelect,
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
  AlertCircle,
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
import { useState } from "react"
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

const YES_NO_OPTIONS = [
  { value: "no", label: "No" },
  { value: "yes", label: "Yes" },
]

const optionalNumber = (minimum: number) =>
  z.preprocess(
    (value) => (value === "" || value == null ? undefined : value),
    z.coerce.number().min(minimum).optional(),
  )

const websiteSchema = z
  .object({
    url: z.string().trim().min(1, "Website URL is required").max(2048),
    country: z
      .string()
      .min(1, "Country is required")
      .refine(
        (value) => COUNTRIES.some(([country]) => country === value),
        "Choose a supported country",
      ),
    language: z
      .string()
      .min(1, "Language is required")
      .refine(
        (value) => MARKETPLACE_LANGUAGES.some((language) => language === value),
        "Choose a supported language",
      ),
    listingTitle: z
      .string()
      .trim()
      .min(3, "Listing title must be at least 3 characters")
      .max(200, "Listing title must be 200 characters or fewer"),
    categoryIds: z
      .array(z.string())
      .min(1, "Choose at least one marketplace category")
      .max(
        MARKETPLACE_CATEGORY_LIMIT,
        `Choose no more than ${MARKETPLACE_CATEGORY_LIMIT} categories`,
      )
      .refine(
        (values) => new Set(values).size === values.length,
        "Choose each category only once",
      ),
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
    sportsGamingAllowed: z.enum(["yes", "no"]),
    pharmacyAllowed: z.enum(["yes", "no"]),
    cryptoAllowed: z.enum(["yes", "no"]),
    backlinkCount: z.coerce.number().int().min(1).max(3),
    linkType: z.enum(LISTING_LINK_TYPES),
    linkValidity: z.enum(LISTING_LINK_VALIDITIES),
    googleNews: z.enum(["yes", "no"]),
    markedSponsored: z.enum(["yes", "no"]),
    foreignLanguageAllowed: z.enum(["yes", "no"]),
  })
  .superRefine((value, context) => {
    for (const issue of validateWebsiteEnlistmentInput(value)) {
      context.addIssue({
        code: "custom",
        path: [issue.field],
        message: issue.message,
      })
    }
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
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const categoriesQ = useQuery<Category[]>({
    queryKey: ["marketplace-categories"],
    queryFn: () => api.marketplace.getCategories(),
  })
  const {
    register,
    handleSubmit,
    control,
    watch,
    clearErrors,
    setError,
    formState: { errors },
  } = useForm<WebsiteFormData>({
    resolver: zodResolver(websiteSchema),
    defaultValues: {
      country: "US",
      language: "English",
      listingTitle: "",
      categoryIds: [],
      description: "",
      addInitialService: true,
      serviceType: "GUEST_POST",
      turnaroundDays: 7,
      revisionRounds: 2,
      sportsGamingAllowed: "no",
      pharmacyAllowed: "no",
      cryptoAllowed: "no",
      backlinkCount: 1,
      linkType: "DOFOLLOW",
      linkValidity: "PERMANENT",
      googleNews: "no",
      markedSponsored: "no",
      foreignLanguageAllowed: "no",
    },
  })
  const description = watch("description") ?? ""
  const categoryCount = watch("categoryIds")?.length ?? 0
  const addInitialService = watch("addInitialService")

  const addMutation = useMutation({
    mutationFn: (data: WebsiteFormData) =>
      api.publishers.addWebsite(publisherId, {
        url: data.url,
        country: data.country,
        language: data.language,
        categoryIds: data.categoryIds,
        listingTitle: data.listingTitle.trim(),
        description: data.description.trim(),
        sportsGamingAllowed: data.sportsGamingAllowed === "yes",
        pharmacyAllowed: data.pharmacyAllowed === "yes",
        cryptoAllowed: data.cryptoAllowed === "yes",
        backlinkCount: data.backlinkCount,
        linkType: data.linkType,
        linkValidity: data.linkValidity,
        googleNews: data.googleNews === "yes",
        markedSponsored: data.markedSponsored === "yes",
        foreignLanguageAllowed: data.foreignLanguageAllowed === "yes",
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
    onError: (error: Error) => {
      const requestId = error instanceof ApiError ? error.requestId : undefined
      const message = error.message || "Website could not be enlisted"
      setError("root.server", {
        message: requestId ? `${message} Request ID: ${requestId}` : message,
      })
      toast.error(message, {
        description: requestId ? `Request ID: ${requestId}` : undefined,
      })
    },
  })

  const submitForm = handleSubmit(
    (data) => {
      setSubmitAttempted(true)
      clearErrors("root.server")
      addMutation.mutate(data)
    },
    () => {
      setSubmitAttempted(true)
      toast.error("Complete the highlighted required fields")
    },
  )

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
        onSubmit={submitForm}
        noValidate
        className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]"
      >
        <div className="space-y-6">
          {submitAttempted && Object.keys(errors).length > 0 && (
            <div
              role="alert"
              className="flex gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">Website could not be submitted</p>
                <p className="mt-1 text-xs leading-5">
                  {errors.root?.server?.message ??
                    "Review every highlighted field and try again."}
                </p>
              </div>
            </div>
          )}
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
              <Field
                label="Website URL"
                htmlFor="website-url"
                required
                error={errors.url?.message}
                description="Use the public homepage only, for example https://example.com."
              >
                <Input
                  id="website-url"
                  placeholder="https://example.com"
                  autoComplete="url"
                  aria-invalid={Boolean(errors.url)}
                  className={errors.url ? "border-destructive" : undefined}
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
                  options={MARKETPLACE_LANGUAGES.map((value) => ({
                    value,
                    label: value,
                  }))}
                  error={errors.language?.message}
                />
              </div>
              <p className="rounded-lg border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
                Search and traffic metrics are imported from the Google Search
                Console and GA4 properties you link after enlistment; they are
                not self-reported here.
              </p>
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
                htmlFor="listing-title"
                required
                error={errors.listingTitle?.message}
                description={LISTING_TITLE_URL_WARNING}
              >
                <Input
                  id="listing-title"
                  placeholder="Technology guest posts on Example"
                  maxLength={200}
                  aria-invalid={Boolean(errors.listingTitle)}
                  className={
                    errors.listingTitle ? "border-destructive" : undefined
                  }
                  {...register("listingTitle")}
                />
              </Field>
              <div className="space-y-2.5">
                <Label>
                  Categories <span className="text-destructive">*</span>
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {categoryCount}/{MARKETPLACE_CATEGORY_LIMIT} selected
                  </span>
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
                    name="categoryIds"
                    control={control}
                    render={({ field }) => (
                      <MultiSelect
                        options={(categoriesQ.data ?? []).map((category) => ({
                          value: category.id,
                          label: category.name,
                        }))}
                        value={field.value}
                        onValueChange={field.onChange}
                        maxSelected={MARKETPLACE_CATEGORY_LIMIT}
                        ariaInvalid={Boolean(errors.categoryIds)}
                        className={
                          errors.categoryIds ? "border-destructive" : undefined
                        }
                        placeholder="Choose 1–7 categories"
                        searchPlaceholder="Search categories..."
                        ariaLabel="Marketplace categories"
                      />
                    )}
                  />
                )}
                <p className="text-xs leading-5 text-muted-foreground">
                  Select at least one relevant niche and up to seven. You can
                  remove a selected category and replace it at any time.
                </p>
                {errors.categoryIds && (
                  <p className="text-xs text-destructive">
                    {errors.categoryIds.message}
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
                  aria-invalid={Boolean(errors.description)}
                  className={
                    errors.description ? "border-destructive" : undefined
                  }
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
              <CardTitle>Placement policy</CardTitle>
              <CardDescription>
                Choose one accurate value for each site-wide publishing term.
                Buyers can filter by these commitments.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              <SelectField
                label="Sports/Gaming allowed?"
                name="sportsGamingAllowed"
                control={control}
                options={YES_NO_OPTIONS}
              />
              <SelectField
                label="Pharmacy allowed?"
                name="pharmacyAllowed"
                control={control}
                options={YES_NO_OPTIONS}
              />
              <SelectField
                label="Crypto allowed?"
                name="cryptoAllowed"
                control={control}
                options={YES_NO_OPTIONS}
              />
              <SelectField
                label="Number of backlinks"
                name="backlinkCount"
                control={control}
                options={[1, 2, 3].map((value) => ({
                  value: String(value),
                  label: String(value),
                }))}
              />
              <SelectField
                label="Link type"
                name="linkType"
                control={control}
                options={LISTING_LINK_TYPES.map((value) => ({
                  value,
                  label: LISTING_LINK_TYPE_LABELS[value],
                }))}
              />
              <SelectField
                label="Link validity"
                name="linkValidity"
                control={control}
                options={LISTING_LINK_VALIDITIES.map((value) => ({
                  value,
                  label: LISTING_LINK_VALIDITY_LABELS[value],
                }))}
              />
              <SelectField
                label="Google News?"
                name="googleNews"
                control={control}
                options={YES_NO_OPTIONS}
              />
              <SelectField
                label="Marked as sponsored?"
                name="markedSponsored"
                control={control}
                options={YES_NO_OPTIONS}
              />
              <SelectField
                label="Foreign-language content allowed?"
                name="foreignLanguageAllowed"
                control={control}
                options={YES_NO_OPTIONS}
              />
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
                      aria-invalid={Boolean(errors.price)}
                      className={
                        errors.price ? "border-destructive" : undefined
                      }
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
  htmlFor,
  required,
  hint,
  description,
  error,
  children,
}: {
  label: string
  htmlFor?: string
  required?: boolean
  hint?: string
  description?: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={htmlFor}>
          {label} {required && <span className="text-destructive">*</span>}
        </Label>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      {children}
      {description && !error && (
        <p className="text-xs leading-5 text-muted-foreground">{description}</p>
      )}
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
  name:
    | "country"
    | "language"
    | "serviceType"
    | "sportsGamingAllowed"
    | "pharmacyAllowed"
    | "cryptoAllowed"
    | "backlinkCount"
    | "linkType"
    | "linkValidity"
    | "googleNews"
    | "markedSponsored"
    | "foreignLanguageAllowed"
  control: any
  options: Array<{ value: string; label: string }>
  error?: string
}) {
  const fieldId = `website-${name}`
  return (
    <div className="space-y-2.5">
      <Label htmlFor={fieldId}>{label}</Label>
      <Controller
        name={name}
        control={control}
        render={({ field }) => (
          <Select value={String(field.value)} onValueChange={field.onChange}>
            <SelectTrigger
              id={fieldId}
              aria-invalid={Boolean(error)}
              className={error ? "border-destructive" : undefined}
            >
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
