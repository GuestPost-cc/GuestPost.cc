"use client"

import { IntegrationProvider, IntegrationStatus } from "@guestpost/api-client"
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  ErrorState,
  PageHeader,
  PROVIDER_METADATA,
  ReconnectBanner,
} from "@guestpost/ui"
import { formatDistanceToNow } from "date-fns"
import {
  CheckCircle2,
  ChevronRight,
  Loader2,
  RefreshCw,
  Trash2,
} from "lucide-react"
import { useRouter, useSearchParams } from "next/navigation"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { api } from "../../../lib/api"
import {
  useConnectIntegration,
  useDisconnectIntegration,
  useIntegrations,
} from "../../../lib/hooks/integrations"

// ── Google Account Card ─────────────────────────────────────

function GoogleAccountCard({
  email,
  grantedScopes,
  lastDiscoveryAt,
  needsReauth,
  onReconnect,
  onRediscover,
  onDisconnect,
  isReconnectPending,
  isRediscoverPending,
}: {
  email: string | null
  grantedScopes: string[]
  lastDiscoveryAt: string | null
  needsReauth: boolean
  onReconnect: () => void
  onRediscover: () => void
  onDisconnect: () => void
  isReconnectPending: boolean
  isRediscoverPending: boolean
}) {
  const scopeLabels: Record<string, string> = {
    "https://www.googleapis.com/auth/webmasters.readonly": "Search Console",
    "https://www.googleapis.com/auth/analytics.readonly": "Analytics",
  }

  return (
    <Card className="overflow-hidden border-primary/10">
      <div className="bg-gradient-to-r from-blue-50 to-indigo-50 px-6 py-5">
        <div className="flex items-start justify-between">
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
                {email ?? "Connected"}
              </p>
            </div>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
            <CheckCircle2 className="h-3 w-3" />
            Connected
          </span>
        </div>
      </div>

      <CardContent className="p-5 space-y-4">
        {grantedScopes.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground mr-1">
              Permissions:
            </span>
            {grantedScopes.map((scope) => (
              <span
                key={scope}
                className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700"
              >
                {scopeLabels[scope] ?? scope.split(".").pop() ?? scope}
              </span>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground">
            {lastDiscoveryAt
              ? `Last discovery: ${formatDistanceToNow(new Date(lastDiscoveryAt), { addSuffix: true })}`
              : "Discovery not yet run"}
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
            {needsReauth && (
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
                    Remove access tokens and stop all Google service syncs.
                    Historical metrics remain.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter className="gap-2">
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
  displayName,
  resourceCount,
  linkedCount,
  lastSyncAt,
  hasNoResources,
  onManage,
  emptyMessage,
  meta,
}: {
  displayName: string
  resourceCount: number
  linkedCount: number
  lastSyncAt: string | null
  hasNoResources: boolean
  onManage: () => void
  emptyMessage: string
  meta: { label?: string; icon?: React.ElementType; color?: string } | null
}) {
  const Icon = meta?.icon

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            {Icon && (
              <div
                className={`flex h-9 w-9 items-center justify-center rounded-lg ${meta?.color ?? "bg-muted"}`}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
              </div>
            )}
            <div>
              <p className="font-medium text-sm">{displayName}</p>
              {!hasNoResources ? (
                <p className="text-xs text-muted-foreground">
                  {resourceCount}{" "}
                  {resourceCount === 1 ? "property" : "properties"} discovered
                  {linkedCount > 0 ? ` \u00b7 ${linkedCount} linked` : ""}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No properties found
                </p>
              )}
            </div>
          </div>
        </div>

        {!hasNoResources ? (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {lastSyncAt ? (
                <>
                  <RefreshCw className="h-3 w-3" />
                  Last sync{" "}
                  {formatDistanceToNow(new Date(lastSyncAt), {
                    addSuffix: true,
                  })}
                </>
              ) : (
                <span>Not yet synced</span>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={onManage}
              className="gap-1.5"
            >
              Manage <ChevronRight className="h-3 w-3" />
            </Button>
          </div>
        ) : (
          <div className="rounded-lg bg-muted/50 px-3 py-2.5">
            <p className="text-xs text-muted-foreground">{emptyMessage}</p>
          </div>
        )}
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
  const searchParams = useSearchParams()

  // Show toast when redirected back from OAuth callback
  useEffect(() => {
    const connected = searchParams.get("connected")
    const error = searchParams.get("error")
    if (connected) {
      toast.success("Google account connected. Discovering services...")
      // Refetch after a short delay so discovery results appear
      setTimeout(() => refetch(), 3000)
      setTimeout(() => refetch(), 8000)
    }
    if (error) {
      toast.error(error)
    }
  }, [searchParams, refetch])

  const integrations = data?.data ?? []

  // Find the Google connection from any Google integration
  const googleAccount = integrations.find(
    (i: any) => i.connection && GOOGLE_PROVIDERS.includes(i.provider),
  ) as any
  const googleConnection = googleAccount?.connection ?? null
  const hasGoogleAccount = !!googleConnection

  // Build a services map: provider → integration
  const services = new Map<string, any>()
  for (const i of integrations) {
    if (i.provider) services.set(i.provider, i)
  }

  const needsReauth = integrations.filter(
    (i: any) => i.status && REAUTH_STATUSES.has(i.status),
  )

  // ── Handlers ─────────────────────────────────────────────────

  const handleConnectGoogle = async () => {
    try {
      const result = await connectMutation.mutateAsync({
        provider: IntegrationProvider.GOOGLE_SEARCH_CONSOLE,
        returnUrl: `${window.location.origin}/dashboard/integrations`,
      })
      window.location.assign(result.authorizationUrl!)
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to initiate connection")
    }
  }

  const handleRediscover = async () => {
    if (!googleConnection?.id) {
      toast.error("No Google connection found")
      return
    }
    setRediscoverId(googleConnection.id)
    try {
      await api.integrations.rediscoverConnection(googleConnection.id)
      toast.success("Rediscovery started")
      setTimeout(() => refetch(), 3000)
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to start rediscovery")
    } finally {
      setRediscoverId(null)
    }
  }

  const handleDisconnectGoogle = async () => {
    const ids = integrations
      .filter((i: any) => GOOGLE_PROVIDERS.includes(i.provider))
      .map((i: any) => i.id)
    for (const id of ids) {
      try {
        await disconnectMutation.mutateAsync(id as string)
      } catch {
        toast.error("Failed to disconnect")
        return
      }
    }
    toast.success("Google account disconnected")
    refetch()
  }

  const handleReconnectGoogle = () => {
    const reauthGoogle = needsReauth.find((r: any) =>
      GOOGLE_PROVIDERS.includes(r.provider),
    )
    if (!reauthGoogle?.provider) return
    handleConnectGoogle()
  }

  // ── Loading ─────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Integrations"
          description="Connect your SEO and analytics accounts"
        />
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
            <div className="h-8 w-24 rounded bg-muted" />
          </div>
        ))}
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

  return (
    <div className="space-y-8">
      <PageHeader
        title="Integrations"
        description="Connect your SEO and analytics accounts"
      />

      {/* Re-auth banners */}
      {needsReauth.map((i: any) => (
        <ReconnectBanner
          key={i.id}
          status={i.status}
          onReconnect={() => handleConnectGoogle()}
        />
      ))}

      {hasGoogleAccount ? (
        <>
          {/* Google Account */}
          <GoogleAccountCard
            email={
              googleConnection.email ?? googleConnection.displayName ?? null
            }
            grantedScopes={googleConnection.grantedScopes ?? []}
            lastDiscoveryAt={googleConnection.lastDiscoveryAt ?? null}
            needsReauth={needsReauth.some((r: any) =>
              GOOGLE_PROVIDERS.includes(r.provider),
            )}
            onReconnect={handleReconnectGoogle}
            onRediscover={handleRediscover}
            onDisconnect={handleDisconnectGoogle}
            isReconnectPending={connectMutation.isPending}
            isRediscoverPending={rediscoverId !== null}
          />

          {/* Google Services (GSC, GA4) */}
          <section className="space-y-4">
            <h2 className="text-lg font-semibold">Services</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              {GOOGLE_PROVIDERS.map((provider) => {
                const svc = services.get(provider)
                const allResources = (svc?.linkedWebsites ?? []).length
                const linkedCount = (svc?.linkedWebsites ?? []).filter(
                  (w: any) =>
                    w.status === "CONNECTED" || w.status === "SYNCING",
                ).length
                const lastSync =
                  svc?.linkedWebsites?.find((w: any) => w.syncedAt)?.syncedAt ??
                  null
                const meta = PROVIDER_METADATA[provider]
                const displayName =
                  provider === "GOOGLE_SEARCH_CONSOLE"
                    ? "Search Console"
                    : "Analytics"
                const emptyMessage =
                  provider === "GOOGLE_ANALYTICS"
                    ? "Create a GA4 property in your Google account, then run Rediscover above to detect it."
                    : "Run Rediscover above to scan for available properties."

                return (
                  <ServiceCard
                    key={provider}
                    displayName={displayName}
                    resourceCount={allResources}
                    linkedCount={linkedCount}
                    lastSyncAt={lastSync}
                    hasNoResources={allResources === 0}
                    onManage={() => {
                      if (svc) router.push(`/dashboard/integrations/${svc.id}`)
                    }}
                    emptyMessage={emptyMessage}
                    meta={meta ?? null}
                  />
                )
              })}
            </div>
          </section>
        </>
      ) : (
        /* No Google account — show Connect card */
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-12">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-blue-50">
              <svg viewBox="0 0 24 24" className="h-7 w-7" fill="#4285F4">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
              </svg>
            </div>
            <div className="text-center">
              <p className="text-lg font-semibold">
                Connect your Google account
              </p>
              <p className="text-sm text-muted-foreground mt-1 max-w-md">
                Link Google to automatically pull your Search Console and
                Analytics data. GuestPost discovers all available services and
                properties.
              </p>
            </div>
            <Button
              onClick={handleConnectGoogle}
              disabled={connectMutation.isPending}
              className="gap-2"
            >
              {connectMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <svg
                  viewBox="0 0 24 24"
                  className="h-4 w-4"
                  fill="currentColor"
                >
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                </svg>
              )}
              Connect Google
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Other providers (Bing, future) */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Available integrations</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Object.values(IntegrationProvider)
            .filter((p) => !GOOGLE_PROVIDERS.includes(p))
            .map((provider) => {
              const meta = PROVIDER_METADATA[provider]
              return (
                <Card key={provider} className="opacity-60">
                  <CardContent className="flex items-center gap-3 p-5">
                    {meta && (
                      <div
                        className={`flex h-9 w-9 items-center justify-center rounded-lg ${meta.color ?? "bg-muted"}`}
                      >
                        <meta.icon className="h-4 w-4" aria-hidden="true" />
                      </div>
                    )}
                    <div className="flex-1">
                      <p className="text-sm font-medium">
                        {meta?.label ?? provider}
                      </p>
                      <Badge variant="secondary" className="mt-1">
                        Coming Soon
                      </Badge>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
        </div>
      </section>
    </div>
  )
}
