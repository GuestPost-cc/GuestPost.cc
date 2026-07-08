"use client"

import type { IntegrationSummary } from "@guestpost/api-client"
import { IntegrationProvider, IntegrationStatus } from "@guestpost/api-client"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  cn,
  EmptyState,
  ErrorState,
  IntegrationCard,
  LoadingState,
  PageHeader,
  PROVIDER_METADATA,
  ReconnectBanner,
} from "@guestpost/ui"
import { Loader2, Plug } from "lucide-react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  useConnectIntegration,
  useIntegrations,
} from "../../../../lib/hooks/integrations"

const REAUTH_STATUSES = new Set([
  IntegrationStatus.TOKEN_EXPIRED,
  IntegrationStatus.REAUTH_REQUIRED,
])

export default function IntegrationsPage() {
  const router = useRouter()
  const { data, isLoading, error, refetch } = useIntegrations()
  const connectMutation = useConnectIntegration()

  const integrations: IntegrationSummary[] = data?.data ?? []
  const connectedProviders = new Set(
    integrations.map((i) => i.provider).filter(Boolean),
  )
  const needsReauth = integrations.filter(
    (i) => i.status && REAUTH_STATUSES.has(i.status),
  )

  const allProviders = (
    Object.values(IntegrationProvider) as IntegrationProvider[]
  ).sort(
    (a, b) =>
      (PROVIDER_METADATA[a]?.displayOrder ?? 99) -
      (PROVIDER_METADATA[b]?.displayOrder ?? 99),
  )

  const handleConnect = async (provider: IntegrationProvider) => {
    try {
      const result = await connectMutation.mutateAsync({
        provider,
        returnUrl: "/dashboard/settings/integrations",
      })
      window.location.assign(result.authorizationUrl!)
    } catch {
      toast.error("Failed to initiate connection")
    }
  }

  if (isLoading) {
    return (
      <div>
        <PageHeader
          title="Integrations"
          description="Connect your SEO and analytics accounts"
        />
        <LoadingState variant="list" />
      </div>
    )
  }

  if (error) {
    return (
      <div>
        <PageHeader
          title="Integrations"
          description="Connect your SEO and analytics accounts"
        />
        <ErrorState onRetry={() => refetch()} />
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Integrations"
        description="Connect your SEO and analytics accounts"
      />

      {needsReauth.map((i) => (
        <ReconnectBanner
          key={i.id}
          status={i.status!}
          onReconnect={() => handleConnect(i.provider!)}
        />
      ))}

      {integrations.length === 0 && (
        <EmptyState
          icon={Plug}
          title="No integrations connected"
          description="Connect your Google Search Console account to verify website ownership and sync SEO metrics."
        />
      )}

      {integrations.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Connected</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {integrations.map((i) => (
              <IntegrationCard
                key={i.id}
                integration={i}
                onClick={() =>
                  router.push(`/dashboard/settings/integrations/${i.id}`)
                }
              />
            ))}
          </div>
        </div>
      )}

      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Available providers</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {allProviders.map((provider) => {
            const meta = PROVIDER_METADATA[provider]
            const isConnected = connectedProviders.has(provider)
            const isConnecting = connectMutation.isPending

            if (isConnected) return null

            return (
              <Card
                key={provider}
                className={meta?.comingSoon ? "opacity-60" : ""}
              >
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-base font-medium">
                    <span className="flex items-center gap-2">
                      {meta && (
                        <meta.icon
                          className={cn("h-4 w-4", meta.color)}
                          aria-hidden="true"
                        />
                      )}
                      {meta?.label ?? provider}
                    </span>
                  </CardTitle>
                  {meta?.comingSoon && (
                    <Badge variant="secondary">Coming Soon</Badge>
                  )}
                </CardHeader>
                <CardContent>
                  {!meta?.comingSoon ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleConnect(provider)}
                      disabled={isConnecting}
                      className="gap-1.5"
                    >
                      {isConnecting && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      )}
                      Connect
                    </Button>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {provider === IntegrationProvider.GOOGLE_ANALYTICS
                        ? "Import traffic and engagement metrics."
                        : "Integration in development."}
                    </p>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      </div>
    </div>
  )
}
