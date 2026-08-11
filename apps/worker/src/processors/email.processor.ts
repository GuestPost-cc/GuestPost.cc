import { prisma } from "@guestpost/database"
import {
  buildEmailActionUrl,
  type CommunicationEventType,
  emailDeliveryJobSchema,
  expectedFinancialDocumentKind,
  financialDocumentIdFromEventPayload,
  type NotificationSeverity,
  QUEUE_JOBS,
  QUEUES,
  renderCommunicationEmail,
  shouldDeliverCommunicationChannel,
} from "@guestpost/shared"
import { verifyJobPayload } from "@guestpost/shared/dist/job-signing"
import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"
import * as Sentry from "@sentry/node"
import * as nodemailer from "nodemailer"
import {
  beginEmailDispatch,
  type EmailDeliveryLease,
  emailDeliveryLeaseWhere,
  ownsEmailDeliveryLease,
  recoverExpiredEmailDeliveryLeases,
} from "../lib/email-delivery-lease"
import { runEmailDeliveryTerminalTransaction } from "../lib/email-event-finalization"
import {
  type RenderedFinancialDocumentAttachment,
  renderFinancialDocumentPdf,
} from "../lib/financial-document-pdf"
import { createObservableWorker } from "../lib/queue-observability"
import { connection } from "../redis"
import { isRepeatableJob } from "../repeatable-job-registry"

const logger = createLogger("worker.email")
const MAX_OUTBOX_BATCH = 100
const MAX_SUBJECT_LENGTH = 500
const MAX_HTML_LENGTH = 500_000
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const LEGACY_JOB_NAMES = new Set([
  "send-welcome",
  "send-invoice",
  "send-notification",
  "send-magic-link",
  "send-verification-email",
  "send-password-reset-email",
  "send-reminder-email",
])

type DeliveryMode = "disabled" | "capture" | "live"

function deliveryMode(): DeliveryMode {
  const configured = process.env.EMAIL_DELIVERY_MODE?.trim().toLowerCase()
  if (
    configured === "disabled" ||
    configured === "capture" ||
    configured === "live"
  ) {
    return configured
  }
  return process.env.NODE_ENV === "production" ? "live" : "capture"
}

function smtpPort(): number {
  const parsed = Number(process.env.SMTP_PORT ?? 1025)
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 65_535
    ? parsed
    : 1025
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "localhost",
  port: smtpPort(),
  secure: process.env.SMTP_SECURE === "true",
  requireTLS:
    process.env.SMTP_REQUIRE_TLS === "true" ||
    (process.env.NODE_ENV === "production" &&
      process.env.SMTP_SECURE !== "true"),
  auth: process.env.SMTP_USER
    ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    : undefined,
  pool: true,
  maxConnections: 3,
  connectionTimeout: 15_000,
  greetingTimeout: 15_000,
  socketTimeout: 30_000,
  tls: { minVersion: "TLSv1.2" },
})

// Optional comma-separated recipient-domain allowlist. This is useful in
// staging/capture environments and is rechecked immediately before delivery.
const allowedDomains = (process.env.EMAIL_ALLOWED_RECIPIENT_DOMAINS ?? "")
  .split(",")
  .map((domain) => domain.trim().toLowerCase())
  .filter(Boolean)

function recipientDomain(address: string): string | null {
  return address.split("@")[1]?.trim().toLowerCase() ?? null
}

function validateRecipient(address: unknown): string | null {
  if (typeof address !== "string" || !EMAIL_REGEX.test(address)) {
    return "Invalid recipient address"
  }
  const domain = recipientDomain(address)
  if (
    allowedDomains.length > 0 &&
    (!domain || !allowedDomains.includes(domain))
  ) {
    return "Recipient domain is not allowed"
  }
  return null
}

function validateLegacyEmailJob(
  to: unknown,
  subject: unknown,
  html: unknown,
): string | null {
  const recipientError = validateRecipient(to)
  if (recipientError) return recipientError
  if (
    typeof subject !== "string" ||
    subject.trim().length === 0 ||
    subject.length > MAX_SUBJECT_LENGTH ||
    /[\r\n]/.test(subject)
  ) {
    return "Subject is missing, unsafe, or too long"
  }
  if (
    typeof html !== "string" ||
    html.trim().length === 0 ||
    html.length > MAX_HTML_LENGTH
  ) {
    return "HTML body is missing or too large"
  }
  return null
}

function legacyPlainText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 100_000)
}

function applicationOrigin(userType: string): string {
  if (userType === "PUBLISHER") {
    return process.env.NEXT_PUBLIC_PUBLISHER_URL ?? "http://localhost:3002"
  }
  if (userType === "STAFF") {
    return process.env.NEXT_PUBLIC_ADMIN_URL ?? "http://localhost:3003"
  }
  return process.env.NEXT_PUBLIC_PORTAL_URL ?? "http://localhost:3001"
}

function retryAt(attempt: number): Date {
  const delayMs = Math.min(
    6 * 60 * 60 * 1000,
    5_000 * 2 ** Math.min(attempt, 12),
  )
  return new Date(Date.now() + delayMs)
}

function safeError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "Email delivery failed"
  // Provider errors occasionally contain the target address. Persist only a
  // bounded, redacted diagnostic because delivery rows are operator-visible.
  return message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .slice(0, 100)
}

function permanentSmtpFailure(error: unknown): boolean {
  const responseCode = Number(
    (error as { responseCode?: unknown } | null)?.responseCode,
  )
  // 550/551/553 are permanent address failures. Do not suppress on 552
  // (mailbox full) or generic 5xx policy errors, which may be recoverable.
  return responseCode === 550 || responseCode === 551 || responseCode === 553
}

function reportRecoveredUncertain(
  uncertain: number,
  deliveryId?: string,
): void {
  if (uncertain === 0) return
  const context = {
    uncertainCount: uncertain,
    ...(deliveryId ? { deliveryId } : {}),
  }
  logger.error("expired SMTP dispatch lease requires reconciliation", context)
  Sentry.captureMessage("Email delivery outcome uncertain after lease expiry", {
    level: "error",
    tags: { subsystem: "email", reason: "dispatch_lease_expired" },
    extra: context,
  })
}

async function suppressDelivery(
  deliveryId: string,
  eventId: string,
  reason: string,
  lease: EmailDeliveryLease,
): Promise<boolean> {
  const suppressed = await runEmailDeliveryTerminalTransaction(
    prisma,
    eventId,
    async (tx: any) => {
      const changed = await tx.communicationDelivery.updateMany({
        where: emailDeliveryLeaseWhere(deliveryId, lease),
        data: {
          status: "SUPPRESSED",
          lockedAt: null,
          lastError: reason.slice(0, 100),
          failedAt: new Date(),
        },
      })
      return { terminalized: changed.count === 1, result: changed }
    },
  )
  if (suppressed.count !== 1) return false
  return true
}

async function buildFinancialAttachment(event: {
  type: string
  aggregateType: string
  aggregateId: string
  organizationId: string | null
  payload: unknown
}): Promise<RenderedFinancialDocumentAttachment | null> {
  const eventType = event.type as CommunicationEventType
  const expectedKind = expectedFinancialDocumentKind(eventType)
  if (!expectedKind) return null

  const payloadHasDocumentId =
    typeof event.payload === "object" &&
    event.payload !== null &&
    !Array.isArray(event.payload) &&
    Object.hasOwn(event.payload, "financialDocumentId")
  const documentId = financialDocumentIdFromEventPayload(
    eventType,
    event.payload,
  )
  // Events committed before financial-document support intentionally remain
  // deliverable without an attachment. A new event that claims to have an
  // attachment but carries malformed metadata fails closed.
  if (!documentId) {
    if (payloadHasDocumentId) {
      throw new Error("Financial document attachment metadata is invalid")
    }
    return null
  }

  const document = await (prisma as any).financialDocument.findUnique({
    where: { id: documentId },
  })
  if (
    !document ||
    document.kind !== expectedKind ||
    document.aggregateType !== event.aggregateType ||
    document.aggregateId !== event.aggregateId ||
    document.organizationId !== event.organizationId
  ) {
    throw new Error("Financial document attachment does not match its event")
  }
  return renderFinancialDocumentPdf(document)
}

export async function processEmailDelivery(deliveryId: string) {
  if (deliveryMode() === "disabled") {
    return { sent: false, skipped: "delivery-disabled" }
  }

  const now = new Date()
  const recovery = await recoverExpiredEmailDeliveryLeases(prisma, {
    now,
    deliveryId,
  })
  reportRecoveredUncertain(recovery.uncertain, deliveryId)

  const claimed = await prisma.communicationDelivery.updateMany({
    where: {
      id: deliveryId,
      channel: "EMAIL",
      status: { in: ["PENDING", "FAILED"] },
      availableAt: { lte: now },
    },
    data: { status: "PROCESSING", lockedAt: now, attempts: { increment: 1 } },
  })
  if (claimed.count !== 1) return { sent: false, skipped: "not-claimable" }

  const delivery = await prisma.communicationDelivery.findUnique({
    where: { id: deliveryId },
    include: {
      event: true,
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          emailVerified: true,
          banned: true,
          userType: true,
          emailSuppressions: {
            where: { active: true },
            select: { email: true },
          },
          notificationPreferences: {
            select: { category: true, channel: true, enabled: true },
          },
        },
      },
    },
  })
  if (!delivery) throw new Error("Claimed email delivery no longer exists")
  const lease: EmailDeliveryLease = {
    attempts: delivery.attempts,
    lockedAt: now,
  }
  if (!ownsEmailDeliveryLease(delivery, lease)) {
    return { sent: false, skipped: "lease-lost" }
  }

  const user = delivery.user
  if (!user || user.banned || !user.emailVerified) {
    const suppressed = await suppressDelivery(
      delivery.id,
      delivery.eventId,
      !user
        ? "Recipient account was removed"
        : "Recipient is not eligible for email",
      lease,
    )
    if (!suppressed) return { sent: false, skipped: "lease-lost" }
    return { sent: false, suppressed: true }
  }

  const currentEmailPreference = user.notificationPreferences.find(
    (preference) =>
      preference.category === delivery.event.category &&
      preference.channel === "EMAIL",
  )
  if (
    !shouldDeliverCommunicationChannel(
      delivery.event.type as CommunicationEventType,
      "EMAIL",
      currentEmailPreference?.enabled,
    )
  ) {
    const suppressed = await suppressDelivery(
      delivery.id,
      delivery.eventId,
      "Disabled by current notification preference",
      lease,
    )
    if (!suppressed) return { sent: false, skipped: "lease-lost" }
    return { sent: false, suppressed: true }
  }

  const email = user.email.trim().toLowerCase()
  const suppressed = user.emailSuppressions.some(
    (entry) => entry.email.trim().toLowerCase() === email,
  )
  const recipientError = validateRecipient(email)
  if (suppressed || recipientError) {
    const deliverySuppressed = await suppressDelivery(
      delivery.id,
      delivery.eventId,
      suppressed ? "Recipient address is suppressed" : recipientError!,
      lease,
    )
    if (!deliverySuppressed) return { sent: false, skipped: "lease-lost" }
    return { sent: false, suppressed: true }
  }

  const origin = applicationOrigin(user.userType)
  const actionUrl = delivery.event.actionPath
    ? buildEmailActionUrl(origin, delivery.event.actionPath)
    : null
  const rendered = renderCommunicationEmail({
    eventType: delivery.event.type as CommunicationEventType,
    recipientName: user.name,
    title: delivery.event.title,
    message: delivery.event.message,
    severity: delivery.event.severity as NotificationSeverity,
    actionUrl,
    preferencesUrl: buildEmailActionUrl(origin, "/dashboard/settings"),
    reference: `${delivery.event.aggregateType}:${delivery.event.aggregateId}`,
  })

  let financialAttachment: RenderedFinancialDocumentAttachment | null
  try {
    financialAttachment = await buildFinancialAttachment(delivery.event)
  } catch (error) {
    const diagnostic = safeError(error)
    const failed = await prisma.communicationDelivery.updateMany({
      where: emailDeliveryLeaseWhere(delivery.id, lease),
      data: {
        status: "FAILED",
        lockedAt: null,
        failedAt: new Date(),
        availableAt: retryAt(lease.attempts),
        lastError: diagnostic,
      },
    })
    if (failed.count !== 1) {
      return { sent: false, skipped: "lease-lost" }
    }
    throw new Error(diagnostic, { cause: error })
  }

  const dispatchLease = await beginEmailDispatch(prisma, delivery.id, lease)
  if (!dispatchLease) return { sent: false, skipped: "lease-lost" }

  const headers: Record<string, string> = {
    "X-GuestPost-Event-ID": delivery.eventId,
    "X-GuestPost-Delivery-ID": delivery.id,
  }
  if (financialAttachment) {
    headers["X-GuestPost-Document-Number"] = financialAttachment.documentNumber
    headers["X-GuestPost-Attachment-SHA256"] = financialAttachment.sha256
  }

  let providerMessageId: string | null = null
  try {
    const result = await transporter.sendMail({
      from: process.env.EMAIL_FROM || '"GuestPost.cc" <noreply@guestpost.cc>',
      to: email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      messageId: `<${delivery.id}@notifications.guestpost.cc>`,
      headers,
      attachments: financialAttachment
        ? [
            {
              filename: financialAttachment.filename,
              content: financialAttachment.content,
              contentType: financialAttachment.contentType,
              contentDisposition: "attachment",
            },
          ]
        : undefined,
    })
    providerMessageId = String(result.messageId ?? "").slice(0, 191) || null
  } catch (error) {
    const diagnostic = safeError(error)
    if (permanentSmtpFailure(error)) {
      const bounced = await runEmailDeliveryTerminalTransaction(
        prisma,
        delivery.eventId,
        async (tx: any) => {
          const changed = await tx.communicationDelivery.updateMany({
            where: emailDeliveryLeaseWhere(delivery.id, dispatchLease),
            data: {
              status: "BOUNCED",
              lockedAt: null,
              failedAt: new Date(),
              bouncedAt: new Date(),
              lastError: diagnostic,
            },
          })
          if (changed.count !== 1) {
            return { terminalized: false, result: false }
          }
          await tx.emailSuppression.upsert({
            where: { userId_email: { userId: user.id, email } },
            create: {
              userId: user.id,
              email,
              reason: "HARD_BOUNCE",
              sourceRef: delivery.id,
            },
            update: {
              active: true,
              reason: "HARD_BOUNCE",
              sourceRef: delivery.id,
            },
          })
          return { terminalized: true, result: true }
        },
      )
      if (!bounced) return { sent: false, skipped: "lease-lost" }
      logger.warn("email address suppressed after permanent SMTP failure", {
        deliveryId: delivery.id,
        recipientDomain: recipientDomain(email),
      })
      return { sent: false, bounced: true }
    }
    // Once SMTP dispatch starts, a transport error does not prove that the
    // provider rejected the message. Quarantine the outcome instead of
    // automatically sending a duplicate invoice or credit note.
    const uncertain = await runEmailDeliveryTerminalTransaction(
      prisma,
      delivery.eventId,
      async (tx: any) => {
        const changed = await tx.communicationDelivery.updateMany({
          where: emailDeliveryLeaseWhere(delivery.id, dispatchLease),
          data: {
            status: "DELIVERY_UNCERTAIN",
            lockedAt: null,
            failedAt: new Date(),
            lastError: diagnostic,
          },
        })
        // DELIVERY_UNCERTAIN deliberately remains in the outstanding count,
        // so this atomically preserves a PENDING parent event for operators.
        return { terminalized: changed.count === 1, result: changed }
      },
    )
    logger.error("SMTP delivery outcome requires manual reconciliation", {
      deliveryId: delivery.id,
      eventType: delivery.event.type,
      recipientDomain: recipientDomain(email),
      stateRecorded: uncertain.count === 1,
      err: diagnostic,
    })
    return { sent: false, uncertain: true, deliveryId: delivery.id }
  }

  const sent = await runEmailDeliveryTerminalTransaction(
    prisma,
    delivery.eventId,
    async (tx: any) => {
      const changed = await tx.communicationDelivery.updateMany({
        where: emailDeliveryLeaseWhere(delivery.id, dispatchLease),
        data: {
          status: "SENT",
          provider: "smtp",
          providerMessageId,
          sentAt: new Date(),
          failedAt: null,
          lockedAt: null,
          lastError: null,
          attachmentName: financialAttachment?.filename ?? null,
          attachmentSha256: financialAttachment?.sha256 ?? null,
          attachmentSize: financialAttachment?.size ?? null,
        },
      })
      return { terminalized: changed.count === 1, result: changed }
    },
  )
  if (sent.count !== 1) {
    logger.error("SMTP accepted email after delivery lease was lost", {
      deliveryId: delivery.id,
      eventType: delivery.event.type,
      recipientDomain: recipientDomain(email),
    })
    return { sent: true, uncertain: true, deliveryId: delivery.id }
  }
  logger.info("transactional email sent", {
    deliveryId: delivery.id,
    eventType: delivery.event.type,
    recipientDomain: recipientDomain(email),
    mode: deliveryMode(),
    attachedFinancialDocument: Boolean(financialAttachment),
  })
  return { sent: true, deliveryId: delivery.id }
}

export async function processEmailOutboxBatch(limit = MAX_OUTBOX_BATCH) {
  if (deliveryMode() === "disabled") return { processed: 0, failed: 0 }
  const batchSize = Math.max(1, Math.min(limit, MAX_OUTBOX_BATCH))
  const now = new Date()
  const recovery = await recoverExpiredEmailDeliveryLeases(prisma, { now })
  reportRecoveredUncertain(recovery.uncertain)
  const deliveries = await prisma.communicationDelivery.findMany({
    where: {
      channel: "EMAIL",
      status: { in: ["PENDING", "FAILED"] },
      availableAt: { lte: now },
    },
    orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
    take: batchSize,
    select: { id: true },
  })
  let processed = 0
  let failed = 0
  for (const delivery of deliveries) {
    try {
      const result = await processEmailDelivery(delivery.id)
      if (
        result.sent ||
        "suppressed" in result ||
        "bounced" in result ||
        "uncertain" in result
      ) {
        processed += 1
      }
    } catch (error) {
      failed += 1
      logger.error("outbox delivery failed", {
        deliveryId: delivery.id,
        err: safeError(error),
      })
    }
  }
  return { processed, failed }
}

async function processLegacyEmail(
  jobName: string,
  data: Record<string, unknown>,
) {
  if (deliveryMode() === "disabled") {
    return { sent: false, skipped: "delivery-disabled" }
  }
  if (!LEGACY_JOB_NAMES.has(jobName)) throw new Error("Unsupported email job")
  let subject = data.subject
  let html = data.html
  if (jobName === "send-welcome") {
    subject = subject || "Welcome to GuestPost.cc"
    html =
      html || "<h1>Welcome to GuestPost.cc</h1><p>We are glad you are here.</p>"
  }
  const validationError = validateLegacyEmailJob(data.to, subject, html)
  if (validationError) throw new Error(validationError)

  const to = data.to as string
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || '"GuestPost.cc" <noreply@guestpost.cc>',
    to,
    subject: subject as string,
    html: html as string,
    text: legacyPlainText(html as string),
  })
  logger.info("legacy email sent", {
    jobName,
    recipientDomain: recipientDomain(to),
  })
  return { sent: true }
}

export function createEmailWorker() {
  const worker = createObservableWorker(
    QUEUES.EMAIL,
    async (job) => {
      if (
        !verifyJobPayload(job.data, {
          maxAgeMs: isRepeatableJob(job.name) ? 0 : undefined,
        })
      ) {
        logger.error("job signature invalid — rejecting", { jobId: job.id })
        throw new Error("Invalid job signature")
      }

      if (job.name === QUEUE_JOBS[QUEUES.EMAIL].SEND_DELIVERY) {
        const { deliveryId } = emailDeliveryJobSchema.parse(job.data)
        return processEmailDelivery(deliveryId)
      }
      if (job.name === QUEUE_JOBS[QUEUES.EMAIL].SWEEP_OUTBOX) {
        return processEmailOutboxBatch()
      }
      return processLegacyEmail(job.name, job.data as Record<string, unknown>)
    },
    { connection },
  )

  worker.on("completed", (job) => {
    logger.info("job completed", { jobId: job.id, jobName: job.name })
  })
  worker.on("failed", (job, error) => {
    logger.error("job failed", {
      jobId: job?.id,
      jobName: job?.name,
      err: safeError(error),
    })
  })
  return worker
}
