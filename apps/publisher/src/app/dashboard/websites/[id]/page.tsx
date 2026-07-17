"use client"

import type {
  IntegrationProvider,
  IntegrationStatus,
} from "@guestpost/api-client"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorState,
  IntegrationStatusBadge,
  LoadingState,
  ProviderBadge,
  ReconnectBanner,
  ResourceTable,
  SyncHistoryTable,
} from "@guestpost/ui"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  ArrowLeft,
  Copy,
  ExternalLink,
  Globe,
  Loader2,
  Plug,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Trash2,
} from "lucide-react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"
import { PublisherListingManager } from "../../../../components/marketplace/publisher-listing-manager"
import { api } from "../../../../lib/api"
import { useAuth } from "../../../../lib/auth"
import {
  useConnectIntegration,
  useDisconnectIntegration,
  useDiscoverResources,
  useLinkProperty,
  useResources,
  useSyncHistory,
  useTriggerSync,
  useUnlinkProperty,
} from "../../../../lib/hooks/integrations"
import { useWebsite } from "../../../../lib/hooks/websites"

interface VerifyInstructions {
  type: string
  host: string
  value: string
  note?: string
}

const VERIFY_BADGE: Record<
  string,
  { label: string; variant: "success" | "warning" | "destructive"; Icon: any }
> = {
  VERIFIED: { label: "Verified", variant: "success", Icon: ShieldCheck },
  PENDING_VERIFICATION: {
    label: "Pending",
    variant: "warning",
    Icon: ShieldAlert,
  },
  VERIFICATION_FAILED: {
    label: "Failed",
    variant: "destructive",
    Icon: ShieldX,
  },
  REVOKED: { label: "Revoked", variant: "destructive", Icon: ShieldX },
}

export default function WebsiteDetailPage() {
  const params = useParams()
  const router = useRouter()
  const queryClient = useQueryClient()
  const websiteId = params.id as string
  const { user } = useAuth()
  const publisherId = user?.publisherId

  const [showLinkDialog, setShowLinkDialog] = useState(false)
  const [selectedResource, setSelectedResource] = useState<string | null>(null)
  const [showDisconnect, setShowDisconnect] = useState(false)
  const [verifyInstructions, setVerifyInstructions] =
    useState<VerifyInstructions | null>(null)

  const { data: website, isLoading, error, refetch } = useWebsite(websiteId)

  const seoIntegration = website?.seoIntegration ?? null
  const gscIntegration = website?.gscIntegration ?? null
  const gscAccountExists = website?.gscAccountExists ?? false
  const integrationId =
    seoIntegration?.integrationId ?? gscIntegration?.id ?? null
  const websiteIntegrationId = seoIntegration?.websiteIntegrationId ?? null
  const needsReauth = seoIntegration?.needsReauth ?? false
  const isPropertyLinked = seoIntegration?.linked ?? false
  const syncInProgress = seoIntegration?.syncInProgress ?? false

  const { data: resourcesData, refetch: refetchResources } = useResources(
    integrationId ?? "",
    { enabled: !!integrationId },
  )
  const { data: syncHistory, refetch: refetchSyncHistory } = useSyncHistory(
    integrationId ?? "",
    { pageSize: 10 },
    { enabled: !!integrationId },
  )

  const discoverMutation = useDiscoverResources(integrationId ?? "")
  const linkMutation = useLinkProperty(integrationId ?? "")
  const unlinkMutation = useUnlinkProperty(integrationId ?? "")
  const triggerSyncMutation = useTriggerSync(integrationId ?? "")
  const disconnectMutation = useDisconnectIntegration()
  const connectMutation = useConnectIntegration()
  const verifyMutation = useMutation({
    mutationFn: async () => {
      if (!publisherId) throw new Error("Not authenticated")
      return api.publishers.verifyWebsite(publisherId, websiteId) as Promise<{
        instructions: VerifyInstructions
      }>
    },
    onSuccess: (res) => {
      setVerifyInstructions(res.instructions)
      queryClient.invalidateQueries({ queryKey: ["website", websiteId] })
      queryClient.invalidateQueries({ queryKey: ["publisher-websites"] })
      toast.success("DNS verification queued")
    },
    onError: (err: any) => {
      toast.error(err?.message ?? "Failed to request DNS verification")
    },
  })

  const resources = (resourcesData?.resources ?? []) as Array<{
    externalResourceId: string
    externalResourceName: string
    metadata?: Record<string, unknown>
  }>

  const syncRows = syncHistory?.data ?? []
  const pagination = (syncHistory?.pagination ?? {
    page: 1,
    pageSize: 10,
    total: 0,
    hasNext: false,
  }) as {
    page: number
    pageSize: number
    total: number
    hasNext: boolean
  }

  const isBusy =
    discoverMutation.isPending ||
    triggerSyncMutation.isPending ||
    disconnectMutation.isPending ||
    syncInProgress

  const handleConnect = async () => {
    if (!gscIntegration) {
      router.push("/dashboard/integrations")
      return
    }
    try {
      const result = await connectMutation.mutateAsync({
        provider: gscIntegration.provider,
        returnUrl: `/dashboard/websites/${websiteId}`,
      })
      window.location.assign(result.authorizationUrl!)
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to initiate connection")
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

  const handleLink = async () => {
    if (!selectedResource || !integrationId) return
    try {
      await linkMutation.mutateAsync({
        websiteId,
        externalResourceId: selectedResource,
      })
      toast.success("Property linked")
      setShowLinkDialog(false)
      setSelectedResource(null)
      queryClient.invalidateQueries({ queryKey: ["website", websiteId] })
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to link property")
    }
  }

  const handleUnlink = async () => {
    if (!websiteIntegrationId || !integrationId) return
    try {
      await unlinkMutation.mutateAsync(websiteIntegrationId)
      toast.success("Property unlinked")
      queryClient.invalidateQueries({ queryKey: ["website", websiteId] })
      await refetchResources()
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to unlink")
    }
  }

  const handleTriggerSync = async () => {
    if (!integrationId) return
    try {
      await triggerSyncMutation.mutateAsync({})
      toast.success("Sync started")
      setTimeout(() => refetchSyncHistory(), 2000)
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to trigger sync")
    }
  }

  const handleReconnect = async () => {
    if (!gscIntegration) return
    try {
      const result = await connectMutation.mutateAsync({
        provider: gscIntegration.provider,
        returnUrl: `/dashboard/websites/${websiteId}`,
      })
      window.location.assign(result.authorizationUrl!)
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to initiate reconnection")
    }
  }

  const handleDisconnect = async () => {
    if (!integrationId) return
    try {
      await disconnectMutation.mutateAsync(integrationId)
      toast.success("Integration disconnected")
      setShowDisconnect(false)
      queryClient.invalidateQueries({ queryKey: ["website", websiteId] })
      queryClient.invalidateQueries({ queryKey: ["websites"] })
      refetch()
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

  if (error || !website) {
    return (
      <div className="space-y-6">
        <ErrorState onRetry={() => refetch()} />
      </div>
    )
  }

  const verificationBadge =
    VERIFY_BADGE[website.verificationStatus ?? "PENDING_VERIFICATION"] ??
    VERIFY_BADGE.PENDING_VERIFICATION
  const isDomainVerified = website.verificationStatus === "VERIFIED"
  const domainInstructions =
    verifyInstructions ?? website.verificationInstructions ?? null

  return (
    <div className="space-y-8">
      {/* Back link */}
      <Link
        href="/dashboard/websites"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Websites
      </Link>

      {/* Website header */}
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Globe
              className="h-5 w-5 text-muted-foreground"
              aria-hidden="true"
            />
            <h1 className="text-2xl font-bold tracking-tight">{website.url}</h1>
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {website.domain && <span>{website.domain}</span>}
            <Badge variant={verificationBadge.variant} className="gap-1">
              <verificationBadge.Icon className="h-3 w-3" />
              {verificationBadge.label}
            </Badge>
            <a
              href={
                website.url.startsWith("http")
                  ? website.url
                  : `https://${website.url}`
              }
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:underline"
            >
              Visit <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>
      </div>

      {website.listing ? (
        <PublisherListingManager
          listing={website.listing}
          verificationStatus={website.verificationStatus}
          onChanged={() => {
            queryClient.invalidateQueries({ queryKey: ["website", websiteId] })
            queryClient.invalidateQueries({
              queryKey: ["publisher-websites"],
            })
            queryClient.invalidateQueries({
              queryKey: ["publisher-listings"],
            })
          }}
        />
      ) : (
        <Card id="marketplace" className="border-destructive/30">
          <CardHeader>
            <CardTitle className="text-base">
              Marketplace listing missing
            </CardTitle>
            <CardDescription>
              This website should have exactly one listing. Contact support so
              the aggregate can be repaired without creating a duplicate.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* Domain ownership section */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Domain Ownership</h2>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <verificationBadge.Icon className="h-4 w-4" aria-hidden="true" />
              DNS TXT verification
            </CardTitle>
            <CardDescription>
              Prove ownership of this domain before submitting it for
              marketplace review. Google Search Console is managed separately
              for search performance data.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 text-sm sm:grid-cols-3">
              <div>
                <span className="text-muted-foreground">Status</span>
                <div className="mt-1">
                  <Badge variant={verificationBadge.variant} className="gap-1">
                    <verificationBadge.Icon className="h-3 w-3" />
                    {verificationBadge.label}
                  </Badge>
                </div>
              </div>
              <div>
                <span className="text-muted-foreground">Last requested</span>
                <p className="mt-1 font-medium">
                  {website.lastVerificationRequestAt
                    ? new Date(
                        website.lastVerificationRequestAt,
                      ).toLocaleString()
                    : "Never"}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">Last checked</span>
                <p className="mt-1 font-medium">
                  {website.lastVerificationCheckAt
                    ? new Date(website.lastVerificationCheckAt).toLocaleString()
                    : "Never"}
                </p>
              </div>
            </div>

            {website.verificationFailureReason && !isDomainVerified && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
                <p className="font-medium text-destructive">
                  Verification issue
                </p>
                <p className="mt-1 text-muted-foreground">
                  {website.verificationFailureReason}
                </p>
              </div>
            )}

            {!isDomainVerified && domainInstructions && (
              <div className="space-y-3 rounded-lg border bg-muted/40 p-4 text-sm">
                <p className="text-muted-foreground">
                  Add this DNS TXT record at your domain registrar, then use
                  Re-check DNS. The worker processes verification
                  asynchronously.
                </p>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">
                    Type
                  </span>
                  <code className="font-mono">{domainInstructions.type}</code>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">
                    Host / Name
                  </span>
                  <code className="font-mono">{domainInstructions.host}</code>
                </div>
                <div className="flex items-start justify-between gap-3">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">
                    Value
                  </span>
                  <div className="flex items-center gap-2 text-right">
                    <code className="break-all font-mono">
                      {domainInstructions.value}
                    </code>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Copy TXT value"
                      onClick={() => {
                        navigator.clipboard.writeText(domainInstructions.value)
                        toast.success("Copied TXT value")
                      }}
                    >
                      <Copy className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
                {domainInstructions.note && (
                  <p className="text-xs text-muted-foreground">
                    {domainInstructions.note}
                  </p>
                )}
              </div>
            )}

            {!isDomainVerified && !domainInstructions && (
              <p className="text-sm text-muted-foreground">
                Request verification to generate DNS TXT instructions for this
                domain.
              </p>
            )}

            {isDomainVerified && website.verifiedAt && (
              <p className="text-sm text-muted-foreground">
                Verified on {new Date(website.verifiedAt).toLocaleString()}.
              </p>
            )}

            {!isDomainVerified && (
              <Button
                variant="outline"
                onClick={() => verifyMutation.mutate()}
                disabled={verifyMutation.isPending}
                className="gap-1.5"
              >
                {verifyMutation.isPending ? (
                  <Loader2
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                )}
                {domainInstructions
                  ? "Re-check DNS"
                  : "Request DNS verification"}
              </Button>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Reconnect banner */}
      {needsReauth && (
        <ReconnectBanner
          status={seoIntegration!.integrationStatus! as IntegrationStatus}
          onReconnect={handleReconnect}
        />
      )}

      {/* Integration section */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Google Search Console</h2>

        {!gscAccountExists && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Plug className="h-4 w-4" aria-hidden="true" />
                No integration connected
              </CardTitle>
              <CardDescription>
                Connect Google Search Console to link search performance data.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={handleConnect} className="gap-1.5">
                <Plug className="h-4 w-4" aria-hidden="true" />
                Connect Google Search Console
              </Button>
            </CardContent>
          </Card>
        )}

        {gscAccountExists && !isPropertyLinked && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ProviderBadge
                  provider={gscIntegration!.provider as IntegrationProvider}
                />
                Google Search Console — Connected
              </CardTitle>
              <CardDescription>
                Link a Search Console property to this website to track search
                performance and sync SEO data.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground">Status</span>
                  <div className="mt-0.5">
                    <IntegrationStatusBadge
                      status={gscIntegration!.status as IntegrationStatus}
                    />
                  </div>
                </div>
                <div>
                  <span className="text-muted-foreground">Last sync</span>
                  <p className="mt-0.5 font-medium">
                    {gscIntegration!.lastSyncAt
                      ? new Date(gscIntegration!.lastSyncAt).toLocaleString()
                      : "Never"}
                  </p>
                </div>
              </div>
              <Button
                variant="default"
                onClick={() => {
                  handleDiscover()
                  setShowLinkDialog(true)
                }}
                className="gap-1.5"
                disabled={discoverMutation.isPending}
              >
                {discoverMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                Link a Property
              </Button>
            </CardContent>
          </Card>
        )}

        {isPropertyLinked && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ProviderBadge
                  provider={seoIntegration!.provider! as IntegrationProvider}
                />
                Google Search Console — Connected
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground">Property</span>
                  <p className="mt-0.5 font-medium font-mono text-xs break-all">
                    {seoIntegration!.externalResourceName ??
                      seoIntegration!.externalResourceId}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">
                    Last sync attempt
                  </span>
                  <p className="mt-0.5 font-medium">
                    {seoIntegration!.lastSyncAttemptAt
                      ? new Date(
                          seoIntegration!.lastSyncAttemptAt,
                        ).toLocaleString()
                      : "Never"}
                  </p>
                  {seoIntegration!.lastSyncAttemptStatus && (
                    <p className="text-xs text-muted-foreground">
                      Status: {seoIntegration!.lastSyncAttemptStatus}
                    </p>
                  )}
                </div>
                <div>
                  <span className="text-muted-foreground">
                    Last successful sync
                  </span>
                  <p className="mt-0.5 font-medium">
                    {seoIntegration!.lastSuccessfulSyncAt
                      ? new Date(
                          seoIntegration!.lastSuccessfulSyncAt,
                        ).toLocaleString()
                      : "Never"}
                  </p>
                </div>
              </div>

              {seoIntegration!.lastSyncError && (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
                  <p className="font-medium text-destructive">
                    Last sync error
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    {seoIntegration!.lastSyncError}
                  </p>
                </div>
              )}

              <div className="flex items-center gap-2">
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleTriggerSync}
                  disabled={isBusy || needsReauth}
                  className="gap-1.5"
                >
                  {triggerSyncMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  Sync Now
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleUnlink}
                  disabled={isBusy}
                >
                  Unlink Property
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {syncInProgress && (
          <div
            className="space-y-1"
            role="progressbar"
            aria-label="Sync progress"
          >
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Sync in progress</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full w-1/2 animate-pulse rounded-full bg-blue-500" />
            </div>
          </div>
        )}
      </section>

      {/* Sync History Section */}
      {isPropertyLinked && (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Sync History</h2>
          <SyncHistoryTable
            rows={syncRows}
            loading={false}
            pagination={pagination}
            onPageChange={() => {}}
          />
        </section>
      )}

      {/* SEO Metrics Section — Phase 5D placeholder */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">SEO Metrics</h2>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Search Console</CardTitle>
            <CardDescription>
              {isPropertyLinked
                ? "Search Console is connected."
                : "Connect a Search Console property to view SEO metrics."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {isPropertyLinked
                ? seoIntegration?.lastSuccessfulSyncAt
                  ? "Metrics will appear after your next synchronization."
                  : "Metrics will appear after your first successful synchronization."
                : "Link a Search Console property to start tracking search performance."}
            </p>
            {isPropertyLinked && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleTriggerSync}
                disabled={isBusy || needsReauth}
                className="mt-4 gap-1.5"
              >
                {triggerSyncMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                {seoIntegration?.lastSuccessfulSyncAt
                  ? "Sync Now"
                  : "Run First Sync"}
              </Button>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Danger Zone */}
      {gscAccountExists && (
        <section className="border-t pt-6">
          <Dialog open={showDisconnect} onOpenChange={setShowDisconnect}>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => !isBusy && setShowDisconnect(true)}
              disabled={isBusy}
              className="gap-2"
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              Disconnect Google Search Console
            </Button>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Disconnect Google Search Console?</DialogTitle>
                <DialogDescription>
                  This will remove access tokens, stop scheduled syncs, and
                  unlink
                  {isPropertyLinked
                    ? " 1 linked property"
                    : " any linked properties"}
                  .
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
      )}

      {/* Link Property Dialog */}
      <Dialog open={showLinkDialog} onOpenChange={setShowLinkDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Link a Search Console Property</DialogTitle>
            <DialogDescription>
              Select a property to link with this website. This determines which
              site data is synchronized.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <ResourceTable
              resources={resources}
              selectedResource={selectedResource ?? undefined}
              onSelect={setSelectedResource}
              onRefresh={handleDiscover}
              loading={discoverMutation.isPending}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowLinkDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleLink}
              disabled={!selectedResource || linkMutation.isPending}
              className="gap-1.5"
            >
              {linkMutation.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              )}
              Confirm & Link
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
