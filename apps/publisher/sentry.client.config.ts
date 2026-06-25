// Phase 7.0 — Sentry browser init for publisher.

import { initSentry } from "@guestpost/shared"
import * as Sentry from "@sentry/nextjs"

initSentry(Sentry, { runtime: "publisher-client" })
