"use client"

import { IntegrationStatus } from "@guestpost/api-client"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  ErrorState,
  IntegrationStatusBadge,
  LoadingState,
  ProviderBadge,
  ReconnectBanner,
  ResourceTable,
  SyncHistoryTable,
  WebsiteIntegrationList,
} from "@guestpost/ui"
import { useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, Loader2, RefreshCw, Trash2 } from "lucide-react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

interface PaginationShape {
  page: number
  pageSize: number
  total: number
  hasNext: boolean
}

interface DiscoveredResource {
  externalId: string
  url: string
  permissionLevel: string
}

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
} from "../../../../../lib/hooks/integrations"

export default function IntegrationDetailPage() {
  const params = useParams()
  const router = useRouter()
  const queryClient = useQueryClient()
  const integrationId = params.id as string

  const [selectedResource, setSelectedResource] = useState<string | null>(null)
  const [showDisconnect, setShowDisconnect] = useState(false)

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

  const discoverMutation = useDiscoverResources(integrationId)
  const linkMutation = useLinkProperty(integrationId)
  const unlinkMutation = useUnlinkProperty(integrationId)
  const triggerSyncMutation = useTriggerSync(integrationId)
  const disconnectMutation = useDisconnectIntegration()
  const connectMutation = useConnectIntegration()

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
  const linkedWebsites = integration?.linkedWebsites ?? []
  const resources = (resourcesData?.resources ?? []) as DiscoveredResource[]
  const discoveredAt = resourcesData?.discoveredAt ?? null
  const syncRows = syncHistory?.data ?? []
  const pagination: PaginationShape =
    (syncHistory?.pagination as PaginationShape) ?? {
      page: 1,
      pageSize: 10,
      total: 0,
      hasNext: false,
    }

  const handleReconnect = async () => {
    if (!provider) return
    try {
      const result = await connectMutation.mutateAsync({
        provider,
        returnUrl: `/dashboard/settings/integrations/${integrationId}`,
      })
      window.location.assign(result.authorizationUrl!)
    } catch {
      toast.error("Failed to initiate reconnection")
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

  const handleLink = async (externalId: string) => {
    const resource = resources.find((r) => r.externalId === externalId)
    if (!resource) {
      toast.error("Resource not found")
      return
    }
    try {
      await linkMutation.mutateAsync({
        websiteId: "",
        externalId,
      })
      toast.success("Property linked")
      await refetch()
      await refetchResources()
      setSelectedResource(null)
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
      router.push("/dashboard/settings/integrations")
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to disconnect")
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <LoadingState variant="detail" />
      </div>
    )
  }

  if (error || !integration) {
    return (
      <div className="space-y-6">
        <ErrorState onRetry={() => refetch()} />
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* Back link + header */}
      <div className="space-y-4">
        <Link
          href="/dashboard/settings/integrations"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Integrations
        </Link>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <ProviderBadge provider={provider!} />
            <IntegrationStatusBadge status={status!} />
          </div>
        </div>
      </div>

      {/* Reconnect banner */}
      {needsReauth && (
        <ReconnectBanner
          status={status! as IntegrationStatus}
          onReconnect={handleReconnect}
        />
      )}

      {/* Linked websites section */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Linked Websites</h2>
        <WebsiteIntegrationList
          websites={linkedWebsites}
          onUnlink={handleUnlink}
        />
      </section>

      {/* Resources section */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Available Properties</h2>
        </div>
        {discoveredAt && (
          <p className="text-xs text-muted-foreground">
            Discovered {new Date(discoveredAt).toLocaleString()}
          </p>
        )}
        <ResourceTable
          resources={resources}
          selectedResource={selectedResource ?? undefined}
          onSelect={handleLink}
          onRefresh={handleDiscover}
          loading={discoverMutation.isPending || isDiscovering}
        />
      </section>

      {/* Sync history section */}
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
          onPageChange={() => {}}
        />
      </section>

      {/* Disconnect section */}
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
