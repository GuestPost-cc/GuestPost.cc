import { withSentryConfig } from "@sentry/nextjs"
import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  transpilePackages: [
    "@guestpost/ui",
    "@guestpost/shared",
    "@guestpost/api-client",
  ],
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
