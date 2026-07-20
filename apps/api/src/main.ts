import { config } from "dotenv"

// Dev env file loads ONLY under explicit NODE_ENV=development. Unset NODE_ENV
// (staging, CI) fails closed: nothing is loaded and validateEnv() exits on
// missing required vars, forcing explicit configuration.
if (process.env.NODE_ENV === "development") {
  config({
    path: require("node:path").resolve(__dirname, "../../../.env.development"),
  })
}

// Sentry instrumentation MUST be imported before any other module so its
// auto-instrumentation can wrap http / express / pg / undici. Importing it
// later silently no-ops the wrappers.
import "./instrument"
import { createAuth, toNodeHandler } from "@guestpost/auth"
import { QUEUES } from "@guestpost/shared"
import {
  generateRequestId,
  isValidRequestId,
  runWithRequestId,
} from "@guestpost/shared/dist/observability/request-context"
import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"
import { ValidationPipe } from "@nestjs/common"
import { NestFactory } from "@nestjs/core"
import { ExpressAdapter } from "@nestjs/platform-express"
import * as Sentry from "@sentry/node"
import { Queue } from "bullmq"
import cookieParser from "cookie-parser"
import cors from "cors"
import express from "express"
import rateLimit from "express-rate-limit"
import helmet from "helmet"
import { AppModule } from "./app.module"
import {
  initAuthContextSubscriber,
  invalidateAuthContext,
} from "./common/auth-context-cache"
import { SentryExceptionFilter } from "./common/filters/sentry-exception.filter"
import { hasAuthCredentials } from "./common/has-auth-credentials"
import { SentryBusinessContextInterceptor } from "./common/interceptors/sentry-business-context.interceptor"
import { PrismaService } from "./common/prisma.service"
import { getQueueConnection, getRedisClient } from "./common/redis-client"
import { validateStripeEnvironment } from "./common/stripe-client"
import { QueueService } from "./modules/queues/queue.service"

const REQUIRED_ENV_VARS = [
  "DATABASE_URL",
  "REDIS_URL",
  "BETTER_AUTH_SECRET",
] as const

const PRODUCTION_ONLY_VARS = ["SMTP_HOST", "EMAIL_FROM"] as const
const bootstrapLogger = createLogger("api.bootstrap")

function validateEnv(): void {
  const missing: string[] = []
  for (const key of REQUIRED_ENV_VARS) {
    if (!process.env[key]) missing.push(key)
  }
  if (missing.length > 0) {
    console.error(
      `FATAL: Missing required environment variables: ${missing.join(", ")}`,
    )
    process.exit(1)
  }

  if ((process.env.BETTER_AUTH_SECRET?.trim().length ?? 0) < 32) {
    bootstrapLogger.error(
      "BETTER_AUTH_SECRET must be a random value of at least 32 characters",
    )
    process.exit(1)
  }

  if (process.env.NODE_ENV === "production") {
    for (const key of PRODUCTION_ONLY_VARS) {
      if (!process.env[key]) {
        console.warn(
          `WARN: Production recommended variable "${key}" is not set`,
        )
      }
    }
    if (!process.env.QUEUE_SIGNING_SECRET) {
      console.error(
        "FATAL: QUEUE_SIGNING_SECRET is required in production (do not reuse JWT_SECRET)",
      )
      process.exit(1)
    }
  }

  try {
    validateStripeEnvironment()
  } catch (error) {
    bootstrapLogger.error("Stripe environment validation failed", {
      error: (error as Error).message,
    })
    process.exit(1)
  }
}

async function bootstrap() {
  validateEnv()

  const server = express()

  server.set("trust proxy", 1)
  server.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: [
            "'self'",
            ...(process.env.NEXT_PUBLIC_API_URL
              ? [process.env.NEXT_PUBLIC_API_URL]
              : []),
          ],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: process.env.NODE_ENV === "production",
      crossOriginOpenerPolicy: { policy: "same-origin" },
      crossOriginResourcePolicy: { policy: "same-origin" },
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
      },
      noSniff: true,
      xssFilter: true,
      frameguard: { action: "deny" },
    }),
  )

  // Health check - before rate limiting (liveness only — no dependency checks)
  server.get("/api/v1/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() })
  })

  // ── Environment-aware rate limiting ──────────────────────────────────────

  // hasAuthCredentials is extracted to common/has-auth-credentials.ts so it
  // can be unit-tested in isolation (cookie-shape regression coverage).

  interface EnvLimits {
    auth: {
      signIn: number
      signUp: number
      magicLink: number
      resetPassword: number
    }
    marketplaceAnon: number
    marketplaceAuth: number
    generalAnon: number
    generalAuth: number
    admin: number
    billing: number
    // Per-IP first-line cap on verification trigger endpoints (publisher DNS
    // verify, admin bulk-retry / recompute-trust). Secondary to the DB-based
    // per-publisher/per-website business throttles — not a replacement.
    verification: number
  }

  function getEnvLimits(): EnvLimits {
    const env = process.env.NODE_ENV || "development"

    const defaults: Record<string, EnvLimits> = {
      development: {
        auth: { signIn: 100, signUp: 50, magicLink: 50, resetPassword: 50 },
        marketplaceAnon: 1000,
        marketplaceAuth: 1000,
        generalAnon: 5000,
        generalAuth: 5000,
        admin: 5000,
        // Test suites (integration + concurrency back-to-back) legitimately
        // exceed 10 deposits/min; staging/production stay at 10.
        billing: 1000,
        verification: 1000,
      },
      staging: {
        auth: { signIn: 10, signUp: 5, magicLink: 5, resetPassword: 5 },
        marketplaceAnon: 120,
        marketplaceAuth: 120,
        generalAnon: 300,
        generalAuth: 300,
        admin: 300,
        billing: 10,
        verification: 30,
      },
      production: {
        auth: { signIn: 5, signUp: 5, magicLink: 5, resetPassword: 5 },
        marketplaceAnon: 60,
        marketplaceAuth: 300,
        generalAnon: 60,
        generalAuth: 300,
        admin: 300,
        billing: 10,
        verification: 15,
      },
    }

    const d = defaults[env] ?? defaults.development

    return {
      auth: {
        signIn: Number(process.env.AUTH_RATE_LIMIT_LOGIN_MAX) || d.auth.signIn,
        signUp:
          Number(process.env.AUTH_RATE_LIMIT_REGISTER_MAX) || d.auth.signUp,
        magicLink:
          Number(process.env.AUTH_RATE_LIMIT_MAGIC_LINK_MAX) ||
          d.auth.magicLink,
        resetPassword:
          Number(process.env.AUTH_RATE_LIMIT_RESET_MAX) || d.auth.resetPassword,
      },
      marketplaceAnon:
        Number(process.env.MARKETPLACE_RATE_LIMIT_ANON_MAX) ||
        d.marketplaceAnon,
      marketplaceAuth:
        Number(process.env.MARKETPLACE_RATE_LIMIT_AUTH_MAX) ||
        d.marketplaceAuth,
      generalAnon: Number(process.env.PUBLIC_RATE_LIMIT_MAX) || d.generalAnon,
      generalAuth:
        Number(process.env.AUTHENTICATED_RATE_LIMIT_MAX) || d.generalAuth,
      admin: Number(process.env.ADMIN_RATE_LIMIT_MAX) || d.admin,
      billing: Number(process.env.BILLING_RATE_LIMIT_MAX) || d.billing,
      verification:
        Number(process.env.VERIFICATION_RATE_LIMIT_MAX) || d.verification,
    }
  }

  function createLimiter(max: number, message?: string) {
    return rateLimit({
      windowMs: 60 * 1000,
      max,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        statusCode: 429,
        message: message ?? "Too many requests, try again later",
      },
    })
  }

  // Mirrors better-auth@1.6.14 rateLimitResponse() exactly so the IP-layer
  // and the email-layer (Phase 7.8 Better Auth plugin) return identical 429s.
  // Account-enumeration safeguard: an attacker comparing the two responses
  // must not be able to tell "IP limit" from "email limit" from the wire
  // shape.
  const BETTER_AUTH_429_BODY = {
    message: "Too many requests. Please try again later.",
  }
  function createAuthLimiter(max: number) {
    return rateLimit({
      windowMs: 60 * 1000,
      max,
      standardHeaders: true,
      legacyHeaders: false,
      handler: (_req, res, _next, options) => {
        const retryAfterSec = Math.ceil(options.windowMs / 1000)
        res
          .status(429)
          .setHeader("X-Retry-After", String(retryAfterSec))
          .json(BETTER_AUTH_429_BODY)
      },
    })
  }

  function createTieredLimiters(
    anonMax: number,
    authMax: number,
    message?: string,
  ) {
    const anon = rateLimit({
      windowMs: 60 * 1000,
      max: anonMax,
      skip: (req: express.Request) => hasAuthCredentials(req),
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        statusCode: 429,
        message: message ?? "Too many requests, try again later",
      },
    })
    const authed = rateLimit({
      windowMs: 60 * 1000,
      max: authMax,
      skip: (req: express.Request) => !hasAuthCredentials(req),
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        statusCode: 429,
        message: message ?? "Too many requests, try again later",
      },
    })
    return [anon, authed]
  }

  const envLimits = getEnvLimits()

  // Auth endpoints — one limiter per path, same limit for all users.
  // Response shape mirrors better-auth's built-in 429 so the IP-layer here
  // is indistinguishable from the email-layer plugin (#26 enumeration
  // safeguard).
  server.use("/api/v1/auth/sign-in", createAuthLimiter(envLimits.auth.signIn))
  server.use("/api/v1/auth/sign-up", createAuthLimiter(envLimits.auth.signUp))
  server.use(
    "/api/v1/auth/sign-in/magic-link",
    createAuthLimiter(envLimits.auth.magicLink),
  )
  server.use(
    "/api/v1/auth/reset-password",
    createAuthLimiter(envLimits.auth.resetPassword),
  )
  server.use(
    "/api/v1/auth/request-password-reset",
    createAuthLimiter(envLimits.auth.resetPassword),
  )

  // Billing — webhook exempt from rate limit (Stripe retries on failure; protected by signature verification instead)
  server.use(
    "/api/v1/billing",
    rateLimit({
      windowMs: 60 * 1000,
      max: envLimits.billing,
      skip: (req: express.Request) => req.path.startsWith("/webhook"),
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        statusCode: 429,
        message: "Too many billing requests, try again later",
      },
    }),
  )

  // Marketplace — two-tier (anon vs authenticated)
  server.use(
    "/api/v1/marketplace/listings",
    ...createTieredLimiters(
      envLimits.marketplaceAnon,
      envLimits.marketplaceAuth,
    ),
  )
  server.use(
    "/api/v1/marketplace/categories",
    ...createTieredLimiters(
      envLimits.marketplaceAnon,
      envLimits.marketplaceAuth,
    ),
  )
  server.use(
    "/api/v1/marketplace/tags",
    ...createTieredLimiters(
      envLimits.marketplaceAnon,
      envLimits.marketplaceAuth,
    ),
  )
  server.use(
    "/api/v1/marketplace/stats",
    ...createTieredLimiters(
      envLimits.marketplaceAnon,
      envLimits.marketplaceAuth,
    ),
  )
  server.use(
    "/api/v1/marketplace/services",
    ...createTieredLimiters(
      envLimits.marketplaceAnon,
      envLimits.marketplaceAuth,
    ),
  )

  // Verification trigger endpoints — lightweight per-IP first line against
  // automated abuse, layered ON TOP of the DB-based per-publisher/per-website
  // throttles (which stay the primary, tenant-aware control). Only counts the
  // POST routes that actually kick off DNS lookups / verification work.
  const VERIFICATION_TRIGGER_RE =
    /\/(websites\/[^/]+\/verify|websites\/verification\/bulk-retry|websites\/[^/]+\/recompute-trust)$/
  function isVerificationTrigger(req: express.Request): boolean {
    return req.method === "POST" && VERIFICATION_TRIGGER_RE.test(req.path)
  }
  server.use(
    "/api/v1",
    rateLimit({
      windowMs: 60 * 1000,
      max: envLimits.verification,
      skip: (req: express.Request) => !isVerificationTrigger(req),
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        statusCode: 429,
        message: "Too many verification requests from this IP, try again later",
      },
    }),
  )

  // Admin
  server.use(
    "/api/v1/admin",
    createLimiter(envLimits.admin, "Too many admin requests, try again later"),
  )

  // Global fallback — two-tier, catches all unmatched routes
  server.use(
    ...createTieredLimiters(envLimits.generalAnon, envLimits.generalAuth),
  )

  const configuredOrigins = process.env.CORS_ORIGIN?.split(",") ?? [
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:3002",
    "http://localhost:3003",
  ]
  const isDev = process.env.NODE_ENV !== "production"
  const localPatterns = [
    /^https?:\/\/localhost(:\d+)?$/i,
    /^https?:\/\/127\.\d+\.\d+\.\d+(:\d+)?$/i,
    /^https?:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/i,
    /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+(:\d+)?$/i,
    /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?$/i,
  ]
  server.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || configuredOrigins.includes(origin))
          return callback(null, true)
        if (isDev && localPatterns.some((p) => p.test(origin)))
          return callback(null, true)
        callback(null, false)
      },
      credentials: true,
    }),
  )

  // Phase 7.8 #26 — Better Auth instance with the email-keyed rate-limit
  // plugin. The IP-layer limiter (createAuthLimiter above) is the first
  // line; this plugin adds a second layer keyed by SHA-256(email) so
  // credential-stuffing across IP pools (one email, many source IPs)
  // gets caught here. Response shape is byte-identical to better-auth's
  // built-in 429 → no enumeration oracle.
  //
  // Limits are env-tunable. Defaults: dev/test 10x looser to keep
  // integration suites comfortable; staging/prod 10/5/5/5 per hour.
  const isAuthRateLimitDev =
    process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "staging"
  const authRateLimitMultiplier = isAuthRateLimitDev ? 10 : 1
  const authLogger = createLogger("api")

  const app = await NestFactory.create(AppModule, new ExpressAdapter(server))

  app.setGlobalPrefix("api/v1")
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  app.useGlobalFilters(new SentryExceptionFilter())
  app.useGlobalInterceptors(new SentryBusinessContextInterceptor())

  // Resolve QueueService from DI before mounting Better Auth, so the
  // sendEmail callback never sees a null ref (eliminates startup race).
  const queueServiceRef: QueueService = app.get(QueueService)
  if (!queueServiceRef) {
    console.error(
      "FATAL: QueueService failed to resolve — aborting startup. " +
        "This should never happen: QueueService is a transient dependency of AppModule.",
    )
    process.exit(1)
  }
  authLogger.info("Nest initialized")
  authLogger.info("QueueService resolved", {
    queueService: queueServiceRef.constructor.name,
  })

  // M-1 — cross-pod auth-context invalidation subscriber (Redis pub/sub).
  // Must be called after Redis connection is available but before any
  // auth-dependent requests arrive. Subscription is fire-and-forget;
  // Redis unavailability is logged but does not block startup.
  initAuthContextSubscriber()
  authLogger.info("Auth context cache subscriber initialized")

  // Phase A3 — dependency-checked readiness endpoint. Runs after Nest init
  // so PrismaService connection is established. Redis PING uses the HTTP
  // client (getRedisClient). Returns 503 when any dependency is down.
  const prismaService: PrismaService = app.get(PrismaService)
  server.get("/api/v1/health/ready", async (_req, res) => {
    const checks: { redis: string; database: string } = {
      redis: "ok",
      database: "ok",
    }
    let allOk = true
    try {
      const result = await getRedisClient().ping()
      if (result !== "PONG") {
        checks.redis = `unexpected response: ${result}`
        allOk = false
      }
    } catch (err) {
      checks.redis = err instanceof Error ? err.message : String(err)
      allOk = false
    }
    try {
      await prismaService.$queryRaw`SELECT 1`
    } catch (err) {
      checks.database = err instanceof Error ? err.message : String(err)
      allOk = false
    }
    res.status(allOk ? 200 : 503).json({
      status: allOk ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      checks,
    })
  })

  // Phase A3 — queue depth metrics using the BullMQ connection.
  // Mirrors the worker's /metrics/queues for API-side queue inspection.
  const queueConnection = getQueueConnection()
  const queueMetricsCacheMs = Math.max(
    Number(process.env.QUEUE_METRICS_CACHE_MS) || 30 * 60_000,
    10_000,
  )
  let queueMetricsCache:
    | { expiresAt: number; value: Record<string, unknown> }
    | undefined
  let queueMetricsInFlight: Promise<Record<string, unknown>> | undefined

  const collectQueueMetrics = async (): Promise<Record<string, unknown>> => {
    if (queueMetricsCache && queueMetricsCache.expiresAt > Date.now()) {
      return queueMetricsCache.value
    }
    if (queueMetricsInFlight) return queueMetricsInFlight
    queueMetricsInFlight = (async () => {
      const queueNames = Object.values(QUEUES)
      const entries = await Promise.all(
        queueNames.map(async (name) => {
          const q = new Queue(name, { connection: queueConnection as any })
          try {
            const counts = await q.getJobCounts(
              "waiting",
              "active",
              "delayed",
              "completed",
              "failed",
              "paused",
            )
            return [name, counts] as const
          } finally {
            await q.close().catch(() => {})
          }
        }),
      )
      const queues: Record<string, unknown> = {}
      const totals = {
        waiting: 0,
        active: 0,
        delayed: 0,
        completed: 0,
        failed: 0,
        paused: 0,
      }
      for (const [name, counts] of entries) {
        const normalized = {
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          delayed: counts.delayed ?? 0,
          completed: counts.completed ?? 0,
          failed: counts.failed ?? 0,
          paused: counts.paused ?? 0,
        }
        queues[name] = normalized
        for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
          totals[key] += normalized[key]
        }
      }
      return { queues, totals }
    })()
    try {
      const value = await queueMetricsInFlight
      queueMetricsCache = {
        expiresAt: Date.now() + queueMetricsCacheMs,
        value,
      }
      return value
    } finally {
      queueMetricsInFlight = undefined
    }
  }

  server.get("/api/v1/metrics/queues", async (_req, res) => {
    try {
      res.json(await collectQueueMetrics())
    } catch (err) {
      res.status(500).json({
        error: "failed to collect queue metrics",
        message: err instanceof Error ? err.message : String(err),
      })
    }
  })

  const authWithRateLimit = createAuth({
    emailRateLimit: {
      redis: getRedisClient(),
      windowMs:
        Number(process.env.AUTH_EMAIL_RATE_LIMIT_WINDOW_MS) || 3_600_000,
      limits: {
        signIn:
          (Number(process.env.AUTH_EMAIL_RATE_LIMIT_SIGN_IN_MAX) || 10) *
          authRateLimitMultiplier,
        signUp:
          (Number(process.env.AUTH_EMAIL_RATE_LIMIT_SIGN_UP_MAX) || 5) *
          authRateLimitMultiplier,
        magicLink:
          (Number(process.env.AUTH_EMAIL_RATE_LIMIT_MAGIC_LINK_MAX) || 5) *
          authRateLimitMultiplier,
        resetPassword:
          (Number(process.env.AUTH_EMAIL_RATE_LIMIT_RESET_PASSWORD_MAX) || 5) *
          authRateLimitMultiplier,
      },
      logger: authLogger,
    },
    // queueServiceRef is guaranteed non-null by the startup assertion above.
    sendEmail: async (args) => {
      await queueServiceRef.sendEmail(args.jobName ?? "send-email", {
        to: args.to,
        subject: args.subject,
        html: args.html,
      })
    },
    onEmailVerified: (userId) => {
      invalidateAuthContext(userId)
    },
    invalidateAuthContext: (userId) => {
      invalidateAuthContext(userId)
    },
  })
  // Better Auth handler must be before body parsers so it can read raw bodies
  // and therefore sits outside Nest's global middleware/filter pipeline.
  // Establish the same request-correlation and 5xx visibility guarantees here
  // without ever logging credentials or request bodies.
  server.use("/api/v1/auth", (req, res, next) => {
    const incoming = req.headers["x-request-id"]
    const candidate = Array.isArray(incoming) ? incoming[0] : incoming
    const requestId = isValidRequestId(candidate)
      ? candidate
      : generateRequestId()
    const startedAt = Date.now()
    const portalHeader = req.headers["x-portal-type"]
    const portal =
      typeof portalHeader === "string" &&
      ["customer", "publisher", "staff"].includes(portalHeader)
        ? portalHeader
        : "unknown"

    res.setHeader("X-Request-ID", requestId)
    ;(req as express.Request & { requestId?: string }).requestId = requestId
    res.on("finish", () => {
      const context = {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        portal,
        durationMs: Date.now() - startedAt,
      }
      if (res.statusCode >= 500) {
        authLogger.error("auth request failed", context)
        Sentry.withScope((scope) => {
          scope.setTag("requestId", requestId)
          scope.setTag("auth.portal", portal)
          scope.setContext("authRequest", context)
          Sentry.captureMessage("Better Auth request returned 5xx", "error")
        })
      } else {
        authLogger.info("auth request completed", context)
      }
    })
    runWithRequestId(requestId, next)
  })
  server.use("/api/v1/auth", toNodeHandler(authWithRateLimit))
  authLogger.info("Better Auth mounted")

  server.use(
    express.json({
      limit: "1mb",
      verify: (req: any, _res: express.Response, buf: Buffer) => {
        req.rawBody = buf
      },
    }),
  )
  server.use(express.urlencoded({ extended: true, limit: "1mb" }))
  server.use(cookieParser())

  const port = process.env.PORT ?? 4000
  await app.listen(port)
  authLogger.info("API running", { port })
}
bootstrap()
