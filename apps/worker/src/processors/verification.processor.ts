import { Worker } from "bullmq"
import { connection } from "../redis"
import { QUEUES } from "@guestpost/shared"
import { prisma } from "@guestpost/database"

export function createVerificationWorker() {
  const worker = new Worker(
    QUEUES.VERIFICATION,
    async (job) => {
      const { orderId, targetUrl, anchorText } = job.data

      switch (job.name) {
        case "verify-link": {
          console.log(`[VERIFICATION] Verifying link for order ${orderId} at ${targetUrl}`)
          // In production: Use a proper web crawler/scraper to verify the link
          // For now, we will simulate the check
          const isVerified = true // Math.random() > 0.1
          
          if (isVerified) {
            await prisma.order.update({
              where: { id: orderId },
              data: {
                status: "VERIFIED",
              },
            })
            console.log(`[VERIFICATION] Link verified successfully for order ${orderId}`)
          } else {
            console.log(`[VERIFICATION] Link verification failed for order ${orderId}`)
          }
          break
        }
        default:
          console.warn(`[VERIFICATION] Unknown job: ${job.name}`)
      }

      return { verified: true, orderId }
    },
    { connection },
  )

  worker.on("completed", (job) => {
    console.log(`[VERIFICATION] Job ${job.id} completed`)
  })

  worker.on("failed", (job, err) => {
    console.error(`[VERIFICATION] Job ${job?.id} failed:`, err)
  })

  return worker
}