"use client"

import { useState } from "react"
import { useQuery, useMutation } from "@tanstack/react-query"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"
import { toast } from "sonner"
import {
  User,
  Mail,
  Building2,
  CreditCard,
  Shield,
  Bell,
  Save,
  RefreshCw,
  Check,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@guestpost/ui"
import { Button } from "@guestpost/ui"
import { Input } from "@guestpost/ui"
import { Label } from "@guestpost/ui"
import { Separator } from "@guestpost/ui"
import { Switch } from "@guestpost/ui"
import { Skeleton } from "@guestpost/ui"

export default function SettingsPage() {
  const { user } = useAuth()
  const [saving, setSaving] = useState<string | null>(null)

  const [profile, setProfile] = useState({
    name: user?.name ?? "",
    email: user?.email ?? "",
    company: "",
    website: "",
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

  const handleSaveProfile = async () => {
    setSaving("profile")
    try {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      toast.success("Profile updated successfully")
    } catch (error) {
      toast.error("Failed to update profile")
    } finally {
      setSaving(null)
    }
  }

  const handleSavePayment = async () => {
    setSaving("payment")
    try {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      toast.success("Payment information updated")
    } catch (error) {
      toast.error("Failed to update payment info")
    } finally {
      setSaving(null)
    }
  }

  const handleSaveNotifications = async () => {
    setSaving("notifications")
    try {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      toast.success("Notification preferences updated")
    } catch (error) {
      toast.error("Failed to update notifications")
    } finally {
      setSaving(null)
    }
  }

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
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="name">Full Name</Label>
              <Input
                id="name"
                value={profile.name}
                onChange={(e) =>
                  setProfile({ ...profile, name: e.target.value })
                }
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
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="company">Company Name</Label>
              <Input
                id="company"
                placeholder="Your company"
                value={profile.company}
                onChange={(e) =>
                  setProfile({ ...profile, company: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="website">Website</Label>
              <Input
                id="website"
                placeholder="https://example.com"
                value={profile.website}
                onChange={(e) =>
                  setProfile({ ...profile, website: e.target.value })
                }
              />
            </div>
          </div>
          <div className="flex justify-end">
            <Button onClick={handleSaveProfile} disabled={saving === "profile"}>
              {saving === "profile" ? (
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
            <Button onClick={handleSavePayment} disabled={saving === "payment"}>
              {saving === "payment" ? (
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
              disabled={saving === "notifications"}
            >
              {saving === "notifications" ? (
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
    </div>
  )
}