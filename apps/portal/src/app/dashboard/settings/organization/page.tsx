"use client"

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ErrorState,
  Input,
  Label,
  Skeleton,
} from "@guestpost/ui"
import { useMutation, useQuery } from "@tanstack/react-query"
import {
  Building2,
  CalendarDays,
  Group,
  Hash,
  Loader2,
  ReceiptText,
  Shield,
  Users,
} from "lucide-react"
import { type FormEvent, useEffect, useState } from "react"
import { toast } from "sonner"
import { RoleBadge } from "../../../../components/RoleBadge"
import { api } from "../../../../lib/api"
import { useAuth } from "../../../../lib/auth"

export default function OrgOverviewPage() {
  const { user } = useAuth()
  const [billingProfile, setBillingProfile] = useState({
    legalName: "",
    billingEmail: "",
    addressLine1: "",
    addressLine2: "",
    city: "",
    region: "",
    postalCode: "",
    countryCode: "",
    taxIdType: "",
    taxId: "",
  })

  const {
    data: org,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["organization", user?.organizationId],
    queryFn: () => api.identity.getOrganization(user!.organizationId!),
    enabled: !!user?.organizationId,
  })

  const {
    data: storedBillingProfile,
    error: billingProfileError,
    isLoading: billingProfileLoading,
    refetch: refetchBillingProfile,
  } = useQuery({
    queryKey: ["billing-profile", user?.organizationId],
    queryFn: () => api.identity.getBillingProfile(user!.organizationId!),
    enabled: Boolean(user?.organizationId && org?.myRole === "OWNER"),
  })

  useEffect(() => {
    if (!storedBillingProfile) return
    setBillingProfile({
      legalName: storedBillingProfile.legalName,
      billingEmail: storedBillingProfile.billingEmail ?? "",
      addressLine1: storedBillingProfile.addressLine1,
      addressLine2: storedBillingProfile.addressLine2 ?? "",
      city: storedBillingProfile.city,
      region: storedBillingProfile.region ?? "",
      postalCode: storedBillingProfile.postalCode,
      countryCode: storedBillingProfile.countryCode,
      taxIdType: storedBillingProfile.taxIdType ?? "",
      taxId: storedBillingProfile.taxId ?? "",
    })
  }, [storedBillingProfile])

  const billingProfileMutation = useMutation({
    mutationFn: () =>
      api.identity.updateBillingProfile(user!.organizationId!, {
        legalName: billingProfile.legalName,
        billingEmail: billingProfile.billingEmail || null,
        addressLine1: billingProfile.addressLine1,
        addressLine2: billingProfile.addressLine2 || null,
        city: billingProfile.city,
        region: billingProfile.region || null,
        postalCode: billingProfile.postalCode,
        countryCode: billingProfile.countryCode.toUpperCase(),
        taxIdType: billingProfile.taxIdType || null,
        taxId: billingProfile.taxId || null,
      }),
    onSuccess: (profile) => {
      setBillingProfile({
        legalName: profile.legalName,
        billingEmail: profile.billingEmail ?? "",
        addressLine1: profile.addressLine1,
        addressLine2: profile.addressLine2 ?? "",
        city: profile.city,
        region: profile.region ?? "",
        postalCode: profile.postalCode,
        countryCode: profile.countryCode,
        taxIdType: profile.taxIdType ?? "",
        taxId: profile.taxId ?? "",
      })
      toast.success("Billing details saved for future invoices")
    },
    onError: (mutationError: Error) => toast.error(mutationError.message),
  })

  const updateBillingField = (
    field: keyof typeof billingProfile,
    value: string,
  ) => {
    setBillingProfile((current) => ({ ...current, [field]: value }))
  }

  const submitBillingProfile = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    billingProfileMutation.mutate()
  }

  if (!user?.organizationId) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <Building2 className="h-12 w-12 text-muted-foreground mb-4" />
          <h3 className="text-lg font-semibold">No organization</h3>
          <p className="text-sm text-muted-foreground mt-1">
            You are not part of an organization yet.
          </p>
        </CardContent>
      </Card>
    )
  }

  if (isLoading) {
    return (
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-4 w-24" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-6 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <ErrorState
        title="Failed to load organization"
        description={(error as Error).message}
        onRetry={() => refetch()}
      />
    )
  }

  if (!org) return null

  const fields = [
    { icon: Building2, label: "Name", value: org.name },
    { icon: Hash, label: "Slug", value: org.slug },
    { icon: Shield, label: "Plan", value: org.plan },
    {
      icon: CalendarDays,
      label: "Created",
      value: new Date(org.createdAt).toLocaleDateString(),
    },
    { icon: Users, label: "Members", value: org.memberCount },
    { icon: Group, label: "Teams", value: org.teamCount },
  ]

  return (
    <div className="space-y-6">
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {fields.map((f) => {
          const Icon = f.icon
          return (
            <Card key={f.label}>
              <CardHeader className="flex flex-row items-center gap-3 pb-2">
                <Icon className="h-5 w-5 text-muted-foreground" />
                <CardTitle className="text-sm font-medium">{f.label}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{f.value}</p>
              </CardContent>
            </Card>
          )
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your Role</CardTitle>
          <CardDescription>
            Your permission level in this organization
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RoleBadge role={org.myRole} />
        </CardContent>
      </Card>

      {org.myRole === "OWNER" && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <ReceiptText className="h-5 w-5 text-muted-foreground" />
              <div>
                <CardTitle className="text-base">Billing details</CardTitle>
                <CardDescription>
                  Snapshotted onto future paid invoices, credit notes, and
                  deposit receipts. Existing documents never change.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {billingProfileError ? (
              <ErrorState
                title="Failed to load billing details"
                description={(billingProfileError as Error).message}
                onRetry={() => refetchBillingProfile()}
              />
            ) : billingProfileLoading ? (
              <div className="grid gap-4 sm:grid-cols-2">
                {Array.from({ length: 8 }).map((_, index) => (
                  <Skeleton key={index} className="h-10" />
                ))}
              </div>
            ) : (
              <form onSubmit={submitBillingProfile} className="space-y-5">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor="billing-legal-name">Legal name</Label>
                    <Input
                      id="billing-legal-name"
                      required
                      maxLength={160}
                      value={billingProfile.legalName}
                      onChange={(event) =>
                        updateBillingField("legalName", event.target.value)
                      }
                    />
                  </div>
                  <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor="billing-email">Billing email</Label>
                    <Input
                      id="billing-email"
                      type="email"
                      maxLength={320}
                      value={billingProfile.billingEmail}
                      onChange={(event) =>
                        updateBillingField("billingEmail", event.target.value)
                      }
                      placeholder="accounts@example.com"
                    />
                  </div>
                  <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor="billing-address-1">Address line 1</Label>
                    <Input
                      id="billing-address-1"
                      required
                      maxLength={160}
                      value={billingProfile.addressLine1}
                      onChange={(event) =>
                        updateBillingField("addressLine1", event.target.value)
                      }
                    />
                  </div>
                  <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor="billing-address-2">
                      Address line 2 <span className="sr-only">optional</span>
                    </Label>
                    <Input
                      id="billing-address-2"
                      maxLength={160}
                      value={billingProfile.addressLine2}
                      onChange={(event) =>
                        updateBillingField("addressLine2", event.target.value)
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="billing-city">City</Label>
                    <Input
                      id="billing-city"
                      required
                      maxLength={100}
                      value={billingProfile.city}
                      onChange={(event) =>
                        updateBillingField("city", event.target.value)
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="billing-region">State / region</Label>
                    <Input
                      id="billing-region"
                      maxLength={100}
                      value={billingProfile.region}
                      onChange={(event) =>
                        updateBillingField("region", event.target.value)
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="billing-postal-code">Postal code</Label>
                    <Input
                      id="billing-postal-code"
                      required
                      maxLength={32}
                      value={billingProfile.postalCode}
                      onChange={(event) =>
                        updateBillingField("postalCode", event.target.value)
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="billing-country-code">Country code</Label>
                    <Input
                      id="billing-country-code"
                      required
                      minLength={2}
                      maxLength={2}
                      autoCapitalize="characters"
                      value={billingProfile.countryCode}
                      onChange={(event) =>
                        updateBillingField(
                          "countryCode",
                          event.target.value.toUpperCase(),
                        )
                      }
                      placeholder="US"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="billing-tax-type">Tax ID type</Label>
                    <Input
                      id="billing-tax-type"
                      maxLength={32}
                      value={billingProfile.taxIdType}
                      onChange={(event) =>
                        updateBillingField("taxIdType", event.target.value)
                      }
                      placeholder="VAT, GST, EIN"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="billing-tax-id">Tax ID</Label>
                    <Input
                      id="billing-tax-id"
                      maxLength={64}
                      value={billingProfile.taxId}
                      onChange={(event) =>
                        updateBillingField("taxId", event.target.value)
                      }
                    />
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">
                  Tax ID type and Tax ID must be supplied together. These
                  details are visible only to organization owners and the
                  finance document processor.
                </p>
                <Button
                  type="submit"
                  disabled={billingProfileMutation.isPending}
                >
                  {billingProfileMutation.isPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Save billing details
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
