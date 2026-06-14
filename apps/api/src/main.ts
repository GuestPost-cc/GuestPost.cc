import { config } from "dotenv";
// Dev env file loads ONLY under explicit NODE_ENV=development. Unset NODE_ENV
// (staging, CI) fails closed: nothing is loaded and validateEnv() exits on
// missing required vars, forcing explicit configuration.
if (process.env.NODE_ENV === "development") {
  config({
    path: require("path").resolve(__dirname, "../../../.env.development"),
  });
}
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { ValidationPipe } from "@nestjs/common";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { toNodeHandler, auth } from "@guestpost/auth";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";

const REQUIRED_ENV_VARS = ["DATABASE_URL", "REDIS_URL", "JWT_SECRET"] as const;

const PRODUCTION_ONLY_VARS = ["SMTP_HOST", "EMAIL_FROM"] as const;

function validateEnv(): void {
  const missing: string[] = [];
  for (const key of REQUIRED_ENV_VARS) {
    if (!process.env[key]) missing.push(key);
  }
  if (missing.length > 0) {
    console.error(
      `FATAL: Missing required environment variables: ${missing.join(", ")}`,
    );
    process.exit(1);
  }

  if (process.env.NODE_ENV === "production") {
    for (const key of PRODUCTION_ONLY_VARS) {
      if (!process.env[key]) {
        console.warn(
          `WARN: Production recommended variable "${key}" is not set`,
        );
      }
    }
    if (!process.env.QUEUE_SIGNING_SECRET) {
      console.error(
        "FATAL: QUEUE_SIGNING_SECRET is required in production (do not reuse JWT_SECRET)",
      );
      process.exit(1);
    }
    if (
      process.env.JWT_SECRET === "dev-jwt-secret-change-in-production" ||
      process.env.JWT_SECRET ===
        "generate_a_random_secret_with_openssl_rand_base64_32"
    ) {
      console.error(
        "FATAL: JWT_SECRET is set to an insecure default value. Generate a unique secret for production.",
      );
      process.exit(1);
    }
    if (
      !/^[0-9a-zA-Z!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]{32,}$/.test(
        process.env.JWT_SECRET ?? "",
      )
    ) {
      console.warn(
        "WARN: JWT_SECRET appears weak. Use a randomly generated 32+ character string.",
      );
    }
  }
}

async function bootstrap() {
  validateEnv();

  const server = express();

  server.set("trust proxy", 1);
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
  );

  // Health check - before rate limiting
  server.get("/api/v1/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // ── Environment-aware rate limiting ──────────────────────────────────────

  function hasAuthCredentials(req: express.Request): boolean {
    if (req.headers.authorization?.startsWith("Bearer ")) return true;
    const cookie = req.headers.cookie;
    if (typeof cookie === "string" && cookie.includes("guestpost-session"))
      return true;
    return false;
  }

  interface EnvLimits {
    auth: {
      signIn: number;
      signUp: number;
      magicLink: number;
      resetPassword: number;
    };
    marketplaceAnon: number;
    marketplaceAuth: number;
    generalAnon: number;
    generalAuth: number;
    admin: number;
    billing: number;
    // Per-IP first-line cap on verification trigger endpoints (publisher DNS
    // verify, admin bulk-retry / recompute-trust). Secondary to the DB-based
    // per-publisher/per-website business throttles — not a replacement.
    verification: number;
  }

  function getEnvLimits(): EnvLimits {
    const env = process.env.NODE_ENV || "development";

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
    };

    const d = defaults[env] ?? defaults.development;

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
    };
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
    });
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
    });
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
    });
    return [anon, authed];
  }

  const envLimits = getEnvLimits();

  // Auth endpoints — one limiter per path, same limit for all users
  server.use(
    "/api/v1/auth/sign-in",
    createLimiter(
      envLimits.auth.signIn,
      "Too many auth attempts, try again later",
    ),
  );
  server.use(
    "/api/v1/auth/sign-up",
    createLimiter(
      envLimits.auth.signUp,
      "Too many auth attempts, try again later",
    ),
  );
  server.use(
    "/api/v1/auth/magic-link",
    createLimiter(
      envLimits.auth.magicLink,
      "Too many auth attempts, try again later",
    ),
  );
  server.use(
    "/api/v1/auth/reset-password",
    createLimiter(
      envLimits.auth.resetPassword,
      "Too many auth attempts, try again later",
    ),
  );

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
  );

  // Marketplace — two-tier (anon vs authenticated)
  server.use(
    "/api/v1/marketplace/listings",
    ...createTieredLimiters(
      envLimits.marketplaceAnon,
      envLimits.marketplaceAuth,
    ),
  );
  server.use(
    "/api/v1/marketplace/categories",
    ...createTieredLimiters(
      envLimits.marketplaceAnon,
      envLimits.marketplaceAuth,
    ),
  );
  server.use(
    "/api/v1/marketplace/tags",
    ...createTieredLimiters(
      envLimits.marketplaceAnon,
      envLimits.marketplaceAuth,
    ),
  );
  server.use(
    "/api/v1/marketplace/stats",
    ...createTieredLimiters(
      envLimits.marketplaceAnon,
      envLimits.marketplaceAuth,
    ),
  );
  server.use(
    "/api/v1/marketplace/services",
    ...createTieredLimiters(
      envLimits.marketplaceAnon,
      envLimits.marketplaceAuth,
    ),
  );

  // Verification trigger endpoints — lightweight per-IP first line against
  // automated abuse, layered ON TOP of the DB-based per-publisher/per-website
  // throttles (which stay the primary, tenant-aware control). Only counts the
  // POST routes that actually kick off DNS lookups / verification work.
  const VERIFICATION_TRIGGER_RE =
    /\/(websites\/[^/]+\/verify|websites\/verification\/bulk-retry|websites\/[^/]+\/recompute-trust)$/;
  function isVerificationTrigger(req: express.Request): boolean {
    return req.method === "POST" && VERIFICATION_TRIGGER_RE.test(req.path);
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
  );

  // Admin
  server.use(
    "/api/v1/admin",
    createLimiter(envLimits.admin, "Too many admin requests, try again later"),
  );

  // Global fallback — two-tier, catches all unmatched routes
  server.use(
    ...createTieredLimiters(envLimits.generalAnon, envLimits.generalAuth),
  );

  const configuredOrigins = process.env.CORS_ORIGIN?.split(",") ?? [
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:3002",
    "http://localhost:3003",
  ];
  const isDev = process.env.NODE_ENV !== "production";
  const localPatterns = [
    /^https?:\/\/localhost(:\d+)?$/i,
    /^https?:\/\/127\.\d+\.\d+\.\d+(:\d+)?$/i,
    /^https?:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/i,
    /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+(:\d+)?$/i,
    /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?$/i,
  ];
  server.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || configuredOrigins.includes(origin))
          return callback(null, true);
        if (isDev && localPatterns.some((p) => p.test(origin)))
          return callback(null, true);
        callback(null, false);
      },
      credentials: true,
    }),
  );

  // Better Auth handler must be before body parsers so it can read raw bodies
  server.use("/api/v1/auth", toNodeHandler(auth));

  server.use(
    express.json({
      limit: "1mb",
      verify: (req: any, _res: express.Response, buf: Buffer) => {
        req.rawBody = buf;
      },
    }),
  );
  server.use(express.urlencoded({ extended: true, limit: "1mb" }));
  server.use(cookieParser());

  const app = await NestFactory.create(AppModule, new ExpressAdapter(server));

  app.setGlobalPrefix("api/v1");
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  const port = process.env.PORT ?? 4000;
  await app.listen(port);
  console.log(`API running on http://localhost:${port}`);
}
bootstrap();
