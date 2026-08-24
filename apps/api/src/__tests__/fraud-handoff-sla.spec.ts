// Fraud-handoff SLA regression spec.
//
// ensureFraudCancellationHandoff previously created ESCALATED cancellation
// requests with responseDeadlineAt: null, which made confirmed-fraud cases
// permanently invisible to every deadline-driven surface (workbench CRITICAL
// flags, command-center overdue routing). It now stamps a configured review
// deadline so the existing SLA machinery applies from creation.

import { DeliveryInterventionService } from "../modules/orders/services/delivery-intervention.service"

function makeService() {
  const prisma = {}
  const audit = { log: jest.fn().mockResolvedValue({}) }
  const queue = { enqueueTrustRecompute: jest.fn().mockResolvedValue({}) }
  const communications = {
    customerOrderRecipients: jest.fn().mockResolvedValue([]),
    publisherRecipients: jest.fn().mockResolvedValue([]),
    record: jest.fn().mockResolvedValue({ eventId: "comm-1" }),
  }
  return new DeliveryInterventionService(
    prisma as any,
    audit as any,
    queue as any,
    communications as any,
  )
}

function makeTx() {
  const created: any[] = []
  return {
    created,
    orderCancellationRequest: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: { data: any }) => {
        created.push(data)
        return { id: "req-1", ...data }
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    deliveryFraudFlag: { findUnique: jest.fn().mockResolvedValue(null) },
  }
}

const ORDER = {
  id: "order-1",
  organizationId: "org-1",
  status: "DELIVERED",
  fulfillmentChannel: "PUBLISHER",
  website: { ownershipType: "PUBLISHER", publisherId: "pub-1" },
}

describe("ensureFraudCancellationHandoff SLA clock", () => {
  it("creates the ESCALATED case with a configured non-null review deadline", async () => {
    const service = makeService()
    const tx = makeTx()
    const before = Date.now()

    const result = await (service as any).ensureFraudCancellationHandoff(tx, {
      order: ORDER,
      fraudFlagId: "flag-1",
      actorUserId: "staff-1",
      role: "SUPER_ADMIN",
    })

    expect(result.created).toBe(true)
    expect(result.request.status).toBe("ESCALATED")
    expect(tx.orderCancellationRequest.create).toHaveBeenCalledTimes(1)

    const data = tx.created[0]
    expect(data.status).toBe("ESCALATED")
    expect(data.responseDeadlineAt).toBeInstanceOf(Date)

    const expectedLow = before + 47.5 * 3_600_000
    const expectedHigh = before + 48.5 * 3_600_000
    expect(data.responseDeadlineAt.getTime()).toBeGreaterThanOrEqual(
      expectedLow,
    )
    expect(data.responseDeadlineAt.getTime()).toBeLessThanOrEqual(expectedHigh)
  })

  it("escalates an existing REQUESTED case without rewriting its original deadline", async () => {
    const service = makeService()
    const tx = makeTx()
    tx.orderCancellationRequest.findFirst.mockResolvedValue({
      id: "req-existing",
      orderId: ORDER.id,
      status: "REQUESTED",
      responseDeadlineAt: new Date("2026-08-01T00:00:00.000Z"),
    })

    const result = await (service as any).ensureFraudCancellationHandoff(tx, {
      order: ORDER,
      fraudFlagId: "flag-2",
      actorUserId: "staff-1",
      role: "SUPER_ADMIN",
    })

    expect(result.created).toBe(false)
    expect(result.escalated).toBe(true)
    expect(result.request.status).toBe("ESCALATED")
    expect(tx.orderCancellationRequest.updateMany).toHaveBeenCalledWith({
      where: { id: "req-existing", orderId: ORDER.id, status: "REQUESTED" },
      data: { status: "ESCALATED" },
    })
    expect(tx.orderCancellationRequest.create).not.toHaveBeenCalled()
  })
})
