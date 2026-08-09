import assert from "node:assert/strict"
import test from "node:test"
import { verifyJobPayload } from "@guestpost/shared/dist/job-signing"
import {
  dispatchPendingDeliveryVerifications,
  isDeliveryVerificationJobEligible,
} from "../src/delivery-verification-dispatch"

process.env.QUEUE_SIGNING_SECRET ??= "worker-dispatch-test-secret-32-bytes"

function candidate(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    verificationVersion: 0,
    verificationStatus: "PENDING",
    supersededByVersion: null,
    activeOrder: { id: `order-${id}` },
    ...overrides,
  }
}

test("dispatches only active, non-superseded PENDING delivery versions", async () => {
  let query: any
  const prisma = {
    orderDeliveryVersion: {
      findMany: async (args: any) => {
        query = args
        return [
          candidate("active"),
          candidate("superseded", { supersededByVersion: 2 }),
          candidate("inactive", { activeOrder: null }),
          candidate("verified", { verificationStatus: "VERIFIED" }),
        ]
      },
      findFirst: async () => null,
    },
  }
  const added: Array<{
    name: string
    data: Record<string, unknown>
    options: Record<string, unknown>
  }> = []
  const queue = {
    add: async (
      name: string,
      data: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => {
      added.push({ name, data, options })
    },
    getJob: async () => null,
  }

  const result = await dispatchPendingDeliveryVerifications(
    prisma as any,
    queue,
    25,
  )

  assert.deepEqual(query.where, {
    verificationStatus: "PENDING",
    supersededByVersion: null,
    activeOrder: { isNot: null },
  })
  assert.deepEqual(query.orderBy, [{ createdAt: "asc" }, { id: "asc" }])
  assert.equal(query.take, 25)
  assert.deepEqual(result, {
    scanned: 4,
    eligible: 1,
    dispatched: 1,
    confirmedExisting: 0,
    rearmedTerminal: 0,
  })
  assert.equal(added.length, 1)
  assert.equal(added[0].name, "delivery-verify")
  assert.equal(added[0].options.jobId, "delivery-verify-active-v0")
  assert.equal(verifyJobPayload(added[0].data), true)
})

test("treats an accepted response lost behind a deterministic ID as success", async () => {
  const prisma = {
    orderDeliveryVersion: {
      findMany: async () => [candidate("accepted", { verificationVersion: 3 })],
      findFirst: async () => null,
    },
  }
  let lookedUpId: string | undefined
  let lookupCount = 0
  const queue = {
    add: async () => {
      throw new Error("connection closed after Redis accepted the command")
    },
    getJob: async (jobId: string) => {
      lookupCount++
      lookedUpId = jobId
      return lookupCount === 1
        ? null
        : {
            getState: async () => "waiting",
            remove: async () => {},
          }
    },
  }

  const result = await dispatchPendingDeliveryVerifications(
    prisma as any,
    queue,
    100,
  )

  assert.equal(lookedUpId, "delivery-verify-accepted-v3")
  assert.equal(result.confirmedExisting, 1)
  assert.equal(result.dispatched, 0)
})

test("re-arms a terminal queue record when Postgres remains PENDING", async () => {
  const prisma = {
    orderDeliveryVersion: {
      findMany: async () => [candidate("terminal", { verificationVersion: 2 })],
      findFirst: async () => null,
    },
  }
  let removed = 0
  let added = 0
  const queue = {
    add: async () => {
      added++
    },
    getJob: async () => ({
      getState: async () => "failed",
      remove: async () => {
        removed++
      },
    }),
  }

  const result = await dispatchPendingDeliveryVerifications(
    prisma as any,
    queue,
    100,
  )

  assert.equal(removed, 1)
  assert.equal(added, 1)
  assert.equal(result.rearmedTerminal, 1)
  assert.equal(result.dispatched, 1)
})

test("a later sweep recovers a real enqueue outage with the same dedupe key", async () => {
  const prisma = {
    orderDeliveryVersion: {
      findMany: async () => [candidate("recover", { verificationVersion: 4 })],
      findFirst: async () => null,
    },
  }
  const attemptedIds: unknown[] = []
  const unavailableQueue = {
    add: async (_name: string, _data: unknown, options: any) => {
      attemptedIds.push(options.jobId)
      throw new Error("redis unavailable")
    },
    getJob: async () => null,
  }
  await assert.rejects(
    dispatchPendingDeliveryVerifications(prisma as any, unavailableQueue, 100),
    /Failed to dispatch 1 of 1/,
  )

  const recoveredQueue = {
    add: async (_name: string, _data: unknown, options: any) => {
      attemptedIds.push(options.jobId)
    },
    getJob: async () => null,
  }
  const recovered = await dispatchPendingDeliveryVerifications(
    prisma as any,
    recoveredQueue,
    100,
  )

  assert.deepEqual(attemptedIds, [
    "delivery-verify-recover-v4",
    "delivery-verify-recover-v4",
  ])
  assert.equal(recovered.dispatched, 1)
})

test("job execution eligibility binds the active delivery generation", async () => {
  let where: any
  const prisma = {
    orderDeliveryVersion: {
      findMany: async () => [],
      findFirst: async (args: any) => {
        where = args.where
        return null
      },
    },
  }

  assert.equal(
    await isDeliveryVerificationJobEligible(prisma as any, "delivery-1", 7),
    false,
  )
  assert.deepEqual(where, {
    id: "delivery-1",
    verificationVersion: 7,
    verificationStatus: { in: ["PENDING", "RETRYING"] },
    supersededByVersion: null,
    activeOrder: { isNot: null },
  })
  assert.equal(
    await isDeliveryVerificationJobEligible(prisma as any, "delivery-1", "7"),
    false,
  )
  assert.equal(
    await isDeliveryVerificationJobEligible(
      prisma as any,
      "delivery-1",
      undefined,
    ),
    false,
  )
})
