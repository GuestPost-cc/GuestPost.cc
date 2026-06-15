// Phase 7.0 — Sentry browser init for admin.
import * as Sentry from "@sentry/nextjs"
import { initSentry } from "@guestpost/shared"

initSentry(Sentry, { runtime: "admin-client" })
