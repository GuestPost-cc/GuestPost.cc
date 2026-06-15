// Phase 7.0 — Sentry browser init for website (public marketing site).
import * as Sentry from "@sentry/nextjs"
import { initSentry } from "@guestpost/shared"

initSentry(Sentry, { runtime: "website-client" })
