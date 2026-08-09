import { Prisma, prisma } from "@guestpost/database"
import {
  ACTIVE_CANCELLATION_REQUEST_STATUSES,
  assertCanonicalPlatformRevenueFundingCore,
  assertFinanceOperationAllowed,
  defaultWorkflowConfig,
  evaluateLockedSettlementEligibility,
  getSettlementReviewDays,
  QUEUE_JOBS,
  QUEUES,
  resolveOrderCancellationConfig,
  resolvePlatformFeePolicyCore,
  runLockedOrderSerializableTransaction,
  WorkflowDecisionService,
} from "@guestpost/shared"
import {
  signJobPayload,
  verifyJobPayload,
} from "@guestpost/shared/dist/job-signing"
import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"
import { refundUnacceptedPaidOrderInTransaction } from "@guestpost/shared/dist/order-refund-core"
import { recomputePublisherTrustCore } from "@guestpost/shared/dist/publisher-trust-core"
import * as Sentry from "@sentry/node"
import { Queue } from "bullmq"
import { createObservableWorker } from "../lib/queue-observability"
import { connection } from "../redis"
import { isRepeatableJob } from "../repeatable-job-registry"

const logger = createLogger("worker.auto-accept")

const decision = new WorkflowDecisionService()

async function resolveListingUnitPrice(
  tx: any,
  listingServiceId: string | null | undefined,
) {
  if (!listingServiceId) return null
  const service = await tx.listingService.findUnique({
    where: { id: listingServiceId },
    select: { price: true },
  })
  return service?.price ?? null
}

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

      if (job.name === QUEUE_JOBS[QUEUES.AUTO_ACCEPT].SWEEP) {
        assertFinanceOperationAllowed("operator_decision")
        return runAutoAcceptSweep()
      }

      if (job.name === QUEUE_JOBS[QUEUES.AUTO_ACCEPT].REMINDER_SWEEP) {
        return runReviewReminderSweep()
      }

      if (
        job.name === QUEUE_JOBS[QUEUES.AUTO_ACCEPT].CANCELLATION_TIMEOUT_SWEEP
      ) {
        assertFinanceOperationAllowed("operator_decision")
        return runCancellationResponseTimeoutSweep()
      }

      if (
        job.name === QUEUE_JOBS[QUEUES.AUTO_ACCEPT].ACCEPTANCE_TIMEOUT_SWEEP
      ) {
        assertFinanceOperationAllowed("operator_decision")
        return runOrderAcceptanceTimeoutSweep()
      }

      logger.warn("unexpected job name — skipping", { jobName: job.name })
    },
    { connection },
  )
}

async function runCancellationResponseTimeoutSweep() {
  const now = new Date()
  const expired = await prisma.orderCancellationRequest.findMany({
    where: { status: "REQUESTED", responseDeadlineAt: { lte: now } },
    select: { id: true, orderId: true },
    take: 100,
  })
  let escalated = 0
  for (const request of expired) {
    const changed = await runLockedOrderSerializableTransaction(
      prisma,
      request.orderId,
      async (tx: any) => {
        const updated = await tx.orderCancellationRequest.updateMany({
          where: { id: request.id, status: "REQUESTED" },
          data: { status: "ESCALATED" },
        })
        if (updated.count === 0) return false
        await tx.orderEvent.create({
          data: {
            orderId: request.orderId,
            eventType: "CANCELLATION_RESPONDED",
            actorId: null,
            message:
              "Cancellation response deadline expired; escalated to staff",
            metadata: { requestId: request.id, automatic: true },
          },
        })
        await tx.auditLog.create({
          data: {
            action: "ORDER_CANCELLATION_ESCALATED",
            entityType: "OrderCancellationRequest",
            entityId: request.id,
            metadata: { orderId: request.orderId, automatic: true },
            userId: null,
            organizationId: null,
          },
        })
        return true
      },
    )
    if (changed) escalated++
  }
  return { scanned: expired.length, escalated }
}

async function runOrderAcceptanceTimeoutSweep() {
  const { acceptanceWindowHours: acceptanceHours } =
    resolveOrderCancellationConfig(process.env)
  const cutoff = new Date(Date.now() - acceptanceHours * 3_600_000)
  const due = await prisma.order.findMany({
    where: {
      status: "SUBMITTED",
      paymentStatus: "PAID",
      submittedAt: { not: null, lte: cutoff },
    },
    include: {
      website: { select: { ownershipType: true, publisherId: true } },
      cancellationRequests: {
        where: {
          status: {
            in: [...ACTIVE_CANCELLATION_REQUEST_STATUSES],
          },
        },
        select: { id: true },
        take: 1,
      },
    },
    take: 100,
  })
  let refunded = 0
  for (const order of due) {
    if (order.cancellationRequests.length > 0) continue
    const responsibility =
      (order.fulfillmentChannel ??
        (order.website?.ownershipType === "PLATFORM"
          ? "PLATFORM"
          : "PUBLISHER")) === "PLATFORM"
        ? "PLATFORM"
        : "PUBLISHER"
    const didRefund = await prisma.$transaction(async (tx: any) => {
      const existing = await tx.transaction.findFirst({
        where: { reference: `acceptance-timeout:${order.id}` },
      })
      if (existing) return false
      await refundUnacceptedPaidOrderInTransaction(
        tx,
        order,
        {
          reference: `acceptance-timeout:${order.id}`,
          reason: `Order not accepted within ${acceptanceHours} hours`,
          responsibility,
          actorUserId: null,
          auditAction: "ORDER_ACCEPTANCE_TIMEOUT_REFUND",
          auditMetadata: { automatic: true, acceptanceHours },
        },
        (data, auditTx) => auditTx.auditLog.create({ data }),
      )
      return true
    })
    if (didRefund) {
      refunded++
      if (responsibility === "PUBLISHER" && order.website?.publisherId) {
        await recomputePublisherTrustCore(prisma, order.website.publisherId, {
          sourceEvent: "ORDER_ACCEPTANCE_TIMEOUT",
          reason: `order ${order.id} was not accepted`,
        })
      }
    }
  }
  return { scanned: due.length, refunded, acceptanceHours }
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
      cancellationRequests: {
        where: {
          status: {
            in: [...ACTIVE_CANCELLATION_REQUEST_STATUSES],
          },
        },
        select: { id: true },
        take: 1,
      },
      website: { select: { publisherId: true, ownershipType: true } },
      activeDeliveryVersion: {
        select: { id: true, publishedUrl: true },
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
    if (order.cancellationRequests?.length) {
      skipped++
      continue
    }
    if (!order.activeDeliveryVersion) {
      skipped++
      continue
    }

    try {
      const didAccept = await runLockedOrderSerializableTransaction(
        prisma,
        order.id,
        async (tx: any) => {
          const upd = await tx.order.updateMany({
            where: {
              id: order.id,
              status: "VERIFIED",
              version: order.version,
            },
            data: {
              status: "DELIVERED",
              deliveredAt: now,
              deliveryAcceptedMethod: "AUTO_TIMEOUT",
              version: { increment: 1 },
            },
          })
          if (upd.count === 0) return false

          const eligibility = await evaluateLockedSettlementEligibility(
            tx,
            order.id,
          )
          if (!eligibility.eligible) {
            const blocked = new Error(
              `Settlement blocked: ${eligibility.reasons.join("; ")}`,
            )
            blocked.name = "SettlementEligibilityBlockedError"
            throw blocked
          }

          const canonicalOrder = await tx.order.findUnique({
            where: { id: order.id },
            include: {
              website: {
                select: { publisherId: true, ownershipType: true },
              },
            },
          })
          if (!canonicalOrder) return false
          const grossAmount = canonicalOrder.amount
            ? new Prisma.Decimal(canonicalOrder.amount)
            : null
          if (
            canonicalOrder.currency !== "USD" ||
            canonicalOrder.paymentStatus !== "PAID" ||
            !grossAmount ||
            grossAmount.lessThanOrEqualTo(0) ||
            grossAmount.decimalPlaces() > 2
          ) {
            throw new Error(
              `Order ${canonicalOrder.id} has no valid exact-USD amount for auto-accept`,
            )
          }

          await tx.orderEvent.create({
            data: {
              orderId: order.id,
              eventType: "AUTO_ACCEPTED",
              actorId: null,
              message: `Review window expired — order auto-accepted at ${now.toISOString()}`,
              metadata: {
                deliveryVersionId: eligibility.snapshot.activeDeliveryVersionId,
                autoAcceptAt: order.autoAcceptAt?.toISOString(),
              },
            },
          })

          // Create settlement with computed release policy
          const publisherId = canonicalOrder.website?.publisherId ?? null
          const ownerType = canonicalOrder.website?.ownershipType ?? null
          const channel =
            canonicalOrder.fulfillmentChannel ??
            (ownerType === "PLATFORM" ? "PLATFORM" : "PUBLISHER")

          if (channel === "PLATFORM") {
            if (canonicalOrder.fulfillmentChannel !== "PLATFORM") {
              throw new Error(
                `Order ${canonicalOrder.id} lacks an explicit PLATFORM channel snapshot`,
              )
            }
            await assertCanonicalPlatformRevenueFundingCore(tx, canonicalOrder)
            const existingRevenue = await tx.platformRevenue.findUnique({
              where: { orderId: canonicalOrder.id },
            })
            let recognizedFee: Prisma.Decimal
            if (existingRevenue) {
              const existingAmount = new Prisma.Decimal(existingRevenue.amount)
              const existingFee = new Prisma.Decimal(
                existingRevenue.platformFee,
              )
              const existingNet = new Prisma.Decimal(existingRevenue.netRevenue)
              const existingFeeBps = existingRevenue.platformFeeBps
              const expectedFee = Number.isInteger(existingFeeBps)
                ? existingAmount
                    .mul(existingFeeBps)
                    .div(10_000)
                    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
                : null
              if (
                existingRevenue.reversedAt !== null ||
                existingRevenue.currency !== "USD" ||
                existingRevenue.fulfillmentChannel !== "PLATFORM" ||
                existingFeeBps == null ||
                existingFeeBps < 0 ||
                existingFeeBps > 10_000 ||
                !existingRevenue.feePolicyVersion ||
                !existingAmount.equals(grossAmount) ||
                !expectedFee?.equals(existingFee) ||
                !existingFee.plus(existingNet).equals(existingAmount)
              ) {
                throw new Error(
                  `Order ${canonicalOrder.id} has conflicting platform revenue evidence`,
                )
              }
              recognizedFee = existingFee
            } else {
              const feePolicy = await resolvePlatformFeePolicyCore(tx)
              const fee = grossAmount
                .mul(feePolicy.fraction)
                .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
              const net = grossAmount.minus(fee)
              await tx.platformRevenue.create({
                data: {
                  orderId: canonicalOrder.id,
                  amount: grossAmount,
                  currency: "USD",
                  platformFee: fee,
                  netRevenue: net,
                  platformFeeBps: feePolicy.basisPoints,
                  feePolicyVersion: feePolicy.policyVersion,
                  listingServiceId: canonicalOrder.listingServiceId ?? null,
                  serviceType: canonicalOrder.type,
                  ownerType,
                  fulfillmentChannel: "PLATFORM",
                  unitPrice: await resolveListingUnitPrice(
                    tx,
                    canonicalOrder.listingServiceId,
                  ),
                },
              })
              recognizedFee = fee
            }
            const completed = await tx.order.updateMany({
              where: { id: canonicalOrder.id, status: "DELIVERED" },
              data: {
                status: "COMPLETED",
                warrantyEndsAt: canonicalOrder.warrantyDays
                  ? new Date(
                      now.getTime() + canonicalOrder.warrantyDays * 86_400_000,
                    )
                  : null,
                version: { increment: 1 },
              },
            })
            if (completed.count === 0) {
              throw new Error(
                `Order ${canonicalOrder.id} changed during platform auto-accept`,
              )
            }
            await tx.orderEvent.create({
              data: {
                orderId: canonicalOrder.id,
                eventType: "SETTLEMENT_CREATED",
                actorId: null,
                message: `Platform revenue recognized after auto-accept — amount: ${grossAmount}`,
                metadata: {
                  platformRevenue: true,
                  amount: grossAmount.toNumber(),
                  platformFee: recognizedFee.toNumber(),
                },
              },
            })
          } else if (publisherId && canonicalOrder.amount) {
            const publisherTierRow = await tx.publisher.findUnique({
              where: { id: publisherId },
              select: { tier: true },
            })

            const feePolicy = await resolvePlatformFeePolicyCore(tx)
            const fee = grossAmount
              .mul(feePolicy.fraction)
              .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
            const net = grossAmount.minus(fee)
            if (net.lessThanOrEqualTo(0)) {
              throw new Error(
                `Order ${canonicalOrder.id} would create a non-positive publisher liability`,
              )
            }

            const releasePolicy = decision.computeSettlementReleasePolicy(
              { verifyMethod: "AUTO", amount: grossAmount.toNumber() },
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
                orderId: canonicalOrder.id,
                publisherId,
                grossAmount,
                currency: "USD",
                platformFee: fee,
                publisherAmount: net,
                platformFeeBps: feePolicy.basisPoints,
                feePolicyVersion: feePolicy.policyVersion,
                status: "PENDING",
                reviewEndsAt: new Date(
                  Date.now() + reviewDays * 24 * 60 * 60 * 1000,
                ),
                releasePolicy,
                listingServiceId: canonicalOrder.listingServiceId ?? null,
                serviceType: canonicalOrder.type,
                ownerType,
                fulfillmentChannel: canonicalOrder.fulfillmentChannel ?? null,
                unitPrice: await resolveListingUnitPrice(
                  tx,
                  canonicalOrder.listingServiceId,
                ),
              },
            })

            await tx.orderEvent.create({
              data: {
                orderId: canonicalOrder.id,
                eventType: "SETTLEMENT_CREATED",
                actorId: null,
                message: `Settlement auto-created after auto-accept — amount: ${grossAmount}`,
                metadata: {
                  settlementId: settlement.id,
                  releasePolicy,
                  publisherAmount: net.toNumber(),
                  platformFee: fee.toNumber(),
                },
              },
            })
          } else {
            throw new Error(
              `Order ${canonicalOrder.id} has no canonical publisher for auto-accept settlement`,
            )
          }

          return true
        },
      )
      if (didAccept) accepted++
      else skipped++
    } catch (err) {
      if (
        err instanceof Error &&
        err.name === "SettlementEligibilityBlockedError"
      ) {
        logger.warn("auto-accept skipped by settlement eligibility gate", {
          orderId: order.id,
          reason: err.message,
        })
        skipped++
        continue
      }
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
