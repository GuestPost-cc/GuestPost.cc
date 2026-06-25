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
import { zodResolver } from "@hookform/resolvers/zod"
import { useMutation, useQuery } from "@tanstack/react-query"
import {
  Bell,
  Globe,
  Loader2,
  Monitor,
  Moon,
  Palette,
  Sun,
  User,
} from "lucide-react"
import { useTheme } from "next-themes"
import { useState } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"

const profileSchema = z.object({
  name: z.string().min(1, "Name is required"),
})

type ProfileForm = z.infer<typeof profileSchema>

const themeOptions = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
]

const NOTIF_STORAGE_KEY = "notification-preferences"

interface NotificationPrefs {
  emailOrders: boolean
  emailEarnings: boolean
  emailMarketing: boolean
}

function loadNotificationPrefs(): NotificationPrefs {
  if (typeof window === "undefined") {
    return { emailOrders: true, emailEarnings: true, emailMarketing: false }
  }
  const stored = localStorage.getItem(NOTIF_STORAGE_KEY)
  if (stored) {
    try {
      return JSON.parse(stored)
    } catch {}
  }
  return { emailOrders: true, emailEarnings: true, emailMarketing: false }
}

export default function SettingsPage() {
  const { user, refresh } = useAuth()
  const { theme, setTheme } = useTheme()
  const [notifPrefs, setNotifPrefs] = useState<NotificationPrefs>(
    loadNotificationPrefs,
  )

  const {
    data: walletData,
    error,
    refetch,
  } = useQuery({
    queryKey: ["wallet"],
    queryFn: () => api.billing.getWallet(),
  })

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ProfileForm>({
    resolver: zodResolver(profileSchema),
    values: { name: user?.name || "" },
  })

  const profileMutation = useMutation({
    mutationFn: (data: ProfileForm) =>
      api.identity.updateProfile({ name: data.name }),
    onSuccess: () => {
      toast.success("Profile updated successfully")
      refresh()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const notifMutation = useMutation({
    mutationFn: (prefs: NotificationPrefs) => {
      localStorage.setItem(NOTIF_STORAGE_KEY, JSON.stringify(prefs))
      return Promise.resolve()
    },
    onSuccess: () => toast.success("Notification preferences saved"),
    onError: () => toast.error("Failed to save preferences"),
  })

  const onProfileSubmit = (data: ProfileForm) => {
    profileMutation.mutate(data)
  }

  if (error)
    return (
      <ErrorState
        title="Failed to load settings"
        description={(error as Error).message}
        onRetry={() => refetch()}
      />
    )

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">
          Manage your account and preferences
        </p>
      </div>

      <div className="grid gap-8 max-w-2xl">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <User className="h-5 w-5 text-muted-foreground" />
              <div>
                <CardTitle className="text-base">Profile</CardTitle>
                <CardDescription>Your account information</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={handleSubmit(onProfileSubmit)}
              className="space-y-4"
            >
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" {...register("name")} />
                {errors.name?.message && (
                  <p className="text-sm text-destructive">
                    {errors.name.message}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" value={user?.email || ""} disabled />
              </div>
              <Button type="submit" disabled={profileMutation.isPending}>
                {profileMutation.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Save
              </Button>
            </form>
            <Separator className="my-4" />
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Account Type</dt>
                <dd className="font-medium capitalize">
                  {user?.userType?.toLowerCase()}
                </dd>
              </div>
              <Separator />
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Email Verified</dt>
                <dd className="font-medium">
                  {user?.emailVerified ? "Yes" : "No"}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Bell className="h-5 w-5 text-muted-foreground" />
              <div>
                <CardTitle className="text-base">Notifications</CardTitle>
                <CardDescription>
                  Manage your email notification preferences
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="emailOrders" className="font-medium">
                    Order Updates
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    Receive emails about order status changes
                  </p>
                </div>
                <Switch
                  id="emailOrders"
                  checked={notifPrefs.emailOrders}
                  onCheckedChange={(checked) =>
                    setNotifPrefs((prev) => ({ ...prev, emailOrders: checked }))
                  }
                />
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="emailEarnings" className="font-medium">
                    Earnings Reports
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    Receive weekly earnings summaries
                  </p>
                </div>
                <Switch
                  id="emailEarnings"
                  checked={notifPrefs.emailEarnings}
                  onCheckedChange={(checked) =>
                    setNotifPrefs((prev) => ({
                      ...prev,
                      emailEarnings: checked,
                    }))
                  }
                />
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="emailMarketing" className="font-medium">
                    Marketing
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    Receive promotional offers and updates
                  </p>
                </div>
                <Switch
                  id="emailMarketing"
                  checked={notifPrefs.emailMarketing}
                  onCheckedChange={(checked) =>
                    setNotifPrefs((prev) => ({
                      ...prev,
                      emailMarketing: checked,
                    }))
                  }
                />
              </div>
              <Button
                onClick={() => notifMutation.mutate(notifPrefs)}
                disabled={notifMutation.isPending}
                className="mt-2"
              >
                {notifMutation.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Save Preferences
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Palette className="h-5 w-5 text-muted-foreground" />
              <div>
                <CardTitle className="text-base">Appearance</CardTitle>
                <CardDescription>
                  Customize your theme preference
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex gap-3">
              {themeOptions.map((option) => {
                const Icon = option.icon
                const isActive = theme === option.value
                return (
                  <button
                    key={option.value}
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

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Globe className="h-5 w-5 text-muted-foreground" />
              <div>
                <CardTitle className="text-base">Account Details</CardTitle>
                <CardDescription>Your account information</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">User ID</dt>
                <dd className="font-mono text-xs">{user?.id}</dd>
              </div>
              <Separator />
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Organization ID</dt>
                <dd className="font-mono text-xs">
                  {user?.organizationId || "—"}
                </dd>
              </div>
              {walletData && (
                <>
                  <Separator />
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Wallet Balance</dt>
                    <dd className="font-mono font-medium">
                      ${Number(walletData?.availableBalance ?? 0).toFixed(2)}
                    </dd>
                  </div>
                </>
              )}
            </dl>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
