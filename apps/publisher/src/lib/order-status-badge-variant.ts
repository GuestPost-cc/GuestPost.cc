import type { OrderStatus } from "@guestpost/shared"
import type { BadgeProps } from "@guestpost/ui"
import { getOrderStatusPresentation } from "@guestpost/ui"

type BadgeVariant = NonNullable<BadgeProps["variant"]>

export function getPublisherOrderBadgeVariant(
  status: OrderStatus,
): BadgeVariant {
  const { variant } = getOrderStatusPresentation(status)
  switch (variant) {
    case "success":
      return "success"
    case "warning":
      return "warning"
    case "info":
      return "info"
    case "pending":
      return "secondary"
    case "destructive":
      return "destructive"
    case "default":
      return "default"
    default: {
      const _exhaustive: never = variant
      return _exhaustive
    }
  }
}
