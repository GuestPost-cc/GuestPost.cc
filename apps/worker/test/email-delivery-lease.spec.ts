import assert from "node:assert/strict"
import { test } from "node:test"
import {
  beginEmailDispatch,
  type EmailDeliveryLease,
  ownsEmailDeliveryLease,
  recoverExpiredEmailDeliveryLeases,
} from "../src/lib/email-delivery-lease"

interface FakeDelivery {
  id: string
  channel: string
  status: string
  attempts: number
  lockedAt: Date | null
  dispatchStartedAt: Date | null
  availableAt?: Date
  failedAt?: Date
  lastError?: string
}

function fakeDb(row: FakeDelivery) {
  return {
    communicationDelivery: {
      async updateMany(input: { where: any; data: any }) {
        const where = input.where
        const matches =
          (where.id === undefined || where.id === row.id) &&
          (where.channel === undefined || where.channel === row.channel) &&
          (where.status === undefined || where.status === row.status) &&
          (where.attempts === undefined || where.attempts === row.attempts) &&
          (where.lockedAt === undefined ||
            (where.lockedAt instanceof Date
              ? row.lockedAt?.getTime() === where.lockedAt.getTime()
              : row.lockedAt !== null &&
                where.lockedAt.lt instanceof Date &&
                row.lockedAt < where.lockedAt.lt)) &&
          (where.dispatchStartedAt === undefined ||
            (where.dispatchStartedAt === null
              ? row.dispatchStartedAt === null
              : where.dispatchStartedAt.not === null &&
                row.dispatchStartedAt !== null))
        if (!matches) return { count: 0 }
        Object.assign(row, input.data)
        return { count: 1 }
      },
    },
  }
}

test("a stale claimant cannot cross the SMTP boundary using a replacement lease", async () => {
  const firstLease: EmailDeliveryLease = {
    attempts: 1,
    lockedAt: new Date("2026-08-11T00:00:00.000Z"),
  }
  const row: FakeDelivery = {
    id: "delivery-1",
    channel: "EMAIL",
    status: "PROCESSING",
    attempts: 2,
    lockedAt: new Date("2026-08-11T00:20:00.000Z"),
    dispatchStartedAt: null,
  }

  const staleDispatch = await beginEmailDispatch(
    fakeDb(row),
    row.id,
    firstLease,
    new Date("2026-08-11T00:20:01.000Z"),
  )

  assert.equal(staleDispatch, null)
  assert.equal(row.dispatchStartedAt, null)
  assert.equal(ownsEmailDeliveryLease(row, firstLease), false)
})

test("an expired post-dispatch lease is quarantined instead of resent", async () => {
  const lease: EmailDeliveryLease = {
    attempts: 3,
    lockedAt: new Date("2026-08-11T00:00:00.000Z"),
  }
  const row: FakeDelivery = {
    id: "delivery-2",
    channel: "EMAIL",
    status: "PROCESSING",
    attempts: lease.attempts,
    lockedAt: lease.lockedAt,
    dispatchStartedAt: new Date("2026-08-11T00:00:01.000Z"),
  }

  const recovered = await recoverExpiredEmailDeliveryLeases(fakeDb(row), {
    now: new Date("2026-08-11T00:16:00.000Z"),
    deliveryId: row.id,
  })

  assert.deepEqual(recovered, { retryable: 0, uncertain: 1 })
  assert.equal(row.status, "DELIVERY_UNCERTAIN")
  assert.equal(row.lockedAt, null)
  assert.match(row.lastError ?? "", /reconcile manually/)
})

test("an expired pre-dispatch lease remains safely retryable", async () => {
  const row: FakeDelivery = {
    id: "delivery-3",
    channel: "EMAIL",
    status: "PROCESSING",
    attempts: 1,
    lockedAt: new Date("2026-08-11T00:00:00.000Z"),
    dispatchStartedAt: null,
  }

  const recovered = await recoverExpiredEmailDeliveryLeases(fakeDb(row), {
    now: new Date("2026-08-11T00:16:00.000Z"),
    deliveryId: row.id,
  })

  assert.deepEqual(recovered, { retryable: 1, uncertain: 0 })
  assert.equal(row.status, "FAILED")
  assert.equal(row.lockedAt, null)
  assert.equal(row.availableAt?.toISOString(), "2026-08-11T00:16:00.000Z")
})
