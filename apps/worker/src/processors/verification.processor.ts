import { connection } from "../redis"
import { QUEUES } from "@guestpost/shared"
import { verifyJobPayload } from "@guestpost/shared/dist/job-signing"
import { prisma } from "@guestpost/database"
import { createObservableWorker } from "../lib/queue-observability"
import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"
// Node-only deep import — undici + dns must stay out of the shared
// package's public index so the Next.js apps can bundle @guestpost/shared.
import { safeFetch, readBodyWithCap, isSafePublicUrl, SafeFetchError } from "@guestpost/shared/dist/safe-fetch"
import { isRepeatableJob } from "../repeatable-job-registry"

const logger = createLogger("worker.verification")

// Phase 7.11 (#13): 5MB cap matches delivery-verification.processor.ts.
const MAX_HTML_BYTES = 5 * 1024 * 1024

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
  let response: Response
  try {
    // Phase 7.11 (#14): safeFetch resolves DNS inside the dispatcher
    // and binds the connection to the validated IP — no TOCTOU window
    // for an attacker-controlled A record to flip to a private IP.
    response = await safeFetch(targetUrl, {
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "GuestPost-Verification/1.0" },
    })
  } catch (err: any) {
    if (err instanceof SafeFetchError) {
      logger.warn("safeFetch rejected target", { code: err.code, targetUrl })
    } else {
      logger.warn("fetch threw", { err: err?.message, targetUrl })
    }
    return null
  }
  if (!response.ok) {
    logger.warn("HTTP non-OK fetching target", { status: response.status, targetUrl })
    return null
  }
  // Phase 7.11 (#13): capped read — 5MB ceiling prevents OOM on a
  // malicious oversized response. Cap exceeded → null (caller treats
  // as "not found", same as any other failure path).
  let html: string
  try {
    html = await readBodyWithCap(response, MAX_HTML_BYTES)
  } catch (err: any) {
    if (err instanceof SafeFetchError && err.code === "BODY_TOO_LARGE") {
      logger.warn("response body cap exceeded", { url: targetUrl, maxBytes: MAX_HTML_BYTES })
    }
    return null
  }
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
          // otherwise enqueue arbitrary URL fetches (SSRF).
          // Phase 7.8 #27 — repeatable cron jobs bypass freshness (none today
          // in this queue, but the helper future-proofs new repeatables).
          if (!verifyJobPayload(job.data, { maxAgeMs: isRepeatableJob(job.name) ? 0 : undefined })) {
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
