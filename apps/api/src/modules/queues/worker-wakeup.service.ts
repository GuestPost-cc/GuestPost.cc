import { Injectable, Logger } from "@nestjs/common"

const DEFAULT_DEBOUNCE_MS = 15_000
const DEFAULT_TIMEOUT_MS = 5_000

/**
 * Best-effort wake-up signal for the short-lived Northflank worker job.
 *
 * This is intentionally not a job transport. Callers must persist work in
 * Redis or Postgres before invoking wake(). A failed wake-up is therefore a
 * latency issue only; the scheduled catch-up runner remains the durability
 * path.
 */
@Injectable()
export class WorkerWakeupService {
  private readonly logger = new Logger(WorkerWakeupService.name)
  private nextWakeAllowedAt = 0
  private inFlight: Promise<void> | null = null
  private warnedUnconfigured = false

  wake(reason: string): Promise<void> {
    const urlValue = process.env.WORKER_ON_DEMAND_TRIGGER_URL?.trim()
    if (!urlValue) {
      if (!this.warnedUnconfigured) {
        this.warnedUnconfigured = true
        this.logger.warn(
          "WORKER_ON_DEMAND_TRIGGER_URL is not configured; queued work will wait for the catch-up job",
        )
      }
      return Promise.resolve()
    }

    const now = Date.now()
    if (this.inFlight) return this.inFlight
    if (now < this.nextWakeAllowedAt) return Promise.resolve()

    const debounceMs = this.readPositiveInt(
      process.env.WORKER_ON_DEMAND_TRIGGER_DEBOUNCE_MS,
      DEFAULT_DEBOUNCE_MS,
    )
    this.nextWakeAllowedAt = now + debounceMs
    this.inFlight = this.send(urlValue, reason).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async send(urlValue: string, reason: string): Promise<void> {
    let url: URL
    try {
      url = new URL(urlValue)
    } catch {
      this.logger.error("Invalid WORKER_ON_DEMAND_TRIGGER_URL")
      return
    }

    // A trigger credential must never traverse plaintext or URL user-info.
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (process.env.NODE_ENV === "production" &&
        (url.protocol !== "https:" ||
          url.hostname !== "api.northflank.com" ||
          (url.port !== "" && url.port !== "443") ||
          !/^\/v1\/(?:teams\/[^/]+\/)?projects\/[^/]+\/jobs\/[^/]+\/runs\/?$/.test(
            url.pathname,
          )))
    ) {
      this.logger.error(
        "Refusing insecure worker trigger URL (production requires the official Northflank HTTPS run-job endpoint; URL credentials/query/fragment are forbidden)",
      )
      return
    }

    const token = process.env.WORKER_ON_DEMAND_TRIGGER_TOKEN?.trim()
    if (!token) {
      this.logger.error(
        "WORKER_ON_DEMAND_TRIGGER_TOKEN is required when the trigger URL is configured",
      )
      return
    }

    const timeoutMs = this.readPositiveInt(
      process.env.WORKER_ON_DEMAND_TRIGGER_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
    )
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        // Northflank's run-job schema accepts an empty overrides object. No
        // application identifiers or provider data leave the API.
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(timeoutMs),
      })
      await response.body?.cancel().catch(() => undefined)
      if (!response.ok) {
        this.logger.warn(
          `On-demand worker wake-up failed (${response.status}); catch-up job will retry queued work`,
          { reason },
        )
        return
      }
      this.logger.log("On-demand worker wake-up accepted", { reason })
    } catch (error) {
      this.logger.warn(
        "On-demand worker wake-up failed; catch-up job will retry queued work",
        {
          reason,
          error: error instanceof Error ? error.name : "UnknownError",
        },
      )
    }
  }

  private readPositiveInt(value: string | undefined, fallback: number): number {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
  }
}
