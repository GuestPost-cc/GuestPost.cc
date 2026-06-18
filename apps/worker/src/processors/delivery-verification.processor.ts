import { connection } from "../redis"
import { QUEUES, verifyJobPayload } from "@guestpost/shared"
import { isRepeatableJob } from "../repeatable-job-registry"
import { createObservableWorker } from "../lib/queue-observability"
// Node-only deep imports keep cheerio + aws-sdk + undici/dns out of the
// shared package's public index — the Next.js apps' webpack chokes on
// `node:*` schemes when bundling. safe-fetch (undici Agent + dns) joins
// the same convention as delivery-verification-core, object-storage,
// observability/structured-logger.
import { runDeliveryVerification, runSettlementHoldLinkSweep, FetchResult } from "@guestpost/shared/dist/delivery-verification-core"
import { putObject } from "@guestpost/shared/dist/object-storage"
import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"
import { safeFetch, readBodyWithCap, isSafePublicUrl, SafeFetchError } from "@guestpost/shared/dist/safe-fetch"
import { prisma } from "@guestpost/database"
import { enqueueTrustRecompute } from "../trust-enqueue"

const logger = createLogger("worker.delivery-verification")

// Delivery verification worker. Fetches the published page (SSRF-guarded,
// redirect chain resolved manually), then delegates to the pure core which
// parses HTML, persists evidence + snapshot, runs fraud detection, and
// transitions the delivery version. Retries on transient failure with 5/15/60m
// backoff; after exhaustion the core routes to MANUAL_REVIEW.

// Phase 7.11 (#13): cap response bodies at 5MB. Typical guest-post pages
// are ~200KB; 5MB is well above legitimate traffic but well below the
// pod's RSS budget at concurrency 4. Oversize triggers SafeFetchError
// (BODY_TOO_LARGE), which we treat as a verification failure → retry →
// MANUAL_REVIEW after attempts exhaust.
const MAX_HTML_BYTES = 5 * 1024 * 1024

// Manual redirect resolution (max 5 hops). Phase 7.11 (#14): safeFetch
// uses an undici Agent whose connect.lookup validates the resolved IP
// against PRIVATE_IP_PATTERNS, closing the DNS-rebinding TOCTOU window
// that the legacy isSafePublicUrl + fetch() pair left open.
async function fetchWithChain(startUrl: string): Promise<FetchResult> {
  const redirectChain: string[] = []
  let current = startUrl
  let lastStatus = 0
  let lastHeaders: Record<string, string> = {}

  for (let hop = 0; hop < 6; hop++) {
    // Pre-flight check kept as defense-in-depth + clearer error message
    // for the redirect-chain error field. safeFetch repeats the check
    // internally; the duplication is intentional and free.
    if (!isSafePublicUrl(current)) {
      return { finalUrl: current, status: 0, headers: {}, html: "", redirectChain, error: "unsafe (non-public) URL" }
    }
    let res: Response
    try {
      res = await safeFetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
        headers: { "User-Agent": "GuestPost-DeliveryVerification/1.0" },
      })
    } catch (err: any) {
      const reason = err instanceof SafeFetchError ? `${err.code}: ${err.message}` : err?.message ?? "fetch failed"
      return { finalUrl: current, status: 0, headers: lastHeaders, html: "", redirectChain, error: reason }
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

    // Terminal response. Phase 7.11 (#13): capped read.
    const html = await readBodyWithCap(res, MAX_HTML_BYTES).catch((err: any) => {
      if (err instanceof SafeFetchError && err.code === "BODY_TOO_LARGE") {
        logger.warn("response body cap exceeded", { url: current, maxBytes: MAX_HTML_BYTES })
      }
      return ""
    })
    return { finalUrl: current, status: res.status, headers: lastHeaders, html, redirectChain, error: undefined }
  }

  return { finalUrl: current, status: lastStatus || 508, headers: lastHeaders, html: "", redirectChain, error: "too many redirects" }
}

export function createDeliveryVerificationWorker() {
  const deps = { prisma, fetchUrl: fetchWithChain, putObject, onTrustEvent: enqueueTrustRecompute }
  const worker = createObservableWorker(
    QUEUES.DELIVERY_VERIFICATION,
    async (job) => {
      // Phase 7.8 #27 — settlement-hold-sweep (repeatable) bypasses
      // freshness; ad-hoc verify jobs get a 96h window to accommodate
      // manual-review re-verify after a delivery dispute (backoff cap
      // is 60m × 3 attempts plus staff turnaround time).
      const maxAgeMs = isRepeatableJob(job.name) ? 0 : 96 * 60 * 60 * 1000
      if (!verifyJobPayload(job.data, { maxAgeMs })) {
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
