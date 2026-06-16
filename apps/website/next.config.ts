import type { NextConfig } from "next"
import { withSentryConfig } from "@sentry/nextjs"

const nextConfig: NextConfig = {
  transpilePackages: ["@guestpost/ui", "@guestpost/shared", "@guestpost/api-client"],
}

// Phase 7.7 C — source-map upload enabled (skipped silently without SENTRY_AUTH_TOKEN).
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  silent: !process.env.CI,
  disableLogger: true,
  widenClientFileUpload: true,
  sourcemaps: { disable: false, deleteSourcemapsAfterUpload: true },
})
