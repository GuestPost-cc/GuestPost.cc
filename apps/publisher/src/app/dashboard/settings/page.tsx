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
  NotificationPreferencesForm,
  type NotificationPreferenceValue,
  Separator,
} from "@guestpost/ui"
import { useMutation, useQuery } from "@tanstack/react-query"
import {
  Bell,
  CreditCard,
  Monitor,
  Moon,
  Palette,
  RefreshCw,
  Save,
  Shield,
  Sun,
  User,
} from "lucide-react"
import { useTheme } from "next-themes"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"

const themeOptions = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
]

export default function SettingsPage() {
  const { user } = useAuth()
  const { theme, setTheme } = useTheme()

  const [profile, setProfile] = useState({
    name: user?.name ?? "",
    email: user?.email ?? "",
  })

  const [payment, setPayment] = useState({
    bankName: "",
    accountNumber: "",
    routingNumber: "",
    accountType: "CHECKING",
    paypalEmail: "",
  })

  const [notificationPreferences, setNotificationPreferences] = useState<
    NotificationPreferenceValue[]
  >([])

  const {
    data: profileData,
    error,
    refetch,
  } = useQuery({
    queryKey: ["publisher-settings"],
    queryFn: () => api.identity.me(),
    enabled: !!user?.id,
  })

  const {
    data: notificationPreferenceData,
    isLoading: notificationPreferencesLoading,
    error: notificationPreferencesError,
  } = useQuery({
    queryKey: ["notification-preferences"],
    queryFn: () => api.notifications.preferences(),
    enabled: Boolean(user?.id),
  })

  useEffect(() => {
    if (!profileData) return
    setProfile((prev) => ({
      ...prev,
      name: (profileData as any).name ?? prev.name,
    }))
    try {
      const meta = (profileData as any).metadata
        ? JSON.parse((profileData as any).metadata)
        : {}
      if (meta.payment) setPayment((prev) => ({ ...prev, ...meta.payment }))
    } catch {}
  }, [profileData])

  useEffect(() => {
    if (notificationPreferenceData) {
      setNotificationPreferences(notificationPreferenceData)
    }
  }, [notificationPreferenceData])

  const profileMutation = useMutation({
    mutationFn: (data: { name: string }) => api.identity.updateProfile(data),
    onSuccess: () => {
      toast.success("Profile updated successfully")
    },
    onError: () => {
      toast.error("Failed to update profile")
    },
  })

  const paymentMutation = useMutation({
    mutationFn: () =>
      api.identity.updateProfile({
        name: user?.name ?? "",
        metadata: JSON.stringify({ payment }),
      } as any),
    onSuccess: () => {
      toast.success("Payment information updated")
    },
    onError: () => {
      toast.error("Failed to update payment info")
    },
  })

  const notificationsMutation = useMutation({
    mutationFn: (preferences: NotificationPreferenceValue[]) =>
      api.notifications.updatePreferences(preferences),
    onSuccess: (preferences) => {
      setNotificationPreferences(preferences)
      toast.success("Notification preferences updated")
    },
    onError: (mutationError: Error) => {
      toast.error(mutationError.message)
    },
  })

  const handleSaveProfile = () => profileMutation.mutate({ name: profile.name })
  const handleSavePayment = () => paymentMutation.mutate()
  const handleSaveNotifications = () =>
    notificationsMutation.mutate(notificationPreferences)

  if (error)
    return (
      <ErrorState
        title="Failed to load settings"
        description={(error as Error).message}
        onRetry={() => refetch()}
      />
    )

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage your account settings and preferences
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <User className="h-5 w-5" />
            Profile Information
          </CardTitle>
          <CardDescription>
            Update your personal information and public profile
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Full Name</Label>
            <Input
              id="name"
              value={profile.name}
              onChange={(e) => setProfile({ ...profile, name: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email Address</Label>
            <Input
              id="email"
              type="email"
              value={profile.email}
              onChange={(e) =>
                setProfile({ ...profile, email: e.target.value })
              }
              disabled
            />
            <p className="text-xs text-muted-foreground">
              Contact support to change your email
            </p>
          </div>
          <div className="flex justify-end">
            <Button
              onClick={handleSaveProfile}
              disabled={profileMutation.isPending}
            >
              {profileMutation.isPending ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="mr-2 h-4 w-4" />
                  Save Changes
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CreditCard className="h-5 w-5" />
            Payment Information
          </CardTitle>
          <CardDescription>
            Manage your payout method and banking details
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border bg-muted/50 p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Shield className="h-4 w-4" />
              Your payment information is encrypted and secure
            </div>
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="paypal">PayPal Email</Label>
              <Input
                id="paypal"
                type="email"
                placeholder="your@email.com"
                value={payment.paypalEmail}
                onChange={(e) =>
                  setPayment({ ...payment, paypalEmail: e.target.value })
                }
              />
            </div>

            <Separator />

            <p className="text-sm font-medium">Bank Transfer Details</p>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="bankName">Bank Name</Label>
                <Input
                  id="bankName"
                  placeholder="Enter bank name"
                  value={payment.bankName}
                  onChange={(e) =>
                    setPayment({ ...payment, bankName: e.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="accountType">Account Type</Label>
                <select
                  id="accountType"
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  value={payment.accountType}
                  onChange={(e) =>
                    setPayment({ ...payment, accountType: e.target.value })
                  }
                >
                  <option value="CHECKING">Checking</option>
                  <option value="SAVINGS">Savings</option>
                </select>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="accountNumber">Account Number</Label>
                <Input
                  id="accountNumber"
                  placeholder="Enter account number"
                  value={payment.accountNumber}
                  onChange={(e) =>
                    setPayment({ ...payment, accountNumber: e.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="routingNumber">Routing Number</Label>
                <Input
                  id="routingNumber"
                  placeholder="Enter routing number"
                  value={payment.routingNumber}
                  onChange={(e) =>
                    setPayment({ ...payment, routingNumber: e.target.value })
                  }
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end">
            <Button
              onClick={handleSavePayment}
              disabled={paymentMutation.isPending}
            >
              {paymentMutation.isPending ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="mr-2 h-4 w-4" />
                  Save Payment Info
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell className="h-5 w-5" />
            Notification Preferences
          </CardTitle>
          <CardDescription>
            Choose how you want to be notified about updates
          </CardDescription>
        </CardHeader>
        <CardContent>
          {notificationPreferencesError ? (
            <ErrorState
              title="Failed to load notification preferences"
              description={(notificationPreferencesError as Error).message}
            />
          ) : (
            <NotificationPreferencesForm
              preferences={notificationPreferences}
              loading={notificationPreferencesLoading}
              saving={notificationsMutation.isPending}
              onChange={setNotificationPreferences}
              onSave={handleSaveNotifications}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Palette className="h-5 w-5" />
            Appearance
          </CardTitle>
          <CardDescription>
            Choose between light, dark, or system theme
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-3">
            {themeOptions.map((option) => {
              const Icon = option.icon
              const isActive = theme === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setTheme(option.value)}
                  className={`flex flex-1 items-center justify-center gap-2 rounded-lg border-2 p-4 transition-all ${
                    isActive
                      ? "border-primary bg-primary/5"
                      : "border-muted hover:border-muted-foreground/30"
                  }`}
                >
                  <Icon
                    className={`h-5 w-5 ${isActive ? "text-primary" : "text-muted-foreground"}`}
                  />
                  <span
                    className={`text-sm font-medium ${isActive ? "text-primary" : ""}`}
                  >
                    {option.label}
                  </span>
                </button>
              )
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
