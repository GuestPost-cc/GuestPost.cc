export const ORDER_STATUS_LABELS: Record<string, string> = {
  PENDING: "Pending",
  ASSIGNED: "Assigned",
  CONTENT_CREATION: "Content Creation",
  OUTREACH: "Outreach",
  PUBLISHED: "Published",
  VERIFIED: "Verified",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
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
  "PENDING",
  "ASSIGNED",
  "CONTENT_CREATION",
  "OUTREACH",
  "PUBLISHED",
  "VERIFIED",
  "DELIVERED",
]

export const CURRENCIES = ["USD", "EUR", "GBP"] as const
export const DEFAULT_CURRENCY = "USD"
