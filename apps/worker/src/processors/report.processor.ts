import { connection } from "../redis"
import { QUEUES } from "@guestpost/shared"
import { verifyJobPayload } from "@guestpost/shared/dist/job-signing"
import { prisma } from "@guestpost/database"
import { createObservableWorker } from "../lib/queue-observability"
import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"
import { isRepeatableJob } from "../repeatable-job-registry"

const logger = createLogger("worker.report")

export function createReportWorker() {
  const worker = createObservableWorker(
    QUEUES.REPORT,
    async (job) => {
      // Phase 7.8 #27 — repeatable cron jobs bypass freshness.
      if (!verifyJobPayload(job.data, { maxAgeMs: isRepeatableJob(job.name) ? 0 : undefined })) {
        logger.error("job signature invalid — rejecting", { jobId: job.id })
        throw new Error("Invalid job signature")
      }

      const { orderId, format } = job.data

      switch (job.name) {
        case "generate-pdf":
        case "generate-csv":
        case "export-report":
        case "generate-report": {
          const order = await prisma.order.findUnique({
            where: { id: orderId },
            include: { website: true, customer: true },
          })
          if (!order) throw new Error(`Order ${orderId} not found`)

          // Phase 6: pull the per-service unitPrice off the snapshotted
          // ListingService so the export carries it without re-deriving
          // from a possibly-edited live row.
          let unitPrice: any = null
          if (order.listingServiceId) {
            const ls = await prisma.listingService.findUnique({
              where: { id: order.listingServiceId }, select: { price: true },
            })
            unitPrice = ls?.price ?? null
          }

          await prisma.report.create({
            data: {
              orderId,
              type: "generated",
              format: format ?? "pdf",
              exportedAt: new Date(),
              data: {
                orderId: order.id,
                type: order.type,
                status: order.status,
                targetUrl: order.targetUrl,
                publishedUrl: order.publishedUrl,
                anchorText: order.anchorText,
                website: order.website?.url,
                publisher: order.website?.publisherId,
                ownershipType: order.website?.ownershipType,
                fulfillmentChannel: order.fulfillmentChannel ?? null,
                // Phase 6 reporting snapshot trio (per-service truth).
                listingId: order.listingId ?? null,
                listingServiceId: order.listingServiceId ?? null,
                serviceType: order.type,
                unitPrice: unitPrice ? String(unitPrice) : null,
                turnaroundDays: order.turnaroundDays ?? null,
                publishedAt: order.publishedAt,
                campaignProgress: "100%",
              },
            },
          })

          logger.info("report generated", { orderId, format: format ?? "pdf" })
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
