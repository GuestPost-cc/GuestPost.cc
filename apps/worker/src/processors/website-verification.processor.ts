import { connection } from "../redis"
import { QUEUES, runWebsiteVerify, runWebsiteReverifySweep } from "@guestpost/shared"
import { verifyJobPayload } from "@guestpost/shared/dist/job-signing"
import { createObservableWorker } from "../lib/queue-observability"
// Node-only DNS lookup — deep import keeps node `dns` out of the shared index
// (which the browser apps bundle).
import { checkDnsTxtToken } from "@guestpost/shared/dist/dns-lookup"
import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"
import { isRepeatableJob } from "../repeatable-job-registry"
import { enqueueTrustRecompute } from "../trust-enqueue"
import { prisma } from "@guestpost/database"

const logger = createLogger("worker.website-verification")

// DNS TXT domain-ownership verification worker. Thin adapter over the pure
// state machine in @guestpost/shared (website-verification-core), injecting the
// real prisma client + node DNS lookup.
//
//  - "website-verify"          : single on-demand check enqueued by the API.
//  - "website-reverify-sweep"  : 30-day repeatable sweep that REVOKES any
//                                VERIFIED site whose TXT record disappeared.

interface VerifyJobData {
  websiteId: string
  actorUserId?: string
}

export function createWebsiteVerificationWorker() {
  const deps = { prisma, checkDns: checkDnsTxtToken, onTrustEvent: enqueueTrustRecompute }
  const worker = createObservableWorker(
    QUEUES.WEBSITE_VERIFICATION,
    async (job) => {
      // Reject anything not HMAC-signed by the API — blocks forged/injected jobs.
      // Phase 7.8 #27 — website-reverify-sweep (repeatable) bypasses freshness.
      if (!verifyJobPayload(job.data, { maxAgeMs: isRepeatableJob(job.name) ? 0 : undefined })) {
        logger.error("job signature invalid — rejecting", { jobId: job.id })
        throw new Error("Invalid job signature")
      }
      switch (job.name) {
        case "website-verify": {
          const data = job.data as VerifyJobData
          const res = await runWebsiteVerify(deps, data.websiteId, data.actorUserId)
          logger.info("website verification complete", { websiteId: data.websiteId, result: res })
          return res
        }
        case "website-reverify-sweep": {
          const res = await runWebsiteReverifySweep(deps)
          logger.info("website re-verify sweep complete", { result: res })
          return res
        }
        default:
          logger.warn("unknown job name", { jobName: job.name })
      }
    },
    { connection, concurrency: 4 },
  )

  worker.on("completed", (job) => logger.info("job completed", { jobId: job.id }))
  worker.on("failed", (job, err) => logger.error("job failed", { jobId: job?.id, err: err?.message }))
  return worker
}
