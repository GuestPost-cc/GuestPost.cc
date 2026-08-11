// Phase 7.0 — worker env validation.
//
// Consolidates ad-hoc process.env reads that were scattered across processors.
// Hard-required vars cause exit(1) on startup. Optional vars warn once.

import {
  financialDocumentIssuerFromEnv,
  resolveFinanceRuntimeMode,
} from "@guestpost/shared"
import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"

const logger = createLogger("worker.env")

const REQUIRED = ["DATABASE_URL"] as const

const PRODUCTION_REQUIRED = [
  "QUEUE_SIGNING_SECRET",
  "EMAIL_DELIVERY_MODE",
] as const

export type EmailDeliveryMode = "disabled" | "capture" | "live"

const EMAIL_DELIVERY_MODES = ["disabled", "capture", "live"] as const
const EMAIL_RECIPIENT_DOMAIN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** Resolve the configured delivery mode, failing closed in production. */
export function emailDeliveryModeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): EmailDeliveryMode {
  const configured = env.EMAIL_DELIVERY_MODE?.trim().toLowerCase()
  if (EMAIL_DELIVERY_MODES.includes(configured as EmailDeliveryMode)) {
    return configured as EmailDeliveryMode
  }
  return env.NODE_ENV === "production" ? "disabled" : "capture"
}

/** Parse, normalize, deduplicate, and count invalid exact recipient domains. */
export function emailAllowedRecipientDomainsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { configured: boolean; domains: string[]; invalidCount: number } {
  const raw = env.EMAIL_ALLOWED_RECIPIENT_DOMAINS ?? ""
  const entries = raw
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean)
  const valid = entries.filter((domain) => EMAIL_RECIPIENT_DOMAIN.test(domain))
  return {
    configured: raw.trim().length > 0,
    domains: [...new Set(valid)],
    invalidCount: entries.length - valid.length,
  }
}

/** Return the fail-closed allowlist validation error for an email mode. */
export function emailRecipientAllowlistIssueFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  mode: EmailDeliveryMode = emailDeliveryModeFromEnv(env),
): "invalid-or-empty" | "capture-required" | null {
  if (mode === "disabled") return null
  const allowlist = emailAllowedRecipientDomainsFromEnv(env)
  if (
    allowlist.configured &&
    (allowlist.domains.length === 0 || allowlist.invalidCount > 0)
  ) {
    return "invalid-or-empty"
  }
  if (mode === "capture" && allowlist.domains.length === 0) {
    return "capture-required"
  }
  return null
}

const EMAIL_REQUIRED = [
  "SMTP_HOST",
  "SMTP_USER",
  "SMTP_PASS",
  "EMAIL_FROM",
  "NEXT_PUBLIC_PORTAL_URL",
  "NEXT_PUBLIC_PUBLISHER_URL",
  "NEXT_PUBLIC_ADMIN_URL",
] as const

const OPTIONAL_WARN = [
  // Without SENTRY_DSN, the worker still runs — Sentry just no-ops.
  "SENTRY_DSN",
  "AHREFS_API_KEY",
  "OPENPAGERANK_API_KEY",
] as const

function validPublicOrigin(value: string | undefined): boolean {
  if (!value) return false
  try {
    const parsed = new URL(value)
    return (
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      parsed.pathname === "/" &&
      !parsed.search &&
      !parsed.hash
    )
  } catch {
    return false
  }
}

export function validateEnv(): void {
  const missing: string[] = []
  for (const key of REQUIRED) {
    if (!process.env[key]) missing.push(key)
  }
  if (!process.env.QUEUE_REDIS_URL?.trim() && !process.env.REDIS_URL?.trim()) {
    missing.push("QUEUE_REDIS_URL (or REDIS_URL fallback)")
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
      logger.error("FATAL: missing production-required env vars", {
        missing: missingProd,
      })
      process.exit(1)
    }

    try {
      financialDocumentIssuerFromEnv(process.env)
      logger.info("financial document configuration validated")
    } catch (error) {
      logger.error("FATAL: financial document configuration is invalid", {
        error: error instanceof Error ? error.message : String(error),
      })
      process.exit(1)
    }

    const configuredEmailMode =
      process.env.EMAIL_DELIVERY_MODE?.trim().toLowerCase()
    if (
      !EMAIL_DELIVERY_MODES.includes(configuredEmailMode as EmailDeliveryMode)
    ) {
      logger.error("FATAL: invalid EMAIL_DELIVERY_MODE", {
        allowed: EMAIL_DELIVERY_MODES,
      })
      process.exit(1)
    }
    const emailMode = emailDeliveryModeFromEnv()
    const emailAllowlist = emailAllowedRecipientDomainsFromEnv()
    const emailAllowlistIssue = emailRecipientAllowlistIssueFromEnv(
      process.env,
      emailMode,
    )
    if (emailAllowlistIssue === "invalid-or-empty") {
      logger.error(
        "FATAL: EMAIL_ALLOWED_RECIPIENT_DOMAINS contains invalid domains or no usable domain",
        { invalidCount: emailAllowlist.invalidCount },
      )
      process.exit(1)
    }
    if (emailAllowlistIssue === "capture-required") {
      logger.error(
        "FATAL: capture email mode requires EMAIL_ALLOWED_RECIPIENT_DOMAINS",
      )
      process.exit(1)
    }
    if (emailMode !== "disabled") {
      const missingEmail = EMAIL_REQUIRED.filter(
        (key) => !process.env[key]?.trim(),
      )
      if (missingEmail.length > 0) {
        logger.error(
          "FATAL: email delivery is enabled but configuration is missing",
          {
            missing: missingEmail,
          },
        )
        process.exit(1)
      }
      const port = Number(process.env.SMTP_PORT ?? 587)
      if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
        logger.error("FATAL: SMTP_PORT must be a valid TCP port")
        process.exit(1)
      }
      if (
        !process.env.EMAIL_FROM?.includes("@") ||
        /[\r\n]/.test(process.env.EMAIL_FROM)
      ) {
        logger.error("FATAL: EMAIL_FROM must be a safe mailbox value")
        process.exit(1)
      }
      const invalidOrigins = [
        "NEXT_PUBLIC_PORTAL_URL",
        "NEXT_PUBLIC_PUBLISHER_URL",
        "NEXT_PUBLIC_ADMIN_URL",
      ].filter((key) => !validPublicOrigin(process.env[key]))
      if (invalidOrigins.length > 0) {
        logger.error("FATAL: email application origins must be HTTPS origins", {
          invalid: invalidOrigins,
        })
        process.exit(1)
      }
    }
  }

  const financeMode = resolveFinanceRuntimeMode(
    process.env.FINANCE_RUNTIME_MODE,
    process.env.NODE_ENV,
  )
  if (!financeMode.valid) {
    logger.error(
      "FINANCE_RUNTIME_MODE is missing or invalid; financial mutations are locked",
      {
        mode: financeMode.mode,
        configured: financeMode.configured,
      },
    )
  } else {
    logger.info("finance runtime mode validated", { mode: financeMode.mode })
  }

  for (const key of OPTIONAL_WARN) {
    if (!process.env[key]) {
      logger.warn("optional env var not set — feature will be disabled", {
        key,
      })
    }
  }
}
