import { IntegrationStatus } from "@guestpost/integrations"
import { cn } from "../../../lib/utils"
import type { BadgeProps } from "../../badge"
import { Badge } from "../../badge"

const STATUS_METADATA: Record<
  IntegrationStatus,
  {
    label: string
    variant: NonNullable<BadgeProps["variant"]>
    className?: string
  }
> = {
  [IntegrationStatus.PENDING]: { label: "Pending", variant: "outline" },
  [IntegrationStatus.DISCOVERING]: {
    label: "Discovering properties\u2026",
    variant: "info",
  },
  [IntegrationStatus.ACTIVE]: { label: "Connected", variant: "success" },
  [IntegrationStatus.TOKEN_EXPIRED]: {
    label: "Reconnect required",
    variant: "warning",
  },
  [IntegrationStatus.REAUTH_REQUIRED]: {
    label: "Reauthorization needed",
    variant: "destructive",
  },
  [IntegrationStatus.DISCONNECTED]: {
    label: "Disconnected",
    variant: "secondary",
    className: "line-through",
  },
  [IntegrationStatus.ERROR]: {
    label: "Connection error",
    variant: "destructive",
  },
}

interface IntegrationStatusBadgeProps {
  status: IntegrationStatus
  className?: string
}

function IntegrationStatusBadge({
  status,
  className,
}: IntegrationStatusBadgeProps) {
  const meta = STATUS_METADATA[status] ?? {
    label: status,
    variant: "default" as const,
  }
  return (
    <Badge variant={meta.variant} className={cn(meta.className, className)}>
      {meta.label}
    </Badge>
  )
}

export type { IntegrationStatusBadgeProps }
export { IntegrationStatusBadge }
