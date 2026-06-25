"use client"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ErrorState,
  Skeleton,
} from "@guestpost/ui"
import { useQuery } from "@tanstack/react-query"
import {
  Building2,
  CalendarDays,
  Group,
  Hash,
  Shield,
  Users,
} from "lucide-react"
import { RoleBadge } from "../../../../components/RoleBadge"
import { api } from "../../../../lib/api"
import { useAuth } from "../../../../lib/auth"

export default function OrgOverviewPage() {
  const { user } = useAuth()

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
    </div>
  )
}
