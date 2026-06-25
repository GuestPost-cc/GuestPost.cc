// Phase 7.7 B — Structured logger for API + worker.
//
// Each log line is one JSON object with stable keys:
//   { ts, level, service, environment, release, requestId, msg, ...ctx }
//
// JSON mode (production, or LOG_FORMAT=json) → grep-friendly + parseable
// by any log aggregator (Datadog, Loki, CloudWatch, Vector, etc.).
// Pretty mode (dev, NODE_ENV !== production) → ANSI-colored single-line
// with requestId shortened for terminal readability.
//
// requestId is auto-injected from the AsyncLocalStorage frame established
// by `runWithRequestId` (request-context.ts). Service operators searching by
// requestId get matching log lines + matching AuditLog rows + matching
// Sentry tags — the Phase 7.7 mission spine.
//
// Node-only (uses `process.stdout` / `process.stderr`). Must be deep-
// imported via `@guestpost/shared/dist/observability/structured-logger`;
// NOT re-exported from the browser-safe barrel (index.ts).

import { getRequestId } from "./request-context"

type LogLevel = "debug" | "info" | "warn" | "error"
export interface LogContext {
  [key: string]: unknown
}

export interface Logger {
  debug: (msg: string, ctx?: LogContext) => void
  info: (msg: string, ctx?: LogContext) => void
  warn: (msg: string, ctx?: LogContext) => void
  error: (msg: string, ctx?: LogContext) => void
  child: (extra: LogContext) => Logger
}

// Resolved once at module init — these are runtime-stable per Phase 7.0's
// Sentry runtime/release tagging conventions. environment falls back to
// SENTRY_ENVIRONMENT → NODE_ENV → "development"; release falls back to
// SENTRY_RELEASE → npm_package_version → "unknown". Aggregation pipelines
// that swallow prod+staging+preview logs together can split by these.
const ENVIRONMENT =
  process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development"
const RELEASE =
  process.env.SENTRY_RELEASE ?? process.env.npm_package_version ?? "unknown"

const USE_PRETTY =
  process.env.LOG_FORMAT !== "json" && process.env.NODE_ENV !== "production"

const COLOR_MAP: Record<LogLevel, string> = {
  debug: "\x1b[90m", // grey
  info: "\x1b[36m", // cyan
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
}
const RESET = "\x1b[0m"

function streamFor(level: LogLevel): NodeJS.WriteStream {
  return level === "error" || level === "warn" ? process.stderr : process.stdout
}

function emit(
  level: LogLevel,
  service: string,
  baseCtx: LogContext,
  msg: string,
  ctx?: LogContext,
) {
  const requestId = getRequestId() ?? undefined
  const record = {
    ts: new Date().toISOString(),
    level,
    service,
    environment: ENVIRONMENT,
    release: RELEASE,
    requestId,
    msg,
    ...baseCtx,
    ...ctx,
  }

  if (USE_PRETTY) {
    const ridSuffix = requestId ? ` rid=${requestId.slice(0, 8)}` : ""
    const merged = { ...baseCtx, ...ctx }
    const ctxStr = Object.keys(merged).length
      ? ` ${JSON.stringify(merged)}`
      : ""
    // env + release intentionally omitted from pretty output (dev noise
    // reduction); always present in JSON mode for prod log aggregation.
    streamFor(level).write(
      `${COLOR_MAP[level]}[${level.toUpperCase()}]${RESET} ${service}${ridSuffix} ${msg}${ctxStr}\n`,
    )
    return
  }

  // JSON.stringify natively omits keys whose value is `undefined` — this
  // keeps the requestId field absent (rather than `null`) when no ALS frame
  // is active, matching log-aggregator expectations.
  streamFor(level).write(`${JSON.stringify(record)}\n`)
}

/**
 * Create a service-scoped logger. Per-module convention:
 *   const logger = createLogger("api.audit")
 *
 * @param service Stable dotted name, e.g. "api.audit", "worker.settlement"
 * @param baseCtx Optional context merged into every emit (e.g. { category: "x" })
 */
export function createLogger(
  service: string,
  baseCtx: LogContext = {},
): Logger {
  return {
    debug: (msg, ctx) => emit("debug", service, baseCtx, msg, ctx),
    info: (msg, ctx) => emit("info", service, baseCtx, msg, ctx),
    warn: (msg, ctx) => emit("warn", service, baseCtx, msg, ctx),
    error: (msg, ctx) => emit("error", service, baseCtx, msg, ctx),
    child: (extra) => createLogger(service, { ...baseCtx, ...extra }),
  }
}

// Internal accessors for tests.
export function __testGetEnvironment(): string {
  return ENVIRONMENT
}
export function __testGetRelease(): string {
  return RELEASE
}
export function __testIsPretty(): boolean {
  return USE_PRETTY
}
