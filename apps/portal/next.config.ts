import type { NextConfig } from "next"
import { withSentryConfig } from "@sentry/nextjs"

const nextConfig: NextConfig = {
  transpilePackages: ["@guestpost/ui", "@guestpost/shared", "@guestpost/api-client"],
}

// Phase 7.0 — Sentry plugin. Safe to call unconditionally; without SENTRY_DSN
// the runtime instrumentation no-ops, and without SENTRY_AUTH_TOKEN the
// source-map upload phase is silently skipped (devs can still `pnpm build`).
//
// Phase 7.7 C — source-map upload enabled. widenClientFileUpload picks up
// every JS chunk under .next; deleteSourcemapsAfterUpload strips .map files
// from the deployed bundle so source isn't shipped to browsers.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  silent: !process.env.CI,
  disableLogger: true,
  widenClientFileUpload: true,
  sourcemaps: { disable: false, deleteSourcemapsAfterUpload: true },
})
