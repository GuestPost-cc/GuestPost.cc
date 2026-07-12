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
  Separator,
  Switch,
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

  const [notifications, setNotifications] = useState({
    emailOrders: true,
    emailEarnings: true,
    emailMarketing: false,
    pushOrders: true,
    pushEarnings: true,
  })

  const {
    data: profileData,
    error,
    refetch,
  } = useQuery({
    queryKey: ["publisher-settings"],
    queryFn: () => api.identity.me(),
    enabled: !!user?.id,
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
      if (meta.emailOrders !== undefined)
        setNotifications((prev) => ({ ...prev, ...meta }))
    } catch {}
  }, [profileData])

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
    mutationFn: () =>
      api.identity.updateProfile({
        name: user?.name ?? "",
        metadata: JSON.stringify(notifications),
      } as any),
    onSuccess: () => {
      toast.success("Notification preferences updated")
    },
    onError: () => {
      toast.error("Failed to update notifications")
    },
  })

  const handleSaveProfile = () => profileMutation.mutate({ name: profile.name })
  const handleSavePayment = () => paymentMutation.mutate()
  const handleSaveNotifications = () => notificationsMutation.mutate()

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
        <CardContent className="space-y-6">
          <div className="space-y-4">
            <p className="text-sm font-medium">Email Notifications</p>
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>New Orders</Label>
                <p className="text-sm text-muted-foreground">
                  Get notified when you receive a new order
                </p>
              </div>
              <Switch
                checked={notifications.emailOrders}
                onCheckedChange={(checked) =>
                  setNotifications({ ...notifications, emailOrders: checked })
                }
              />
            </div>
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Earnings Updates</Label>
                <p className="text-sm text-muted-foreground">
                  Receive updates about your earnings and withdrawals
                </p>
              </div>
              <Switch
                checked={notifications.emailEarnings}
                onCheckedChange={(checked) =>
                  setNotifications({ ...notifications, emailEarnings: checked })
                }
              />
            </div>
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Marketing & Tips</Label>
                <p className="text-sm text-muted-foreground">
                  Receive tips and promotional offers
                </p>
              </div>
              <Switch
                checked={notifications.emailMarketing}
                onCheckedChange={(checked) =>
                  setNotifications({
                    ...notifications,
                    emailMarketing: checked,
                  })
                }
              />
            </div>
          </div>

          <Separator />

          <div className="space-y-4">
            <p className="text-sm font-medium">Push Notifications</p>
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Order Updates</Label>
                <p className="text-sm text-muted-foreground">
                  Get push notifications for order changes
                </p>
              </div>
              <Switch
                checked={notifications.pushOrders}
                onCheckedChange={(checked) =>
                  setNotifications({ ...notifications, pushOrders: checked })
                }
              />
            </div>
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Earnings Alerts</Label>
                <p className="text-sm text-muted-foreground">
                  Receive alerts for earnings and withdrawals
                </p>
              </div>
              <Switch
                checked={notifications.pushEarnings}
                onCheckedChange={(checked) =>
                  setNotifications({ ...notifications, pushEarnings: checked })
                }
              />
            </div>
          </div>

          <div className="flex justify-end">
            <Button
              onClick={handleSaveNotifications}
              disabled={notificationsMutation.isPending}
            >
              {notificationsMutation.isPending ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="mr-2 h-4 w-4" />
                  Save Preferences
                </>
              )}
            </Button>
          </div>
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
