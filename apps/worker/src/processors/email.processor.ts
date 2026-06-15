import { connection } from "../redis"
import { QUEUES, verifyJobPayload } from "@guestpost/shared"
import { createObservableWorker } from "../lib/queue-observability"
import * as nodemailer from "nodemailer"

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "localhost",
  port: Number(process.env.SMTP_PORT) || 1025,
  secure: process.env.SMTP_SECURE === "true",
  auth: process.env.SMTP_USER ? {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  } : undefined,
})

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_SUBJECT_LENGTH = 500
const MAX_HTML_LENGTH = 500_000

// Optional comma-separated recipient-domain allowlist (e.g. staging: only company domains)
const allowedDomains = (process.env.EMAIL_ALLOWED_RECIPIENT_DOMAINS ?? "")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean)

function validateEmailJob(to: unknown, subject: unknown, html: unknown): string | null {
  if (typeof to !== "string" || !EMAIL_REGEX.test(to)) return `Invalid recipient: ${to}`
  if (allowedDomains.length > 0) {
    const domain = to.split("@")[1]?.toLowerCase()
    if (!domain || !allowedDomains.includes(domain)) return `Recipient domain not allowed: ${to}`
  }
  if (subject != null && (typeof subject !== "string" || subject.length > MAX_SUBJECT_LENGTH)) {
    return "Subject missing or too long"
  }
  if (html != null && (typeof html !== "string" || html.length > MAX_HTML_LENGTH)) {
    return "HTML body too large"
  }
  return null
}

export function createEmailWorker() {
  const worker = createObservableWorker(
    QUEUES.EMAIL,
    async (job) => {
      if (!verifyJobPayload(job.data)) {
        console.error(`[EMAIL] Job ${job.id} has missing/invalid signature — rejecting`)
        throw new Error("Invalid job signature")
      }

      const { to, subject, html } = job.data

      const validationError = validateEmailJob(to, subject, html)
      if (validationError) {
        console.error(`[EMAIL] Job ${job.id} rejected: ${validationError}`)
        throw new Error(validationError)
      }

      let finalSubject = subject
      let finalHtml = html

      switch (job.name) {
        case "send-welcome":
          finalSubject = finalSubject || "Welcome to GuestPost.cc"
          finalHtml = finalHtml || `<h1>Welcome to GuestPost.cc</h1><p>We are glad you are here.</p>`
          console.log(`[EMAIL] Welcome email to ${to}`)
          break
        case "send-invoice":
          console.log(`[EMAIL] Invoice to ${to}: ${subject}`)
          break
        case "send-magic-link":
          console.log(`[EMAIL] Magic link to ${to}`)
          break
        default:
          console.log(`[EMAIL] ${subject} to ${to}`)
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
    console.log(`[EMAIL] Job ${job.id} completed`)
  })

  worker.on("failed", (job, err) => {
    console.error(`[EMAIL] Job ${job?.id} failed:`, err)
  })

  return worker
}
