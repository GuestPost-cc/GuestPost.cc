import { isIP } from "net"
import { connection } from "../redis"
import { QUEUES, verifyJobPayload } from "@guestpost/shared"
import { prisma } from "@guestpost/database"
import { createObservableWorker } from "../lib/queue-observability"
import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"

const logger = createLogger("worker.verification")

const PRIVATE_IP_PATTERNS = [
  /^127\./, /^10\./, /^192\.168\./, /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^0\./,
  /^::1$/, /^f[cd]/i, /^fe80:/i,
]

function isSafePublicUrl(rawUrl: string): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false
  if (isIP(host) && PRIVATE_IP_PATTERNS.some((p) => p.test(host))) return false
  return true
}

function hostMatchesWebsite(targetUrl: string, websiteUrl: string): boolean {
  try {
    const targetHost = new URL(targetUrl).hostname.toLowerCase().replace(/^www\./, "")
    const siteHost = new URL(websiteUrl).hostname.toLowerCase().replace(/^www\./, "")
    return targetHost === siteHost || targetHost.endsWith(`.${siteHost}`)
  } catch {
    return false
  }
}

async function verifyLinkOnPage(targetUrl: string, anchorText?: string): Promise<string | null> {
  const response = await fetch(targetUrl, {
    signal: AbortSignal.timeout(15000),
    headers: { "User-Agent": "GuestPost-Verification/1.0" },
  })
  if (!response.ok) {
    logger.warn("HTTP non-OK fetching target", { status: response.status, targetUrl })
    return null
  }
  const html = await response.text()
  const lowerHtml = html.toLowerCase()
  if (!anchorText) return "found"
  const lowerAnchor = anchorText.toLowerCase()
  if (lowerHtml.includes(lowerAnchor)) return "found"
  const anchorRegex = new RegExp(`>\\s*${escapeRegex(lowerAnchor)}\\s*<`, "i")
  if (anchorRegex.test(html)) return "found"
  return null
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function createVerificationWorker() {
  const worker = createObservableWorker(
    QUEUES.VERIFICATION,
    async (job) => {
      const { orderId, targetUrl, anchorText, organizationId } = job.data

      switch (job.name) {
        case "verify-link": {
          // Reject jobs not signed by the API — anyone with Redis access could
          // otherwise enqueue arbitrary URL fetches (SSRF)
          if (!verifyJobPayload(job.data)) {
            logger.error("job signature invalid — rejecting", { jobId: job.id })
            throw new Error("Invalid job signature")
          }

          if (!targetUrl) {
            throw new Error("Missing targetUrl in verification job data")
          }

          if (!isSafePublicUrl(targetUrl)) {
            logger.error("unsafe target URL rejected (SSRF guard)", { orderId, targetUrl })
            return { verified: false, orderId, reason: "Target URL is not a safe public URL" }
          }

          const order = await prisma.order.findUnique({
            where: { id: orderId },
            include: { website: { select: { url: true } } },
          })
          if (!order) throw new Error(`Order ${orderId} not found`)

          if (order.website?.url && !hostMatchesWebsite(targetUrl, order.website.url)) {
            logger.warn("target URL host does not match order website", { orderId, targetUrl, websiteUrl: order.website.url })
            return { verified: false, orderId, reason: "Published URL does not match the order's website domain" }
          }
          if (order.status !== "PUBLISHED") {
            logger.warn("order not PUBLISHED — skipping", { orderId, status: order.status })
            return { verified: false, orderId, reason: `Status is ${order.status}, expected PUBLISHED` }
          }

          const orgId = organizationId || order.organizationId
          if (orgId && order.organizationId !== orgId) {
            logger.warn("organization mismatch", { orderId, expectedOrg: orgId, actualOrg: order.organizationId })
            return { verified: false, orderId, reason: "Organization mismatch" }
          }

          logger.info("verifying link", { orderId, targetUrl, anchorText: anchorText ?? null })
          const evidence = await verifyLinkOnPage(targetUrl, anchorText)

          if (evidence) {
            const now = new Date()
            await prisma.order.update({
              where: { id: orderId },
              data: {
                status: "VERIFIED",
                verifiedAt: now,
                verifiedBy: "system",
                verifyMethod: "auto",
              },
            })

            await prisma.orderEvent.create({
              data: {
                orderId,
                eventType: "VERIFIED_AUTO",
                actorId: "system",
                message: `Link verified automatically on ${targetUrl}`,
                metadata: {
                  targetUrl,
                  evidence,
                  anchorText: anchorText ?? null,
                  verifiedAt: now.toISOString(),
                },
              },
            })

            logger.info("link verified", { orderId, targetUrl, anchorText: anchorText ?? null })
          } else {
            await prisma.orderEvent.create({
              data: {
                orderId,
                eventType: "VERIFIED_AUTO",
                actorId: "system",
                message: `Verification failed — link NOT found on ${targetUrl}`,
                metadata: {
                  targetUrl,
                  anchorText: anchorText ?? null,
                  evidence: null,
                },
              },
            })
            logger.warn("link NOT found", { orderId, targetUrl, anchorText: anchorText ?? null })
          }

          return { verified: !!evidence, orderId, evidence }
        }
        default:
          logger.warn("unknown job name", { jobName: job.name })
      }

      return { verified: false, orderId }
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
