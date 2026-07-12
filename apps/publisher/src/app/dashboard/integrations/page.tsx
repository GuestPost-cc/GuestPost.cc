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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  EmptyState,
  ErrorState,
  IntegrationStatusBadge,
  PageHeader,
  PROVIDER_METADATA,
  ReconnectBanner,
} from "@guestpost/ui"
import { formatDistanceToNow } from "date-fns"
import {
  CheckCircle2,
  ChevronRight,
  Loader2,
  Plug,
  RefreshCw,
  Trash2,
} from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"
import { api } from "../../../lib/api"
import {
  useConnectIntegration,
  useDisconnectIntegration,
  useIntegrations,
} from "../../../lib/hooks/integrations"

// ── Google Account Card ─────────────────────────────────────

function GoogleAccountCard({
  googleConnection,
  googleIntegrations,
  hasReauth,
  lastDiscoveryAt,
  onReconnect,
  onRediscover,
  onDisconnect,
  isReconnectPending,
  isRediscoverPending,
}: {
  googleConnection: NonNullable<IntegrationSummary["connection"]>
  googleIntegrations: IntegrationSummary[]
  hasReauth: boolean
  lastDiscoveryAt: string | null
  onReconnect: () => void
  onRediscover: () => void
  onDisconnect: () => void
  isReconnectPending: boolean
  isRediscoverPending: boolean
}) {
  const scopes = (googleConnection as any).grantedScopes ?? []
  const scopeLabels: Record<string, string> = {
    "https://www.googleapis.com/auth/webmasters.readonly": "Search Console",
    "https://www.googleapis.com/auth/analytics.readonly": "Analytics",
  }

  return (
    <Card className="overflow-hidden border-primary/10">
      <div className="bg-gradient-to-r from-blue-50 to-indigo-50 px-6 py-5">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white shadow-sm">
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="#4285F4">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-semibold">Google Account</p>
                <p className="text-sm text-muted-foreground">
                  Connected as{" "}
                  {googleConnection.email ??
                    googleConnection.displayName ??
                    "Google user"}
                </p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
              <CheckCircle2 className="h-3 w-3" />
              Connected
            </span>
          </div>
        </div>
      </div>

      <CardContent className="p-5 space-y-4">
        {/* Granted permissions */}
        {scopes.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground mr-1">
              Permissions:
            </span>
            {scopes.map((scope: string) => (
              <span
                key={scope}
                className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700"
              >
                {scopeLabels[scope] ?? scope.split(".").pop() ?? scope}
              </span>
            ))}
          </div>
        )}

        {/* Last discovery + actions */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            {lastDiscoveryAt ? (
              <span>
                Last discovery:{" "}
                {formatDistanceToNow(new Date(lastDiscoveryAt), {
                  addSuffix: true,
                })}
              </span>
            ) : (
              <span>Discovery not yet run</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onRediscover}
              disabled={isRediscoverPending}
              className="gap-1.5"
            >
              {isRediscoverPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Rediscover
            </Button>
            {hasReauth && (
              <Button
                variant="outline"
                size="sm"
                onClick={onReconnect}
                disabled={isReconnectPending}
              >
                Reconnect
              </Button>
            )}
            <Dialog>
              <DialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Disconnect Google Account?</DialogTitle>
                  <DialogDescription>
                    This will remove access tokens, stop scheduled syncs, and
                    unlink all Google services. Historical metrics will remain
                    available.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="outline" type="button">
                    Cancel
                  </Button>
                  <Button variant="destructive" onClick={onDisconnect}>
                    Disconnect
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Service Card ────────────────────────────────────────────

function ServiceCard({
  integration,
  provider,
  onConnect,
  onManage,
  isConnecting,
}: {
  integration: IntegrationSummary | undefined
  provider: IntegrationProvider
  onConnect: () => void
  onManage: () => void
  isConnecting: boolean
}) {
  const meta = PROVIDER_METADATA[provider]
  const isConnected = !!integration
  const isComingSoon = meta?.comingSoon
  const linkedCount = integration?.linkedWebsites?.length ?? 0
  const lastSyncAt =
    integration?.linkedWebsites?.find((w) => w.syncedAt)?.syncedAt ?? null
  const isActive = integration?.status === IntegrationStatus.ACTIVE

  return (
    <Card className={isComingSoon ? "opacity-60" : ""}>
      <CardContent className="p-5 space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            {meta && (
              <div
                className={`flex h-9 w-9 items-center justify-center rounded-lg ${meta.color ?? "bg-muted"} bg-opacity-10`}
              >
                <meta.icon className="h-4 w-4" aria-hidden="true" />
              </div>
            )}
            <div>
              <p className="font-medium text-sm">{meta?.label ?? provider}</p>
              {isConnected && isActive && (
                <p className="text-xs text-emerald-600 flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3" />
                  {linkedCount > 0
                    ? `${linkedCount} ${linkedCount === 1 ? "property" : "properties"} linked`
                    : "Connected"}
                </p>
              )}
              {isConnected && !isActive && (
                <p className="text-xs text-muted-foreground">
                  <IntegrationStatusBadge status={integration.status!} />
                </p>
              )}
            </div>
          </div>
          {isComingSoon && (
            <Badge variant="secondary" className="shrink-0">
              Coming Soon
            </Badge>
          )}
        </div>

        {/* No-resources state */}
        {!isConnected && !isComingSoon && (
          <div className="rounded-lg bg-muted/50 px-3 py-3 text-sm text-muted-foreground">
            <p className="font-medium text-foreground mb-0.5">
              {provider === IntegrationProvider.GOOGLE_ANALYTICS
                ? "No GA4 properties found"
                : `No ${meta?.label ?? "resources"} found`}
            </p>
            <p className="text-xs">
              {provider === IntegrationProvider.GOOGLE_ANALYTICS
                ? "Create a GA4 property in your Google account, then run Rediscover to detect it."
                : `Run Rediscover to scan for available ${meta?.label?.toLowerCase() ?? "resources"}.`}
            </p>
          </div>
        )}

        {/* Sync info */}
        {isConnected && lastSyncAt && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <RefreshCw className="h-3 w-3" />
            Last sync{" "}
            {formatDistanceToNow(new Date(lastSyncAt), { addSuffix: true })}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2">
          {isConnected ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onManage}
              className="gap-1.5"
            >
              Manage <ChevronRight className="h-3 w-3" />
            </Button>
          ) : isComingSoon ? (
            <p className="text-xs text-muted-foreground">
              Integration in development.
            </p>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={onConnect}
              disabled={isConnecting}
              className="gap-1.5"
            >
              {isConnecting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Connect
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

// ── Constants ───────────────────────────────────────────────

const REAUTH_STATUSES = new Set([
  IntegrationStatus.TOKEN_EXPIRED,
  IntegrationStatus.REAUTH_REQUIRED,
])

const GOOGLE_PROVIDERS = [
  IntegrationProvider.GOOGLE_SEARCH_CONSOLE,
  IntegrationProvider.GOOGLE_ANALYTICS,
]

// ── Page ────────────────────────────────────────────────────

export default function IntegrationsPage() {
  const router = useRouter()
  const { data, isLoading, error, refetch } = useIntegrations()
  const connectMutation = useConnectIntegration()
  const disconnectMutation = useDisconnectIntegration()
  const [rediscoverId, setRediscoverId] = useState<string | null>(null)

  const integrations: IntegrationSummary[] = data?.data ?? []

  // Map provider → integration for quick lookup
  const providerIntegrationMap = new Map<
    IntegrationProvider,
    IntegrationSummary
  >()
  for (const i of integrations) {
    if (i.provider)
      providerIntegrationMap.set(i.provider as IntegrationProvider, i)
  }

  // Google-specific helpers
  const googleIntegrations = integrations.filter(
    (i) =>
      i.provider &&
      GOOGLE_PROVIDERS.includes(i.provider as IntegrationProvider),
  )
  const googleConnection =
    googleIntegrations.find((i) => i.connection)?.connection ?? null
  const lastDiscoveryAt =
    (
      googleIntegrations.find(
        (i) => (i as any).connection?.lastDiscoveryAt,
      ) as any
    )?.connection?.lastDiscoveryAt ?? null

  // All providers sorted by display order
  const allProviders = (
    Object.values(IntegrationProvider) as IntegrationProvider[]
  ).sort(
    (a, b) =>
      (PROVIDER_METADATA[a]?.displayOrder ?? 99) -
      (PROVIDER_METADATA[b]?.displayOrder ?? 99),
  )

  const needsReauth = integrations.filter(
    (i) => i.status && REAUTH_STATUSES.has(i.status),
  )

  // ── Handlers ─────────────────────────────────────────────────

  const handleConnect = async (provider: IntegrationProvider) => {
    try {
      const result = await connectMutation.mutateAsync({
        provider,
        returnUrl: "/dashboard/integrations",
      })
      window.location.assign(result.authorizationUrl!)
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to initiate connection")
    }
  }

  const handleReconnect = async (provider: IntegrationProvider) => {
    await handleConnect(provider)
  }

  const handleDisconnectGoogle = async () => {
    const ids = googleIntegrations.map((gi) => gi.id)
    for (const id of ids) {
      try {
        await disconnectMutation.mutateAsync(id as string)
      } catch (err: any) {
        toast.error(err?.message ?? "Failed to disconnect Google integration")
        return
      }
    }
    toast.success("Google account disconnected")
    refetch()
  }

  const handleReconnectGoogle = () => {
    const reauthGoogle = needsReauth.find((r) =>
      GOOGLE_PROVIDERS.includes(r.provider as IntegrationProvider),
    )
    if (!reauthGoogle?.provider) return
    handleReconnect(reauthGoogle.provider as IntegrationProvider)
  }

  const handleRediscover = async () => {
    const connectionId = googleIntegrations.find((i) => i.connection)
      ?.connection?.id
    if (!connectionId) {
      toast.error("No Google connection found")
      return
    }
    setRediscoverId(connectionId)
    try {
      await api.integrations.rediscoverConnection(connectionId)
      toast.success("Rediscovery started — new services will appear shortly")
      setTimeout(() => refetch(), 3000)
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to start rediscovery")
    } finally {
      setRediscoverId(null)
    }
  }

  const handleTriggerSync = async (integrationId: string) => {
    router.push(`/dashboard/integrations/${integrationId}`)
  }

  // ── Loading state ────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Integrations"
          description="Connect your SEO and analytics accounts"
        />
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="rounded-xl border bg-card p-5 space-y-4 animate-pulse"
            >
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-lg bg-muted" />
                <div className="space-y-1.5">
                  <div className="h-4 w-32 rounded bg-muted" />
                  <div className="h-3 w-24 rounded bg-muted" />
                </div>
              </div>
              <div className="h-4 w-3/4 rounded bg-muted" />
              <div className="h-8 w-24 rounded bg-muted" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Integrations"
          description="Connect your SEO and analytics accounts"
        />
        <ErrorState onRetry={() => refetch()} />
      </div>
    )
  }

  const hasGoogleAccount = !!googleConnection
  const hasAnyIntegration = integrations.length > 0

  return (
    <div className="space-y-8">
      <PageHeader
        title="Integrations"
        description="Connect your SEO and analytics accounts"
      />

      {/* Re-auth banners */}
      {needsReauth.map((i) => (
        <ReconnectBanner
          key={i.id}
          status={i.status!}
          onReconnect={() => handleReconnect(i.provider as IntegrationProvider)}
        />
      ))}

      {/* Google Account section */}
      {hasGoogleAccount && (
        <GoogleAccountCard
          googleConnection={googleConnection}
          googleIntegrations={googleIntegrations}
          hasReauth={needsReauth.some((r) =>
            GOOGLE_PROVIDERS.includes(r.provider as IntegrationProvider),
          )}
          lastDiscoveryAt={lastDiscoveryAt}
          onReconnect={handleReconnectGoogle}
          onRediscover={handleRediscover}
          onDisconnect={handleDisconnectGoogle}
          isReconnectPending={connectMutation.isPending}
          isRediscoverPending={rediscoverId !== null}
        />
      )}

      {/* Google service cards */}
      {hasGoogleAccount && (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Services</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {GOOGLE_PROVIDERS.map((provider) => (
              <ServiceCard
                key={provider}
                integration={providerIntegrationMap.get(provider)}
                provider={provider}
                onConnect={() => handleConnect(provider)}
                onManage={() => {
                  const gi = providerIntegrationMap.get(provider)
                  if (gi) router.push(`/dashboard/integrations/${gi.id}`)
                }}
                isConnecting={connectMutation.isPending}
              />
            ))}
          </div>
        </section>
      )}

      {/* Other providers (Bing, etc.) */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Available providers</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {allProviders.map((provider) => {
            const meta = PROVIDER_METADATA[provider]
            const isGoogle = GOOGLE_PROVIDERS.includes(provider)
            const isConnected = providerIntegrationMap.has(provider)
            const isConnecting = connectMutation.isPending

            // Google services shown above
            if (isGoogle && hasGoogleAccount) return null

            // Google services shown as connect cards when no account yet
            if (isGoogle && !hasGoogleAccount) {
              return (
                <ServiceCard
                  key={provider}
                  integration={undefined}
                  provider={provider}
                  onConnect={() => handleConnect(provider)}
                  onManage={() => {}}
                  isConnecting={isConnecting}
                />
              )
            }

            // Non-Google providers
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
                          className={`h-4 w-4 ${meta.color ?? ""}`}
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
                      Integration in development.
                    </p>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      </section>

      {/* Empty state */}
      {!hasAnyIntegration && !hasGoogleAccount && (
        <EmptyState
          icon={Plug}
          title="No integrations connected"
          description="Connect your Google account to link search performance data and traffic analytics."
        />
      )}
    </div>
  )
}
