import { Worker } from "bullmq"
import { connection } from "../redis"
import { QUEUES, verifyJobPayload } from "@guestpost/shared"
import { prisma } from "@guestpost/database"

export function createReportWorker() {
  const worker = new Worker(
    QUEUES.REPORT,
    async (job) => {
      if (!verifyJobPayload(job.data)) {
        console.error(`[REPORT] Job ${job.id} has missing/invalid signature — rejecting`)
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

          console.log(`[REPORT] ${format ?? "pdf"} report generated for order ${orderId}`)
          break
        }
        default:
          console.warn(`[REPORT] Unknown job: ${job.name}`)
      }

      return { generated: true, orderId }
    },
    { connection },
  )

  worker.on("completed", (job) => {
    console.log(`[REPORT] Job ${job.id} completed`)
  })

  worker.on("failed", (job, err) => {
    console.error(`[REPORT] Job ${job?.id} failed:`, err)
  })

  return worker
}
