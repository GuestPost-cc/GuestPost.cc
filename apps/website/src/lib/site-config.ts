export const SITE_NAME = "GuestPost"
export const SITE_DESCRIPTION =
  "A managed marketplace for accountable guest-post placements, verified delivery, and controlled settlement."

function normalizePublicUrl(value: string | undefined, fallback: string) {
  try {
    const url = new URL(value ?? fallback)
    return url.toString().replace(/\/$/, "")
  } catch {
    return fallback
  }
}

export const SITE_URL = normalizePublicUrl(
  process.env.NEXT_PUBLIC_SITE_URL ??
    process.env.NEXT_PUBLIC_WEBSITE_URL ??
    process.env.NEXT_PUBLIC_APP_URL,
  "https://guestpost.cc",
)

export const BLOG_URL = normalizePublicUrl(
  process.env.NEXT_PUBLIC_BLOG_URL,
  "https://blog.guestpost.cc",
)

export const PORTAL_URL = normalizePublicUrl(
  process.env.NEXT_PUBLIC_PORTAL_URL,
  "http://localhost:3001",
)

export const PUBLISHER_URL = normalizePublicUrl(
  process.env.NEXT_PUBLIC_PUBLISHER_URL,
  "http://localhost:3002",
)

export const ACCOUNT_DESTINATIONS = {
  customer: PORTAL_URL,
  publisher: PUBLISHER_URL,
} as const

export const PUBLIC_CONTENT_UPDATED_AT = "2026-07-28"

// Documentation routes are sourced from docs-registry.ts to prevent drift.
export const INDEXABLE_ROUTES = [
  { path: "/", priority: 1, changeFrequency: "weekly" },
  { path: "/about", priority: 0.7, changeFrequency: "monthly" },
  { path: "/pricing", priority: 0.8, changeFrequency: "monthly" },
  { path: "/publishers", priority: 0.8, changeFrequency: "monthly" },
  { path: "/contact", priority: 0.6, changeFrequency: "yearly" },
  { path: "/legal/terms", priority: 0.6, changeFrequency: "yearly" },
  { path: "/legal/privacy", priority: 0.6, changeFrequency: "yearly" },
  {
    path: "/legal/refund-policy",
    priority: 0.6,
    changeFrequency: "yearly",
  },
  {
    path: "/legal/acceptable-use",
    priority: 0.5,
    changeFrequency: "yearly",
  },
  {
    path: "/legal/cookie-policy",
    priority: 0.5,
    changeFrequency: "yearly",
  },
] as const
