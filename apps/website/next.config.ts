import path from "node:path"
import { withSentryConfig } from "@sentry/nextjs"
import type { NextConfig } from "next"

const securityHeaders = [
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-XSS-Protection", value: "0" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
  { key: "Origin-Agent-Cluster", value: "?1" },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=(self), clipboard-write=(self)",
  },
  {
    key: "Cross-Origin-Opener-Policy",
    value: "same-origin",
  },
  {
    key: "Cross-Origin-Resource-Policy",
    value: "same-origin",
  },
  ...(process.env.NODE_ENV === "production"
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
      ]
    : []),
]

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname, "../../"),
  },
  transpilePackages: [
    "@guestpost/ui",
    "@guestpost/shared",
    "@guestpost/api-client",
    "@guestpost/auth",
  ],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
      ...["/login", "/signup", "/forgot-password", "/reset-password"].map(
        (source) => ({
          source,
          headers: [
            {
              key: "Cache-Control",
              value: "private, no-store, max-age=0",
            },
            {
              key: "X-Robots-Tag",
              value: "noindex, nofollow, noarchive",
            },
          ],
        }),
      ),
    ]
  },
}

// Phase 7.7 C — source-map upload enabled (skipped silently without SENTRY_AUTH_TOKEN).
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  silent: !process.env.CI,
  disableLogger: true,
  widenClientFileUpload: true,
  // Without SENTRY_AUTH_TOKEN the plugin hangs on network calls in CI;
  // gating `disable` on token presence keeps fork PRs + local dev no-op.
  sourcemaps: {
    disable: !process.env.SENTRY_AUTH_TOKEN,
    deleteSourcemapsAfterUpload: true,
  },
})
