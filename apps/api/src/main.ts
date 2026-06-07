import { config } from "dotenv"
config({ path: require("path").resolve(__dirname, "../../../.env.development") })
import { NestFactory } from "@nestjs/core"
import { ExpressAdapter } from "@nestjs/platform-express"
import { ValidationPipe } from "@nestjs/common"
import express from "express"
import cors from "cors"
import cookieParser from "cookie-parser"
import helmet from "helmet"
import rateLimit from "express-rate-limit"
import { toNodeHandler, auth } from "@guestpost/auth"
import { AppModule } from "./app.module"
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter"

async function bootstrap() {
  const server = express()

  server.set("trust proxy", 1)
  server.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", ...(process.env.NEXT_PUBLIC_API_URL ? [process.env.NEXT_PUBLIC_API_URL] : [])],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    frameguard: { action: "deny" },
  }))

  if (process.env.NODE_ENV === "production") {
    const authLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 20,
      standardHeaders: true,
      legacyHeaders: false,
      message: { statusCode: 429, message: "Too many auth attempts, try again later" },
    })
    server.use("/api/v1/auth/sign-in", authLimiter)
    server.use("/api/v1/auth/sign-up", authLimiter)

    const billingLimiter = rateLimit({
      windowMs: 1 * 60 * 1000,
      max: 10,
      standardHeaders: true,
      legacyHeaders: false,
      message: { statusCode: 429, message: "Too many billing requests, try again later" },
    })
    server.use("/api/v1/billing", billingLimiter)

    server.use(rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100,
      standardHeaders: true,
      legacyHeaders: false,
    }))
  }

  const configuredOrigins = process.env.CORS_ORIGIN?.split(",") ?? [
    "http://localhost:3000", "http://localhost:3001", "http://localhost:3002", "http://localhost:3003",
  ]
  const isDev = process.env.NODE_ENV !== "production"
  const localPatterns = [/^https?:\/\/localhost(:\d+)?$/i, /^https?:\/\/127\.\d+\.\d+\.\d+(:\d+)?$/i, /^https?:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/i, /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+(:\d+)?$/i, /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?$/i]
  server.use(cors({
    origin: (origin, callback) => {
      if (!origin || configuredOrigins.includes(origin)) return callback(null, true)
      if (isDev && localPatterns.some(p => p.test(origin))) return callback(null, true)
      callback(null, false)
    },
    credentials: true,
  }))

  // Better Auth handler must be before body parsers so it can read raw bodies
  server.use("/api/v1/auth", toNodeHandler(auth))

  server.use(express.json({ limit: "1mb" }))
  server.use(express.urlencoded({ extended: true, limit: "1mb" }))
  server.use(cookieParser())

  const app = await NestFactory.create(AppModule, new ExpressAdapter(server))

  app.setGlobalPrefix("api/v1")
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  app.useGlobalFilters(new AllExceptionsFilter())

  const port = process.env.PORT ?? 4000
  await app.listen(port)
  console.log(`API running on http://localhost:${port}`)
}
bootstrap()
