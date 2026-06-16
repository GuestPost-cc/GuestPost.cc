// Phase 7.0 — observability wrapper for BullMQ workers.
//
// Replaces direct `new Worker(...)` calls in every processor. Adds:
//
//   1. Request-ID propagation. Each job's signed payload may carry a
//      `requestId` (originated at the API on the request that enqueued it).
//      We re-enter the AsyncLocalStorage frame inside the processor so any
//      audit logs the worker writes carry the same correlation ID as the
//      originating API request.
//
//   2. Sentry scope tagging. Every processor runs with tags
//      { queue, jobId, requestId? } so any captured exception (whether by
//      the failed-event listener or a manual capture inside the processor)
//      surfaces with the routing context.
//
//   3. Failed/error/stalled event listeners that route to Sentry. Without
//      these, BullMQ silently moves exhausted jobs to the failed set and
//      nothing alerts. The console log is emitted unconditionally so even
//      DSN-less dev runs surface the failure.

import { Worker, type Processor, type WorkerOptions, type Job } from "bullmq"
import * as Sentry from "@sentry/node"
// Deep import: request-context uses node:async_hooks and is not in the
// shared barrel.
import { runWithRequestId } from "@guestpost/shared/dist/observability/request-context"

type RequestIdCarrier = { requestId?: unknown }

function extractRequestId(job: Job | undefined): string | undefined {
  if (!job) return undefined
  const data = job.data as RequestIdCarrier | null | undefined
  const id = data?.requestId
  return typeof id === "string" && id.length > 0 ? id : undefined
}

// Note: default TData is `any` to match BullMQ's pre-Worker-typing era — every
// processor here calls verifyJobPayload(job.data) before reading fields, which
// is the actual shape gate. Tightening to per-processor types is a follow-up.
export function createObservableWorker<TData = any, TResult = any>(
  queueName: string,
  processor: Processor<TData, TResult, string>,
  opts: WorkerOptions,
): Worker<TData, TResult, string> {
  const wrappedProcessor: Processor<TData, TResult, string> = async (job, token) => {
    const requestId = extractRequestId(job)
    const run = async (): Promise<TResult> => {
      // Sentry scope tags are inherited by any captureException fired from
      // inside the processor (including the SDK's auto-instrumentation).
      return Sentry.withScope(async (scope) => {
        scope.setTag("queue", queueName)
        if (job?.id) scope.setTag("jobId", String(job.id))
        if (requestId) scope.setTag("requestId", requestId)
        return processor(job, token)
      })
    }
    if (requestId) {
      return runWithRequestId(requestId, run)
    }
    return run()
  }

  const worker = new Worker<TData, TResult, string>(queueName, wrappedProcessor, opts)

  worker.on("failed", (job, err) => {
    const requestId = extractRequestId(job)
    Sentry.withScope((scope) => {
      scope.setTag("queue", queueName)
      if (job?.id) scope.setTag("jobId", String(job.id))
      if (job?.attemptsMade != null) scope.setTag("attemptsMade", String(job.attemptsMade))
      if (requestId) scope.setTag("requestId", requestId)
      Sentry.captureException(err)
    })
    console.error(
      `[OBSERVABILITY] captured job failure: queue=${queueName} jobId=${job?.id ?? "?"} attempts=${job?.attemptsMade ?? "?"} requestId=${requestId ?? "-"} err=${err.message}`,
    )
  })

  // BullMQ emits 'error' for worker-level failures (Redis disconnect, etc.) —
  // distinct from per-job 'failed' events. Always capture.
  worker.on("error", (err) => {
    Sentry.withScope((scope) => {
      scope.setTag("queue", queueName)
      scope.setTag("source", "worker-error")
      Sentry.captureException(err)
    })
    console.error(`[OBSERVABILITY] worker error: queue=${queueName} err=${err.message}`)
  })

  // 'stalled' jobs are recovered automatically by BullMQ on the next sweep,
  // but the pattern usually indicates a processor hang or a pod evict — worth
  // logging even if not capturing as an exception.
  worker.on("stalled", (jobId) => {
    console.warn(`[OBSERVABILITY] job stalled: queue=${queueName} jobId=${jobId}`)
  })

  return worker
}
