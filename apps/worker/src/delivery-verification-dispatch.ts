import {
  deliveryVerificationJobId,
  QUEUE_JOBS,
  QUEUES,
} from "@guestpost/shared"
import { signJobPayload } from "@guestpost/shared/dist/job-signing"

const DEFAULT_BATCH_SIZE = 100
const MAX_BATCH_SIZE = 1_000

interface DispatchCandidate {
  id: string
  verificationVersion: number
  verificationStatus: string
  supersededByVersion: number | null
  activeOrder: { id: string } | null
}

interface DispatchPrisma {
  orderDeliveryVersion: {
    // Prisma delegates are generic functions whose exact signature is not
    // structurally assignable to a hand-written Promise interface. Keep the
    // boundary narrow here and validate the selected shape below.
    findMany: (...args: any[]) => Promise<any>
    findFirst: (...args: any[]) => Promise<any>
  }
}

interface DispatchQueue {
  add(
    name: string,
    data: Record<string, unknown>,
    options: Record<string, unknown>,
  ): Promise<unknown>
  getJob(jobId: string): Promise<
    | {
        getState(): Promise<string>
        remove(): Promise<void>
      }
    | null
    | undefined
  >
}

export interface DeliveryVerificationDispatchResult {
  scanned: number
  eligible: number
  dispatched: number
  confirmedExisting: number
  rearmedTerminal: number
}

const TERMINAL_JOB_STATES = new Set(["completed", "failed"])

export function deliveryVerificationDispatchBatchSize(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_BATCH_SIZE
  return Math.min(parsed, MAX_BATCH_SIZE)
}

/**
 * Recover committed delivery versions whose post-commit Redis enqueue failed.
 *
 * The query and the in-memory predicate intentionally duplicate eligibility.
 * The processor performs a third check immediately before network work. This
 * makes stale/superseded delivery versions harmless even when they change
 * between the database scan, Redis enqueue, and job execution.
 */
export async function dispatchPendingDeliveryVerifications(
  prisma: DispatchPrisma,
  queue: DispatchQueue,
  requestedBatchSize: unknown,
): Promise<DeliveryVerificationDispatchResult> {
  const batchSize = deliveryVerificationDispatchBatchSize(requestedBatchSize)
  const candidates = (await prisma.orderDeliveryVersion.findMany({
    where: {
      verificationStatus: "PENDING",
      supersededByVersion: null,
      activeOrder: { isNot: null },
    },
    select: {
      id: true,
      verificationVersion: true,
      verificationStatus: true,
      supersededByVersion: true,
      activeOrder: { select: { id: true } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: batchSize,
  })) as DispatchCandidate[]

  const eligible = candidates.filter(
    (candidate) =>
      candidate.verificationStatus === "PENDING" &&
      candidate.supersededByVersion == null &&
      candidate.activeOrder != null &&
      Number.isSafeInteger(candidate.verificationVersion) &&
      candidate.verificationVersion >= 0,
  )
  let dispatched = 0
  let confirmedExisting = 0
  let rearmedTerminal = 0
  const failures: Error[] = []

  for (const candidate of eligible) {
    const jobId = deliveryVerificationJobId(
      candidate.id,
      candidate.verificationVersion,
    )
    try {
      const existing = await queue.getJob(jobId)
      if (existing) {
        const state = await existing.getState()
        if (!TERMINAL_JOB_STATES.has(state)) {
          confirmedExisting++
          continue
        }
        // A worker can exhaust/finalize its BullMQ job before changing the
        // Postgres row (for example, a crash before core execution). Remove
        // only terminal jobs; active/waiting/delayed jobs are never disturbed.
        await existing.remove()
        rearmedTerminal++
      }
      await queue.add(
        QUEUE_JOBS[QUEUES.DELIVERY_VERIFICATION].VERIFY,
        signJobPayload({
          deliveryVersionId: candidate.id,
          verificationVersion: candidate.verificationVersion,
        }),
        {
          jobId,
          attempts: 3,
          backoff: { type: "custom" },
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 100 },
        },
      )
      dispatched++
    } catch (error) {
      // Redis may commit queue.add and lose the response. Confirming the
      // deterministic ID turns that ambiguous timeout into success.
      const existing = await queue.getJob(jobId).catch(() => null)
      if (existing) {
        confirmedExisting++
        continue
      }
      failures.push(error instanceof Error ? error : new Error(String(error)))
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Failed to dispatch ${failures.length} of ${eligible.length} pending delivery verifications`,
    )
  }

  return {
    scanned: candidates.length,
    eligible: eligible.length,
    dispatched,
    confirmedExisting,
    rearmedTerminal,
  }
}

export async function isDeliveryVerificationJobEligible(
  prisma: DispatchPrisma,
  deliveryVersionId: string,
  verificationVersion: unknown,
): Promise<boolean> {
  if (
    typeof deliveryVersionId !== "string" ||
    deliveryVersionId.length === 0 ||
    deliveryVersionId.length > 191
  ) {
    return false
  }
  if (
    !Number.isSafeInteger(verificationVersion) ||
    Number(verificationVersion) < 0
  ) {
    return false
  }
  const row = await prisma.orderDeliveryVersion.findFirst({
    where: {
      id: deliveryVersionId,
      verificationVersion: Number(verificationVersion),
      verificationStatus: { in: ["PENDING", "RETRYING"] },
      supersededByVersion: null,
      activeOrder: { isNot: null },
    },
    select: { id: true },
  })
  return row != null
}
