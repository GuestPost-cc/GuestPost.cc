import type { IntegrationProvider } from "@guestpost/integrations"
import { Loader2, Plus } from "lucide-react"
import { cn } from "../../../lib/utils"
import { Button } from "../../button"
import { ProviderBadge } from "../primitives/provider-badge"

interface ConnectButtonProps {
  provider: IntegrationProvider
  onClick: () => void
  loading?: boolean
  disabled?: boolean
  className?: string
}

function ConnectButton({
  provider,
  onClick,
  loading = false,
  disabled = false,
  className,
}: ConnectButtonProps) {
  return (
    <Button
      variant="outline"
      onClick={onClick}
      disabled={disabled || loading}
      className={cn("gap-2", className)}
      aria-label={`Connect ${provider}`}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        <Plus className="h-4 w-4" aria-hidden="true" />
      )}
      <ProviderBadge provider={provider} />
    </Button>
  )
}

export type { ConnectButtonProps }
export { ConnectButton }
