import { Worker } from "bullmq"
import { isIP } from "net"
import { connection } from "../redis"
import { QUEUES, verifyJobPayload } from "@guestpost/shared"
// Node-only deep imports keep cheerio + aws-sdk out of the shared index.
import { runDeliveryVerification, FetchResult } from "@guestpost/shared/dist/delivery-verification-core"
import { putObject } from "@guestpost/shared/dist/object-storage"
import { prisma } from "@guestpost/database"

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
  const deps = { prisma, fetchUrl: fetchWithChain, putObject }
  const worker = new Worker(
    QUEUES.DELIVERY_VERIFICATION,
    async (job) => {
      if (!verifyJobPayload(job.data)) {
        console.error(`[DELIVERY_VERIFY] Job ${job.id} missing/invalid signature — rejecting`)
        throw new Error("Invalid job signature")
      }
      if (job.name !== "delivery-verify") {
        console.warn(`[DELIVERY_VERIFY] Unknown job: ${job.name}`)
        return
      }
      const { deliveryVersionId, actorUserId } = job.data as { deliveryVersionId: string; actorUserId?: string }
      const maxAttempts = job.opts.attempts ?? 1
      const isFinalAttempt = job.attemptsMade >= maxAttempts - 1
      const res = await runDeliveryVerification(deps, deliveryVersionId, { actorUserId, isFinalAttempt })
      console.log(`[DELIVERY_VERIFY] ${deliveryVersionId} (attempt ${job.attemptsMade + 1}/${maxAttempts}): ${JSON.stringify(res)}`)
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

  worker.on("completed", (job) => console.log(`[DELIVERY_VERIFY] Job ${job.id} completed`))
  worker.on("failed", (job, err) => console.error(`[DELIVERY_VERIFY] Job ${job?.id} failed:`, err?.message))
  return worker
}
