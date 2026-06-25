// Phase 7.0 — Sentry browser init for admin.

import { initSentry } from "@guestpost/shared"
import * as Sentry from "@sentry/nextjs"

initSentry(Sentry, { runtime: "admin-client" })
