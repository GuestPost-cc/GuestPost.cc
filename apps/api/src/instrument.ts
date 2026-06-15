// Sentry initialization for the API process.
//
// Phase 7.0 (audit #8 + #11). This file MUST be the very first import in
// `main.ts` so Sentry's auto-instrumentation can wrap http / express / pg
// / undici before any other module loads. Importing it later means
// auto-instrumentation silently no-ops and you lose stack-trace context.
//
// Behavior:
//   - With SENTRY_DSN set: Sentry.init() is called with redaction filter,
//     release from GIT_COMMIT_SHA, environment from SENTRY_ENVIRONMENT.
//   - Without SENTRY_DSN: no-op. Logs `[SENTRY] disabled (no DSN) runtime=api`.
//
// Either way, exactly one self-test line is emitted so deployment verification
// can grep for it.

import * as Sentry from "@sentry/node"
import { initSentry } from "@guestpost/shared"

initSentry(Sentry, { runtime: "api" })
