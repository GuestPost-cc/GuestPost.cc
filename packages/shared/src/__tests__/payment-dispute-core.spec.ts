import {
  type FingerprintablePaymentDisputeEvent,
  PaymentDisputeTransitionError,
  paymentDisputeEventFingerprint,
  paymentDisputeEventFromStoredRow,
  paymentDisputeTargetStatus,
  transitionPaymentDispute,
} from "../payment-dispute-core"

function storedEvent(
  overrides: Partial<FingerprintablePaymentDisputeEvent> & {
    id?: string
  } = {},
) {
  const fingerprintable: FingerprintablePaymentDisputeEvent = {
    provider: "stripe",
    providerEventId: "evt_dispute_1",
    eventType: "charge.dispute.created",
    providerDisputeId: "dp_1",
    providerPaymentId: "pi_1",
    providerChargeId: "ch_1",
    amountMinor: 60000n,
    amount: "600.00",
    currency: "USD",
    providerStatus: "needs_response",
    livemode: false,
    ...overrides,
  }
  return {
    id: overrides.id ?? "inbox-1",
    provider: fingerprintable.provider,
    providerEventId: fingerprintable.providerEventId,
    eventType: fingerprintable.eventType,
    objectId: fingerprintable.providerDisputeId,
    providerPaymentId: fingerprintable.providerPaymentId,
    providerChargeId: fingerprintable.providerChargeId,
    disputeAmountMinor: fingerprintable.amountMinor,
    disputeCurrency: fingerprintable.currency,
    providerStatus: fingerprintable.providerStatus,
    livemode: fingerprintable.livemode,
    eventFingerprint: paymentDisputeEventFingerprint(fingerprintable),
    status: "PROCESSING",
    attempts: 1,
    lockedAt: new Date("2026-07-29T00:00:00.000Z"),
  }
}

describe("payment dispute canonical core", () => {
  const previousStripeSecretKey = process.env.STRIPE_SECRET_KEY
  const previousStripeLiveMode = process.env.STRIPE_LIVE_MODE_ENABLED

  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = "rk_test_payment_dispute_core"
    process.env.STRIPE_LIVE_MODE_ENABLED = "false"
  })

  afterAll(() => {
    if (previousStripeSecretKey === undefined) {
      delete process.env.STRIPE_SECRET_KEY
    } else {
      process.env.STRIPE_SECRET_KEY = previousStripeSecretKey
    }
    if (previousStripeLiveMode === undefined) {
      delete process.env.STRIPE_LIVE_MODE_ENABLED
    } else {
      process.env.STRIPE_LIVE_MODE_ENABLED = previousStripeLiveMode
    }
  })

  it("maps Stripe prevented to the terminal WON outcome", () => {
    const input = paymentDisputeEventFromStoredRow(
      storedEvent({
        eventType: "charge.dispute.closed",
        providerStatus: "prevented",
      }),
    )

    expect(paymentDisputeTargetStatus(input)).toBe("WON")
  })

  it("fingerprints every immutable financial envelope field", () => {
    const first = storedEvent()
    const changed = storedEvent({ providerPaymentId: "pi_other" })

    expect(first.eventFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(first.eventFingerprint).not.toBe(changed.eventFingerprint)
  })

  it("rejects stored facts whose fingerprint was changed independently", () => {
    expect(() =>
      paymentDisputeEventFromStoredRow({
        ...storedEvent(),
        disputeAmountMinor: 1n,
      }),
    ).toThrow(PaymentDisputeTransitionError)
  })

  it("locks the inbox row before reading event or deposit evidence", async () => {
    const order: string[] = []
    const event = storedEvent()
    const tx = {
      $queryRawUnsafe: jest.fn(async () => {
        order.push("lock-event")
        return []
      }),
      paymentProviderEvent: {
        findUnique: jest.fn(async () => {
          order.push("read-event")
          return event
        }),
      },
      transaction: {
        findFirst: jest.fn(async () => {
          order.push("read-deposit")
          return null
        }),
      },
    }
    const client = {
      $transaction: jest.fn((callback: any) => callback(tx)),
    }
    const input = paymentDisputeEventFromStoredRow(event)

    await expect(
      transitionPaymentDispute(
        client,
        {
          audit: jest.fn(),
          notifyFinance: jest.fn(),
        },
        input,
      ),
    ).rejects.toMatchObject({
      code: "DEPOSIT_NOT_LINKED",
      retryable: true,
    })
    expect(order).toEqual(["lock-event", "read-event", "read-deposit"])
  })

  it("rejects a stale claimant after the inbox lease is recovered", async () => {
    const original = storedEvent()
    const recovered = {
      ...original,
      attempts: 2,
      lockedAt: new Date("2026-07-29T00:20:00.000Z"),
    }
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      paymentProviderEvent: {
        findUnique: jest.fn().mockResolvedValue(recovered),
      },
      transaction: {
        findFirst: jest.fn(),
      },
    }
    const client = {
      $transaction: jest.fn((callback: any) => callback(tx)),
    }

    await expect(
      transitionPaymentDispute(
        client,
        {
          audit: jest.fn(),
          notifyFinance: jest.fn(),
        },
        paymentDisputeEventFromStoredRow(original),
      ),
    ).rejects.toMatchObject({
      code: "EVENT_ENVELOPE_MISMATCH",
      retryable: false,
    })
    expect(tx.transaction.findFirst).not.toHaveBeenCalled()
  })

  it("locks the wallet before reading or creating a dispute case", async () => {
    const order: string[] = []
    const event = storedEvent()
    const sentinel = new Error("stop after lock-order proof")
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql: string) => {
        order.push(
          sql.includes('"PaymentProviderEvent"') ? "lock-event" : "lock-wallet",
        )
        return []
      }),
      paymentProviderEvent: {
        findUnique: jest.fn(async () => {
          order.push("read-event")
          return event
        }),
      },
      transaction: {
        findFirst: jest.fn(async () => {
          order.push("read-deposit")
          return {
            id: "deposit-transaction-1",
            walletId: "wallet-1",
            amount: "600.00",
            currency: "USD",
            depositAttempt: {
              id: "deposit-attempt-1",
              walletId: "wallet-1",
              walletCredit: "600.00",
              currency: "USD",
              provider: "stripe",
              providerPaymentId: "pi_1",
              ledgerTransactionId: "deposit-transaction-1",
              status: "SUCCEEDED",
            },
          }
        }),
      },
      paymentDispute: {
        findUnique: jest.fn(async () => {
          order.push("read-case")
          throw sentinel
        }),
      },
    }
    const client = {
      $transaction: jest.fn((callback: any) => callback(tx)),
    }

    await expect(
      transitionPaymentDispute(
        client,
        {
          audit: jest.fn(),
          notifyFinance: jest.fn(),
        },
        paymentDisputeEventFromStoredRow(event),
      ),
    ).rejects.toBe(sentinel)
    expect(order).toEqual([
      "lock-event",
      "read-event",
      "read-deposit",
      "lock-wallet",
      "read-case",
    ])
    expect(tx.$queryRawUnsafe).toHaveBeenNthCalledWith(
      2,
      'SELECT "id" FROM "Wallet" WHERE "id" = $1 FOR UPDATE',
      "wallet-1",
    )
  })

  it.each([
    [
      "stored test evidence after live promotion",
      false,
      "rk_live_payment_dispute_core",
      "true",
      "STRIPE_PROVIDER_MODE_MISMATCH",
    ],
    [
      "stored live evidence after switching to test",
      true,
      "rk_test_payment_dispute_core",
      "false",
      "STRIPE_PROVIDER_MODE_MISMATCH",
    ],
    [
      "stored live evidence while the live-money gate is disabled",
      true,
      "rk_live_payment_dispute_core",
      "false",
      "STRIPE_LIVE_MODE_DISABLED",
    ],
  ] as const)("rejects %s before the wallet/case mutation boundary", async (_name, livemode, secretKey, liveModeEnabled, expectedCode) => {
    process.env.STRIPE_SECRET_KEY = secretKey
    process.env.STRIPE_LIVE_MODE_ENABLED = liveModeEnabled
    const event = storedEvent({ livemode })
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      paymentProviderEvent: {
        findUnique: jest.fn().mockResolvedValue(event),
      },
      transaction: {
        findFirst: jest.fn().mockResolvedValue({
          id: "deposit-transaction-1",
          walletId: "wallet-1",
          amount: "600.00",
          currency: "USD",
          depositAttempt: {
            id: "deposit-attempt-1",
            walletId: "wallet-1",
            walletCredit: "600.00",
            currency: "USD",
            provider: "stripe",
            providerPaymentId: "pi_1",
            ledgerTransactionId: "deposit-transaction-1",
            status: "SUCCEEDED",
          },
        }),
      },
      paymentDispute: {
        findUnique: jest.fn(),
      },
    }
    const client = {
      $transaction: jest.fn((callback: any) => callback(tx)),
    }

    await expect(
      transitionPaymentDispute(
        client,
        {
          audit: jest.fn(),
          notifyFinance: jest.fn(),
        },
        paymentDisputeEventFromStoredRow(event),
      ),
    ).rejects.toMatchObject({
      code: expectedCode,
      retryable: false,
    })
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1)
    expect(tx.paymentDispute.findUnique).not.toHaveBeenCalled()
  })
})
