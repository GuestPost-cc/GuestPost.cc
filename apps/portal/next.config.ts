import { withSentryConfig } from "@sentry/nextjs"
import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  transpilePackages: [
    "@guestpost/ui",
    "@guestpost/shared",
    "@guestpost/api-client",
  ],
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
  // Gate sourcemap generation on SENTRY_AUTH_TOKEN. Without a token the
  // upload step skips, but `disable: false` still made the Sentry plugin
  // hang on network calls in CI (PR runs without secrets). With the gate
  // the plugin is a no-op when there's no token — what local devs + fork
  // PRs need.
  sourcemaps: {
    disable: !process.env.SENTRY_AUTH_TOKEN,
    deleteSourcemapsAfterUpload: true,
  },
})
