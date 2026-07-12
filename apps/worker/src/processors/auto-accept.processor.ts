import { prisma } from "@guestpost/database"
import {
  defaultWorkflowConfig,
  getSettlementReviewDays,
  QUEUE_JOBS,
  QUEUES,
  WorkflowDecisionService,
} from "@guestpost/shared"
import {
  signJobPayload,
  verifyJobPayload,
} from "@guestpost/shared/dist/job-signing"
import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"
import * as Sentry from "@sentry/node"
import { Queue } from "bullmq"
import { createObservableWorker } from "../lib/queue-observability"
import { connection } from "../redis"
import { isRepeatableJob } from "../repeatable-job-registry"

const logger = createLogger("worker.auto-accept")

const decision = new WorkflowDecisionService()

export function createAutoAcceptWorker() {
  return createObservableWorker(
    QUEUES.AUTO_ACCEPT,
    async (job) => {
      if (
        !verifyJobPayload(job.data, {
          maxAgeMs: isRepeatableJob(job.name) ? 0 : undefined,
        })
      ) {
        logger.error("job signature invalid — rejecting", { jobId: job.id })
        throw new Error("Invalid job signature")
      }

      if (job.name === "auto-accept-sweep") {
        return runAutoAcceptSweep()
      }

      if (job.name === "review-reminder-sweep") {
        return runReviewReminderSweep()
      }

      logger.warn("unexpected job name — skipping", { jobName: job.name })
    },
    { connection },
  )
}

interface AutoAcceptResult {
  scanned: number
  accepted: number
  skipped: number
  durationMs: number
}

async function runAutoAcceptSweep(): Promise<AutoAcceptResult> {
  const startedAt = Date.now()
  const now = new Date()

  const due = await prisma.order.findMany({
    where: {
      status: "VERIFIED",
      autoAcceptAt: { lte: now },
    },
    include: {
      dispute: { select: { status: true } },
      website: { select: { publisherId: true, ownershipType: true } },
      activeDeliveryVersion: {
        select: { id: true, publishedUrl: true },
      },
      items: {
        where: { websiteId: { not: null } },
        take: 1,
        include: {
          website: { select: { publisherId: true, ownershipType: true } },
        },
      },
    },
  })

  let accepted = 0
  let skipped = 0

  for (const raw of due) {
    const order: any = raw
    if (
      order.dispute &&
      ["OPEN", "UNDER_REVIEW"].includes(order.dispute.status)
    ) {
      skipped++
      continue
    }
    if (!order.activeDeliveryVersion) {
      skipped++
      continue
    }

    try {
      await prisma.$transaction(async (tx: any) => {
        const upd = await tx.order.updateMany({
          where: { id: order.id, status: "VERIFIED" },
          data: {
            status: "DELIVERED",
            deliveredAt: now,
            deliveryAcceptedMethod: "AUTO_TIMEOUT",
          },
        })
        if (upd.count === 0) return false

        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            eventType: "AUTO_ACCEPTED",
            actorId: null,
            message: `Review window expired — order auto-accepted at ${now.toISOString()}`,
            metadata: {
              deliveryVersionId: order.activeDeliveryVersion!.id,
              autoAcceptAt: order.autoAcceptAt?.toISOString(),
            },
          },
        })

        // Create settlement with computed release policy
        const publisherId =
          order.items?.[0]?.website?.publisherId ?? order.website?.publisherId
        const ownerType =
          order.items?.[0]?.website?.ownershipType ??
          order.website?.ownershipType ??
          null

        if (publisherId && order.amount) {
          const publisherTierRow = await tx.publisher.findUnique({
            where: { id: publisherId },
            select: { tier: true },
          })

          const pct = Number(process.env.PLATFORM_FEE_PERCENT ?? 20)
          const feeFraction = Math.min(Math.max(pct, 0), 100) / 100
          const amount =
            typeof order.amount === "number"
              ? order.amount
              : Number(order.amount)
          const fee = Math.round(amount * feeFraction * 100) / 100
          const net = Math.round((amount - fee) * 100) / 100

          const releasePolicy = decision.computeSettlementReleasePolicy(
            { verifyMethod: "AUTO", amount },
            publisherTierRow ? { tier: publisherTierRow.tier } : null,
            [],
            null,
          )

          const reviewDays = getSettlementReviewDays(
            (publisherTierRow?.tier ?? "NEW") as any,
            process.env.SETTLEMENT_REVIEW_DAYS,
          )

          const settlement = await tx.settlement.create({
            data: {
              orderId: order.id,
              publisherId,
              grossAmount: amount,
              platformFee: fee,
              publisherAmount: net,
              status: "PENDING",
              reviewEndsAt: new Date(
                Date.now() + reviewDays * 24 * 60 * 60 * 1000,
              ),
              releasePolicy,
              listingServiceId: order.listingServiceId ?? null,
              serviceType: order.type,
              ownerType,
              fulfillmentChannel: order.fulfillmentChannel ?? null,
              unitPrice: null,
            },
          })

          await tx.orderEvent.create({
            data: {
              orderId: order.id,
              eventType: "SETTLEMENT_CREATED",
              actorId: null,
              message: `Settlement auto-created after auto-accept — amount: ${amount}`,
              metadata: {
                settlementId: settlement.id,
                releasePolicy,
                publisherAmount: net,
                platformFee: fee,
              },
            },
          })
        }

        return true
      })
      accepted++
    } catch (err) {
      logger.error("auto-accept transaction failed", {
        orderId: order.id,
        err: err instanceof Error ? err.message : String(err),
      })
      Sentry.captureException(err, {
        tags: { queue: "auto-accept", orderId: order.id },
      })
      skipped++
    }
  }

  const durationMs = Date.now() - startedAt
  logger.info("[AUTO_ACCEPT] sweep complete", {
    runsTotal: 1,
    scanned: due.length,
    accepted,
    skipped,
    durationMs,
  })

  return { scanned: due.length, accepted, skipped, durationMs }
}

interface ReminderResult {
  scanned: number
  reminded: number
  durationMs: number
}

async function runReviewReminderSweep(): Promise<ReminderResult> {
  const startedAt = Date.now()
  const now = new Date()

  const pending = await prisma.order.findMany({
    where: {
      status: "VERIFIED",
      autoAcceptAt: { not: null },
    },
    select: {
      id: true,
      autoAcceptAt: true,
      createdAt: true,
      customerId: true,
      organizationId: true,
      listing: { select: { title: true } },
      customer: { select: { email: true, name: true } },
    },
  })

  let reminded = 0

  for (const order of pending) {
    if (!order.autoAcceptAt) continue

    const daysRemaining = Math.floor(
      (order.autoAcceptAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
    )

    const reminderDays = defaultWorkflowConfig.reminderDays
    const shouldRemindToday = reminderDays.includes(daysRemaining)

    if (!shouldRemindToday) continue

    // Check if already reminded for this day bucket
    const existing = await prisma.orderEvent.findFirst({
      where: {
        orderId: order.id,
        eventType: "REVIEW_REMINDER",
        metadata: { path: ["day"], equals: daysRemaining },
      },
    })
    if (existing) continue

    try {
      await prisma.orderEvent.create({
        data: {
          orderId: order.id,
          eventType: "REVIEW_REMINDER",
          actorId: null,
          message: `Review reminder — ${daysRemaining} day(s) remaining before auto-accept`,
          metadata: {
            day: daysRemaining,
            channel: "email",
            autoAcceptAt: order.autoAcceptAt.toISOString(),
          },
        },
      })

      // Best-effort notification creation for the email worker
      await prisma.notification
        .create({
          data: {
            userId: order.customerId,
            organizationId: order.organizationId,
            type: "REVIEW_REMINDER",
            message: `Your order review window expires in ${daysRemaining} day(s). Review your order before auto-acceptance.`,
            dedupKey: `review-reminder-${order.id}-day-${daysRemaining}`,
          },
        })
        .catch(() => {})

      // Enqueue review reminder email
      const listingTitle = (order as any).listing?.title ?? "Order"
      const customerName = (order as any).customer?.name ?? "Customer"
      const customerEmail = (order as any).customer?.email
      if (customerEmail) {
        const subject = `Review reminder: ${daysRemaining} day(s) left to review your order`
        const html = buildReminderEmailHtml({
          customerName,
          listingTitle,
          orderId: order.id,
          daysRemaining,
        })
        enqueueReminderEmail(customerEmail, subject, html)
      }

      reminded++
    } catch (err) {
      logger.error("reminder creation failed", {
        orderId: order.id,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const durationMs = Date.now() - startedAt
  logger.info("[REVIEW_REMINDER] sweep complete", {
    scanned: pending.length,
    reminded,
    durationMs,
  })

  return { scanned: pending.length, reminded, durationMs }
}

// Lazy email queue producer — created once, reused across sweep iterations.
let emailQueue: Queue | null = null
function getEmailQueue(): Queue {
  if (!emailQueue) emailQueue = new Queue(QUEUES.EMAIL, { connection })
  return emailQueue
}

function buildReminderEmailHtml(opts: {
  customerName: string
  listingTitle: string
  orderId: string
  daysRemaining: number
}): string {
  const baseUrl = process.env.APP_URL ?? "https://guestpost.cc"
  const reviewUrl = `${baseUrl}/orders/${opts.orderId}/review`
  return `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
<h2>Review reminder</h2>
<p>Hi ${opts.customerName},</p>
<p>Your order <strong>${opts.listingTitle}</strong> is awaiting your review.</p>
<p>You have <strong>${opts.daysRemaining} day(s)</strong> left to review and accept or request changes before the order is automatically accepted.</p>
<p><a href="${reviewUrl}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;">Review your order</a></p>
<p>If you take no action, the order will be auto-accepted after the review window expires.</p>
<hr style="margin-top:24px;border:none;border-top:1px solid #e5e7eb;"/>
<p style="color:#6b7280;font-size:12px;">GuestPost.cc · Order #${opts.orderId}</p>
</div>`
}

function enqueueReminderEmail(to: string, subject: string, html: string): void {
  getEmailQueue()
    .add(
      QUEUE_JOBS[QUEUES.EMAIL].SEND_REMINDER_EMAIL,
      signJobPayload({ to, subject, html }),
      {
        jobId: `reminder-${to}-${subject.slice(0, 40)}`,
        removeOnComplete: { count: 100, age: 86400 },
        removeOnFail: { count: 50, age: 604800 },
        attempts: 5,
        backoff: { type: "exponential", delay: 5000 },
      },
    )
    .catch((err) => {
      logger.error("failed to enqueue reminder email", {
        to,
        err: String(err),
      })
    })
}
