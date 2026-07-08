import { IntegrationStatus } from "@guestpost/integrations"
import { AlertTriangle, RefreshCw } from "lucide-react"
import { cn } from "../../../lib/utils"
import { Button } from "../../button"

interface ReconnectBannerProps {
  status: IntegrationStatus
  onReconnect: () => void
  className?: string
}

const RECONNECT_MESSAGES: Partial<
  Record<IntegrationStatus, { title: string; description: string }>
> = {
  [IntegrationStatus.TOKEN_EXPIRED]: {
    title: "Token expired",
    description:
      "Your Google Search Console access token has expired. Reconnect to continue syncing.",
  },
  [IntegrationStatus.REAUTH_REQUIRED]: {
    title: "Reauthorization required",
    description:
      "Google requires you to grant permissions again. Reconnect to restore access.",
  },
}

function ReconnectBanner({
  status,
  onReconnect,
  className,
}: ReconnectBannerProps) {
  const msg = RECONNECT_MESSAGES[status]
  if (!msg) return null

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/50 dark:bg-amber-950/20",
        className,
      )}
      role="alert"
    >
      <AlertTriangle
        className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400"
        aria-hidden="true"
      />
      <div className="flex-1 space-y-1">
        <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
          {msg.title}
        </p>
        <p className="text-sm text-amber-700 dark:text-amber-400">
          {msg.description}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onReconnect}
        className="shrink-0 gap-1.5"
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
        Reconnect
      </Button>
    </div>
  )
}

export type { ReconnectBannerProps }
export { ReconnectBanner }
