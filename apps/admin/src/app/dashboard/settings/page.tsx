"use client"

import { Button, Input, Label, Switch } from "@guestpost/ui"
import { zodResolver } from "@hookform/resolvers/zod"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { RefreshCw, Save } from "lucide-react"
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

export default function SettingsPage() {
  const { user } = useAuth()
  const queryClient = useQueryClient()

  const { data: profileData } = useQuery({
    queryKey: ["admin-settings"],
    queryFn: () => api.identity.me(),
    enabled: !!user?.id,
  })

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

  const [maintenanceMode, setMaintenanceMode] = useState(false)

  return (
    <div>
      <h1 className="mb-8 text-3xl font-bold tracking-tight">Settings</h1>

      <div className="grid gap-8 max-w-2xl">
        <div className="rounded-lg border p-6">
          <h2 className="mb-4 text-lg font-semibold">Platform Info</h2>
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
        </div>

        <div className="rounded-lg border p-6">
          <h2 className="mb-4 text-lg font-semibold">Profile</h2>
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
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> Saving...
                </>
              ) : (
                <>
                  <Save className="mr-2 h-4 w-4" /> Save Changes
                </>
              )}
            </Button>
          </form>
        </div>

        <div className="rounded-lg border p-6">
          <h2 className="mb-4 text-lg font-semibold">Platform Settings</h2>
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
              onCheckedChange={setMaintenanceMode}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
