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
  recordCommunicationOutbox,
  resolveOrderCancellationConfig,
  resolvePlatformFeePolicyCore,
  runLockedOrderSerializableTransaction,
  WorkflowDecisionService,
} from "@guestpost/shared"
import { verifyJobPayload } from "@guestpost/shared/dist/job-signing"
import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"
import { refundUnacceptedPaidOrderInTransaction } from "@guestpost/shared/dist/order-refund-core"
import { recomputePublisherTrustCore } from "@guestpost/shared/dist/publisher-trust-core"
import * as Sentry from "@sentry/node"
import { recordPublisherTierCommunications } from "../lib/publisher-tier-communications"
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

async function customerOrderRecipients(tx: any, order: any) {
  const memberships = await tx.membership.findMany({
    where: {
      organizationId: order.organizationId,
      status: "ACTIVE",
      role: "OWNER",
    },
    select: { userId: true },
  })
  return [
    ...new Set<string>([
      order.customerId,
      ...memberships.map((item: { userId: string }) => item.userId),
    ]),
  ]
}

async function publisherRecipients(tx: any, publisherId?: string | null) {
  if (!publisherId) return []
  const memberships = await tx.publisherMembership.findMany({
    where: { publisherId },
    select: { userId: true },
  })
  return memberships.map((item: { userId: string }) => item.userId)
}

function safeThreshold(envKey: string, fallback: number): number {
  const raw = process.env[envKey]
  if (raw === undefined || raw.trim() === "") return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
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
      const recipients = [
        ...new Set<string>([
          ...(await customerOrderRecipients(tx, order)),
          ...(await publisherRecipients(tx, order.website?.publisherId)),
        ]),
      ]
      await recordCommunicationOutbox(tx, {
        type: "ORDER_REFUNDED",
        aggregateType: "Order",
        aggregateId: order.id,
        organizationId: order.organizationId,
        title: "Order refund completed",
        message: `${Number(order.amount).toFixed(2)} ${order.currency} was returned to the customer wallet because order ${order.id} was not accepted in time.`,
        actionPath: `/dashboard/orders/${order.id}`,
        payload: { amount: Number(order.amount), currency: order.currency },
        dedupKey: `order:${order.id}:refunded`,
        recipientUserIds: recipients,
      })
      if (
        Number(order.amount) >
        safeThreshold("ADMIN_REFUND_NOTIFICATION_THRESHOLD", 100)
      ) {
        const staff = await tx.staffMembership.findMany({
          where: {
            role: { in: ["SUPER_ADMIN", "FINANCE"] },
            user: { banned: false },
          },
          select: { userId: true },
        })
        await recordCommunicationOutbox(tx, {
          type: "STAFF_HIGH_VALUE_REFUND",
          aggregateType: "Order",
          aggregateId: order.id,
          organizationId: order.organizationId,
          title: "High-value automatic refund",
          message: `${Number(order.amount).toFixed(2)} ${order.currency} was refunded for unaccepted order ${order.id}.`,
          actionPath: `/dashboard/orders/${order.id}`,
          payload: { amount: Number(order.amount), currency: order.currency },
          dedupKey: `staff:order:${order.id}:high-value-refund`,
          recipientUserIds: staff.map(
            (item: { userId: string }) => item.userId,
          ),
        })
      }
      return true
    })
    if (didRefund) {
      refunded++
      if (responsibility === "PUBLISHER" && order.website?.publisherId) {
        const result = await recomputePublisherTrustCore(
          prisma,
          order.website.publisherId,
          {
            sourceEvent: "ORDER_ACCEPTANCE_TIMEOUT",
            reason: `order ${order.id} was not accepted`,
          },
        )
        await recordPublisherTierCommunications(result)
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
            await recordCommunicationOutbox(tx, {
              type: "SETTLEMENT_CREATED",
              aggregateType: "Settlement",
              aggregateId: settlement.id,
              organizationId: canonicalOrder.organizationId,
              title: "Settlement created",
              message: `A ${net.toFixed(2)} ${canonicalOrder.currency} settlement was created for order ${canonicalOrder.id}.`,
              actionPath: "/dashboard/earnings",
              payload: {
                amount: net.toNumber(),
                currency: canonicalOrder.currency,
                orderId: canonicalOrder.id,
              },
              dedupKey: `settlement:${settlement.id}:created`,
              recipientUserIds: await publisherRecipients(tx, publisherId),
            })
          } else {
            throw new Error(
              `Order ${canonicalOrder.id} has no canonical publisher for auto-accept settlement`,
            )
          }

          const partyRecipients = [
            ...new Set<string>([
              ...(await customerOrderRecipients(tx, canonicalOrder)),
              ...(await publisherRecipients(tx, publisherId)),
            ]),
          ]
          await recordCommunicationOutbox(tx, {
            type: "ORDER_DELIVERED",
            aggregateType: "Order",
            aggregateId: canonicalOrder.id,
            organizationId: canonicalOrder.organizationId,
            title: "Order delivered",
            message: `Order ${canonicalOrder.id} was automatically accepted after its review window ended.`,
            actionPath: `/dashboard/orders/${canonicalOrder.id}`,
            dedupKey: `order:${canonicalOrder.id}:delivered`,
            recipientUserIds: partyRecipients,
          })
          if (channel === "PLATFORM") {
            await recordCommunicationOutbox(tx, {
              type: "ORDER_COMPLETED",
              aggregateType: "Order",
              aggregateId: canonicalOrder.id,
              organizationId: canonicalOrder.organizationId,
              title: "Order completed",
              message: `Order ${canonicalOrder.id} is complete.`,
              actionPath: `/dashboard/orders/${canonicalOrder.id}`,
              dedupKey: `order:${canonicalOrder.id}:completed`,
              recipientUserIds: partyRecipients,
            })
            if (
              grossAmount.greaterThan(
                safeThreshold("ADMIN_HIGH_VALUE_ORDER_THRESHOLD", 500),
              )
            ) {
              const staff = await tx.staffMembership.findMany({
                where: {
                  role: { in: ["SUPER_ADMIN", "OPERATIONS", "FINANCE"] },
                  user: { banned: false },
                },
                select: { userId: true },
              })
              await recordCommunicationOutbox(tx, {
                type: "STAFF_HIGH_VALUE_ORDER_COMPLETED",
                aggregateType: "Order",
                aggregateId: canonicalOrder.id,
                organizationId: canonicalOrder.organizationId,
                title: "High-value order completed",
                message: `Order ${canonicalOrder.id} completed at ${grossAmount.toFixed(2)} ${canonicalOrder.currency}.`,
                actionPath: `/dashboard/orders/${canonicalOrder.id}`,
                payload: {
                  amount: grossAmount.toNumber(),
                  currency: canonicalOrder.currency,
                },
                dedupKey: `staff:order:${canonicalOrder.id}:high-value-completed`,
                recipientUserIds: staff.map(
                  (item: { userId: string }) => item.userId,
                ),
              })
            }
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
      customer: {
        select: {
          email: true,
          emailVerified: true,
          banned: true,
          emailSuppressions: {
            where: { active: true },
            select: { email: true },
          },
        },
      },
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
      await prisma.$transaction(async (tx) => {
        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            eventType: "REVIEW_REMINDER",
            actorId: null,
            message: `Review reminder — ${daysRemaining} day(s) remaining before auto-accept`,
            metadata: {
              day: daysRemaining,
              channel: "email",
              autoAcceptAt: order.autoAcceptAt!.toISOString(),
            },
          },
        })
        await recordCommunicationOutbox(tx, {
          type: "ORDER_REVIEW_REMINDER",
          aggregateType: "Order",
          aggregateId: order.id,
          organizationId: order.organizationId,
          title: "Order review deadline approaching",
          message: `Your order review window expires in ${daysRemaining} day(s). Review the delivery before automatic acceptance.`,
          actionPath: `/dashboard/orders/${order.id}`,
          dedupKey: `order:${order.id}:review-reminder:${daysRemaining}`,
          recipientUserIds: [order.customerId],
        })
      })

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
