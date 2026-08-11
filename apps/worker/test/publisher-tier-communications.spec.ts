import assert from "node:assert/strict"
import test from "node:test"
import { recordPublisherTierCommunications } from "../src/lib/publisher-tier-communications"

function harness() {
  const dedupKeys: string[] = []
  const tx = {
    $queryRaw: async () => [{ id: "event" }],
    publisher: {
      findUnique: async () => ({ name: "Publisher", organizationId: "org-1" }),
    },
    publisherMembership: {
      findMany: async () => [{ userId: "publisher-user" }],
    },
    staffMembership: {
      findMany: async () => [{ userId: "staff-user" }],
    },
    communicationEvent: {
      upsert: async ({ create }: any) => {
        dedupKeys.push(create.dedupKey)
        return {
          id: `event-${dedupKeys.length}`,
          ...create,
          payload: create.payload ?? null,
        }
      },
      updateMany: async () => ({ count: 1 }),
    },
    user: { findMany: async () => [] },
    communicationDelivery: { count: async () => 0 },
  }
  return { tx, dedupKeys }
}

test("computed tier cycles use the durable transition id instead of from/to", async () => {
  const { tx, dedupKeys } = harness()
  const base = {
    publisherId: "publisher-1",
    oldScore: 30,
    newScore: 70,
    oldTier: "NEW",
    newTier: "TRUSTED",
    changed: true,
    durationMs: 1,
  }

  await recordPublisherTierCommunications(tx, {
    ...base,
    transitionId: "audit-transition-1",
  })
  await recordPublisherTierCommunications(tx, {
    ...base,
    transitionId: "audit-transition-2",
  })

  assert.deepEqual(dedupKeys, [
    "publisher:publisher-1:tier-change:audit-transition-1",
    "staff:publisher:publisher-1:tier-change:audit-transition-1",
    "publisher:publisher-1:tier-change:audit-transition-2",
    "staff:publisher:publisher-1:tier-change:audit-transition-2",
  ])
  assert.equal(new Set(dedupKeys).size, 4)
})

test("computed tier communication fails closed without durable identity", async () => {
  const { tx } = harness()

  await assert.rejects(
    recordPublisherTierCommunications(tx, {
      publisherId: "publisher-1",
      oldScore: 30,
      newScore: 70,
      oldTier: "NEW",
      newTier: "TRUSTED",
      changed: true,
      transitionId: null,
      durationMs: 1,
    }),
    /missing durable identity/,
  )
})
