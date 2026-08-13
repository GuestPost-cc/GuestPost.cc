export interface OrderEventPresentation {
  label: string
}

export const ORDER_EVENT_PRESENTATION: Record<string, OrderEventPresentation> =
  {
    ORDER_CREATED: { label: "Order created" },
    ITEM_ADDED: { label: "Item added" },
    ITEM_REMOVED: { label: "Item removed" },
    PAYMENT_SUBMITTED: { label: "Payment submitted" },
    ORDER_SUBMITTED: { label: "Order submitted" },
    PAYMENT_CAPTURED: { label: "Payment captured" },
    ORDER_ACCEPTED: { label: "Order accepted" },
    CONTENT_REQUESTED: { label: "Content requested" },
    CONTENT_SUBMITTED: { label: "Content submitted" },
    CONTENT_MARKED_READY: { label: "Content marked ready" },
    CONTENT_SUBMITTED_FOR_REVIEW: { label: "Content submitted for review" },
    CONTENT_APPROVED: { label: "Content approved" },
    REVISION_REQUESTED: { label: "Revision requested" },
    PUBLICATION_MARKED: { label: "Publication marked" },
    VERIFIED_AUTO: { label: "Automatically verified" },
    VERIFIED_MANUAL: { label: "Manually verified" },
    DELIVERY_CONFIRMED: { label: "Delivery confirmed" },
    DISPUTE_OPENED: { label: "Dispute opened" },
    DISPUTE_RESOLVED: { label: "Dispute resolved" },
    ORDER_CANCELLED: { label: "Order cancelled" },
    REFUND_ISSUED: { label: "Refund issued" },
    SETTLEMENT_CREATED: { label: "Settlement created" },
    PLATFORM_REVENUE_RECOGNIZED: { label: "Platform revenue recognized" },
    SETTLEMENT_CUSTOMER_APPROVED: { label: "Settlement customer-approved" },
    SETTLEMENT_RETURNED_TO_REVIEW: { label: "Settlement returned to review" },
    SETTLEMENT_RELEASED: { label: "Settlement funds released" },
    REFUNDED: { label: "Refund completed" },
    VERIFICATION_ESCALATED: { label: "Verification escalated" },
    AUTO_ACCEPTED: { label: "Auto-accepted" },
    REVIEW_REMINDER: { label: "Review reminder sent" },
    CANCELLATION_REQUESTED: { label: "Cancellation requested" },
    CANCELLATION_RESPONDED: { label: "Cancellation response recorded" },
    CANCELLATION_RESOLVED: { label: "Cancellation resolved" },
    ORDER_DECLINED: { label: "Order declined" },
    PUBLISHER_COMPENSATION_RECORDED: {
      label: "Publisher compensation recorded",
    },
  }

export function getOrderEventPresentation(
  eventType: string,
): OrderEventPresentation {
  return (
    ORDER_EVENT_PRESENTATION[eventType] ?? {
      label: eventType
        .replace(/_/g, " ")
        .toLowerCase()
        .replace(/\b\w/g, (character) => character.toUpperCase()),
    }
  )
}
