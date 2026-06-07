"use client"

import { useQuery } from "@tanstack/react-query"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@guestpost/ui"
import { Separator } from "@guestpost/ui"
import {
  User,
  Shield,
  Bell,
  Palette,
  Globe,
  Key,
  Sun,
  Moon,
  Monitor,
} from "lucide-react"
import { useTheme } from "next-themes"

const themeOptions = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
]

export default function SettingsPage() {
  const { user } = useAuth()
  const { theme, setTheme } = useTheme()

  const { data: walletData } = useQuery({
    queryKey: ["wallet"],
    queryFn: () => api.billing.getWallet(),
  })

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">Manage your account and preferences</p>
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
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Name</dt>
                <dd className="font-medium">{user?.name || "—"}</dd>
              </div>
              <Separator />
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Email</dt>
                <dd className="font-medium">{user?.email}</dd>
              </div>
              <Separator />
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Account Type</dt>
                <dd className="font-medium capitalize">{user?.userType?.toLowerCase()}</dd>
              </div>
              <Separator />
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Email Verified</dt>
                <dd className="font-medium">{user?.emailVerified ? "Yes" : "No"}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Palette className="h-5 w-5 text-muted-foreground" />
              <div>
                <CardTitle className="text-base">Appearance</CardTitle>
                <CardDescription>Customize your theme preference</CardDescription>
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
                    <Icon className={`h-5 w-5 ${isActive ? "text-primary" : "text-muted-foreground"}`} />
                    <span className={`text-sm font-medium ${isActive ? "text-primary" : ""}`}>
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
                <dd className="font-mono text-xs">{user?.organizationId || "—"}</dd>
              </div>
              {walletData && (
                <>
                  <Separator />
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Wallet Balance</dt>
                    <dd className="font-mono font-medium">${(walletData?.balance ?? 0).toFixed(2)}</dd>
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