import assert from "node:assert/strict"
import test from "node:test"
import { verifyJobPayload } from "@guestpost/shared/dist/job-signing"
import { dispatchCommittedCommunicationEvents } from "../src/lib/communication-outbox-dispatch-core"

process.env.QUEUE_SIGNING_SECRET ??=
  "communication-dispatch-test-secret-32-bytes"

test("communication wake jobs are authenticated for the email processor", async () => {
  let query: any
  const prisma = {
    communicationDelivery: {
      findMany: async (args: any) => {
        query = args
        return [
          {
            id: "delivery-1",
            attempts: 2,
            availableAt: new Date("2026-08-11T12:00:00.000Z"),
          },
        ]
      },
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
  }

  const dispatched = await dispatchCommittedCommunicationEvents(prisma, queue, [
    "event-1",
    "event-1",
  ])

  assert.equal(dispatched, 1)
  assert.deepEqual(query.where.eventId, { in: ["event-1"] })
  assert.equal(query.where.channel, "EMAIL")
  assert.deepEqual(query.where.status, { in: ["PENDING", "FAILED"] })
  assert.equal(added.length, 1)
  assert.equal(added[0].name, "send-email-delivery")
  assert.equal(
    added[0].options.jobId,
    "email-delivery-delivery-1-a2-at1786449600000",
  )
  assert.equal(added[0].options.attempts, 1)
  assert.deepEqual(added[0].options.removeOnComplete, {
    count: 100,
    age: 86_400,
  })
  assert.deepEqual(added[0].options.removeOnFail, {
    count: 100,
    age: 604_800,
  })
  assert.equal(added[0].data.deliveryId, "delivery-1")
  assert.equal(verifyJobPayload(added[0].data), true)
})

test("a database retry receives a new wake id even while the prior job is retained", async () => {
  let delivery = {
    id: "delivery-retry",
    attempts: 1,
    availableAt: new Date("2026-08-11T12:00:00.000Z"),
  }
  const prisma = {
    communicationDelivery: {
      findMany: async () => [delivery],
    },
  }
  const jobIds: unknown[] = []
  const queue = {
    add: async (_name: string, _data: unknown, options: any) => {
      jobIds.push(options.jobId)
    },
  }

  await dispatchCommittedCommunicationEvents(prisma, queue, ["event-1"])
  delivery = {
    ...delivery,
    attempts: 2,
    availableAt: new Date("2026-08-11T12:05:00.000Z"),
  }
  await dispatchCommittedCommunicationEvents(prisma, queue, ["event-1"])

  assert.equal(jobIds.length, 2)
  assert.notEqual(jobIds[0], jobIds[1])
})
