/**
 * Phase 7.8 #27 — single source of truth for BullMQ repeatable job names.
 *
 * The iat freshness check in verifyJobPayload rejects payloads older
 * than maxAgeMs. Repeatable cron jobs sign their payload ONCE at worker
 * boot (in apps/worker/src/index.ts) and BullMQ reuses that signed
 * payload for every recurrence — so after maxAgeMs every recurrence
 * fails. To avoid this, each processor's verify call passes
 * `maxAgeMs: 0` when the job name is in this set (HMAC integrity check
 * still runs; only freshness is bypassed).
 *
 * If you register a new repeatable in worker/index.ts, add its name
 * to JOB_NAMES below. The RepeatableJobName type, REPEATABLE_JOB_NAMES
 * Set, and the boot-time drift guard in assertNoRegistryDrift() all
 * derive from this single array — there is exactly one source of truth.
 *
 * The drift-guard spec at apps/worker/src/__tests__/repeatable-job-registry.spec.ts
 * provides CI-level coverage. The boot-time assertion in bootstrap()
 * provides faster, harder safety: the worker refuses to start if the
 * Set and actual register*() calls disagree.
 *
 * Phase 8.12 — added RepeatableJobName union type, RegisteredJob
 * interface, and assertNoRegistryDrift(). Registration functions in
 * worker/index.ts return RegisteredJob objects that bootstrap()
 * collects and validates against REPEATABLE_JOB_NAMES at startup.
 */

const JOB_NAMES = [
  "payout-check-status",
  "reconciliation-run",
  "website-reverify-sweep",
  "settlement-hold-sweep",
  "settlement-auto-approve",
  "settlement-auto-release",
  "auto-accept-sweep",
  "review-reminder-sweep",
  "cancellation-response-timeout-sweep",
  "order-acceptance-timeout-sweep",
] as const

export type RepeatableJobName = (typeof JOB_NAMES)[number]

/** What a register*() function reports back after successfully scheduling a repeatable job. */
export interface RegisteredJob {
  name: RepeatableJobName
  /** BullMQ queue this job was registered on. Enables future queue-level validation. */
  queue: string
}

export const REPEATABLE_JOB_NAMES = new Set<RepeatableJobName>(JOB_NAMES)

/**
 * Boot-time drift guard. Called from bootstrap() after all register*()
 * calls resolve. Compares the canonical REPEATABLE_JOB_NAMES Set against
 * the list of job names actually registered at startup. Throws on
 * mismatch, which propagates to bootstrap.catch() → process.exit(1).
 *
 * This prevents the silent failure class where a developer adds a new
 * repeatable job to bootstrap() but forgets JOB_NAMES above, or
 * removes one from JOB_NAMES without cleaning up the register*() call.
 */
export function assertNoRegistryDrift(registered: RegisteredJob[]): void {
  const registeredNames = new Set(registered.map((j) => j.name))

  const inSetNotRegistered = [...REPEATABLE_JOB_NAMES].filter(
    (name) => !registeredNames.has(name),
  )
  const inRegisteredNotInSet = [...registeredNames].filter(
    (name) => !REPEATABLE_JOB_NAMES.has(name),
  )

  if (inSetNotRegistered.length === 0 && inRegisteredNotInSet.length === 0)
    return

  const lines: string[] = [
    "registry drift: repeatable-job canonical set differs from boot-registered jobs",
  ]
  if (inSetNotRegistered.length > 0) {
    lines.push(
      `  in REPEATABLE_JOB_NAMES but NOT registered at boot: ${JSON.stringify(inSetNotRegistered)}`,
    )
  }
  if (inRegisteredNotInSet.length > 0) {
    lines.push(
      `  registered at boot but NOT in REPEATABLE_JOB_NAMES: ${JSON.stringify(inRegisteredNotInSet)}`,
    )
  }
  throw new Error(lines.join("\n"))
}

export function isRepeatableJob(jobName: string | undefined | null): boolean {
  if (!jobName) return false
  return REPEATABLE_JOB_NAMES.has(jobName as RepeatableJobName)
}
