"use client"

import type { IntegrationSummary, SyncJob } from "@guestpost/api-client"
import { IntegrationProvider, IntegrationStatus } from "@guestpost/api-client"

// WebsiteIntegrationStatus values (not re-exported from api-client)
const WebsiteIntegrationStatus = {
  CONNECTED: "CONNECTED" as const,
  SYNCING: "SYNCING" as const,
  OUT_OF_SYNC: "OUT_OF_SYNC" as const,
  REMOVED: "REMOVED" as const,
  DISABLED: "DISABLED" as const,
}
type WebsiteIntegrationStatus =
  (typeof WebsiteIntegrationStatus)[keyof typeof WebsiteIntegrationStatus]

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
  ErrorState,
  IntegrationStatusBadge,
  ProviderBadge,
  ReconnectBanner,
  SyncHistoryTable,
} from "@guestpost/ui"
import { useQueryClient } from "@tanstack/react-query"
import { formatDistanceToNow } from "date-fns"
import {
  ArrowLeft,
  Globe,
  Link2,
  Loader2,
  RefreshCw,
  Search,
  Table,
  Trash2,
} from "lucide-react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"
import {
  useConnectIntegration,
  useDisconnectIntegration,
  useDiscoverResources,
  useIntegration,
  useLinkProperty,
  useResources,
  useSyncHistory,
  useTriggerSync,
  useUnlinkProperty,
} from "../../../../lib/hooks/integrations"

// ── Local types (not re-exported from api-client) ──────────

interface LinkedWebsite {
  id: string
  websiteId: string
  externalResourceId: string
  externalResourceName: string | null
  status: WebsiteIntegrationStatus
  syncedAt: string | null
}

interface Pagination {
  page: number
  pageSize: number
  total: number
  hasNext: boolean
}

// Resources response item
type DiscoveredResourceItem = {
  externalResourceId: string
  externalResourceName: string | null
  metadata: Record<string, unknown> | null
}

// ── Helpers ──────────────────────────────────────────────────

const WEBSITE_STATUS_META: Record<
  WebsiteIntegrationStatus,
  {
    label: string
    variant: "success" | "info" | "warning" | "secondary" | "destructive"
  }
> = {
  [WebsiteIntegrationStatus.CONNECTED]: {
    label: "Connected",
    variant: "success",
  },
  [WebsiteIntegrationStatus.SYNCING]: { label: "Syncing", variant: "info" },
  [WebsiteIntegrationStatus.OUT_OF_SYNC]: {
    label: "Out of sync",
    variant: "warning",
  },
  [WebsiteIntegrationStatus.REMOVED]: {
    label: "Removed",
    variant: "secondary",
  },
  [WebsiteIntegrationStatus.DISABLED]: {
    label: "Disabled",
    variant: "destructive",
  },
}

function WebsiteStatusBadge({ status }: { status: WebsiteIntegrationStatus }) {
  const meta = WEBSITE_STATUS_META[status] ?? {
    label: status,
    variant: "secondary" as const,
  }
  return <Badge variant={meta.variant}>{meta.label}</Badge>
}

// ── Page Component ───────────────────────────────────────────

export default function IntegrationDetailPage() {
  const params = useParams()
  const router = useRouter()
  const queryClient = useQueryClient()
  const integrationId = params.id as string

  const [showDisconnect, setShowDisconnect] = useState(false)
  const [selectedResourceId, setSelectedResourceId] = useState<string | null>(
    null,
  )

  // ── Queries ──────────────────────────────────────────────

  const {
    data: integration,
    isLoading,
    error,
    refetch,
  } = useIntegration(integrationId)
  const { data: resourcesData, refetch: refetchResources } =
    useResources(integrationId)
  const {
    data: syncHistory,
    refetch: refetchSyncHistory,
    isLoading: syncHistoryLoading,
  } = useSyncHistory(integrationId, { pageSize: 10 })

  // ── Mutations ────────────────────────────────────────────

  const discoverMutation = useDiscoverResources(integrationId)
  const linkMutation = useLinkProperty(integrationId)
  const unlinkMutation = useUnlinkProperty(integrationId)
  const triggerSyncMutation = useTriggerSync(integrationId)
  const disconnectMutation = useDisconnectIntegration()
  const connectMutation = useConnectIntegration()

  // ── Derived state ────────────────────────────────────────

  const provider = integration?.provider
  const status = integration?.status
  const needsReauth =
    status === IntegrationStatus.TOKEN_EXPIRED ||
    status === IntegrationStatus.REAUTH_REQUIRED
  const isDiscovering = status === IntegrationStatus.DISCOVERING
  const isDisconnected = status === IntegrationStatus.DISCONNECTED
  const canSync =
    !isDiscovering &&
    !needsReauth &&
    !isDisconnected &&
    !triggerSyncMutation.isPending

  const linkedWebsites: LinkedWebsite[] = (integration?.linkedWebsites ??
    []) as LinkedWebsite[]
  const resources = resourcesData?.resources ?? []
  const discoveredAt = resourcesData?.discoveredAt ?? null
  const syncRows: SyncJob[] = syncHistory?.data ?? []
  const initialPagination: Pagination = {
    page: 1,
    pageSize: 10,
    total: 0,
    hasNext: false,
  }
  const pagination: Pagination =
    (syncHistory?.pagination as Pagination | undefined) ?? initialPagination
  const connection = integration?.connection

  // ── Handlers ─────────────────────────────────────────────

  const handleReconnect = async () => {
    if (!provider) return
    try {
      const result = await connectMutation.mutateAsync({
        provider,
        returnUrl: `/dashboard/integrations/${integrationId}`,
      })
      window.location.assign(result.authorizationUrl!)
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to initiate reconnection")
    }
  }

  const handleDiscover = async () => {
    try {
      await discoverMutation.mutateAsync()
      toast.success("Discovery started")
    } catch (err: any) {
      toast.error(err?.message ?? "Discovery failed")
    }
  }

  const handleLink = async (externalResourceId: string) => {
    try {
      await linkMutation.mutateAsync({
        websiteId: "",
        externalResourceId,
      })
      toast.success("Property linked")
      await refetch()
      await refetchResources()
      setSelectedResourceId(null)
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to link property")
    }
  }

  const handleUnlink = async (websiteIntegrationId: string) => {
    try {
      await unlinkMutation.mutateAsync(websiteIntegrationId)
      toast.success("Website unlinked")
      await refetch()
      await refetchResources()
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to unlink")
    }
  }

  const handleTriggerSync = async () => {
    try {
      await triggerSyncMutation.mutateAsync({})
      toast.success("Sync started")
      setTimeout(() => refetchSyncHistory(), 2000)
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to trigger sync")
    }
  }

  const handleDisconnect = async () => {
    try {
      await disconnectMutation.mutateAsync(integrationId)
      toast.success("Integration disconnected")
      router.push("/dashboard/integrations")
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to disconnect")
    }
  }

  const handlePageChange = (_page: number) => {
    // Pagination is not implemented via the current hook — the backend
    // returns a page at a time. Placeholder for future expansion.
  }

  // ── Loading state ────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        {/* Back link skeleton */}
        <div className="h-4 w-24 rounded bg-muted" />

        {/* Header skeleton */}
        <div className="flex items-center gap-3">
          <div className="h-8 w-40 rounded bg-muted" />
          <div className="h-6 w-24 rounded-full bg-muted" />
        </div>

        {/* Connection card skeleton */}
        <div className="rounded-xl border p-5 space-y-3">
          <div className="h-5 w-36 rounded bg-muted" />
          <div className="h-4 w-48 rounded bg-muted" />
          <div className="flex gap-2">
            <div className="h-6 w-20 rounded-full bg-muted" />
            <div className="h-6 w-28 rounded-full bg-muted" />
          </div>
        </div>

        {/* Content skeleton */}
        <div className="space-y-3">
          <div className="h-6 w-40 rounded bg-muted" />
          <div className="h-32 rounded-xl bg-muted" />
        </div>
        <div className="space-y-3">
          <div className="h-6 w-40 rounded bg-muted" />
          <div className="h-32 rounded-xl bg-muted" />
        </div>
      </div>
    )
  }

  // ── Error state ──────────────────────────────────────────

  if (error || !integration) {
    return (
      <div className="space-y-6">
        <Link
          href="/dashboard/integrations"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Integrations
        </Link>
        <ErrorState onRetry={() => refetch()} />
      </div>
    )
  }

  // ── Main render ──────────────────────────────────────────

  return (
    <div className="space-y-8">
      {/* ── Back link ─────────────────────────────────────── */}
      <Link
        href="/dashboard/integrations"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Integrations
      </Link>

      {/* ── Header: provider badge + status ──────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ProviderBadge provider={provider as IntegrationProvider} />
          <IntegrationStatusBadge status={status as IntegrationStatus} />
        </div>
      </div>

      {/* ── Reconnect banner ──────────────────────────────── */}
      {needsReauth && (
        <ReconnectBanner
          status={status as IntegrationStatus}
          onReconnect={handleReconnect}
        />
      )}

      {/* ── Connection info card ──────────────────────────── */}
      {connection && <ConnectionInfoCard connection={connection} />}

      {/* ── Linked Websites ───────────────────────────────── */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Linked Websites</h2>

        {linkedWebsites.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border py-10 text-center">
            <Globe
              className="h-8 w-8 text-muted-foreground"
              aria-hidden="true"
            />
            <p className="text-sm text-muted-foreground">No linked websites.</p>
            <p className="text-xs text-muted-foreground max-w-sm">
              Discover and link a property below to start syncing data.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border">
            <table className="w-full">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="py-3 pl-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Resource
                  </th>
                  <th className="py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Status
                  </th>
                  <th className="py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Last Synced
                  </th>
                  <th className="py-3 pr-4 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {linkedWebsites.map((w) => (
                  <tr key={w.id} className="border-b last:border-0">
                    <td className="py-3 pl-4">
                      <div>
                        <p className="text-sm font-medium">
                          {w.externalResourceName ?? w.externalResourceId}
                        </p>
                        {w.externalResourceName && (
                          <p className="text-xs text-muted-foreground mt-0.5 font-mono">
                            {w.externalResourceId}
                          </p>
                        )}
                      </div>
                    </td>
                    <td className="py-3">
                      <WebsiteStatusBadge status={w.status} />
                    </td>
                    <td className="py-3 text-sm text-muted-foreground">
                      {w.syncedAt
                        ? formatDistanceToNow(new Date(w.syncedAt), {
                            addSuffix: true,
                          })
                        : "Never"}
                    </td>
                    <td className="py-3 pr-4 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleUnlink(w.id)}
                        className="gap-1.5 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        Unlink
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Available Resources ────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Available Properties</h2>
          <Button
            variant="outline"
            size="sm"
            onClick={handleDiscover}
            disabled={discoverMutation.isPending || isDiscovering}
            className="gap-1.5"
          >
            {discoverMutation.isPending || isDiscovering ? (
              <Loader2
                className="h-3.5 w-3.5 animate-spin"
                aria-hidden="true"
              />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {isDiscovering ? "Discovering..." : "Discover"}
          </Button>
        </div>

        {discoveredAt && (
          <p className="text-xs text-muted-foreground">
            Discovered {new Date(discoveredAt).toLocaleString()}
          </p>
        )}

        {discoverMutation.isPending || isDiscovering ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        ) : resources.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border py-10 text-center">
            <Table
              className="h-8 w-8 text-muted-foreground"
              aria-hidden="true"
            />
            <p className="text-sm text-muted-foreground">
              No properties discovered yet.
            </p>
            <p className="text-xs text-muted-foreground max-w-sm">
              Click "Discover" to fetch available properties from the provider.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border">
            <table className="w-full">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="py-3 pl-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Resource ID
                  </th>
                  <th className="py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Name
                  </th>
                  <th className="py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Metadata
                  </th>
                  <th className="py-3 pr-4 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {(resources as DiscoveredResourceItem[]).map((r) => {
                  const isAlreadyLinked = linkedWebsites.some(
                    (lw) => lw.externalResourceId === r.externalResourceId,
                  )
                  const isSelected = r.externalResourceId === selectedResourceId
                  const isLinking = isSelected && linkMutation.isPending

                  return (
                    <tr
                      key={r.externalResourceId}
                      className={cn(
                        "border-b last:border-0",
                        isAlreadyLinked && "opacity-50",
                      )}
                    >
                      <td className="py-3 pl-4 font-mono text-sm">
                        {r.externalResourceId}
                      </td>
                      <td className="py-3 text-sm">
                        {r.externalResourceName ?? "—"}
                      </td>
                      <td className="py-3 text-sm text-muted-foreground">
                        {r.metadata ? Object.keys(r.metadata).join(", ") : "—"}
                      </td>
                      <td className="py-3 pr-4 text-right">
                        {isAlreadyLinked ? (
                          <Badge variant="secondary" className="text-xs">
                            Linked
                          </Badge>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setSelectedResourceId(r.externalResourceId)
                              handleLink(r.externalResourceId)
                            }}
                            disabled={isLinking}
                            className="gap-1.5"
                          >
                            {isLinking ? (
                              <Loader2
                                className="h-3.5 w-3.5 animate-spin"
                                aria-hidden="true"
                              />
                            ) : (
                              <Link2
                                className="h-3.5 w-3.5"
                                aria-hidden="true"
                              />
                            )}
                            Link
                          </Button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Sync History ────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Sync History</h2>
          <Button
            variant="outline"
            size="sm"
            onClick={handleTriggerSync}
            disabled={!canSync}
            className="gap-1.5"
            title={
              !canSync
                ? isDiscovering
                  ? "Cannot sync while discovering"
                  : needsReauth
                    ? "Reconnect required before syncing"
                    : triggerSyncMutation.isPending
                      ? "Sync in progress"
                      : "Cannot sync"
                : undefined
            }
          >
            {triggerSyncMutation.isPending ? (
              <Loader2
                className="h-3.5 w-3.5 animate-spin"
                aria-hidden="true"
              />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Sync Now
          </Button>
        </div>

        <SyncHistoryTable
          rows={syncRows}
          loading={syncHistoryLoading}
          pagination={pagination}
          onPageChange={handlePageChange}
        />
      </section>

      {/* ── Disconnect ──────────────────────────────────────── */}
      <section className="border-t pt-6">
        <Dialog open={showDisconnect} onOpenChange={setShowDisconnect}>
          <DialogTrigger asChild>
            <Button variant="destructive" className="gap-2">
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              Disconnect Integration
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Disconnect {provider ?? "Integration"}?</DialogTitle>
              <DialogDescription>
                This will remove access tokens, stop scheduled syncs, and unlink{" "}
                {linkedWebsites.length} website
                {linkedWebsites.length !== 1 ? "s" : ""}.
                <br />
                <br />
                Historical metrics will remain available.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowDisconnect(false)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleDisconnect}
                disabled={disconnectMutation.isPending}
                className="gap-1.5"
              >
                {disconnectMutation.isPending && (
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
      </section>
    </div>
  )
}

// ── Connection Info Card ────────────────────────────────────

function ConnectionInfoCard({
  connection,
}: {
  connection: NonNullable<IntegrationSummary["connection"]>
}) {
  const email = connection.email
  const displayName = connection.displayName
  const scopes = connection.grantedScopes ?? []

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Search className="h-4 w-4 text-blue-500" aria-hidden="true" />
          Connection
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {email && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground min-w-24">Email:</span>
            <span className="font-medium">{email}</span>
          </div>
        )}
        {displayName && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground min-w-24">
              Display name:
            </span>
            <span className="font-medium">{displayName}</span>
          </div>
        )}
        {scopes.length > 0 && (
          <div className="flex items-start gap-2 text-sm">
            <span className="text-muted-foreground min-w-24 mt-0.5">
              Scopes:
            </span>
            <div className="flex flex-wrap gap-1.5">
              {scopes.map((scope) => (
                <Badge key={scope} variant="outline" className="text-xs">
                  {scope}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
