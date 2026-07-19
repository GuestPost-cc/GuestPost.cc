import { QUEUES } from "@guestpost/shared"
import { verifyJobPayload } from "@guestpost/shared/dist/job-signing"
import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"
import * as nodemailer from "nodemailer"
import { createObservableWorker } from "../lib/queue-observability"
import { connection } from "../redis"
import { isRepeatableJob } from "../repeatable-job-registry"

const logger = createLogger("worker.email")

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "localhost",
  port: Number(process.env.SMTP_PORT) || 1025,
  secure: process.env.SMTP_SECURE === "true",
  auth: process.env.SMTP_USER
    ? {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      }
    : undefined,
})

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_SUBJECT_LENGTH = 500
const MAX_HTML_LENGTH = 500_000

// Optional comma-separated recipient-domain allowlist (e.g. staging: only company domains)
const allowedDomains = (process.env.EMAIL_ALLOWED_RECIPIENT_DOMAINS ?? "")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean)

function validateEmailJob(
  to: unknown,
  subject: unknown,
  html: unknown,
): string | null {
  if (typeof to !== "string" || !EMAIL_REGEX.test(to))
    return `Invalid recipient: ${to}`
  if (allowedDomains.length > 0) {
    const domain = to.split("@")[1]?.toLowerCase()
    if (!domain || !allowedDomains.includes(domain))
      return `Recipient domain not allowed: ${to}`
  }
  if (
    subject != null &&
    (typeof subject !== "string" || subject.length > MAX_SUBJECT_LENGTH)
  ) {
    return "Subject missing or too long"
  }
  if (
    html != null &&
    (typeof html !== "string" || html.length > MAX_HTML_LENGTH)
  ) {
    return "HTML body too large"
  }
  return null
}

export function createEmailWorker() {
  const worker = createObservableWorker(
    QUEUES.EMAIL,
    async (job) => {
      // Phase 7.8 #27 — repeatable cron jobs bypass freshness (their
      // payload is signed once at boot and reused across recurrences).
      if (
        !verifyJobPayload(job.data, {
          maxAgeMs: isRepeatableJob(job.name) ? 0 : undefined,
        })
      ) {
        logger.error("job signature invalid — rejecting", { jobId: job.id })
        throw new Error("Invalid job signature")
      }

      const { to, subject, html } = job.data

      const validationError = validateEmailJob(to, subject, html)
      if (validationError) {
        logger.error("job rejected by validator", {
          jobId: job.id,
          error: validationError,
        })
        throw new Error(validationError)
      }

      let finalSubject = subject
      let finalHtml = html

      switch (job.name) {
        case "send-welcome":
          finalSubject = finalSubject || "Welcome to GuestPost.cc"
          finalHtml =
            finalHtml ||
            `<h1>Welcome to GuestPost.cc</h1><p>We are glad you are here.</p>`
          logger.info("sending welcome email", { to })
          break
        case "send-invoice":
          logger.info("sending invoice email", { to, subject })
          break
        case "send-magic-link":
          logger.info("sending magic-link email", { to })
          break
        case "send-verification-email":
          // Phase 7.10 — email-verification flow. Template is rendered
          // by Better Auth's emailVerification.sendVerificationEmail
          // callback (in packages/auth/src/index.ts); the worker just
          // ships it. Tagged for log-search parity with the other
          // template-named job kinds.
          logger.info("sending verification email", { to })
          break
        case "send-password-reset-email":
          logger.info("sending password reset email", { to })
          break
        case "send-reminder-email":
          logger.info("sending review reminder email", { to, subject })
          break
        default:
          logger.info("sending email", { to, subject, jobName: job.name })
          break
      }

      await transporter.sendMail({
        from: process.env.EMAIL_FROM || '"GuestPost.cc" <noreply@guestpost.cc>',
        to,
        subject: finalSubject,
        html: finalHtml,
      })

      return { sent: true, to }
    },
    { connection },
  )

  worker.on("completed", (job) => {
    logger.info("job completed", { jobId: job.id })
  })

  worker.on("failed", (job, err) => {
    logger.error("job failed", { jobId: job?.id, err: err?.message })
  })

  return worker
}
