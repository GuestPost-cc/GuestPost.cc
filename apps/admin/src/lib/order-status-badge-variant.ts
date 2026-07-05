import type { OrderStatus } from "@guestpost/shared"
import type { BadgeProps } from "@guestpost/ui"
import { getOrderStatusPresentation } from "@guestpost/ui"

type BadgeVariant = NonNullable<BadgeProps["variant"]>

export function getOrderBadgeVariant(status: OrderStatus): BadgeVariant {
  const { variant } = getOrderStatusPresentation(status)
  switch (variant) {
    case "success":
      return "default"
    case "warning":
    case "info":
      return "secondary"
    case "pending":
      return "outline"
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
