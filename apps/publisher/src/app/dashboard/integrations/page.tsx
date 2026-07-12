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
  Separator,
} from "@guestpost/ui"
import { formatDistanceToNow } from "date-fns"
import {
  CheckCircle2,
  ExternalLink,
  Loader2,
  Plug,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  useConnectIntegration,
  useDisconnectIntegration,
  useIntegrations,
} from "../../../lib/hooks/integrations"

// ── Google Account Card Component ────────────────────────────

interface GoogleAccountCardProps {
  googleConnection: NonNullable<IntegrationSummary["connection"]>
  googleIntegrations: IntegrationSummary[]
  hasReauth: boolean
  onReconnect: () => void
  onDisconnect: () => void
  isPending: boolean
}

function GoogleAccountCard({
  googleConnection,
  googleIntegrations,
  hasReauth,
  onReconnect,
  onDisconnect,
  isPending,
}: GoogleAccountCardProps) {
  const isActive = googleIntegrations.some(
    (gi) => gi.status === IntegrationStatus.ACTIVE,
  )
  const overallStatus = isActive
    ? IntegrationStatus.ACTIVE
    : (googleIntegrations[0]?.status ?? IntegrationStatus.ERROR)

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <Search className="h-5 w-5 text-blue-500" aria-hidden="true" />
              Google Account
            </CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Connected as:{" "}
              <span className="font-medium text-foreground">
                {googleConnection.email ??
                  googleConnection.displayName ??
                  "Google Account"}
              </span>
            </p>
          </div>
          <IntegrationStatusBadge status={overallStatus} />
        </div>
      </CardHeader>

      {googleConnection.grantedScopes &&
        googleConnection.grantedScopes.length > 0 && (
          <CardContent className="pb-3">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
              Granted permissions
            </p>
            <div className="flex flex-wrap gap-2">
              {googleIntegrations.map((gi) => {
                const meta =
                  PROVIDER_METADATA[gi.provider as IntegrationProvider]
                return (
                  <Badge
                    key={gi.id}
                    variant="secondary"
                    className="gap-1.5 py-1"
                  >
                    <CheckCircle2
                      className="h-3.5 w-3.5 text-emerald-500"
                      aria-hidden="true"
                    />
                    {meta?.label ?? gi.provider}
                  </Badge>
                )
              })}
            </div>
          </CardContent>
        )}

      <Separator />

      <div className="flex items-center gap-2 px-6 py-3">
        {hasReauth && (
          <Button
            variant="outline"
            size="sm"
            onClick={onReconnect}
            className="gap-1.5"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Reconnect
          </Button>
        )}
        <Dialog>
          <DialogTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-destructive hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Disconnect
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Disconnect Google Account?</DialogTitle>
              <DialogDescription>
                This will remove access tokens and stop scheduled syncs for all
                Google services ({googleIntegrations.length} total). Historical
                metrics will remain available.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogTrigger asChild>
                <Button variant="outline">Cancel</Button>
              </DialogTrigger>
              <Button
                variant="destructive"
                onClick={onDisconnect}
                disabled={isPending}
                className="gap-1.5"
              >
                {isPending && (
                  <Loader2
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                )}
                Disconnect
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </Card>
  )
}

// ── Page Component ──────────────────────────────────────────

const REAUTH_STATUSES = new Set([
  IntegrationStatus.TOKEN_EXPIRED,
  IntegrationStatus.REAUTH_REQUIRED,
])

export default function IntegrationsPage() {
  const router = useRouter()
  const { data, isLoading, error, refetch } = useIntegrations()
  const connectMutation = useConnectIntegration()
  const disconnectMutation = useDisconnectIntegration()

  const integrations: IntegrationSummary[] = data?.data ?? []

  // Map provider → integration for quick lookup
  const providerIntegrationMap = new Map<
    IntegrationProvider,
    IntegrationSummary
  >()
  for (const i of integrations) {
    if (i.provider) providerIntegrationMap.set(i.provider, i)
  }

  // Google-specific helpers
  const googleProviders = [
    IntegrationProvider.GOOGLE_SEARCH_CONSOLE,
    IntegrationProvider.GOOGLE_ANALYTICS,
  ]
  const googleIntegrations = integrations.filter(
    (i) => i.provider && googleProviders.includes(i.provider),
  )
  const googleConnection =
    googleIntegrations.find((i) => i.connection)?.connection ?? null

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
      googleProviders.includes(r.provider as IntegrationProvider),
    )
    if (!reauthGoogle?.provider) return
    handleReconnect(reauthGoogle.provider as IntegrationProvider)
  }

  const handleTriggerSync = async (integrationId: string) => {
    // Simple sync trigger — navigate to detail page for full controls
    router.push(`/dashboard/integrations/${integrationId}`)
  }

  // ── Loading state (matching orders page skeleton) ────────────

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Integrations"
          description="Connect your SEO and analytics accounts"
        />
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="rounded-xl border bg-card p-5 space-y-4 animate-pulse"
            >
              <div className="flex justify-between">
                <div className="h-3 w-20 rounded bg-muted" />
                <div className="h-5 w-16 rounded-full bg-muted" />
              </div>
              <div className="space-y-2">
                <div className="h-5 w-3/4 rounded bg-muted" />
                <div className="h-4 w-1/2 rounded bg-muted" />
              </div>
              <div className="flex justify-between">
                <div className="h-4 w-2/5 rounded bg-muted" />
                <div className="h-4 w-14 rounded bg-muted" />
              </div>
              <div className="h-8 rounded bg-muted" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  // ── Error state ──────────────────────────────────────────────

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

  // ── Empty state ──────────────────────────────────────────────

  if (integrations.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Integrations"
          description="Connect your SEO and analytics accounts"
        />
        <EmptyState
          icon={Plug}
          title="No integrations connected"
          description="Connect your Google Search Console account to link search performance data and sync SEO metrics."
        />
        <div className="space-y-3">
          {allProviders
            .filter((p) => !PROVIDER_METADATA[p]?.comingSoon)
            .map((provider) => {
              const meta = PROVIDER_METADATA[provider]
              const isConnecting = connectMutation.isPending
              return (
                <Card key={provider}>
                  <CardContent className="py-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {meta && (
                          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
                            <meta.icon
                              className={cn("h-4 w-4", meta.color)}
                              aria-hidden="true"
                            />
                          </div>
                        )}
                        <div>
                          <p className="text-sm font-medium">
                            {meta?.label ?? provider}
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {provider === IntegrationProvider.GOOGLE_ANALYTICS
                              ? "Import traffic and engagement metrics."
                              : "Connect to sync SEO data."}
                          </p>
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleConnect(provider)}
                        disabled={isConnecting}
                        className="gap-1.5"
                      >
                        {isConnecting && (
                          <Loader2
                            className="h-3.5 w-3.5 animate-spin"
                            aria-hidden="true"
                          />
                        )}
                        Connect
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          {/* Bing Coming Soon */}
          {allProviders
            .filter((p) => PROVIDER_METADATA[p]?.comingSoon)
            .map((provider) => {
              const meta = PROVIDER_METADATA[provider]
              return (
                <Card key={provider} className="opacity-60">
                  <CardContent className="py-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {meta && (
                          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
                            <meta.icon
                              className={cn("h-4 w-4", meta.color)}
                              aria-hidden="true"
                            />
                          </div>
                        )}
                        <div>
                          <p className="text-sm font-medium">
                            {meta?.label ?? provider}
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Integration in development
                          </p>
                        </div>
                      </div>
                      <Badge variant="secondary">Coming Soon</Badge>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
        </div>
      </div>
    )
  }

  // ── Main content ────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <PageHeader
        title="Integrations"
        description="Connect your SEO and analytics accounts"
      />

      {/* Reconnect banners */}
      {needsReauth.map((i) => (
        <ReconnectBanner
          key={i.id}
          status={i.status!}
          onReconnect={() => handleReconnect(i.provider!)}
        />
      ))}

      {/* Google Account header card */}
      {googleConnection && (
        <GoogleAccountCard
          googleConnection={googleConnection}
          googleIntegrations={googleIntegrations}
          hasReauth={needsReauth.some((r) =>
            googleProviders.includes(r.provider as IntegrationProvider),
          )}
          onReconnect={handleReconnectGoogle}
          onDisconnect={handleDisconnectGoogle}
          isPending={disconnectMutation.isPending}
        />
      )}

      {/* Service cards */}
      <div className="space-y-3">
        {allProviders.map((provider) => {
          const meta = PROVIDER_METADATA[provider]
          const integration = providerIntegrationMap.get(provider)
          const isConnected = !!integration
          const isGoogleProvider = googleProviders.includes(provider)

          // ── Coming soon ──────────────────────────────────────
          if (meta?.comingSoon) {
            return (
              <Card key={provider} className="opacity-60">
                <CardContent className="py-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
                        <meta.icon
                          className={cn("h-4 w-4", meta.color)}
                          aria-hidden="true"
                        />
                      </div>
                      <div>
                        <p className="text-sm font-medium">{meta.label}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Integration in development
                        </p>
                      </div>
                    </div>
                    <Badge variant="secondary">Coming Soon</Badge>
                  </div>
                </CardContent>
              </Card>
            )
          }

          // ── Connected service ────────────────────────────────
          if (isConnected && integration) {
            const linkedCount = integration.linkedWebsites?.length ?? 0
            const lastSyncAt = integration.updatedAt
            const isActive = integration.status === IntegrationStatus.ACTIVE

            return (
              <Card
                key={provider}
                className="transition-shadow hover:shadow-md"
              >
                <CardContent className="py-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className={cn(
                          "flex h-9 w-9 items-center justify-center rounded-lg shrink-0",
                          isActive ? "bg-emerald-50" : "bg-muted",
                        )}
                      >
                        {meta && (
                          <meta.icon
                            className={cn("h-4 w-4", meta.color)}
                            aria-hidden="true"
                          />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium">
                            {meta?.label ?? provider}
                          </p>
                          <IntegrationStatusBadge
                            status={integration.status!}
                          />
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">
                          {linkedCount} site{linkedCount !== 1 ? "s" : ""}{" "}
                          linked
                          {lastSyncAt && (
                            <>
                              {" "}
                              · Last sync:{" "}
                              {formatDistanceToNow(new Date(lastSyncAt), {
                                addSuffix: true,
                              })}
                            </>
                          )}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          router.push(
                            `/dashboard/integrations/${integration.id}`,
                          )
                        }
                        className="gap-1"
                      >
                        Manage
                        <ExternalLink className="h-3 w-3" aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          }

          // ── Non-connected / available provider ──────────────
          const isConnecting = connectMutation.isPending
          return (
            <Card key={provider}>
              <CardContent className="py-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0">
                    {meta && (
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted shrink-0">
                        <meta.icon
                          className={cn("h-4 w-4", meta.color)}
                          aria-hidden="true"
                        />
                      </div>
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {meta?.label ?? provider}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">
                        {provider === IntegrationProvider.GOOGLE_ANALYTICS
                          ? "Connect to pull traffic and engagement metrics."
                          : "Not connected"}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleConnect(provider)}
                    disabled={isConnecting}
                    className="gap-1.5 shrink-0"
                  >
                    {isConnecting && (
                      <Loader2
                        className="h-3.5 w-3.5 animate-spin"
                        aria-hidden="true"
                      />
                    )}
                    Connect
                  </Button>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
