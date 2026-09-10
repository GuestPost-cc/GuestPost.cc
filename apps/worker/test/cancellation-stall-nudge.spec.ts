import assert from "node:assert/strict"
import test from "node:test"
import type { CommunicationEventInput } from "@guestpost/shared"
import {
  type CancellationStallCase,
  nudgeStaleCancellationCases,
} from "../src/lib/cancellation-stall-nudge"

const NOW = new Date("2026-08-24T12:00:00.000Z")
const CONFIG = {
  caseStallFirstReminderDays: 3,
  caseStallReminderIntervalDays: 7,
}

function stalledCase(overrides: Partial<CancellationStallCase> = {}) {
  return {
    id: "req-1",
    orderId: "order-1",
    status: "ESCALATED",
    updatedAt: new Date("2026-08-21T00:00:00.000Z"),
    order: { organizationId: "org-1" },
    ...overrides,
  }
}

function harness(cases: CancellationStallCase[]) {
  const recorded: CommunicationEventInput[] = []
  const createdEvents: any[] = []
  const tx = {
    orderEvent: {
      create: async ({ data }: { data: any }) => {
        createdEvents.push(data)
        return { id: `event-${createdEvents.length}` }
      },
    },
    staffMembership: {
      findMany: async () => [{ userId: "staff-1" }, { userId: "staff-2" }],
    },
  }
  const prisma = {
    orderCancellationRequest: {
      findMany: async () => cases,
    },
    orderEvent: { findMany: async () => [] },
    staffMembership: {
      findMany: async () => [
        { userId: "staff-1", role: "OPERATIONS" },
        { userId: "staff-2", role: "SUPER_ADMIN" },
      ],
    },
    $transaction: async (fn: (tx: any) => Promise<unknown>) => fn(tx),
  }
  const recordOutbox = async (_tx: any, input: CommunicationEventInput) => {
    recorded.push(input)
    return { eventId: `comm-${recorded.length}`, deliveryIds: [] }
  }
  return { prisma, recorded, createdEvents, recordOutbox }
}

test("nudges ESCALATED cases to Operations + Super Admin on the first due bucket", async () => {
  const { prisma, recorded, recordOutbox } = harness([stalledCase()])
  const result = await nudgeStaleCancellationCases(prisma, NOW, CONFIG, {
    recordOutbox,
  })

  assert.equal(result.staleScanned, 1)
  assert.equal(result.nudged, 1)
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].type, "STAFF_RECONCILIATION_ALERT")
  assert.equal(recorded[0].actionPath, "/dashboard/cancellations")
  assert.deepEqual(recorded[0].recipientUserIds, ["staff-1", "staff-2"])
  assert.ok(recorded[0].dedupKey === "staff:cancellation-case:req-1:stall:3")
})

test("routes PENDING_FINANCE nudges to Finance + Super Admin", async () => {
  const { prisma, recorded, recordOutbox } = harness([
    stalledCase({
      id: "req-fin",
      status: "PENDING_FINANCE",
      updatedAt: new Date("2026-08-14T12:00:00.000Z"),
    }),
  ])
  const result = await nudgeStaleCancellationCases(prisma, NOW, CONFIG, {
    recordOutbox,
  })

  assert.equal(result.nudged, 1)
  assert.match(recorded[0].message, /Finance approval/)
  assert.equal(recorded[0].dedupKey, "staff:cancellation-case:req-fin:stall:10")
})

test("skips cases younger than the first reminder day and off-bucket ages", async () => {
  const { prisma, recorded, recordOutbox } = harness([
    stalledCase({
      id: "young",
      updatedAt: new Date("2026-08-23T00:00:00.000Z"),
    }),
    stalledCase({
      id: "offbucket",
      updatedAt: new Date("2026-08-19T00:00:00.000Z"),
    }),
  ])
  const result = await nudgeStaleCancellationCases(prisma, NOW, CONFIG, {
    recordOutbox,
  })

  assert.equal(result.staleScanned, 2)
  assert.equal(result.nudged, 0)
  assert.equal(recorded.length, 0)
})

test("is idempotent per day bucket via the existing order-event trail", async () => {
  const { prisma, recorded, recordOutbox } = harness([stalledCase()])
  const withExisting = {
    ...prisma,
    orderEvent: {
      findMany: async () => [
        { orderId: "order-1", metadata: { stalledDays: 3 } },
      ],
    },
    $transaction: async (fn: (tx: any) => Promise<unknown>) =>
      fn({
        ...harness([]).prisma.$transaction,
        orderEvent: {
          create: async () => {
            throw new Error("must not create duplicate trail")
          },
        },
      } as any),
  }

  const result = await nudgeStaleCancellationCases(withExisting, NOW, CONFIG, {
    recordOutbox,
  })
  assert.equal(result.staleScanned, 1)
  assert.equal(result.nudged, 0)
  assert.equal(recorded.length, 0)
})

test("continues past failing cases without losing the rest", async () => {
  const recorded: CommunicationEventInput[] = []
  const recordOutbox = async (_tx: any, input: CommunicationEventInput) => {
    recorded.push(input)
    return { eventId: `comm-${recorded.length}`, deliveryIds: [] }
  }
  const prisma = {
    orderCancellationRequest: {
      findMany: async () => [
        stalledCase({ id: "bad" }),
        stalledCase({ id: "good", orderId: "order-2" }),
      ],
    },
    orderEvent: { findMany: async () => [] },
    staffMembership: {
      findMany: async () => [{ userId: "staff-1", role: "SUPER_ADMIN" }],
    },
    $transaction: async () => {
      throw new Error("boom")
    },
  }

  let failures = 0
  const result = await nudgeStaleCancellationCases(prisma, NOW, CONFIG, {
    recordOutbox,
    onError: () => {
      failures++
    },
  })

  assert.equal(failures, 2)
  assert.equal(result.staleScanned, 2)
  assert.equal(result.nudged, 0)
  assert.equal(recorded.length, 0)
})

test("does not consume the reminder bucket when no eligible staff exist", async () => {
  const base = harness([stalledCase()])
  const createdEvents: any[] = []
  const prisma = {
    ...base.prisma,
    staffMembership: { findMany: async () => [] },
    $transaction: async (fn: (tx: any) => Promise<unknown>) =>
      fn({
        orderEvent: {
          create: async ({ data }: { data: any }) => {
            createdEvents.push(data)
            return { id: "trail-1" }
          },
        },
      } as any),
  }

  const result = await nudgeStaleCancellationCases(prisma, NOW, CONFIG, {
    recordOutbox: base.recordOutbox,
  })

  assert.equal(createdEvents.length, 0)
  assert.equal(base.recorded.length, 0)
  assert.equal(result.nudged, 0)
})

test("paginates beyond old off-bucket cases so later due cases are not starved", async () => {
  const cases = [
    stalledCase({
      id: "offbucket-20",
      updatedAt: new Date("2026-08-04T12:00:00.000Z"),
    }),
    stalledCase({
      id: "offbucket-19",
      updatedAt: new Date("2026-08-05T12:00:00.000Z"),
    }),
    stalledCase({
      id: "due-17",
      orderId: "order-due",
      updatedAt: new Date("2026-08-07T12:00:00.000Z"),
    }),
  ]
  const base = harness(cases)
  const queries: any[] = []
  const prisma = {
    ...base.prisma,
    orderCancellationRequest: {
      findMany: async (args: any) => {
        queries.push(args)
        const start = queries.length === 1 ? 0 : 2
        return cases.slice(start, start + args.take)
      },
    },
  }

  const result = await nudgeStaleCancellationCases(prisma, NOW, CONFIG, {
    take: 2,
    recordOutbox: base.recordOutbox,
  })

  assert.equal(queries.length, 2)
  assert.deepEqual(queries[1].where.AND[1], {
    OR: [
      { updatedAt: { gt: new Date("2026-08-05T12:00:00.000Z") } },
      {
        updatedAt: new Date("2026-08-05T12:00:00.000Z"),
        id: { gt: "offbucket-19" },
      },
    ],
  })
  assert.equal(result.staleScanned, 3)
  assert.equal(result.nudged, 1)
  assert.equal(result.nextCursor, null)
  assert.equal(
    base.recorded[0].dedupKey,
    "staff:cancellation-case:due-17:stall:17",
  )
})

test("returns a stable cursor when the scan cap is reached", async () => {
  const cases = [
    stalledCase({
      id: "due-17-a",
      orderId: "order-a",
      updatedAt: new Date("2026-08-07T12:00:00.000Z"),
    }),
    stalledCase({
      id: "due-17-b",
      orderId: "order-b",
      updatedAt: new Date("2026-08-07T12:00:00.000Z"),
    }),
  ]
  const base = harness(cases)

  const result = await nudgeStaleCancellationCases(base.prisma, NOW, CONFIG, {
    take: 2,
    maxScan: 2,
    recordOutbox: base.recordOutbox,
  })

  assert.deepEqual(result.nextCursor, {
    updatedAt: "2026-08-07T12:00:00.000Z",
    id: "due-17-b",
  })
})

test("starts after a saved cross-run cursor", async () => {
  const laterCase = stalledCase({
    id: "due-10",
    orderId: "order-later",
    status: "PENDING_FINANCE",
    updatedAt: new Date("2026-08-14T12:00:00.000Z"),
  })
  const base = harness([laterCase])
  let query: any
  const prisma = {
    ...base.prisma,
    orderCancellationRequest: {
      findMany: async (args: any) => {
        query = args
        return [laterCase]
      },
    },
  }

  const result = await nudgeStaleCancellationCases(prisma, NOW, CONFIG, {
    startAfter: {
      updatedAt: "2026-08-07T12:00:00.000Z",
      id: "due-17-b",
    },
    recordOutbox: base.recordOutbox,
  })

  assert.deepEqual(query.where.AND[1], {
    OR: [
      { updatedAt: { gt: new Date("2026-08-07T12:00:00.000Z") } },
      {
        updatedAt: new Date("2026-08-07T12:00:00.000Z"),
        id: { gt: "due-17-b" },
      },
    ],
  })
  assert.equal(result.nudged, 1)
  assert.equal(result.nextCursor, null)
})
