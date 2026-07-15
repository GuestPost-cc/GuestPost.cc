/**
 * Regression tests for the 2026-06-11 pre-beta audit findings.
 *
 * F-1: Stripe deposit webhook double-credit race — a P2002 on the ledger
 *      insert must ABORT the transaction (wallet increment rolls back).
 * F-2: payout webhook normalization — real Wise/Stripe payload shapes map
 *      through the same status maps as the poller.
 * F-3: order idempotency replay is tenant-scoped.
 * F-4: FAILED withdrawals are reversible exactly once, never when money
 *      may have moved at the provider.
 * F-5: customerApprove cannot overwrite a RELEASED settlement.
 * F-6: chargebacks place a spend-blocking hold; closed disputes release or
 *      debit it idempotently.
 */

import { normalizeProviderWebhook } from "@guestpost/shared"
import { BadRequestException, ConflictException } from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/client"
import { OrdersService } from "../../orders/orders.service"
import { PublisherPayoutsService } from "../../publisher-payouts/publisher-payouts.service"
import { SettlementsService } from "../../settlements/settlements.service"
import { BillingService } from "../billing.service"

function makePrismaMock() {
  const tables = [
    "wallet",
    "transaction",
    "order",
    "orderItem",
    "orderEvent",
    "settlement",
    "settlementApproval",
    "publisherBalance",
    "withdrawal",
    "payoutExecution",
    "publisher",
    "publisherMembership",
    "staffMembership",
    "notification",
    "orderDispute",
    "auditLog",
    "marketplaceListing",
    "service",
    // Phase 6 — production orders.service.ts calls tx.listingService.findUnique
    // on the snapshot path; F-3 needs this model to be on the mock.
    "listingService",
  ]
  const mock: any = {}
  for (const t of tables) {
    mock[t] = {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      upsert: jest.fn().mockResolvedValue({}),
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    }
  }
  // Tracks whether the interactive transaction COMMITTED (callback resolved)
  // or ROLLED BACK (callback rejected) — the heart of the F-1/F-6 assertions.
  mock.__committed = null
  mock.$transaction = jest.fn().mockImplementation(async (cb: any) => {
    try {
      const result = await cb(mock)
      mock.__committed = true
      return result
    } catch (err) {
      mock.__committed = false
      throw err
    }
  })
  return mock
}

const auditMock = () => ({ log: jest.fn().mockResolvedValue(undefined) })
const queueMock = () => ({
  addJob: jest.fn().mockResolvedValue({ id: "job-1" }),
})

// ─────────────────────────────────────────────────────────────────────────────
describe("F-1: deposit webhook double-credit race", () => {
  let service: BillingService
  let prisma: any
  let audit: any

  beforeEach(() => {
    prisma = makePrismaMock()
    audit = auditMock()
    service = new BillingService(prisma, audit as any)
  })

  const session = {
    id: "cs_test_123",
    amount_total: 25050, // $250.50
    payment_intent: "pi_test_456",
    metadata: {
      walletId: "wallet-1",
      organizationId: "org-1",
      userId: "user-1",
    },
  }

  it("commits exactly one wallet increment with the ledger row (happy path)", async () => {
    prisma.transaction.findFirst.mockResolvedValue(null)
    prisma.wallet.findUniqueOrThrow.mockResolvedValue({
      id: "wallet-1",
      version: 3,
    })

    await (service as any).processSuccessfulPayment(session)

    expect(prisma.__committed).toBe(true)
    expect(prisma.wallet.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "wallet-1", version: 3 },
      }),
    )
    // Ledger row carries the payment_intent linkage for chargeback lookup (F-6).
    // FIN-02 regression guard: `provider: "stripe"` MUST be set so the row
    // participates in the provider-aware partial unique index
    // `(provider, providerRef) WHERE providerRef IS NOT NULL` (migration
    // 20260716030403). Without it, a replayed webhook with a new session.id
    // but the same payment_intent bypasses the constraint (NULL=NULL is
    // treated as distinct by PostgreSQL unique indexes).
    expect(prisma.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        reference: "cs_test_123",
        provider: "stripe",
        providerRef: "pi_test_456",
        type: "DEPOSIT",
      }),
    })
  })

  it("ROLLS BACK the wallet increment when the ledger insert hits P2002 (duplicate race)", async () => {
    prisma.transaction.findFirst.mockResolvedValue(null) // fast path passes — race window
    prisma.wallet.findUniqueOrThrow.mockResolvedValue({
      id: "wallet-1",
      version: 3,
    })
    prisma.transaction.create.mockRejectedValue(
      Object.assign(new Error("unique"), { code: "P2002" }),
    )

    // Service swallows the duplicate (webhook returns 200 so Stripe stops retrying)…
    await expect(
      (service as any).processSuccessfulPayment(session),
    ).resolves.toBeUndefined()

    // …but the transaction itself must have ABORTED: the previous behavior
    // caught P2002 inside the callback and returned, committing the wallet
    // increment without a ledger row.
    expect(prisma.__committed).toBe(false)
  })

  it("rolls back when the fast-path dedupe finds an existing ledger row", async () => {
    prisma.transaction.findFirst.mockResolvedValue({
      id: "t-1",
      reference: "cs_test_123",
    })

    await expect(
      (service as any).processSuccessfulPayment(session),
    ).resolves.toBeUndefined()
    expect(prisma.__committed).toBe(false)
    expect(prisma.wallet.updateMany).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("F-6: chargeback hold workflow", () => {
  let service: BillingService
  let prisma: any
  let audit: any

  const dispute = {
    id: "dp_1",
    charge: "ch_1",
    payment_intent: "pi_test_456",
    amount: 60000, // $600
    currency: "usd",
    reason: "fraudulent",
    status: "needs_response",
  }

  beforeEach(() => {
    prisma = makePrismaMock()
    audit = auditMock()
    service = new BillingService(prisma, audit as any)
  })

  it("places a hold (available -> reserved) linked via payment_intent", async () => {
    // outer lookup: deposit row; in-tx lookup: no existing hold
    prisma.transaction.findFirst
      .mockResolvedValueOnce({
        id: "t-dep",
        walletId: "wallet-1",
        amount: new Decimal(1000),
        reference: "cs_1",
      })
      .mockResolvedValueOnce(null)
    prisma.wallet.findUniqueOrThrow.mockResolvedValue({
      id: "wallet-1",
      version: 2,
      availableBalance: new Decimal(1000),
      reservedBalance: new Decimal(0),
    })

    await (service as any).handleChargeback(dispute)

    expect(prisma.__committed).toBe(true)
    expect(prisma.wallet.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "wallet-1", version: 2 },
        data: expect.objectContaining({
          availableBalance: { decrement: expect.anything() },
          reservedBalance: { increment: expect.anything() },
        }),
      }),
    )
    // FIN-02 regression guard: the hold row also carries `provider: "stripe"`
    // so it sits under the same provider-aware identity as the originating
    // deposit (the partial unique sees (`stripe`, `pi_test_456`) for both).
    expect(prisma.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "RESERVATION",
        reference: "chargeback-hold-dp_1",
        provider: "stripe",
        providerRef: "pi_test_456",
      }),
    })
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "STRIPE_CHARGEBACK_HOLD_PLACED",
        metadata: expect.objectContaining({
          heldAmount: "600.00",
          uncoveredExposure: "0.00",
        }),
      }),
    )
  })

  it("holds only what remains and records the uncovered exposure", async () => {
    prisma.transaction.findFirst
      .mockResolvedValueOnce({
        id: "t-dep",
        walletId: "wallet-1",
        amount: new Decimal(1000),
        reference: "cs_1",
      })
      .mockResolvedValueOnce(null)
    prisma.wallet.findUniqueOrThrow.mockResolvedValue({
      id: "wallet-1",
      version: 2,
      availableBalance: new Decimal(100),
      reservedBalance: new Decimal(0),
    })

    await (service as any).handleChargeback(dispute)

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "STRIPE_CHARGEBACK_HOLD_PLACED",
        metadata: expect.objectContaining({
          heldAmount: "100.00",
          uncoveredExposure: "500.00",
        }),
      }),
    )
  })

  it("ignores a duplicate dispute webhook without touching the wallet", async () => {
    prisma.transaction.findFirst
      .mockResolvedValueOnce({
        id: "t-dep",
        walletId: "wallet-1",
        amount: new Decimal(1000),
        reference: "cs_1",
      })
      .mockResolvedValueOnce({
        id: "t-hold",
        reference: "chargeback-hold-dp_1",
      }) // hold already exists

    await (service as any).handleChargeback(dispute)

    expect(prisma.__committed).toBe(false) // transaction aborted
    expect(prisma.wallet.updateMany).not.toHaveBeenCalled()
    expect(audit.log).not.toHaveBeenCalled()
  })

  it("audits UNLINKED (manual review) when no deposit matches the payment_intent", async () => {
    prisma.transaction.findFirst.mockResolvedValue(null)

    await (service as any).handleChargeback(dispute)

    expect(prisma.wallet.updateMany).not.toHaveBeenCalled()
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "STRIPE_CHARGEBACK_UNLINKED",
      }),
    )
  })

  it("dispute WON releases the hold back to available", async () => {
    prisma.transaction.findFirst
      .mockResolvedValueOnce({
        id: "t-hold",
        walletId: "wallet-1",
        amount: new Decimal(-600),
      })
      .mockResolvedValueOnce(null) // no release row yet
    prisma.wallet.findUniqueOrThrow.mockResolvedValue({
      id: "wallet-1",
      version: 5,
    })

    await (service as any).handleChargebackClosed({ id: "dp_1", status: "won" })

    expect(prisma.wallet.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reservedBalance: { decrement: expect.anything() },
          availableBalance: { increment: expect.anything() },
        }),
      }),
    )
    expect(prisma.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "RESERVATION",
        reference: "chargeback-release-dp_1",
      }),
    })
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "STRIPE_CHARGEBACK_WON_RELEASED" }),
    )
  })

  it("dispute LOST debits the hold permanently with a CHARGEBACK ledger row", async () => {
    prisma.transaction.findFirst
      .mockResolvedValueOnce({
        id: "t-hold",
        walletId: "wallet-1",
        amount: new Decimal(-600),
      })
      .mockResolvedValueOnce(null)
    prisma.wallet.findUniqueOrThrow.mockResolvedValue({
      id: "wallet-1",
      version: 5,
    })

    await (service as any).handleChargebackClosed({
      id: "dp_1",
      status: "lost",
    })

    const updateData = prisma.wallet.updateMany.mock.calls[0][0].data
    expect(updateData.reservedBalance).toEqual({ decrement: expect.anything() })
    expect(updateData.availableBalance).toBeUndefined() // money does NOT come back
    expect(prisma.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "CHARGEBACK",
        reference: "chargeback-lost-dp_1",
      }),
    })
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "STRIPE_CHARGEBACK_LOST_DEBITED" }),
    )
  })

  it("dispute closed as warning_closed (inquiry dropped, no chargeback) RELEASES — never debits", async () => {
    prisma.transaction.findFirst
      .mockResolvedValueOnce({
        id: "t-hold",
        walletId: "wallet-1",
        amount: new Decimal(-600),
      })
      .mockResolvedValueOnce(null)
    prisma.wallet.findUniqueOrThrow.mockResolvedValue({
      id: "wallet-1",
      version: 5,
    })

    await (service as any).handleChargebackClosed({
      id: "dp_1",
      status: "warning_closed",
    })

    expect(prisma.wallet.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          availableBalance: { increment: expect.anything() },
        }),
      }),
    )
    expect(prisma.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "RESERVATION",
        reference: "chargeback-release-dp_1",
      }),
    })
  })

  it("unrecognized dispute-closed status moves NO money — alerts for manual resolution", async () => {
    prisma.transaction.findFirst.mockResolvedValueOnce({
      id: "t-hold",
      walletId: "wallet-1",
      amount: new Decimal(-600),
    })

    await (service as any).handleChargebackClosed({
      id: "dp_1",
      status: "under_review",
    })

    expect(prisma.wallet.updateMany).not.toHaveBeenCalled()
    expect(prisma.transaction.create).not.toHaveBeenCalled()
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "STRIPE_CHARGEBACK_CLOSED_UNRECOGNIZED",
      }),
    )
  })

  it("duplicate dispute-closed webhook is a no-op", async () => {
    prisma.transaction.findFirst
      .mockResolvedValueOnce({
        id: "t-hold",
        walletId: "wallet-1",
        amount: new Decimal(-600),
      })
      .mockResolvedValueOnce({
        id: "t-rel",
        reference: "chargeback-release-dp_1",
      }) // already released

    await (service as any).handleChargebackClosed({ id: "dp_1", status: "won" })

    expect(prisma.__committed).toBe(false)
    expect(prisma.wallet.updateMany).not.toHaveBeenCalled()
    expect(audit.log).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("F-2: payout webhook normalization (real provider shapes)", () => {
  it("maps a real Wise transfers#state-change envelope", () => {
    const wiseEnvelope = {
      data: {
        resource: {
          id: 12345678,
          profile_id: 111,
          account_id: 222,
          type: "transfer",
        },
        current_state: "outgoing_payment_sent",
        previous_state: "processing",
        occurred_at: "2026-06-11T12:00:00Z",
      },
      subscription_id: "sub-1",
      event_type: "transfers#state-change",
      schema_version: "2.0.0",
      sent_at: "2026-06-11T12:00:01Z",
    }
    const n = normalizeProviderWebhook("wise", wiseEnvelope)
    expect(n.providerExecutionId).toBe("12345678")
    expect(n.status).toBe("PROCESSING") // same WISE_STATUS_MAP as the poller
    expect(n.rawStatus).toBe("outgoing_payment_sent")
  })

  it("maps the unwrapped inner Wise data the webhook controller enqueues", () => {
    const inner = {
      resource: { id: 99, type: "transfer" },
      current_state: "completed",
    }
    const n = normalizeProviderWebhook("wise", inner)
    expect(n.providerExecutionId).toBe("99")
    expect(n.status).toBe("COMPLETED")
  })

  it("maps Wise cancelled to FAILED", () => {
    const n = normalizeProviderWebhook("wise", {
      resource: { id: 7 },
      current_state: "cancelled",
    })
    expect(n.status).toBe("FAILED")
  })

  it("maps a real Stripe event envelope (transfer paid)", () => {
    const stripeEnvelope = {
      id: "evt_1",
      type: "transfer.updated",
      data: {
        object: {
          id: "tr_123",
          object: "transfer",
          status: "paid",
          amount: 20000,
        },
      },
    }
    const n = normalizeProviderWebhook("stripe_connect", stripeEnvelope)
    expect(n.providerExecutionId).toBe("tr_123")
    expect(n.status).toBe("COMPLETED")
  })

  it("maps Stripe payout failure with the failure message", () => {
    const n = normalizeProviderWebhook("stripe_connect", {
      object: {
        id: "po_9",
        status: "failed",
        failure_message: "account closed",
      },
    })
    expect(n.providerExecutionId).toBe("po_9")
    expect(n.status).toBe("FAILED")
    expect(n.error).toBe("account closed")
  })

  it("passes pre-normalized internal payloads through untouched", () => {
    const n = normalizeProviderWebhook("wise", {
      providerExecutionId: "abc",
      status: "COMPLETED",
    })
    expect(n.providerExecutionId).toBe("abc")
    expect(n.status).toBe("COMPLETED")
  })

  it("yields no transition for unknown provider states", () => {
    const n = normalizeProviderWebhook("wise", {
      resource: { id: 1 },
      current_state: "bounced_back_weirdly",
    })
    expect(n.providerExecutionId).toBe("1")
    expect(n.status).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("F-3: tenant-scoped order idempotency", () => {
  let service: OrdersService
  let prisma: any

  beforeEach(() => {
    prisma = makePrismaMock()
    service = new OrdersService(
      prisma,
      auditMock() as any,
      queueMock() as any,
      {} as any,
    )
  })

  it("replays via the composite (organizationId, idempotencyKey) lookup — never key-only", async () => {
    const existing = { id: "order-A", organizationId: "org-A" }
    prisma.order.findUnique.mockResolvedValue(existing)

    const result = await service.createOrder(
      {
        type: "GUEST_POST",
        customerId: "u1",
        organizationId: "org-A",
        idempotencyKey: "key-1",
      } as any,
      "u1",
    )

    expect(result).toBe(existing)
    expect(prisma.order.findUnique).toHaveBeenCalledWith({
      where: {
        organizationId_idempotencyKey: {
          organizationId: "org-A",
          idempotencyKey: "key-1",
        },
      },
    })
    expect(prisma.order.create).not.toHaveBeenCalled()
  })

  it("another tenant reusing the same key gets its OWN order, not the other tenant's", async () => {
    prisma.order.findUnique.mockResolvedValue(null) // scoped lookup: no hit for org-B

    // Phase 6 — orders.service.ts:99–132 requires the listingServiceId snapshot
    // to resolve before order creation. Mock shape mirrors the production
    // findUnique({ where, include: { listing: { include: { website } } } })
    // query so the snapshot block can read availability + listing.status +
    // listing.ownerType + listing.website.{id,ownershipType,verificationStatus,managedByUserId}.
    prisma.listingService.findUnique.mockResolvedValue({
      id: "ls-B",
      listingId: "listing-B",
      serviceType: "GUEST_POST",
      price: 500,
      availability: "AVAILABLE",
      turnaroundDays: 7,
      listing: {
        status: "APPROVED",
        ownerType: "PUBLISHER",
        website: {
          id: "site-B",
          ownershipType: "PUBLISHER",
          verificationStatus: "VERIFIED",
          managedByUserId: null,
        },
      },
    })
    prisma.order.create.mockResolvedValue({
      id: "order-B",
      organizationId: "org-B",
    })

    const result = await service.createOrder(
      {
        type: "GUEST_POST",
        customerId: "u2",
        organizationId: "org-B",
        idempotencyKey: "key-1",
        listingServiceId: "ls-B", // Phase 6 snapshot requirement
      } as any,
      "u2",
    )

    expect(result.id).toBe("order-B")
    expect(prisma.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org-B",
          idempotencyKey: "key-1",
        }),
      }),
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("F-4: FAILED withdrawal reversal", () => {
  let service: PublisherPayoutsService
  let prisma: any
  let audit: any

  const failedWithdrawal = {
    id: "wd-1",
    publisherId: "pub-1",
    amount: new Decimal(200),
    status: "FAILED",
    version: 4,
    publisher: { id: "pub-1", organizationId: "org-1" },
  }

  beforeEach(() => {
    prisma = makePrismaMock()
    audit = auditMock()
    service = new PublisherPayoutsService(
      prisma,
      audit as any,
      queueMock() as any,
      {} as any,
      {} as any,
    )
  })

  it("FAILED -> REVERSED restores the balance and writes the WITHDRAWAL_REVERSAL ledger row", async () => {
    prisma.withdrawal.findUnique.mockResolvedValue(failedWithdrawal)
    prisma.payoutExecution.findFirst.mockResolvedValue(null) // no money moved
    prisma.withdrawal.updateMany.mockResolvedValue({ count: 1 })
    prisma.withdrawal.findUniqueOrThrow.mockResolvedValue({
      ...failedWithdrawal,
      status: "REVERSED",
    })
    prisma.publisherBalance.findUnique.mockResolvedValue({
      publisherId: "pub-1",
      version: 7,
    })

    const result = await service.reverseFailedWithdrawal(
      "wd-1",
      "admin-1",
      "provider rejected account",
    )

    expect(result.status).toBe("REVERSED")
    expect(prisma.withdrawal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "wd-1", status: "FAILED", version: 4 },
      }),
    )
    expect(prisma.publisherBalance.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { publisherId: "pub-1", version: 7 },
        data: expect.objectContaining({
          withdrawableBalance: { increment: 200 },
        }),
      }),
    )
    expect(prisma.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "WITHDRAWAL_REVERSAL",
        reference: "withdrawal-reverse-wd-1",
      }),
    })
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "WITHDRAWAL_REVERSED" }),
      prisma,
    )
  })

  it("rejects a second reversal (status no longer FAILED)", async () => {
    prisma.withdrawal.findUnique.mockResolvedValue({
      ...failedWithdrawal,
      status: "REVERSED",
    })

    await expect(
      service.reverseFailedWithdrawal("wd-1", "admin-1", "double attempt here"),
    ).rejects.toThrow(BadRequestException)
    expect(prisma.publisherBalance.updateMany).not.toHaveBeenCalled()
  })

  it("refuses while an execution is COMPLETED (money moved at the provider)", async () => {
    prisma.withdrawal.findUnique.mockResolvedValue(failedWithdrawal)
    prisma.payoutExecution.findFirst.mockResolvedValue({
      id: "exec-1",
      status: "COMPLETED",
    })

    await expect(
      service.reverseFailedWithdrawal("wd-1", "admin-1", "should be refused"),
    ).rejects.toThrow(/COMPLETED/)
    expect(prisma.withdrawal.updateMany).not.toHaveBeenCalled()
  })

  it("refuses while an execution is still PROCESSING", async () => {
    prisma.withdrawal.findUnique.mockResolvedValue(failedWithdrawal)
    prisma.payoutExecution.findFirst.mockResolvedValue({
      id: "exec-2",
      status: "PROCESSING",
    })

    await expect(
      service.reverseFailedWithdrawal("wd-1", "admin-1", "should be refused"),
    ).rejects.toThrow(/PROCESSING/)
  })

  it("loses the race cleanly when the withdrawal transitions concurrently", async () => {
    prisma.withdrawal.findUnique.mockResolvedValue(failedWithdrawal)
    prisma.payoutExecution.findFirst.mockResolvedValue(null)
    prisma.withdrawal.updateMany.mockResolvedValue({ count: 0 }) // concurrent retry won

    await expect(
      service.reverseFailedWithdrawal("wd-1", "admin-1", "race condition test"),
    ).rejects.toThrow(ConflictException)
    expect(prisma.publisherBalance.updateMany).not.toHaveBeenCalled()
    expect(prisma.transaction.create).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("F-5: customerApprove cannot corrupt a RELEASED settlement", () => {
  let service: SettlementsService
  let prisma: any

  const settlement = {
    id: "set-1",
    orderId: "order-1",
    publisherId: "pub-1",
    status: "PENDING",
    publisherAmount: new Decimal(160),
    version: 2,
    order: { organizationId: "org-1", customerId: "u1" },
  }

  beforeEach(() => {
    prisma = makePrismaMock()
    service = new SettlementsService(
      prisma,
      auditMock() as any,
      queueMock() as any,
    )
  })

  it("approves via a status+version-guarded conditional update", async () => {
    prisma.settlement.findUnique.mockResolvedValue(settlement)
    prisma.orderDispute.findFirst.mockResolvedValue(null)
    prisma.settlement.updateMany.mockResolvedValue({ count: 1 })
    prisma.settlement.findUniqueOrThrow.mockResolvedValue({
      ...settlement,
      status: "CUSTOMER_APPROVED",
    })

    const result = await service.customerApprove(
      "set-1",
      "u1",
      "org-1",
      "OWNER",
    )

    expect(result.status).toBe("CUSTOMER_APPROVED")
    expect(prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "set-1",
          status: { in: ["PENDING", "UNDER_REVIEW"] },
          version: 2,
        },
      }),
    )
    // The unguarded settlement.update() path must be gone
    expect(prisma.settlement.update).not.toHaveBeenCalled()
  })

  it("conflicts instead of overwriting when the settlement was concurrently RELEASED", async () => {
    // Stale pre-tx read says PENDING; by the time the tx runs, a concurrent
    // forceApprove chain has already moved the row to RELEASED.
    prisma.settlement.findUnique.mockResolvedValue(settlement)
    prisma.orderDispute.findFirst.mockResolvedValue(null)
    prisma.settlement.updateMany.mockResolvedValue({ count: 0 }) // guard catches it

    await expect(
      service.customerApprove("set-1", "u1", "org-1", "OWNER"),
    ).rejects.toThrow(ConflictException)
    expect(prisma.settlementApproval.upsert).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// FIN-02: provider-aware uniqueness on Transaction
//
// Audit finding: deposit idempotency relied solely on `reference` (Stripe
// session.id), leaving a hole when a replayed webhook returned a new session.id
// but the same `payment_intent`. Sprint 3 closes the race at the DB level with
// a partial unique index on `(provider, providerRef) WHERE providerRef IS NOT
// NULL` (migration 20260716030403). The application MUST set `provider: "stripe"`
// on every row that sets `providerRef` — otherwise the row falls outside the
// partial-unique identity model and the constraint can't see it. These tests
// lock in that invariant on the two write paths (deposit + chargeback hold) AND
// on the two read paths (chargeback lookup + early-fraud-warning lookup) —
// every callsite that touches `providerRef` must filter/write by `provider`.
//
// Note: the write-time assertions are duplicated in the F-1 / F-6 blocks
// above (so future regression PRs that touch only one path still hear about
// it); this block additionally covers the early-fraud-warning path which has
// no other test coverage of `provider`-awareness.
// ──────────────────────────────────────────────────────────
describe("FIN-02: provider-aware uniqueness on Transaction", () => {
  let service: BillingService
  let prisma: any
  let audit: any

  const depositRow = {
    id: "t-dep",
    walletId: "wallet-1",
    amount: new Decimal(1000),
    reference: "cs_1",
    orderId: null,
  }

  beforeEach(() => {
    prisma = makePrismaMock()
    audit = auditMock()
    service = new BillingService(prisma, audit as any)
  })

  it("handleChargeback filters the deposit lookup by `provider: stripe`", async () => {
    prisma.transaction.findFirst.mockResolvedValueOnce(depositRow) // outer lookup
    prisma.transaction.findFirst.mockResolvedValueOnce(null) // inner: no existing hold
    prisma.wallet.findUniqueOrThrow.mockResolvedValue({
      id: "wallet-1",
      version: 2,
      availableBalance: new Decimal(1000),
      reservedBalance: new Decimal(0),
    })

    await (service as any).handleChargeback({
      id: "dp_fin02",
      charge: "ch_fin02",
      payment_intent: "pi_fin02",
      amount: 10000,
      currency: "usd",
      reason: "fraudulent",
      status: "needs_response",
    })

    // Outer (pre-tx) findFirst MUST scope by provider + providerRef + type.
    // Without `provider` in the WHERE, the lookup could miss rows that the
    // partial-unique constraint already anchored on `provider = 'stripe'`.
    const outerLookup = prisma.transaction.findFirst.mock.calls[0][0]
    expect(outerLookup).toEqual({
      where: {
        provider: "stripe",
        providerRef: "pi_fin02",
        type: "DEPOSIT",
      },
      select: {
        id: true,
        walletId: true,
        amount: true,
        reference: true,
      },
    })
  })

  it("handleEarlyFraudWarning filters the deposit lookup by `provider: stripe`", async () => {
    // The audit-log idempotency precheck returns null so the handler
    // proceeds to the deposit lookup.
    prisma.auditLog.findFirst.mockResolvedValueOnce(null)
    prisma.transaction.findFirst.mockResolvedValueOnce({
      ...depositRow,
      orderId: "order-1",
    })

    await (service as any).handleEarlyFraudWarning({
      id: "evt_fin02",
      type: "radar.early_fraud_warning.created",
      data: {
        object: {
          id: "ifw_fin02",
          payment_intent: "pi_fin02",
          charge: "ch_fin02",
          amount: 10000,
          currency: "usd",
        },
      },
    })

    // The deposit-lookup WHERE must include `provider: "stripe"` — same
    // identity model as the write path. A lookup that forgets the provider
    // would still HIT a matching row today (the backfill set `provider='stripe'`
    // on historical rows), but tying the read to the write identity keeps a
    // future Wise/PayPal integration from cross-pollinating deposit refs.
    const depositLookup = prisma.transaction.findFirst.mock.calls.find(
      (c: any) =>
        c[0]?.where?.providerRef === "pi_fin02" &&
        c[0]?.where?.type === "DEPOSIT",
    )
    expect(depositLookup?.[0]?.where).toEqual({
      provider: "stripe",
      providerRef: "pi_fin02",
      type: "DEPOSIT",
    })
  })
})
