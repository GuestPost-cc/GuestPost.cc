import { ConflictException } from "@nestjs/common"
import {
  ORDER_TRANSITION_CONFLICT_MESSAGE,
  transitionOrderCas,
} from "../order-transition-cas"

describe("transitionOrderCas", () => {
  const submittedAt = new Date("2026-08-12T00:00:00.000Z")

  it.each([
    {
      label: "lifecycle state",
      fromStatus: "CONTENT_READY" as const,
      toStatus: "CUSTOMER_REVIEW" as const,
      fromPaymentStatus: undefined,
      toPaymentStatus: undefined,
      patch: undefined,
      expectedWhere: {
        id: "order-1",
        version: 7,
        status: "CONTENT_READY",
      },
      expectedData: {
        status: "CUSTOMER_REVIEW",
        version: { increment: 1 },
      },
    },
    {
      label: "lifecycle and payment states",
      fromStatus: "DRAFT" as const,
      toStatus: "SUBMITTED" as const,
      fromPaymentStatus: "PENDING" as const,
      toPaymentStatus: "PAID" as const,
      patch: { submittedAt },
      expectedWhere: {
        id: "order-1",
        version: 7,
        status: "DRAFT",
        paymentStatus: "PENDING",
      },
      expectedData: {
        submittedAt,
        status: "SUBMITTED",
        paymentStatus: "PAID",
        version: { increment: 1 },
      },
    },
    {
      label: "lifecycle patch",
      fromStatus: "SUBMITTED" as const,
      toStatus: "ACCEPTED" as const,
      fromPaymentStatus: undefined,
      toPaymentStatus: undefined,
      patch: { assigneeId: "publisher-user-1" },
      expectedWhere: { id: "order-1", version: 7, status: "SUBMITTED" },
      expectedData: {
        assigneeId: "publisher-user-1",
        status: "ACCEPTED",
        version: { increment: 1 },
      },
    },
  ])("guards $label and owns one version increment", async (testCase) => {
    const committed = { id: "order-1", version: 8, status: "SUBMITTED" }
    const db = {
      order: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(committed),
      },
    }

    await expect(
      transitionOrderCas({
        db: db as any,
        orderId: "order-1",
        expectedVersion: 7,
        fromStatus: testCase.fromStatus,
        toStatus: testCase.toStatus,
        fromPaymentStatus: testCase.fromPaymentStatus,
        toPaymentStatus: testCase.toPaymentStatus,
        patch: testCase.patch,
      } as any),
    ).resolves.toBe(committed)

    expect(db.order.updateMany).toHaveBeenCalledWith({
      where: testCase.expectedWhere,
      data: testCase.expectedData,
    })
    expect(db.order.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: "order-1" },
    })
  })

  it.each([
    0, 2,
  ])("fails closed when the CAS affects %i rows", async (count) => {
    const db = {
      order: {
        updateMany: jest.fn().mockResolvedValue({ count }),
        findUniqueOrThrow: jest.fn(),
      },
    }

    await expect(
      transitionOrderCas({
        db: db as any,
        orderId: "order-1",
        expectedVersion: 7,
        fromStatus: "DRAFT",
        toStatus: "SUBMITTED",
      }),
    ).rejects.toEqual(new ConflictException(ORDER_TRANSITION_CONFLICT_MESSAGE))
    expect(db.order.findUniqueOrThrow).not.toHaveBeenCalled()
  })

  it("allows exactly one winner when two commands race on the same version", async () => {
    let claimed = false
    const db = {
      order: {
        updateMany: jest.fn().mockImplementation(async () => {
          if (claimed) return { count: 0 }
          claimed = true
          return { count: 1 }
        }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: "order-1",
          version: 8,
          status: "SUBMITTED",
        }),
      },
    }
    const command = () =>
      transitionOrderCas({
        db: db as any,
        orderId: "order-1",
        expectedVersion: 7,
        fromStatus: "DRAFT",
        toStatus: "SUBMITTED",
      })

    const results = await Promise.allSettled([command(), command()])

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1)
    const rejected = results.find((result) => result.status === "rejected")
    expect(rejected).toMatchObject({ reason: expect.any(ConflictException) })
    expect(db.order.findUniqueOrThrow).toHaveBeenCalledTimes(1)
  })
})
