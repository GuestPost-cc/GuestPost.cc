"use client"

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@guestpost/ui"
import { zodResolver } from "@hookform/resolvers/zod"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, Globe2 } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Controller, useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"
import { api } from "../../../../lib/api"
import { useAuth } from "../../../../lib/auth"

const websiteSchema = z.object({
  url: z.string().url("Must be a valid URL").min(1, "URL is required"),
  domainRating: z.coerce.number().min(0).max(100).optional(),
  monthlyTraffic: z.coerce.number().min(0).optional(),
  country: z.string().min(1, "Country is required"),
  language: z.string().min(1, "Language is required"),
  price: z.coerce.number().min(0, "Price must be positive").optional(),
  niche: z.string().optional(),
  description: z.string().optional(),
})

type WebsiteFormData = z.infer<typeof websiteSchema>

const countries = [
  { value: "US", label: "United States" },
  { value: "UK", label: "United Kingdom" },
  { value: "CA", label: "Canada" },
  { value: "AU", label: "Australia" },
  { value: "DE", label: "Germany" },
  { value: "FR", label: "France" },
  { value: "IN", label: "India" },
  { value: "OTHER", label: "Other" },
]

const languages = [
  { value: "English", label: "English" },
  { value: "Spanish", label: "Spanish" },
  { value: "French", label: "French" },
  { value: "German", label: "German" },
  { value: "Portuguese", label: "Portuguese" },
  { value: "Dutch", label: "Dutch" },
  { value: "Other", label: "Other" },
]

const niches = [
  "Technology",
  "Finance",
  "Health",
  "Business",
  "Marketing",
  "Real Estate",
  "Travel",
  "Food",
  "Fashion",
  "Sports",
  "Entertainment",
  "Education",
  "Other",
]

export default function NewWebsitePage() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { user } = useAuth()

  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<WebsiteFormData>({
    resolver: zodResolver(websiteSchema),
    defaultValues: {
      country: "US",
      language: "English",
      niche: "",
    },
  })

  const addMutation = useMutation({
    mutationFn: (data: WebsiteFormData) =>
      api.publishers.addWebsite(user?.publisherId ?? "current", {
        url: data.url,
        category: data.niche,
        language: data.language,
        country: data.country,
        domainRating: data.domainRating,
        monthlyTraffic: data.monthlyTraffic,
        price: data.price,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["publisher-websites"] })
      toast.success("Website added successfully")
      router.push("/dashboard/websites")
    },
    onError: () => {
      toast.error("Failed to add website")
    },
  })

  const onSubmit = (data: WebsiteFormData) => {
    addMutation.mutate(data)
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/dashboard/websites">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Add New Website</h1>
          <p className="text-sm text-muted-foreground">
            Add a website to your inventory for guest posting
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe2 className="h-5 w-5" />
            Website Details
          </CardTitle>
          <CardDescription>
            Add a site to your publisher inventory. You can price and list it on
            the marketplace after adding.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="url">
                Website URL <span className="text-destructive">*</span>
              </Label>
              <Input
                id="url"
                placeholder="https://example.com"
                {...register("url")}
              />
              {errors.url && (
                <p className="text-xs text-destructive">{errors.url.message}</p>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="domainRating">Domain Rating (DA)</Label>
                <Input
                  id="domainRating"
                  type="number"
                  min="0"
                  max="100"
                  placeholder="50"
                  {...register("domainRating")}
                />
                {errors.domainRating && (
                  <p className="text-xs text-destructive">
                    {errors.domainRating.message}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="monthlyTraffic">Monthly Traffic</Label>
                <Input
                  id="monthlyTraffic"
                  type="number"
                  min="0"
                  placeholder="10000"
                  {...register("monthlyTraffic")}
                />
                {errors.monthlyTraffic && (
                  <p className="text-xs text-destructive">
                    {errors.monthlyTraffic.message}
                  </p>
                )}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="country">
                  Country <span className="text-destructive">*</span>
                </Label>
                <Controller
                  name="country"
                  control={control}
                  render={({ field }) => (
                    <Select onValueChange={field.onChange} value={field.value}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select country" />
                      </SelectTrigger>
                      <SelectContent>
                        {countries.map((c) => (
                          <SelectItem key={c.value} value={c.value}>
                            {c.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                {errors.country && (
                  <p className="text-xs text-destructive">
                    {errors.country.message}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="language">
                  Language <span className="text-destructive">*</span>
                </Label>
                <Controller
                  name="language"
                  control={control}
                  render={({ field }) => (
                    <Select onValueChange={field.onChange} value={field.value}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select language" />
                      </SelectTrigger>
                      <SelectContent>
                        {languages.map((l) => (
                          <SelectItem key={l.value} value={l.value}>
                            {l.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                {errors.language && (
                  <p className="text-xs text-destructive">
                    {errors.language.message}
                  </p>
                )}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="price">Price per Post (USD)</Label>
                <Input
                  id="price"
                  type="number"
                  min="0"
                  placeholder="100"
                  {...register("price")}
                />
                {errors.price && (
                  <p className="text-xs text-destructive">
                    {errors.price.message}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="niche">Niche</Label>
                <Controller
                  name="niche"
                  control={control}
                  render={({ field }) => (
                    <Select onValueChange={field.onChange} value={field.value}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a niche" />
                      </SelectTrigger>
                      <SelectContent>
                        {niches.map((n) => (
                          <SelectItem key={n} value={n}>
                            {n}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description (Optional)</Label>
              <Textarea
                id="description"
                rows={3}
                placeholder="Tell us more about your website..."
                {...register("description")}
              />
            </div>

            <div className="flex gap-3 pt-4">
              <Button type="button" variant="outline" asChild>
                <Link href="/dashboard/websites">Cancel</Link>
              </Button>
              <Button type="submit" disabled={addMutation.isPending}>
                {addMutation.isPending ? "Adding..." : "Add Website"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
