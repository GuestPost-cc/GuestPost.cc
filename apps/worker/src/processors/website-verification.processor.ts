import { Worker } from "bullmq"
import { connection } from "../redis"
import { QUEUES, verifyJobPayload, runWebsiteVerify, runWebsiteReverifySweep } from "@guestpost/shared"
// Node-only DNS lookup — deep import keeps node `dns` out of the shared index
// (which the browser apps bundle).
import { checkDnsTxtToken } from "@guestpost/shared/dist/dns-lookup"
import { prisma } from "@guestpost/database"

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
  const deps = { prisma, checkDns: checkDnsTxtToken }
  const worker = new Worker(
    QUEUES.WEBSITE_VERIFICATION,
    async (job) => {
      // Reject anything not HMAC-signed by the API — blocks forged/injected jobs.
      if (!verifyJobPayload(job.data)) {
        console.error(`[WEBSITE_VERIFY] Job ${job.id} has missing/invalid signature — rejecting`)
        throw new Error("Invalid job signature")
      }
      switch (job.name) {
        case "website-verify": {
          const data = job.data as VerifyJobData
          const res = await runWebsiteVerify(deps, data.websiteId, data.actorUserId)
          console.log(`[WEBSITE_VERIFY] ${data.websiteId}: ${JSON.stringify(res)}`)
          return res
        }
        case "website-reverify-sweep": {
          const res = await runWebsiteReverifySweep(deps)
          console.log(`[WEBSITE_VERIFY] Sweep: ${JSON.stringify(res)}`)
          return res
        }
        default:
          console.warn(`[WEBSITE_VERIFY] Unknown job: ${job.name}`)
      }
    },
    { connection, concurrency: 4 },
  )

  worker.on("completed", (job) => console.log(`[WEBSITE_VERIFY] Job ${job.id} completed`))
  worker.on("failed", (job, err) => console.error(`[WEBSITE_VERIFY] Job ${job?.id} failed:`, err))
  return worker
}
