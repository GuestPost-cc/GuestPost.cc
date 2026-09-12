import type { Prisma } from "@guestpost/database"

const DAY_MS = 86_400_000

/**
 * Select only reminder buckets that have not already produced their durable
 * order-event marker. Applying this before `take` lets later orders advance
 * through a bounded sweep instead of repeatedly selecting the same prefix.
 */
export function buildReviewReminderWhere(
  now: Date,
  reminderDays: readonly number[],
): Prisma.OrderWhereInput {
  return {
    status: "VERIFIED",
    OR: reminderDays.map((day) => ({
      autoAcceptAt: {
        gte: new Date(now.getTime() + day * DAY_MS),
        lt: new Date(now.getTime() + (day + 1) * DAY_MS),
      },
      events: {
        none: {
          eventType: "REVIEW_REMINDER",
          metadata: { path: ["day"], equals: day },
        },
      },
    })),
  }
}
