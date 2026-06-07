import { Worker } from "bullmq"
import { connection } from "../redis"
import { QUEUES } from "@guestpost/shared"
import { prisma } from "@guestpost/database"

async function verifyLinkOnPage(targetUrl: string, anchorText?: string): Promise<boolean> {
  const response = await fetch(targetUrl, {
    signal: AbortSignal.timeout(15000),
    headers: { "User-Agent": "GuestPost-Verification/1.0" },
  })
  if (!response.ok) {
    console.warn(`[VERIFICATION] HTTP ${response.status} fetching ${targetUrl}`)
    return false
  }
  const html = await response.text()
  if (!anchorText) return true
  const lowerHtml = html.toLowerCase()
  const lowerAnchor = anchorText.toLowerCase()
  if (lowerHtml.includes(lowerAnchor)) return true
  const anchorRegex = new RegExp(`>\\s*${escapeRegex(lowerAnchor)}\\s*<`, "i")
  return anchorRegex.test(html)
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function createVerificationWorker() {
  const worker = new Worker(
    QUEUES.VERIFICATION,
    async (job) => {
      const { orderId, targetUrl, anchorText } = job.data

      switch (job.name) {
        case "verify-link": {
          if (!targetUrl) {
            throw new Error("Missing targetUrl in verification job data")
          }

          console.log(`[VERIFICATION] Verifying link for order ${orderId} at ${targetUrl}`)
          const isVerified = await verifyLinkOnPage(targetUrl, anchorText)

          if (isVerified) {
            await prisma.order.update({
              where: { id: orderId },
              data: { status: "VERIFIED" },
            })
            console.log(`[VERIFICATION] Link verified for order ${orderId}${anchorText ? ` (anchor: "${anchorText}")` : ""}`)
          } else {
            console.warn(`[VERIFICATION] Link NOT found on ${targetUrl} for order ${orderId}${anchorText ? ` (anchor: "${anchorText}")` : ""}`)
          }

          return { verified: isVerified, orderId }
        }
        default:
          console.warn(`[VERIFICATION] Unknown job: ${job.name}`)
      }

      return { verified: false, orderId }
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