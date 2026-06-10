export const ORDER_STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  PENDING_PAYMENT: "Pending Payment",
  PAID: "Paid",
  SUBMITTED: "Submitted",
  ACCEPTED: "Accepted",
  CONTENT_REQUESTED: "Content Requested",
  CONTENT_CREATION: "Content Creation",
  CONTENT_READY: "Content Ready",
  CUSTOMER_REVIEW: "Customer Review",
  APPROVED: "Approved",
  PUBLISHED: "Published",
  VERIFIED: "Verified",
  DELIVERED: "Delivered",
  SETTLED: "Settled",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  REFUNDED: "Refunded",
  DISPUTED: "Disputed",
}

export const SETTLEMENT_STATUS_LABELS: Record<string, string> = {
  PENDING: "Pending",
  UNDER_REVIEW: "Under Review",
  CUSTOMER_APPROVED: "Customer Approved",
  ADMIN_APPROVED: "Admin Approved",
  RELEASED: "Released",
  CANCELLED: "Cancelled",
}

export const DISPUTE_STATUS_LABELS: Record<string, string> = {
  OPEN: "Open",
  UNDER_REVIEW: "Under Review",
  RESOLVED_REFUNDED: "Resolved — Refunded",
  RESOLVED_REJECTED: "Resolved — Rejected",
  RESOLVED_RESTORED: "Resolved — Restored",
}

export const SERVICE_TYPE_LABELS: Record<string, string> = {
  GUEST_POST: "Guest Post",
  NICHE_EDIT: "Niche Edit",
  EDITORIAL_LINK: "Editorial Link",
  OUTREACH_LINK: "Outreach Link",
  LOCAL_CITATION: "Local Citation",
  FOUNDATION_LINK: "Foundation Link",
  BLOG_ARTICLE: "Blog Article",
  SEO_CONTENT: "SEO Content",
}

export const ORDER_STATUS_FLOW: string[] = [
  "DRAFT",
  "PENDING_PAYMENT",
  "PAID",
  "SUBMITTED",
  "ACCEPTED",
  "CONTENT_REQUESTED",
  "CONTENT_CREATION",
  "CONTENT_READY",
  "CUSTOMER_REVIEW",
  "APPROVED",
  "PUBLISHED",
  "VERIFIED",
  "DELIVERED",
  "SETTLED",
  "COMPLETED",
]

export const CURRENCIES = ["USD", "EUR", "GBP"] as const
export const DEFAULT_CURRENCY = "USD"
