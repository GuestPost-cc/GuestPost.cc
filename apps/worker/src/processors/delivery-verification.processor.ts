import { isIP } from "net"
import { connection } from "../redis"
import { QUEUES, verifyJobPayload } from "@guestpost/shared"
import { createObservableWorker } from "../lib/queue-observability"
// Node-only deep imports keep cheerio + aws-sdk out of the shared index.
import { runDeliveryVerification, runSettlementHoldLinkSweep, FetchResult } from "@guestpost/shared/dist/delivery-verification-core"
import { putObject } from "@guestpost/shared/dist/object-storage"
import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"
import { prisma } from "@guestpost/database"
import { enqueueTrustRecompute } from "../trust-enqueue"

const logger = createLogger("worker.delivery-verification")

// Delivery verification worker. Fetches the published page (SSRF-guarded,
// redirect chain resolved manually), then delegates to the pure core which
// parses HTML, persists evidence + snapshot, runs fraud detection, and
// transitions the delivery version. Retries on transient failure with 5/15/60m
// backoff; after exhaustion the core routes to MANUAL_REVIEW.

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

// Manual redirect resolution (max 5 hops). Each hop is SSRF-checked — a public
// URL must never be allowed to redirect into the internal network.
async function fetchWithChain(startUrl: string): Promise<FetchResult> {
  const redirectChain: string[] = []
  let current = startUrl
  let lastStatus = 0
  let lastHeaders: Record<string, string> = {}

  for (let hop = 0; hop < 6; hop++) {
    if (!isSafePublicUrl(current)) {
      return { finalUrl: current, status: 0, headers: {}, html: "", redirectChain, error: "unsafe (non-public) URL" }
    }
    let res: Response
    try {
      res = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
        headers: { "User-Agent": "GuestPost-DeliveryVerification/1.0" },
      })
    } catch (err: any) {
      return { finalUrl: current, status: 0, headers: lastHeaders, html: "", redirectChain, error: err?.message ?? "fetch failed" }
    }
    lastStatus = res.status
    lastHeaders = Object.fromEntries(res.headers.entries())

    // Follow 3xx with a Location header
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location")
      if (!loc) break
      let next: string
      try {
        next = new URL(loc, current).toString()
      } catch {
        break
      }
      redirectChain.push(current)
      current = next
      continue
    }

    // Terminal response
    const html = await res.text().catch(() => "")
    return { finalUrl: current, status: res.status, headers: lastHeaders, html, redirectChain, error: undefined }
  }

  return { finalUrl: current, status: lastStatus || 508, headers: lastHeaders, html: "", redirectChain, error: "too many redirects" }
}

export function createDeliveryVerificationWorker() {
  const deps = { prisma, fetchUrl: fetchWithChain, putObject, onTrustEvent: enqueueTrustRecompute }
  const worker = createObservableWorker(
    QUEUES.DELIVERY_VERIFICATION,
    async (job) => {
      if (!verifyJobPayload(job.data)) {
        logger.error("job signature invalid — rejecting", { jobId: job.id })
        throw new Error("Invalid job signature")
      }
      // Settlement-hold link monitoring sweep (repeatable).
      if (job.name === "settlement-hold-sweep") {
        const res = await runSettlementHoldLinkSweep(deps)
        logger.info("settlement-hold link sweep complete", { result: res })
        return res
      }
      if (job.name !== "delivery-verify") {
        logger.warn("unknown job name", { jobName: job.name })
        return
      }
      const { deliveryVersionId, actorUserId } = job.data as { deliveryVersionId: string; actorUserId?: string }
      const maxAttempts = job.opts.attempts ?? 1
      const isFinalAttempt = job.attemptsMade >= maxAttempts - 1
      const res = await runDeliveryVerification(deps, deliveryVersionId, { actorUserId, isFinalAttempt })
      logger.info("delivery verification complete", {
        deliveryVersionId,
        attempt: job.attemptsMade + 1,
        maxAttempts,
        result: res,
      })
      return res
    },
    {
      connection,
      concurrency: 4,
      // 5m, 15m, 60m backoff between attempts.
      settings: {
        backoffStrategy: (attemptsMade: number) => {
          const delays = [5, 15, 60].map((m) => m * 60 * 1000)
          return delays[Math.min(attemptsMade - 1, delays.length - 1)] ?? delays[delays.length - 1]
        },
      },
    },
  )

  worker.on("completed", (job) => logger.info("job completed", { jobId: job.id }))
  worker.on("failed", (job, err) => logger.error("job failed", { jobId: job?.id, err: err?.message }))
  return worker
}
