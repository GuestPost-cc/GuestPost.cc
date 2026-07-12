import type { IntegrationProvider } from "@guestpost/integrations/client"
import { Loader2, Plug } from "lucide-react"
import { cn } from "../../../lib/utils"
import { Button } from "../../button"

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
      variant="default"
      onClick={onClick}
      disabled={disabled || loading}
      className={cn("gap-2", className)}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        <Plug className="h-4 w-4" aria-hidden="true" />
      )}
      {loading
        ? `Connecting ${String(provider)}`
        : `Connect ${String(provider)}`}
    </Button>
  )
}

export type { ConnectButtonProps }
export { ConnectButton }
