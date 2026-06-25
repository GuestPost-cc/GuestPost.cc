// Phase 7.0 — Sentry browser init for website (public marketing site).

import { initSentry } from "@guestpost/shared"
import * as Sentry from "@sentry/nextjs"

initSentry(Sentry, { runtime: "website-client" })
