// Phase 7.0 — worker env validation.
//
// Consolidates ad-hoc process.env reads that were scattered across processors.
// Hard-required vars cause exit(1) on startup. Optional vars warn once.

import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"

const logger = createLogger("worker.env")

const REQUIRED = ["DATABASE_URL", "REDIS_URL"] as const

const PRODUCTION_REQUIRED = ["QUEUE_SIGNING_SECRET"] as const

const OPTIONAL_WARN = [
  // Without SENTRY_DSN, the worker still runs — Sentry just no-ops.
  "SENTRY_DSN",
] as const

export function validateEnv(): void {
  const missing: string[] = []
  for (const key of REQUIRED) {
    if (!process.env[key]) missing.push(key)
  }
  if (missing.length > 0) {
    logger.error("FATAL: missing required env vars", { missing })
    process.exit(1)
  }

  if (process.env.NODE_ENV === "production") {
    const missingProd: string[] = []
    for (const key of PRODUCTION_REQUIRED) {
      if (!process.env[key]) missingProd.push(key)
    }
    if (missingProd.length > 0) {
      logger.error("FATAL: missing production-required env vars", { missing: missingProd })
      process.exit(1)
    }
  }

  for (const key of OPTIONAL_WARN) {
    if (!process.env[key]) {
      logger.warn("optional env var not set — feature will be disabled", { key })
    }
  }
}
