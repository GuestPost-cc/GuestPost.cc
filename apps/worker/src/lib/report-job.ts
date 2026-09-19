import { QUEUE_JOBS, QUEUES } from "@guestpost/shared"

export type ReportJobFormat = "pdf" | "csv"

/**
 * Keep legacy jobs executable during rolling deployments while rejecting
 * unknown names instead of acknowledging work that produced no artifact.
 */
export function resolveReportJobFormat(
  jobName: string,
  requestedFormat: unknown,
): ReportJobFormat {
  if (jobName === QUEUE_JOBS[QUEUES.REPORT].GENERATE_CSV) return "csv"
  if (jobName === QUEUE_JOBS[QUEUES.REPORT].GENERATE_PDF) return "pdf"
  if (
    jobName === QUEUE_JOBS[QUEUES.REPORT].EXPORT_REPORT ||
    jobName === QUEUE_JOBS[QUEUES.REPORT].LEGACY_GENERATE
  ) {
    return requestedFormat === "csv" ? "csv" : "pdf"
  }
  throw new Error(`Unsupported report job name: ${jobName}`)
}
