"use client"

import {
  Button,
  Card,
  CardContent,
  Input,
  Label,
  NotificationPreferencesForm,
  type NotificationPreferenceValue,
  Switch,
} from "@guestpost/ui"
import { zodResolver } from "@hookform/resolvers/zod"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Bell,
  RefreshCw,
  Save,
  Settings,
  ShieldCheck,
  UserRound,
} from "lucide-react"
import { useEffect, useState } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"
import {
  AdminNotice,
  AdminPage,
  AdminPageHeader,
} from "../../../components/admin-workspace"
import { api } from "../../../lib/api"
import { useAuth } from "../../../lib/auth"

const profileSchema = z.object({
  name: z.string().min(1, "Name is required"),
})

type ProfileForm = z.infer<typeof profileSchema>

export default function SettingsPage() {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const [notificationPreferences, setNotificationPreferences] = useState<
    NotificationPreferenceValue[]
  >([])

  const { data: profileData } = useQuery({
    queryKey: ["admin-settings"],
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
    if (notificationPreferenceData) {
      setNotificationPreferences(notificationPreferenceData)
    }
  }, [notificationPreferenceData])

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ProfileForm>({
    resolver: zodResolver(profileSchema),
    values: { name: profileData?.name ?? user?.name ?? "" },
  })

  const profileMutation = useMutation({
    mutationFn: (data: { name: string }) => api.identity.updateProfile(data),
    onSuccess: () => {
      toast.success("Profile updated")
      queryClient.invalidateQueries({ queryKey: ["admin-settings"] })
    },
    onError: () => toast.error("Failed to update profile"),
  })

  const notificationMutation = useMutation({
    mutationFn: (preferences: NotificationPreferenceValue[]) =>
      api.notifications.updatePreferences(preferences),
    onSuccess: (preferences) => {
      setNotificationPreferences(preferences)
      toast.success("Notification preferences updated")
    },
    onError: (mutationError: Error) => toast.error(mutationError.message),
  })

  // Maintenance mode requires a backend endpoint — currently inactive
  // until the API route is implemented.
  const [maintenanceMode] = useState(false)

  return (
    <AdminPage>
      <AdminPageHeader
        title="Settings"
        description="Manage your staff profile and review the environment used by this Admin workspace."
        eyebrow="Account & environment"
        icon={Settings}
      />

      <div className="grid max-w-3xl gap-6">
        <Card className="rounded-2xl">
          <CardContent className="p-6">
            <div className="mb-4 flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">Platform information</h2>
            </div>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Version</dt>
                <dd className="font-medium">1.0.0</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">API URL</dt>
                <dd className="font-mono text-xs">
                  {process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000"}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Environment</dt>
                <dd className="font-medium">
                  {process.env.NODE_ENV || "development"}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card className="rounded-2xl">
          <CardContent className="p-6">
            <div className="mb-4 flex items-center gap-2">
              <Bell className="h-5 w-5 text-primary" />
              <div>
                <h2 className="text-lg font-semibold">
                  Notification preferences
                </h2>
                <p className="text-sm text-muted-foreground">
                  Choose where you receive operational and account updates.
                </p>
              </div>
            </div>
            {notificationPreferencesError ? (
              <AdminNotice title="Preferences unavailable" tone="warning">
                {(notificationPreferencesError as Error).message}
              </AdminNotice>
            ) : (
              <NotificationPreferencesForm
                preferences={notificationPreferences}
                loading={notificationPreferencesLoading}
                saving={notificationMutation.isPending}
                onChange={setNotificationPreferences}
                onSave={() =>
                  notificationMutation.mutate(notificationPreferences)
                }
              />
            )}
          </CardContent>
        </Card>

        <Card className="rounded-2xl">
          <CardContent className="p-6">
            <div className="mb-4 flex items-center gap-2">
              <UserRound className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">Profile</h2>
            </div>
            <form
              onSubmit={handleSubmit((data) => profileMutation.mutate(data))}
              className="space-y-4"
            >
              <div className="space-y-2">
                <Label htmlFor="name">Display Name</Label>
                <Input id="name" {...register("name")} />
                {errors.name && (
                  <p className="text-sm text-destructive">
                    {errors.name.message}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" value={user?.email ?? ""} disabled />
              </div>
              <Button type="submit" disabled={profileMutation.isPending}>
                {profileMutation.isPending ? (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />{" "}
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="mr-2 h-4 w-4" /> Save Changes
                  </>
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card className="rounded-2xl">
          <CardContent className="p-6">
            <h2 className="mb-4 text-lg font-semibold">Platform settings</h2>
            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="maintenance-mode">Maintenance Mode</Label>
                <p className="text-sm text-muted-foreground">
                  When enabled, only admins can access the platform
                </p>
              </div>
              <Switch
                id="maintenance-mode"
                checked={maintenanceMode}
                disabled
              />
            </div>
          </CardContent>
        </Card>

        <AdminNotice title="Protected control" tone="warning">
          Maintenance mode stays unavailable until the corresponding secured API
          route, authorization policy, and audit event are implemented.
        </AdminNotice>
      </div>
    </AdminPage>
  )
}
