import { prisma } from "@guestpost/database"
import { QUEUE_JOBS, QUEUES } from "@guestpost/shared"
import { verifyJobPayload } from "@guestpost/shared/dist/job-signing"
import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"
import { createObservableWorker } from "../lib/queue-observability"
import { connection } from "../redis"
import { isRepeatableJob } from "../repeatable-job-registry"

const logger = createLogger("worker.report")

export function createReportWorker() {
  const worker = createObservableWorker(
    QUEUES.REPORT,
    async (job) => {
      // Phase 7.8 #27 — repeatable cron jobs bypass freshness.
      if (
        !verifyJobPayload(job.data, {
          maxAgeMs: isRepeatableJob(job.name) ? 0 : undefined,
        })
      ) {
        logger.error("job signature invalid — rejecting", { jobId: job.id })
        throw new Error("Invalid job signature")
      }

      const { orderId, format, organizationId } = job.data

      switch (job.name) {
        case QUEUE_JOBS[QUEUES.REPORT].GENERATE_PDF:
        case QUEUE_JOBS[QUEUES.REPORT].GENERATE_CSV:
        case QUEUE_JOBS[QUEUES.REPORT].EXPORT_REPORT: {
          if (typeof organizationId !== "string" || !organizationId) {
            throw new Error("Report job is missing organization scope")
          }
          const resolvedFormat =
            job.name === QUEUE_JOBS[QUEUES.REPORT].GENERATE_CSV
              ? "csv"
              : job.name === QUEUE_JOBS[QUEUES.REPORT].GENERATE_PDF
                ? "pdf"
                : format === "csv"
                  ? "csv"
                  : "pdf"
          const order = await prisma.order.findFirst({
            where: { id: orderId, organizationId },
            select: {
              id: true,
              type: true,
              status: true,
              targetUrl: true,
              publishedUrl: true,
              anchorText: true,
              fulfillmentChannel: true,
              listingId: true,
              listingServiceId: true,
              turnaroundDays: true,
              publishedAt: true,
              listingService: { select: { price: true } },
            },
          })
          if (!order) throw new Error(`Order ${orderId} not found`)
          const dedupKey = `generated:${orderId}:${resolvedFormat}`
          const reportData = {
            orderId: order.id,
            type: order.type,
            status: order.status,
            targetUrl: order.targetUrl,
            publishedUrl: order.publishedUrl,
            anchorText: order.anchorText,
            fulfillmentChannel: order.fulfillmentChannel ?? null,
            listingId: order.listingId ?? null,
            listingServiceId: order.listingServiceId ?? null,
            serviceType: order.type,
            unitPrice: order.listingService?.price
              ? String(order.listingService.price)
              : null,
            turnaroundDays: order.turnaroundDays ?? null,
            publishedAt: order.publishedAt,
            campaignProgress: "100%",
          }

          await prisma.report.upsert({
            where: { dedupKey },
            create: {
              orderId,
              dedupKey,
              type: "generated",
              format: resolvedFormat,
              exportedAt: new Date(),
              data: reportData,
            },
            update: {
              type: "generated",
              format: resolvedFormat,
              exportedAt: new Date(),
              data: reportData,
            },
          })

          logger.info("report generated", { orderId, format: resolvedFormat })
          break
        }
        default:
          logger.warn("unknown job name", { jobName: job.name })
      }

      return { generated: true, orderId }
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
