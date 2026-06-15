// Shared Sentry initialization for every runtime in the monorepo.
//
// Design: packages/shared takes no compile-time dep on @sentry/node or
// @sentry/nextjs. Each consumer imports its own SDK and passes it in, so
// this file works for API (Node SDK), worker (Node SDK), and Next.js apps
// (browser / server / edge SDK).
//
// Responsibilities:
//   1. Build a consistent options object (DSN, release, environment, sample rate)
//   2. Apply a single beforeSend redaction filter — the only line of defense
//      between leaked PII / secrets and the Sentry dashboard
//   3. Emit exactly one self-test log line so deployment verification is grep-able
//   4. Validate runtime tag against a closed allowlist — wrong literal = throw
//
// Adding a new redacted key: append to REDACTED_KEYS below. New sensitive
// payment-method fields (e.g. a future Wise replacement) must be added here
// or they will leak into Sentry events.

export const RUNTIME_TAGS = [
  "api",
  "worker",
  "portal-client",
  "portal-server",
  "portal-edge",
  "publisher-client",
  "publisher-server",
  "publisher-edge",
  "admin-client",
  "admin-server",
  "admin-edge",
  "website-client",
  "website-server",
  "website-edge",
] as const

export type SentryRuntimeTag = (typeof RUNTIME_TAGS)[number]

// Keys whose values are redacted from breadcrumb data, extra context, and
// event request bodies. Match is case-insensitive and is applied to property
// names anywhere in the object tree (recursive).
export const REDACTED_KEYS = [
  "password",
  "accessToken",
  "refreshToken",
  "apiKey",
  "paymentMethod",
  "paymentMethodId",
  "verificationToken",
  "encryptedPayload",
  "webhookSecret",
  "signature",
] as const

// Headers stripped from request data on every event.
const REDACTED_HEADERS = ["authorization", "cookie", "set-cookie"] as const

const REDACTED_PLACEHOLDER = "[REDACTED]"

export interface SentryStartupConfig {
  dsn: string | undefined
  runtime: SentryRuntimeTag
  release: string | undefined
  environment: string
  tracesSampleRate: number
}

export interface InitSentryOptions {
  runtime: SentryRuntimeTag
  // Override DSN; otherwise reads SENTRY_DSN (backend) or NEXT_PUBLIC_SENTRY_DSN (browser).
  dsn?: string
  // Extra Sentry init options (integrations, transport, etc) merged into the final options object.
  extra?: Record<string, unknown>
  // Override logger for tests.
  logger?: Pick<Console, "log" | "warn">
}

// Loose Sentry-module shape. Both @sentry/node and @sentry/nextjs expose
// init(opts) — we don't need anything else here.
export interface SentryLike {
  init: (options: Record<string, unknown>) => void
}

function readEnv(key: string): string | undefined {
  // Works in Node and in browser bundlers that inline process.env. The
  // `typeof process` guard avoids ReferenceError in raw browser contexts.
  if (typeof process === "undefined" || !process.env) return undefined
  const value = process.env[key]
  return value && value.length > 0 ? value : undefined
}

function resolveDsn(override: string | undefined, runtime: SentryRuntimeTag): string | undefined {
  if (override) return override
  // Browser bundles inject NEXT_PUBLIC_SENTRY_DSN at build time; Node reads SENTRY_DSN.
  const isBrowserRuntime = runtime.endsWith("-client") || runtime.endsWith("-edge")
  if (isBrowserRuntime) {
    return readEnv("NEXT_PUBLIC_SENTRY_DSN") ?? readEnv("SENTRY_DSN")
  }
  return readEnv("SENTRY_DSN")
}

function resolveEnvironment(): string {
  return readEnv("SENTRY_ENVIRONMENT") ?? readEnv("NODE_ENV") ?? "development"
}

function resolveRelease(): string | undefined {
  return readEnv("GIT_COMMIT_SHA") ?? readEnv("SENTRY_RELEASE") ?? undefined
}

function resolveTracesSampleRate(environment: string): number {
  const override = readEnv("SENTRY_TRACES_SAMPLE_RATE")
  if (override) {
    const parsed = Number(override)
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) return parsed
  }
  // Default: capture every trace in dev (100%), 10% in prod, 10% otherwise.
  if (environment === "production") return 0.1
  if (environment === "development") return 1.0
  return 0.1
}

// Recursive redactor — operates on a structuredClone of the event so we never
// mutate the caller's object. Strips REDACTED_HEADERS from any `headers` object
// it finds, and replaces values of REDACTED_KEYS with [REDACTED] anywhere.
export function redactSensitiveData<T>(value: T): T {
  if (value === null || value === undefined) return value
  if (typeof value !== "object") return value
  if (Array.isArray(value)) {
    return value.map((v) => redactSensitiveData(v)) as unknown as T
  }
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase()
    // Header object: redact known header names case-insensitively.
    if (lowerKey === "headers" && val && typeof val === "object" && !Array.isArray(val)) {
      const headers: Record<string, unknown> = {}
      for (const [hk, hv] of Object.entries(val as Record<string, unknown>)) {
        headers[hk] = (REDACTED_HEADERS as readonly string[]).includes(hk.toLowerCase())
          ? REDACTED_PLACEHOLDER
          : redactSensitiveData(hv)
      }
      out[key] = headers
      continue
    }
    // Redact any value whose key matches the sensitive list (case-insensitive).
    if ((REDACTED_KEYS as readonly string[]).some((k) => k.toLowerCase() === lowerKey)) {
      out[key] = REDACTED_PLACEHOLDER
      continue
    }
    out[key] = redactSensitiveData(val)
  }
  return out as unknown as T
}

// The actual beforeSend installed in Sentry. Returns the event with redacted
// fields, or null to drop the event entirely (we never drop; redaction is enough).
export function buildBeforeSend() {
  return (event: Record<string, unknown>): Record<string, unknown> => {
    return redactSensitiveData(event)
  }
}

export function buildStartupConfig(opts: InitSentryOptions): SentryStartupConfig {
  if (!(RUNTIME_TAGS as readonly string[]).includes(opts.runtime)) {
    throw new Error(
      `[SENTRY] invalid runtime tag '${opts.runtime}'. Allowed: ${RUNTIME_TAGS.join(", ")}`,
    )
  }
  const environment = resolveEnvironment()
  return {
    dsn: resolveDsn(opts.dsn, opts.runtime),
    runtime: opts.runtime,
    release: resolveRelease(),
    environment,
    tracesSampleRate: resolveTracesSampleRate(environment),
  }
}

export function logSentryStartup(config: SentryStartupConfig, logger?: Pick<Console, "log" | "warn">): void {
  const log = logger ?? console
  if (!config.dsn) {
    log.warn(`[SENTRY] disabled (no DSN) runtime=${config.runtime}`)
    return
  }
  log.log(
    `[SENTRY] enabled runtime=${config.runtime} release=${config.release ?? "unknown"} environment=${config.environment}`,
  )
}

// Main entry. Each runtime calls this once at startup. The Sentry SDK module
// (Sentry-node or Sentry-nextjs) is passed in so packages/shared takes no
// SDK dependency.
export function initSentry(Sentry: SentryLike, opts: InitSentryOptions): SentryStartupConfig {
  const config = buildStartupConfig(opts)
  logSentryStartup(config, opts.logger)
  if (!config.dsn) return config
  Sentry.init({
    dsn: config.dsn,
    release: config.release,
    environment: config.environment,
    tracesSampleRate: config.tracesSampleRate,
    beforeSend: buildBeforeSend(),
    ...(opts.extra ?? {}),
  })
  return config
}
