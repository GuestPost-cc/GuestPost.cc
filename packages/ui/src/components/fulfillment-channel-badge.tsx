// Pill that renders the FulfillmentChannel snapshot on an order. The
// channel is authoritative for routing (settlement, ticket assignee,
// publisher inbox vs ops queue) so surfacing it consistently in the UI is
// what lets staff and customers see "who's actually handling this".
//
// Used by order lists, ticket cards, settlement detail, and admin filters.

import { cn } from "../lib/utils"

export type FulfillmentChannelValue = "PLATFORM" | "PUBLISHER" | string | null | undefined

export interface FulfillmentChannelBadgeProps {
  channel: FulfillmentChannelValue
  className?: string
  unknownLabel?: string
}

export function FulfillmentChannelBadge({
  channel,
  className,
  unknownLabel = "Legacy",
}: FulfillmentChannelBadgeProps) {
  const variant = resolveVariant(channel)
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        variant.classes,
        className,
      )}
      title={variant.title}
    >
      <span className={cn("mr-1 h-1.5 w-1.5 rounded-full", variant.dotClasses)} aria-hidden />
      {variant.label || unknownLabel}
    </span>
  )
}

function resolveVariant(channel: FulfillmentChannelValue) {
  switch (channel) {
    case "PLATFORM":
      return {
        label: "Platform",
        title: "Fulfilled by GuestPost.cc operations",
        classes: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
        dotClasses: "bg-blue-500",
      }
    case "PUBLISHER":
      return {
        label: "Publisher",
        title: "Fulfilled by the publisher who owns the site",
        classes: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
        dotClasses: "bg-emerald-500",
      }
    default:
      return {
        label: "",
        title: "No channel snapshot on this order (pre-Phase-2)",
        classes: "bg-muted text-muted-foreground",
        dotClasses: "bg-muted-foreground/40",
      }
  }
}
