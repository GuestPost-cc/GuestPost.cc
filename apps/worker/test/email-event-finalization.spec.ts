import assert from "node:assert/strict"
import { test } from "node:test"
import { runEmailDeliveryTerminalTransaction } from "../src/lib/email-event-finalization"

test("concurrent final deliveries cannot strand their event as pending", async () => {
  const deliveries = new Map([
    ["delivery-1", "PROCESSING"],
    ["delivery-2", "PROCESSING"],
  ])
  let eventStatus = "PENDING"
  let lockTail = Promise.resolve()

  const prisma = {
    async $transaction(operation: (tx: any) => Promise<unknown>) {
      let releaseLock!: () => void
      const acquired = new Promise<void>((resolve) => {
        releaseLock = resolve
      })
      const predecessor = lockTail
      lockTail = acquired
      let ownsEventLock = false
      const tx = {
        async $queryRaw() {
          await predecessor
          ownsEventLock = true
          return [{ id: "event-1" }]
        },
        communicationDelivery: {
          async updateMany(input: { where: { id: string }; data: any }) {
            assert.equal(ownsEventLock, true)
            if (deliveries.get(input.where.id) !== "PROCESSING") {
              return { count: 0 }
            }
            deliveries.set(input.where.id, input.data.status)
            return { count: 1 }
          },
          async count() {
            return [...deliveries.values()].filter((status) =>
              [
                "PENDING",
                "PROCESSING",
                "FAILED",
                "DELIVERY_UNCERTAIN",
              ].includes(status),
            ).length
          },
        },
        communicationEvent: {
          async updateMany(input: { data: { status: string } }) {
            eventStatus = input.data.status
            return { count: 1 }
          },
        },
      }
      try {
        return await operation(tx)
      } finally {
        releaseLock()
      }
    },
  }

  await Promise.all(
    [...deliveries.keys()].map((deliveryId) =>
      runEmailDeliveryTerminalTransaction(prisma, "event-1", async (tx) => {
        const changed = await tx.communicationDelivery.updateMany({
          where: { id: deliveryId },
          data: { status: "SENT" },
        })
        return { terminalized: changed.count === 1, result: changed.count }
      }),
    ),
  )

  assert.deepEqual([...deliveries.values()], ["SENT", "SENT"])
  assert.equal(eventStatus, "PROCESSED")
})

test("a lost delivery lease cannot finalize its event", async () => {
  let eventUpdated = false
  const prisma = {
    async $transaction(operation: (tx: any) => Promise<unknown>) {
      return operation({
        $queryRaw: async () => [{ id: "event-1" }],
        communicationDelivery: {
          count: async () => 0,
        },
        communicationEvent: {
          updateMany: async () => {
            eventUpdated = true
            return { count: 1 }
          },
        },
      })
    },
  }

  const result = await runEmailDeliveryTerminalTransaction(
    prisma,
    "event-1",
    async () => ({ terminalized: false, result: "lease-lost" }),
  )

  assert.equal(result, "lease-lost")
  assert.equal(eventUpdated, false)
})

test("an uncertain delivery keeps its event durably outstanding", async () => {
  let eventUpdate: any = null
  const prisma = {
    async $transaction(operation: (tx: any) => Promise<unknown>) {
      return operation({
        $queryRaw: async () => [{ id: "event-1" }],
        communicationDelivery: {
          count: async () => 1,
        },
        communicationEvent: {
          updateMany: async (input: any) => {
            eventUpdate = input
            return { count: 1 }
          },
        },
      })
    },
  }

  const result = await runEmailDeliveryTerminalTransaction(
    prisma,
    "event-1",
    async () => ({ terminalized: true, result: "DELIVERY_UNCERTAIN" }),
  )

  assert.equal(result, "DELIVERY_UNCERTAIN")
  assert.deepEqual(eventUpdate, {
    where: { id: "event-1", status: "PROCESSED" },
    data: { status: "PENDING", processedAt: null },
  })
})
