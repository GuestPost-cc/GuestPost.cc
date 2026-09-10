import assert from "node:assert/strict"
import test from "node:test"
import { buildReviewReminderWhere } from "../src/lib/review-reminder-query"

test("excludes an existing reminder in each deadline bucket before applying a limit", () => {
  const now = new Date("2026-09-10T12:00:00.000Z")
  const where = buildReviewReminderWhere(now, [3, 1])

  assert.equal(where.status, "VERIFIED")
  assert.deepEqual(where.OR, [
    {
      autoAcceptAt: {
        gte: new Date("2026-09-13T12:00:00.000Z"),
        lt: new Date("2026-09-14T12:00:00.000Z"),
      },
      events: {
        none: {
          eventType: "REVIEW_REMINDER",
          metadata: { path: ["day"], equals: 3 },
        },
      },
    },
    {
      autoAcceptAt: {
        gte: new Date("2026-09-11T12:00:00.000Z"),
        lt: new Date("2026-09-12T12:00:00.000Z"),
      },
      events: {
        none: {
          eventType: "REVIEW_REMINDER",
          metadata: { path: ["day"], equals: 1 },
        },
      },
    },
  ])
})
