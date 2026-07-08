import type { IntegrationSummary } from "@guestpost/integrations"
import { ChevronRight } from "lucide-react"
import { cn } from "../../../lib/utils"
import { Card, CardContent, CardHeader, CardTitle } from "../../card"
import { IntegrationStatusBadge } from "../primitives/integration-status-badge"
import { ProviderBadge } from "../primitives/provider-badge"

interface IntegrationCardProps {
  integration: IntegrationSummary
  onClick?: () => void
  className?: string
}

function IntegrationCard({
  integration,
  onClick,
  className,
}: IntegrationCardProps) {
  const linkedCount = integration.linkedWebsites?.length ?? 0
  return (
    <Card
      className={cn(
        "cursor-pointer transition-shadow hover:shadow-md",
        className,
      )}
      onClick={onClick}
      role="button"
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") onClick()
            }
          : undefined
      }
      aria-label={`${integration.provider ?? "Integration"} card`}
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div className="flex items-center gap-2">
          <CardTitle className="text-base font-medium">
            <ProviderBadge provider={integration.provider!} />
          </CardTitle>
        </div>
        <div className="flex items-center gap-2">
          <IntegrationStatusBadge status={integration.status!} />
          {onClick && (
            <ChevronRight
              className="h-4 w-4 text-muted-foreground"
              aria-hidden="true"
            />
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-1 text-sm text-muted-foreground">
          <p>
            {linkedCount} linked website{linkedCount !== 1 ? "s" : ""}
          </p>
          {integration.lastSyncAt && (
            <p>
              Last sync: {new Date(integration.lastSyncAt).toLocaleDateString()}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

export type { IntegrationCardProps }
export { IntegrationCard }
