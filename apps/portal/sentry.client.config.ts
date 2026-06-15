// Phase 7.0 — Sentry browser init for portal.
// Runs in the user's browser. Reads NEXT_PUBLIC_SENTRY_DSN at build time.
import * as Sentry from "@sentry/nextjs"
import { initSentry } from "@guestpost/shared"

initSentry(Sentry, { runtime: "portal-client" })
