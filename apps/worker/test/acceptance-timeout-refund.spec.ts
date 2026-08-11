import assert from "node:assert/strict"
import test from "node:test"
import {
  type CommunicationEventInput,
  expectedFinancialDocumentKind,
} from "@guestpost/shared"
import {
  AcceptanceTimeoutRefundEvidenceError,
  processAcceptanceTimeoutOrderInTransaction,
} from "../src/lib/acceptance-timeout-refund"

function refundedOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-1",
    organizationId: "customer-org",
    customerId: "customer-user",
    status: "REFUNDED",
    paymentStatus: "REFUNDED",
    refundResponsibility: "PUBLISHER",
    fulfillmentChannel: "PUBLISHER",
    type: "GUEST_POST",
    currency: "USD",
    amount: "125.00",
    version: 2,
    website: {
      ownershipType: "PUBLISHER",
      publisherId: "publisher-1",
    },
    organization: {
      id: "customer-org",
      name: "Customer Org",
      billingProfile: null,
    },
    ...overrides,
  }
}

function replayHarness(order = refundedOrder()) {
  const recorded: CommunicationEventInput[] = []
  const tx = {
    order: {
      findUnique: async () => order,
      updateMany: async () => {
        throw new Error("replay must not refund twice")
      },
    },
    transaction: {
      findUnique: async () => ({
        id: "refund-ledger-1",
        type: "REFUND",
        orderId: order.id,
        reference: `acceptance-timeout:${order.id}`,
        walletId: "wallet-1",
        amount: order.amount,
        currency: order.currency,
        wallet: {
          organizationId: order.organizationId,
          currency: order.currency,
        },
      }),
    },
    membership: {
      findMany: async () => [{ userId: "customer-owner" }],
    },
    orderEvent: {
      findFirst: async () => ({
        orderId: order.id,
        eventType: "REFUND_ISSUED",
        metadata: { refundTransactionId: "refund-ledger-1" },
      }),
    },
    publisher: {
      findUnique: async () => ({
        organizationId: "publisher-org",
        publisherMemberships: [{ userId: "publisher-user" }],
      }),
    },
    staffMembership: { findMany: async () => [] },
    communicationDelivery: {
      count: async () => 1,
      updateMany: async (args: any) => {
        tx.suppressionQueries.push(args)
        return { count: 1 }
      },
    },
    notification: {
      deleteMany: async (args: any) => {
        tx.notificationCleanupQueries.push(args)
        return { count: 1 }
      },
    },
    communicationEvent: {
      updateMany: async (args: any) => {
        tx.eventStatusQueries.push(args)
        return { count: 1 }
      },
    },
    suppressionQueries: [] as any[],
    notificationCleanupQueries: [] as any[],
    eventStatusQueries: [] as any[],
  }
  const recordOutbox = async (_tx: any, input: CommunicationEventInput) => {
    recorded.push(input)
    return { eventId: `event-${recorded.length}`, deliveryIds: [] }
  }
  return { tx, recorded, recordOutbox }
}

test("repair replay keeps the credit note customer-only and gives the publisher a non-financial notice", async () => {
  const { tx, recorded, recordOutbox } = replayHarness()

  const result = await processAcceptanceTimeoutOrderInTransaction(
    tx,
    {
      orderId: "order-1",
      acceptanceHours: 24,
      highValueThreshold: 1_000,
    },
    recordOutbox,
  )

  assert.equal(result.didRefund, false)
  assert.equal(result.refundTransactionId, "refund-ledger-1")
  assert.deepEqual(result.communicationEventIds, ["event-1", "event-2"])
  const refund = recorded.find((event) => event.type === "ORDER_REFUNDED")
  const publisher = recorded.find((event) => event.type === "ORDER_CANCELLED")
  assert.ok(refund)
  assert.ok(publisher)
  assert.deepEqual(refund.recipientUserIds, ["customer-user", "customer-owner"])
  assert.equal(refund.recipientUserIds.includes("publisher-user"), false)
  assert.deepEqual(refund.payload, {
    amount: "125.00",
    currency: "USD",
    responsibility: "PUBLISHER",
    refundTransactionId: "refund-ledger-1",
  })
  assert.deepEqual(publisher.recipientUserIds, ["publisher-user"])
  assert.equal(publisher.organizationId, "publisher-org")
  assert.equal("amount" in (publisher.payload as object), false)
  assert.equal("refundTransactionId" in (publisher.payload as object), false)
  assert.equal(expectedFinancialDocumentKind(refund.type), "CREDIT_NOTE")
  assert.equal(expectedFinancialDocumentKind(publisher.type), null)
  assert.equal(tx.suppressionQueries.length, 1)
  assert.deepEqual(tx.suppressionQueries[0].where.OR, [
    { userId: null },
    {
      userId: { notIn: ["customer-user", "customer-owner"] },
    },
  ])
  assert.equal(tx.notificationCleanupQueries.length, 1)
  assert.equal(tx.eventStatusQueries.length, 1)
})

test("whole-dollar amounts ending in zero remain exact in refund and staff payloads", async () => {
  const { tx, recorded, recordOutbox } = replayHarness(
    refundedOrder({ amount: "120.00" }),
  )
  tx.staffMembership.findMany = async () => [{ userId: "finance-user" }]

  await processAcceptanceTimeoutOrderInTransaction(
    tx,
    {
      orderId: "order-1",
      acceptanceHours: 24,
      highValueThreshold: 100,
    },
    recordOutbox,
  )

  const refund = recorded.find((event) => event.type === "ORDER_REFUNDED")
  const staff = recorded.find(
    (event) => event.type === "STAFF_HIGH_VALUE_REFUND",
  )
  assert.equal((refund?.payload as Record<string, unknown>).amount, "120.00")
  assert.equal((staff?.payload as Record<string, unknown>).amount, "120.00")
})

test("repair replay fails closed on cross-tenant refund ledger evidence", async () => {
  const { tx, recorded, recordOutbox } = replayHarness()
  tx.transaction.findUnique = async () => ({
    id: "refund-ledger-1",
    type: "REFUND",
    orderId: "order-1",
    reference: "acceptance-timeout:order-1",
    walletId: "publisher-wallet",
    amount: "125.00",
    currency: "USD",
    wallet: { organizationId: "publisher-org", currency: "USD" },
  })

  await assert.rejects(
    processAcceptanceTimeoutOrderInTransaction(
      tx,
      {
        orderId: "order-1",
        acceptanceHours: 24,
        highValueThreshold: 1_000,
      },
      recordOutbox,
    ),
    AcceptanceTimeoutRefundEvidenceError,
  )
  assert.equal(recorded.length, 0)
})

test("repair replay fails closed on missing or mismatched REFUND_ISSUED evidence", async () => {
  for (const refundEvent of [
    null,
    {
      orderId: "order-1",
      eventType: "REFUND_ISSUED",
      metadata: { refundTransactionId: "another-refund" },
    },
  ]) {
    const { tx, recorded, recordOutbox } = replayHarness()
    tx.orderEvent.findFirst = async () => refundEvent

    await assert.rejects(
      processAcceptanceTimeoutOrderInTransaction(
        tx,
        {
          orderId: "order-1",
          acceptanceHours: 24,
          highValueThreshold: 1_000,
        },
        recordOutbox,
      ),
      AcceptanceTimeoutRefundEvidenceError,
    )
    assert.equal(recorded.length, 0)
  }
})

test("new timeout refund binds every financial projection to the committed ledger ID", async () => {
  const order = refundedOrder({
    status: "SUBMITTED",
    paymentStatus: "PAID",
    refundResponsibility: null,
    version: 1,
  })
  const { tx, recorded, recordOutbox } = replayHarness(order)
  tx.transaction.findUnique = async () => null
  Object.assign(tx.transaction, {
    create: async () => ({ id: "refund-ledger-new" }),
  })
  Object.assign(tx.order, {
    updateMany: async () => ({ count: 1 }),
    findUniqueOrThrow: async () =>
      refundedOrder({
        refundResponsibility: "PUBLISHER",
        version: 2,
        website: undefined,
      }),
  })
  Object.assign(tx, {
    wallet: {
      findUnique: async () => ({
        id: "wallet-1",
        organizationId: "customer-org",
        currency: "USD",
        version: 1,
      }),
      updateMany: async () => ({ count: 1 }),
    },
    fulfillmentAssignment: { updateMany: async () => ({ count: 0 }) },
    orderCancellationRequest: { findFirst: async () => null },
    orderEvent: { create: async () => ({}) },
    auditLog: { create: async () => ({}) },
  })

  const result = await processAcceptanceTimeoutOrderInTransaction(
    tx,
    {
      orderId: "order-1",
      acceptanceHours: 24,
      highValueThreshold: 1_000,
    },
    recordOutbox,
  )

  assert.equal(result.didRefund, true)
  assert.equal(result.refundTransactionId, "refund-ledger-new")
  const refund = recorded.find((event) => event.type === "ORDER_REFUNDED")
  assert.equal(
    (refund?.payload as Record<string, unknown>).refundTransactionId,
    "refund-ledger-new",
  )
})

function legacySnapshot() {
  return {
    schemaVersion: 1,
    environment: "NON_PRODUCTION",
    issuer: {
      legalName: "GuestPost LLC",
      addressLine1: "1 Platform Road",
      city: "Dhaka",
      postalCode: "1200",
      countryCode: "BD",
    },
    recipient: { legalName: "Customer Org" },
    lineItems: [
      {
        description: "Refund - Guest Post service",
        quantity: 1,
        unitAmount: "125.00",
        lineTotal: "125.00",
      },
    ],
    payment: {
      status: "REFUNDED",
      method: "GuestPost.cc wallet",
      reference: "Order order-1",
    },
    tax: {
      label: "Tax",
      treatment: "NOT_SEPARATELY_CHARGED",
      note: "No tax was separately charged on this document.",
    },
    relatedDocumentNumber: null,
    notes: [],
  }
}

function legacyReplayHarness(documentOverrides: Record<string, unknown> = {}) {
  const base = replayHarness()
  const legacyEvent = {
    id: "legacy-refund-event",
    type: "ORDER_REFUNDED",
    category: "BILLING",
    severity: "WARNING",
    aggregateType: "Order",
    aggregateId: "order-1",
    organizationId: "customer-org",
    title: "Order refund completed",
    message:
      "125.00 USD was returned to the customer wallet because order order-1 was not accepted in time.",
    actionPath: "/dashboard/orders/order-1",
    payload: {
      amount: 125,
      currency: "USD",
      financialDocumentId: "legacy-credit-note",
    },
  }
  const events = new Map([["order:order-1:refunded", legacyEvent]])
  Object.assign(base.tx, {
    $queryRaw: async (_query: unknown, identity: string) => {
      const event =
        events.get(identity) ??
        [...events.values()].find((candidate) => candidate.id === identity)
      return event ? [{ id: event.id }] : []
    },
    communicationEvent: {
      findUnique: async (args: any) => events.get(args.where.dedupKey) ?? null,
      updateMany: async () => ({ count: 1 }),
    },
    financialDocument: {
      findUnique: async () => ({
        id: "legacy-credit-note",
        kind: "CREDIT_NOTE",
        aggregateType: "Order",
        aggregateId: "order-1",
        organizationId: "customer-org",
        relatedDocumentId: null,
        relatedDocument: null,
        currency: "USD",
        subtotal: "125.00",
        taxAmount: "0.00",
        total: "125.00",
        dedupKey: "financial-document:order:order-1:refunded",
        snapshot: legacySnapshot(),
        ...documentOverrides,
      }),
    },
    user: {
      findMany: async () => [
        {
          id: "customer-user",
          email: "customer@example.com",
          emailVerified: true,
          banned: false,
          notificationPreferences: [],
          emailSuppressions: [],
        },
        {
          id: "customer-owner",
          email: "owner@example.com",
          emailVerified: true,
          banned: false,
          notificationPreferences: [],
          emailSuppressions: [],
        },
      ],
    },
  })
  Object.assign(base.tx.notification, {
    upsert: async () => ({}),
  })
  Object.assign(base.tx.communicationDelivery, {
    count: async (args: any) => (args.where.channel === "EMAIL" ? 1 : 2),
    upsert: async (args: any) => ({
      id: `delivery-${args.create.userId}`,
      status: args.create.status,
    }),
  })
  return { ...base, legacyEvent, events }
}

test("origin/main legacy credit note is preserved while its combined audience is repaired before publisher notice", async () => {
  const { tx, recorded, recordOutbox, legacyEvent } = legacyReplayHarness()

  const result = await processAcceptanceTimeoutOrderInTransaction(
    tx,
    {
      orderId: "order-1",
      acceptanceHours: 24,
      highValueThreshold: 1_000,
    },
    recordOutbox,
  )

  assert.equal(result.didRefund, false)
  assert.equal(result.legacyUnauthorizedTerminalDeliveryCount, 1)
  assert.deepEqual(result.communicationEventIds, [legacyEvent.id, "event-1"])
  assert.equal(
    recorded.some((event) => event.type === "ORDER_REFUNDED"),
    false,
  )
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0]?.type, "ORDER_CANCELLED")
  assert.deepEqual(recorded[0]?.recipientUserIds, ["publisher-user"])
  assert.equal(tx.suppressionQueries.length, 1)
  assert.deepEqual(tx.suppressionQueries[0].where.OR, [
    { userId: null },
    { userId: { notIn: ["customer-user", "customer-owner"] } },
  ])
})

test("legacy replay trusts the immutable recipient snapshot after a billing-profile edit", async () => {
  const order = refundedOrder({
    organization: {
      id: "customer-org",
      name: "Renamed Customer Org",
      billingProfile: {
        legalName: "New Legal Name",
        billingEmail: "new-billing@example.com",
        addressLine1: "99 New Street",
        city: "Chattogram",
        postalCode: "4000",
        countryCode: "BD",
      },
    },
  })
  const base = legacyReplayHarness()
  base.tx.order.findUnique = async () => order

  const result = await processAcceptanceTimeoutOrderInTransaction(
    base.tx,
    {
      orderId: "order-1",
      acceptanceHours: 24,
      highValueThreshold: 1_000,
    },
    base.recordOutbox,
  )

  assert.equal(result.refundTransactionId, "refund-ledger-1")
  assert.equal(
    base.recorded.some((event) => event.type === "ORDER_REFUNDED"),
    false,
  )
})

test("legacy replay preserves an exact numeric staff event without creating new numeric payloads", async () => {
  const base = legacyReplayHarness()
  const legacyStaffEvent = {
    id: "legacy-high-value-refund-event",
    type: "STAFF_HIGH_VALUE_REFUND",
    category: "STAFF_ALERTS",
    severity: "WARNING",
    aggregateType: "Order",
    aggregateId: "order-1",
    organizationId: "customer-org",
    title: "High-value automatic refund",
    message: "125.00 USD was refunded for unaccepted order order-1.",
    actionPath: "/dashboard/orders/order-1",
    payload: { amount: 125, currency: "USD" },
  }
  base.events.set(
    "staff:order:order-1:high-value-refund",
    legacyStaffEvent as typeof base.legacyEvent,
  )

  const result = await processAcceptanceTimeoutOrderInTransaction(
    base.tx,
    {
      orderId: "order-1",
      acceptanceHours: 24,
      highValueThreshold: 100,
    },
    base.recordOutbox,
  )

  assert.deepEqual(result.communicationEventIds, [
    base.legacyEvent.id,
    "event-1",
    legacyStaffEvent.id,
  ])
  assert.deepEqual(
    base.recorded.map((event) => event.type),
    ["ORDER_CANCELLED"],
  )
})

test("legacy replay fails before audience mutation when the immutable credit note is cross-tenant", async () => {
  const { tx, recordOutbox } = legacyReplayHarness({
    organizationId: "publisher-org",
  })

  await assert.rejects(
    processAcceptanceTimeoutOrderInTransaction(
      tx,
      {
        orderId: "order-1",
        acceptanceHours: 24,
        highValueThreshold: 1_000,
      },
      recordOutbox,
    ),
    AcceptanceTimeoutRefundEvidenceError,
  )
  assert.equal(tx.suppressionQueries.length, 0)
  assert.equal(tx.notificationCleanupQueries.length, 0)
})
