import {
  createHash,
  createHmac,
  createSign,
  generateKeyPairSync,
} from "node:crypto"
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common"
import { PayoutWebhookController } from "../payout-webhook.controller"

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe("payout webhook durable inbox dedup", () => {
  let prismaMock: any
  let wakeupMock: any
  let controller: PayoutWebhookController

  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = "rk_test_phase83"
    process.env.STRIPE_LIVE_MODE_ENABLED = "false"
    process.env.STRIPE_PAYOUT_WEBHOOK_SECRET = "whsec_platform_phase83"
    process.env.STRIPE_CONNECTED_PAYOUT_WEBHOOK_SECRET =
      "whsec_connected_phase83"
    prismaMock = {
      payoutWebhookEvent: {
        create: jest.fn().mockResolvedValue({ id: "inbox-1" }),
        findUnique: jest.fn().mockResolvedValue({ id: "inbox-1" }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      staffMembership: { findMany: jest.fn().mockResolvedValue([]) },
      notification: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: "inbox-1" }]),
    }
    prismaMock.$transaction = jest.fn(async (work: any) => work(prismaMock))
    wakeupMock = { wake: jest.fn().mockResolvedValue(undefined) }
    controller = new PayoutWebhookController(prismaMock, wakeupMock)
  })

  function stripeSig(secret: string, body: string): string {
    const timestamp = Math.floor(Date.now() / 1000)
    const v1 = createHmac("sha256", secret)
      .update(`${timestamp}.${body}`)
      .digest("hex")
    return `t=${timestamp},v1=${v1}`
  }

  function persistedData(): Record<string, unknown> {
    return prismaMock.payoutWebhookEvent.create.mock.calls[0][0].data
  }

  function deliverPlatformStripe(
    payload: string,
    secret = "whsec_platform_phase83",
  ) {
    return controller.handleStripePlatformWebhook(
      { "stripe-signature": stripeSig(secret, payload) },
      { rawBody: Buffer.from(payload) } as any,
    )
  }

  function deliverConnectedStripe(
    payload: string,
    secret = "whsec_connected_phase83",
  ) {
    return controller.handleStripeConnectedWebhook(
      { "stripe-signature": stripeSig(secret, payload) },
      { rawBody: Buffer.from(payload) } as any,
    )
  }

  function stripeAccountPayload() {
    return JSON.stringify({
      id: "evt_account_updated",
      type: "account.updated",
      livemode: false,
      account: "acct_managed1",
      data: {
        object: {
          id: "acct_managed1",
          object: "account",
          payouts_enabled: true,
        },
      },
    })
  }

  function accountEnvelope() {
    return {
      id: "inbox-1",
      eventType: "account.updated",
      providerExecutionId: null,
      providerAccountExternalId: "acct_managed1",
      livemode: false,
      payoutAmountMinor: null,
      payoutCurrency: null,
      providerStatus: null,
      rawStatus: null,
    }
  }

  it("retires the legacy shared-secret Stripe payout route", () => {
    expect(() =>
      controller.handleWebhook("stripe_connect", {}, {
        rawBody: Buffer.from("{}"),
      } as any),
    ).toThrow(BadRequestException)
    expect(prismaMock.payoutWebhookEvent.create).not.toHaveBeenCalled()
  })

  it("rejects platform signatures on the connected-account route", async () => {
    const payload = JSON.stringify({
      id: "evt_cross_platform",
      type: "payout.paid",
      livemode: false,
      account: "acct_connected1",
      data: {
        object: {
          id: "po_cross1",
          status: "paid",
          amount: 1000,
          currency: "usd",
        },
      },
    })

    await expect(
      deliverConnectedStripe(payload, "whsec_platform_phase83"),
    ).rejects.toThrow(UnauthorizedException)
    expect(prismaMock.payoutWebhookEvent.create).not.toHaveBeenCalled()
  })

  it("rejects connected-account signatures on the platform route", async () => {
    const payload = JSON.stringify({
      id: "evt_cross_connected",
      type: "transfer.updated",
      livemode: false,
      data: { object: { id: "tr_cross1", status: "pending" } },
    })

    await expect(
      deliverPlatformStripe(payload, "whsec_connected_phase83"),
    ).rejects.toThrow(UnauthorizedException)
    expect(prismaMock.payoutWebhookEvent.create).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: "platform event with connected-account topology",
      channel: "platform",
      payload: {
        id: "evt_platform_account",
        type: "transfer.updated",
        livemode: false,
        account: "acct_untrusted1",
        data: { object: { id: "tr_platform1", status: "pending" } },
      },
    },
    {
      name: "connected event without an account",
      channel: "connected",
      payload: {
        id: "evt_connected_no_account",
        type: "payout.paid",
        livemode: false,
        data: {
          object: {
            id: "po_connected1",
            status: "paid",
            amount: 1000,
            currency: "usd",
          },
        },
      },
    },
    {
      name: "connected account event with mismatched object",
      channel: "connected",
      payload: {
        id: "evt_account_mismatch",
        type: "account.updated",
        livemode: false,
        account: "acct_expected1",
        data: { object: { id: "acct_other1", object: "account" } },
      },
    },
    {
      name: "connected route with a platform event type",
      channel: "connected",
      payload: {
        id: "evt_connected_transfer",
        type: "transfer.updated",
        livemode: false,
        account: "acct_connected2",
        data: { object: { id: "tr_wrongchannel1", status: "pending" } },
      },
    },
    {
      name: "platform route with a connected event type",
      channel: "platform",
      payload: {
        id: "evt_platform_payout",
        type: "payout.paid",
        livemode: false,
        data: {
          object: {
            id: "po_wrongchannel1",
            status: "paid",
            amount: 1000,
            currency: "usd",
          },
        },
      },
    },
  ])("rejects $name before inbox mutation", async ({ channel, payload }) => {
    const encoded = JSON.stringify(payload)
    const request =
      channel === "platform"
        ? deliverPlatformStripe(encoded)
        : deliverConnectedStripe(encoded)

    await expect(request).rejects.toThrow(BadRequestException)
    expect(prismaMock.payoutWebhookEvent.create).not.toHaveBeenCalled()
  })

  it.each([
    "paid",
    "failed",
  ])("keeps signed payout.updated with %s object state observational", async (status) => {
    const payload = JSON.stringify({
      id: `evt_updated_${status}`,
      type: "payout.updated",
      livemode: false,
      account: "acct_updated1",
      data: {
        object: {
          id: "po_updated1",
          status,
          amount: 1000,
          currency: "usd",
        },
      },
    })

    await expect(deliverConnectedStripe(payload)).resolves.toMatchObject({
      received: true,
    })
    expect(persistedData()).toMatchObject({
      eventType: "payout.updated",
      providerExecutionId: "po_updated1",
      providerStatus: "PROCESSING",
      rawStatus: status,
    })
  })

  it("rejects a typed terminal payout event whose object status contradicts it", async () => {
    const payload = JSON.stringify({
      id: "evt_paid_pending",
      type: "payout.paid",
      livemode: false,
      account: "acct_mismatch1",
      data: {
        object: {
          id: "po_mismatch1",
          status: "pending",
          amount: 1000,
          currency: "usd",
        },
      },
    })

    await expect(deliverConnectedStripe(payload)).rejects.toThrow(
      BadRequestException,
    )
    expect(prismaMock.payoutWebhookEvent.create).not.toHaveBeenCalled()
  })

  it("deduplicates by provider event identity, not by transfer id", async () => {
    const makePayload = (eventId: string, status: string) =>
      JSON.stringify({
        id: eventId,
        type: "transfer.updated",
        livemode: false,
        data: { object: { id: "tr_same", status } },
      })

    const first = makePayload("evt_processing", "pending")
    await deliverPlatformStripe(first)
    const firstData = persistedData()

    prismaMock.payoutWebhookEvent.create.mockClear()
    const completed = makePayload("evt_completed", "paid")
    await deliverPlatformStripe(completed)
    const completedData = persistedData()

    expect(firstData.providerExecutionId).toBe("tr_same")
    expect(completedData.providerExecutionId).toBe("tr_same")
    expect(firstData.dedupKey).not.toBe(completedData.dedupKey)
    expect(completedData.providerStatus).toBe("PROCESSING")
  })

  it("returns the existing durable event on an identical replay", async () => {
    prismaMock.payoutWebhookEvent.create.mockRejectedValue({
      code: "P2010",
      meta: {
        driverAdapterError: {
          cause: { originalCode: "23505" },
        },
      },
    })
    prismaMock.payoutWebhookEvent.findUnique.mockResolvedValue({
      id: "inbox-existing",
      eventType: "transfer.updated",
      providerExecutionId: "tr_1",
      providerAccountExternalId: null,
      livemode: false,
      payoutAmountMinor: null,
      payoutCurrency: null,
      providerStatus: "PROCESSING",
      rawStatus: "paid",
    })
    const payload = JSON.stringify({
      id: "evt_replay",
      type: "transfer.updated",
      livemode: false,
      data: { object: { id: "tr_1", status: "paid" } },
    })

    const result = await deliverPlatformStripe(payload)

    expect(result).toEqual({
      received: true,
      eventId: "inbox-existing",
      duplicate: true,
    })
    const expectedKey = createHash("sha256")
      .update("event:evt_replay")
      .digest("hex")
    expect(prismaMock.payoutWebhookEvent.findUnique).toHaveBeenCalledWith({
      where: {
        provider_dedupKey: {
          provider: "stripe_connect",
          dedupKey: expectedKey,
        },
      },
      select: {
        id: true,
        eventType: true,
        providerExecutionId: true,
        providerAccountExternalId: true,
        livemode: true,
        payoutAmountMinor: true,
        payoutCurrency: true,
        providerStatus: true,
        rawStatus: true,
      },
    })
  })

  it("quarantines a reused provider event identity bound to a different connected account", async () => {
    prismaMock.payoutWebhookEvent.create.mockRejectedValue({ code: "P2002" })
    prismaMock.payoutWebhookEvent.findUnique.mockResolvedValue({
      id: "inbox-conflict",
      eventType: "payout.paid",
      providerExecutionId: "po_1",
      providerAccountExternalId: "acct_original",
      livemode: false,
      payoutAmountMinor: 10_000n,
      payoutCurrency: "USD",
      providerStatus: "COMPLETED",
      rawStatus: "paid",
    })
    prismaMock.staffMembership.findMany.mockResolvedValue([
      { userId: "finance-1" },
    ])
    const payload = JSON.stringify({
      id: "evt_conflicting_replay",
      type: "payout.paid",
      livemode: false,
      account: "acct_incoming",
      data: {
        object: {
          id: "po_1",
          status: "paid",
          amount: 10_000,
          currency: "usd",
        },
      },
    })

    await expect(deliverConnectedStripe(payload)).rejects.toThrow(
      ConflictException,
    )

    expect(prismaMock.payoutWebhookEvent.update).toHaveBeenCalledWith({
      where: { id: "inbox-conflict" },
      data: expect.objectContaining({
        status: "QUARANTINED",
        lastError: "DuplicateIdentityPayloadMismatch",
      }),
    })
    expect(prismaMock.staffMembership.findMany).toHaveBeenCalledWith({
      where: { role: { in: ["FINANCE", "SUPER_ADMIN"] } },
      select: { userId: true },
    })
    expect(prismaMock.notification.createMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "PAYOUT_WEBHOOK_IDENTITY_CONFLICT_QUARANTINED",
        entityId: "inbox-conflict",
      }),
    })
    expect(wakeupMock.wake).not.toHaveBeenCalled()
  })

  it("retains a linked processed completion event when its provider identity later collides", async () => {
    prismaMock.payoutWebhookEvent.create.mockRejectedValue({ code: "P2002" })
    prismaMock.payoutWebhookEvent.findUnique.mockResolvedValue({
      id: "inbox-linked",
      status: "PROCESSED",
      processedAt: new Date("2026-01-01T00:00:00.000Z"),
      lastError: null,
      eventType: "payout.paid",
      providerExecutionId: "po_linked",
      providerAccountExternalId: "acct_original",
      livemode: true,
      payoutAmountMinor: 10_000n,
      payoutCurrency: "USD",
      providerStatus: "COMPLETED",
      rawStatus: "paid",
      completedExecution: {
        id: "execution-linked",
        status: "COMPLETED",
        completionSource: "PROVIDER_WEBHOOK",
      },
    })
    prismaMock.staffMembership.findMany.mockResolvedValue([
      { userId: "finance-1" },
    ])
    const payload = JSON.stringify({
      id: "evt_linked_collision",
      type: "payout.paid",
      livemode: false,
      account: "acct_original",
      data: {
        object: {
          id: "po_linked",
          status: "paid",
          amount: 10_000,
          currency: "usd",
        },
      },
    })

    await expect(deliverConnectedStripe(payload)).rejects.toThrow(
      ConflictException,
    )

    expect(prismaMock.payoutWebhookEvent.update).not.toHaveBeenCalled()
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "PAYOUT_WEBHOOK_IDENTITY_CONFLICT_DETECTED",
        entityId: "inbox-linked",
        metadata: expect.objectContaining({
          canonicalCompletionRetained: true,
          completedExecutionId: "execution-linked",
          existingLivemode: true,
          incomingLivemode: false,
        }),
      }),
    })
    expect(prismaMock.notification.createMany).toHaveBeenCalledTimes(1)
  })

  it("uses a verified payload hash when Wise supplies no event id", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    })
    process.env.WISE_WEBHOOK_PUBLIC_KEY = publicKey
      .export({ type: "spki", format: "pem" })
      .toString()
    const payload = JSON.stringify({
      event_type: "balances#credit",
      occurred_at: new Date().toISOString(),
      data: { current_state: "processing" },
    })
    const rawBody = Buffer.from(payload)
    const signer = createSign("RSA-SHA256")
    signer.update(rawBody)
    const signature = signer.sign(privateKey, "base64")

    await controller.handleWebhook(
      "wise",
      { "x-signature-sha256": signature },
      { rawBody } as any,
    )

    const payloadHash = createHash("sha256").update(rawBody).digest("hex")
    const expectedKey = createHash("sha256")
      .update(`payload:${payloadHash}`)
      .digest("hex")
    expect(persistedData()).toMatchObject({
      provider: "wise",
      dedupKey: expectedKey,
      eventType: "balances#credit",
      providerExecutionId: null,
      livemode: null,
    })
  })

  it("persists only normalized allow-listed fields", async () => {
    const payload = JSON.stringify({
      id: "evt_safe",
      type: "payout.paid",
      livemode: false,
      account: "acct_safe",
      secretBankField: "must-not-persist",
      data: {
        object: {
          id: "po_safe",
          status: "paid",
          amount: 12_345,
          currency: "usd",
          destination: "acct_sensitive",
        },
      },
    })
    await deliverConnectedStripe(payload)

    const serialized = JSON.stringify(persistedData(), (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    )
    expect(serialized).not.toContain("must-not-persist")
    expect(serialized).not.toContain("acct_sensitive")
    expect(persistedData()).toMatchObject({
      providerExecutionId: "po_safe",
      providerAccountExternalId: "acct_safe",
      livemode: false,
      payoutAmountMinor: 12_345n,
      payoutCurrency: "USD",
      providerStatus: "COMPLETED",
      rawStatus: "paid",
    })
    expect(wakeupMock.wake).toHaveBeenCalledWith("payout-webhook")
  })

  it("persists a signed account update but performs no routing mutation while finance is locked", async () => {
    process.env.FINANCE_RUNTIME_MODE = "locked"
    const stripeConnect = { syncAccount: jest.fn() }
    controller = new PayoutWebhookController(
      prismaMock,
      wakeupMock,
      stripeConnect as any,
    )
    const payload = stripeAccountPayload()

    await expect(deliverConnectedStripe(payload)).rejects.toThrow(
      ServiceUnavailableException,
    )

    expect(persistedData()).toMatchObject({
      provider: "stripe_connect",
      eventType: "account.updated",
      providerExecutionId: null,
      providerAccountExternalId: "acct_managed1",
      livemode: false,
      payoutAmountMinor: null,
      payoutCurrency: null,
      providerStatus: null,
      rawStatus: null,
    })
    expect(stripeConnect.syncAccount).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(wakeupMock.wake).not.toHaveBeenCalled()
  })

  it("replays the same locked account evidence once recovery processing is enabled", async () => {
    process.env.FINANCE_RUNTIME_MODE = "recovery_only"
    prismaMock.payoutWebhookEvent.create.mockRejectedValue({ code: "P2002" })
    prismaMock.payoutWebhookEvent.findUnique
      .mockResolvedValueOnce(accountEnvelope())
      .mockResolvedValueOnce({ status: "PENDING" })
      .mockResolvedValueOnce({
        status: "PENDING",
        attempts: 0,
        availableAt: new Date(0),
        lockedAt: null,
      })
    const stripeConnect = { syncAccount: jest.fn().mockResolvedValue({}) }
    controller = new PayoutWebhookController(
      prismaMock,
      wakeupMock,
      stripeConnect as any,
    )
    const payload = stripeAccountPayload()

    await expect(deliverConnectedStripe(payload)).resolves.toEqual({
      received: true,
      eventId: "inbox-1",
      duplicate: true,
      accountSynced: true,
    })

    expect(stripeConnect.syncAccount).toHaveBeenCalledTimes(1)
    expect(stripeConnect.syncAccount).toHaveBeenCalledWith(
      "acct_managed1",
      expect.objectContaining({
        source: "webhook",
        payoutWebhookEventId: "inbox-1",
        claimAttempt: 1,
        claimLockedAt: expect.any(String),
      }),
    )
    expect(prismaMock.payoutWebhookEvent.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          id: "inbox-1",
          status: { in: ["PENDING", "FAILED"] },
        }),
        data: expect.objectContaining({
          status: "PROCESSING",
          attempts: { increment: 1 },
        }),
      }),
    )
    expect(prismaMock.payoutWebhookEvent.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          id: "inbox-1",
          status: "PROCESSING",
          attempts: 1,
          lockedAt: expect.any(Date),
        },
        data: expect.objectContaining({ status: "PROCESSED" }),
      }),
    )
    expect(wakeupMock.wake).not.toHaveBeenCalled()
  })

  it("treats a processed account update replay as an exact no-op", async () => {
    process.env.FINANCE_RUNTIME_MODE = "locked"
    prismaMock.payoutWebhookEvent.create.mockRejectedValue({ code: "P2002" })
    prismaMock.payoutWebhookEvent.findUnique
      .mockResolvedValueOnce(accountEnvelope())
      .mockResolvedValueOnce({
        status: "PROCESSED",
        availableAt: new Date(0),
        lockedAt: null,
      })
    const stripeConnect = { syncAccount: jest.fn() }
    controller = new PayoutWebhookController(
      prismaMock,
      wakeupMock,
      stripeConnect as any,
    )
    const payload = stripeAccountPayload()

    await expect(deliverConnectedStripe(payload)).resolves.toMatchObject({
      eventId: "inbox-1",
      duplicate: true,
      accountSynced: true,
    })

    expect(stripeConnect.syncAccount).not.toHaveBeenCalled()
    expect(prismaMock.payoutWebhookEvent.updateMany).not.toHaveBeenCalled()
  })

  it("marks account sync failures retryable and returns non-2xx", async () => {
    process.env.FINANCE_RUNTIME_MODE = "normal"
    prismaMock.payoutWebhookEvent.findUnique
      .mockResolvedValueOnce({ status: "PENDING" })
      .mockResolvedValueOnce({
        status: "PENDING",
        attempts: 0,
        availableAt: new Date(0),
        lockedAt: null,
      })
    const stripeConnect = {
      syncAccount: jest
        .fn()
        .mockRejectedValue(new TypeError("provider secret")),
    }
    controller = new PayoutWebhookController(
      prismaMock,
      wakeupMock,
      stripeConnect as any,
    )
    const payload = stripeAccountPayload()

    await expect(deliverConnectedStripe(payload)).rejects.toThrow(
      ServiceUnavailableException,
    )

    expect(prismaMock.payoutWebhookEvent.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: "inbox-1",
        status: "PROCESSING",
        attempts: 1,
        lockedAt: expect.any(Date),
      },
      data: expect.objectContaining({
        status: "FAILED",
        lockedAt: null,
        processedAt: null,
        lastError: "TypeError",
      }),
    })
    expect(
      JSON.stringify(prismaMock.payoutWebhookEvent.updateMany.mock.calls),
    ).not.toContain("provider secret")
  })

  it("does not duplicate an account sync while another fresh lease owns the event", async () => {
    process.env.FINANCE_RUNTIME_MODE = "normal"
    prismaMock.payoutWebhookEvent.findUnique
      .mockResolvedValueOnce({ status: "PROCESSING" })
      .mockResolvedValueOnce({
        status: "PROCESSING",
        attempts: 1,
        availableAt: new Date(0),
        lockedAt: new Date(),
      })
    const stripeConnect = { syncAccount: jest.fn() }
    controller = new PayoutWebhookController(
      prismaMock,
      wakeupMock,
      stripeConnect as any,
    )
    const payload = stripeAccountPayload()

    await expect(deliverConnectedStripe(payload)).rejects.toThrow(
      ServiceUnavailableException,
    )

    expect(stripeConnect.syncAccount).not.toHaveBeenCalled()
    expect(prismaMock.payoutWebhookEvent.updateMany).not.toHaveBeenCalled()
  })

  it("fences a recovered stale account lease with a new attempt identity", async () => {
    process.env.FINANCE_RUNTIME_MODE = "recovery_only"
    prismaMock.payoutWebhookEvent.findUnique
      .mockResolvedValueOnce({ status: "PROCESSING" })
      .mockResolvedValueOnce({
        status: "PROCESSING",
        attempts: 1,
        availableAt: new Date(0),
        lockedAt: new Date(Date.now() - 16 * 60 * 1000),
      })
    const stripeConnect = { syncAccount: jest.fn().mockResolvedValue({}) }
    controller = new PayoutWebhookController(
      prismaMock,
      wakeupMock,
      stripeConnect as any,
    )
    const payload = stripeAccountPayload()

    await expect(deliverConnectedStripe(payload)).resolves.toMatchObject({
      eventId: "inbox-1",
      accountSynced: true,
    })

    expect(prismaMock.payoutWebhookEvent.update).toHaveBeenCalledWith({
      where: { id: "inbox-1" },
      data: expect.objectContaining({
        status: "FAILED",
        lastError: "StaleAccountSyncLeaseRecovered",
      }),
    })
    expect(stripeConnect.syncAccount).toHaveBeenCalledWith(
      "acct_managed1",
      expect.objectContaining({
        claimAttempt: 2,
        claimLockedAt: expect.any(String),
      }),
    )
    expect(prismaMock.payoutWebhookEvent.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "inbox-1",
          status: "PROCESSING",
          attempts: 2,
          lockedAt: expect.any(Date),
        }),
        data: expect.objectContaining({ status: "PROCESSED" }),
      }),
    )
  })
})
