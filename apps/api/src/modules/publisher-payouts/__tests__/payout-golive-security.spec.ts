import { createHmac, createSign, generateKeyPairSync } from "node:crypto"
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/client"
import * as stripeClient from "../../../common/stripe-client"
import { PayoutExecutionService } from "../payout-execution.service"
import { PayoutWebhookController } from "../payout-webhook.controller"
import { PayoutProviderResponseMismatchError } from "../providers/payout-provider.interface"
import { StripeConnectPayoutAdapter } from "../providers/stripe-connect-payout.adapter"
import {
  idempotencyKeyToUuid,
  WisePayoutAdapter,
} from "../providers/wise-payout.adapter"

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
  process.env = { ...ORIGINAL_ENV }
})

describe("PayoutWebhookController — signature verification", () => {
  let controller: PayoutWebhookController
  let prismaMock: any
  let wakeupMock: any

  // Default test payload — Wise-shape (data.id), used by both providers via
  // normalizeProviderWebhook's envelope-or-inner tolerance. The Stripe-specific
  // "queues a correctly signed Stripe webhook" test overrides with the real
  // Stripe envelope shape so the Phase 8.3 jobId dedup path is exercised.
  // occurred_at is required for Wise replay protection (M-2 pen test fix).
  const payload = JSON.stringify({
    occurred_at: new Date().toISOString(),
    data: { id: "transfer-1", status: "COMPLETED" },
    event: "transfer.state-change",
  })
  const rawBody = Buffer.from(payload, "utf8")
  const stripePlatformPayload = JSON.stringify({
    id: "evt_platform_test",
    type: "transfer.updated",
    livemode: false,
    data: { object: { id: "tr_platform_test", status: "pending" } },
  })
  const stripePlatformRawBody = Buffer.from(stripePlatformPayload, "utf8")

  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = "rk_test_webhook"
    process.env.STRIPE_LIVE_MODE_ENABLED = "false"
    process.env.STRIPE_PAYOUT_WEBHOOK_SECRET = "whsec_platform_test"
    process.env.STRIPE_CONNECTED_PAYOUT_WEBHOOK_SECRET = "whsec_connected_test"
    prismaMock = {
      payoutWebhookEvent: {
        create: jest.fn().mockResolvedValue({ id: "event-1" }),
        findUnique: jest.fn().mockResolvedValue({ id: "event-1" }),
      },
    }
    wakeupMock = { wake: jest.fn().mockResolvedValue(undefined) }
    controller = new PayoutWebhookController(prismaMock, wakeupMock)
  })

  function stripeSig(
    secret: string,
    body: string,
    timestamp = Math.floor(Date.now() / 1000),
  ) {
    const v1 = createHmac("sha256", secret)
      .update(`${timestamp}.${body}`)
      .digest("hex")
    return `t=${timestamp},v1=${v1}`
  }

  it("rejects unsupported providers", async () => {
    await expect(
      controller.handleWebhook("paypal", {}, { rawBody } as any),
    ).rejects.toThrow(BadRequestException)
  })

  it("rejects Stripe webhook when no secret is configured (fail closed)", async () => {
    delete process.env.STRIPE_PAYOUT_WEBHOOK_SECRET
    delete process.env.STRIPE_CONNECTED_PAYOUT_WEBHOOK_SECRET
    delete process.env.STRIPE_WEBHOOK_SECRET
    await expect(
      controller.handleStripePlatformWebhook(
        { "stripe-signature": "t=1,v1=abc" },
        { rawBody: stripePlatformRawBody } as any,
      ),
    ).rejects.toThrow(ServiceUnavailableException)
    expect(prismaMock.payoutWebhookEvent.create).not.toHaveBeenCalled()
  })

  it("rejects Stripe webhook with missing signature header", async () => {
    await expect(
      controller.handleStripePlatformWebhook({}, {
        rawBody: stripePlatformRawBody,
      } as any),
    ).rejects.toThrow(UnauthorizedException)
    expect(prismaMock.payoutWebhookEvent.create).not.toHaveBeenCalled()
  })

  it("rejects Stripe webhook with a forged signature", async () => {
    const forged = stripeSig("wrong-secret", stripePlatformPayload)
    await expect(
      controller.handleStripePlatformWebhook({ "stripe-signature": forged }, {
        rawBody: stripePlatformRawBody,
      } as any),
    ).rejects.toThrow(UnauthorizedException)
    expect(prismaMock.payoutWebhookEvent.create).not.toHaveBeenCalled()
  })

  it("rejects Stripe webhook with a stale timestamp (replay protection)", async () => {
    const stale = stripeSig(
      "whsec_platform_test",
      stripePlatformPayload,
      Math.floor(Date.now() / 1000) - 3600,
    )
    await expect(
      controller.handleStripePlatformWebhook({ "stripe-signature": stale }, {
        rawBody: stripePlatformRawBody,
      } as any),
    ).rejects.toThrow(UnauthorizedException)
  })

  it("durably stores a correctly signed Stripe webhook before wake-up", async () => {
    // Use the real Stripe envelope shape so normalizeProviderWebhook extracts
    // data.object.id = "tr_phase83" → jobId = "payout-webhook:stripe_connect:tr_phase83".
    const stripePayload = JSON.stringify({
      id: "evt_phase83",
      type: "transfer.updated",
      livemode: false,
      data: { object: { id: "tr_phase83", status: "paid" } },
    })
    const stripeRaw = Buffer.from(stripePayload, "utf8")
    const sig = stripeSig("whsec_platform_test", stripePayload)
    const result = await controller.handleStripePlatformWebhook(
      { "stripe-signature": sig },
      { rawBody: stripeRaw } as any,
    )
    expect(result).toEqual({
      received: true,
      eventId: "event-1",
      duplicate: false,
    })
    expect(prismaMock.payoutWebhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider: "stripe_connect",
          providerExecutionId: "tr_phase83",
          providerStatus: "PROCESSING",
        }),
      }),
    )
    expect(wakeupMock.wake).toHaveBeenCalledWith("payout-webhook")
  })

  it("accepts the separate connected-account webhook signing secret", async () => {
    const body = JSON.stringify({
      id: "evt_connected_payout",
      type: "payout.paid",
      livemode: false,
      account: "acct_connectedtest",
      data: {
        object: {
          id: "po_connected",
          status: "paid",
          amount: 1000,
          currency: "usd",
        },
      },
    })

    await expect(
      controller.handleStripeConnectedWebhook(
        {
          "stripe-signature": stripeSig("whsec_connected_test", body),
        },
        { rawBody: Buffer.from(body) } as any,
      ),
    ).resolves.toMatchObject({ received: true })
    expect(prismaMock.payoutWebhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          providerExecutionId: "po_connected",
          providerStatus: "COMPLETED",
        }),
      }),
    )
  })

  it("rejects a signed Stripe event when its test/live mode is missing", async () => {
    const body = JSON.stringify({
      id: "evt_mode_missing",
      type: "payout.paid",
      account: "acct_modemissing",
      data: {
        object: {
          id: "po_1",
          status: "paid",
          amount: 1000,
          currency: "usd",
        },
      },
    })

    await expect(
      controller.handleStripeConnectedWebhook(
        {
          "stripe-signature": stripeSig("whsec_connected_test", body),
        },
        { rawBody: Buffer.from(body) } as any,
      ),
    ).rejects.toThrow(/mode does not match/i)
    expect(prismaMock.payoutWebhookEvent.create).not.toHaveBeenCalled()
  })

  it.each([
    undefined,
    "not-a-stripe-key",
  ])("rejects a signed test event when Stripe credential mode is %s", async (key) => {
    if (key === undefined) {
      delete process.env.STRIPE_SECRET_KEY
    } else {
      process.env.STRIPE_SECRET_KEY = key
    }
    const body = JSON.stringify({
      id: "evt_mode_unverifiable",
      type: "payout.paid",
      livemode: false,
      account: "acct_modeunverifiable",
      data: {
        object: {
          id: "po_1",
          status: "paid",
          amount: 1000,
          currency: "usd",
        },
      },
    })

    await expect(
      controller.handleStripeConnectedWebhook(
        {
          "stripe-signature": stripeSig("whsec_connected_test", body),
        },
        { rawBody: Buffer.from(body) } as any,
      ),
    ).rejects.toThrow(/mode does not match/i)
    expect(prismaMock.payoutWebhookEvent.create).not.toHaveBeenCalled()
  })

  it("rejects a signed live event while the explicit live-money gate is off", async () => {
    process.env.STRIPE_CONNECTED_PAYOUT_WEBHOOK_SECRET = "whsec_live"
    process.env.STRIPE_SECRET_KEY = "rk_live_webhook"
    process.env.STRIPE_LIVE_MODE_ENABLED = "false"
    const body = JSON.stringify({
      id: "evt_live_gate_off",
      type: "payout.paid",
      livemode: true,
      account: "acct_livegate",
      data: {
        object: {
          id: "po_1",
          status: "paid",
          amount: 1000,
          currency: "usd",
        },
      },
    })

    await expect(
      controller.handleStripeConnectedWebhook(
        { "stripe-signature": stripeSig("whsec_live", body) },
        { rawBody: Buffer.from(body) } as any,
      ),
    ).rejects.toThrow(/mode does not match/i)
    expect(prismaMock.payoutWebhookEvent.create).not.toHaveBeenCalled()
  })

  it("rejects Wise webhook when no public key is configured (fail closed)", async () => {
    delete process.env.WISE_WEBHOOK_PUBLIC_KEY
    await expect(
      controller.handleWebhook("wise", { "x-signature-sha256": "abc" }, {
        rawBody,
      } as any),
    ).rejects.toThrow(ServiceUnavailableException)
  })

  it("rejects Wise webhook with a forged signature and queues a valid one", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    })
    process.env.WISE_WEBHOOK_PUBLIC_KEY = publicKey
      .export({ type: "spki", format: "pem" })
      .toString()

    await expect(
      controller.handleWebhook(
        "wise",
        { "x-signature-sha256": Buffer.from("forged").toString("base64") },
        { rawBody } as any,
      ),
    ).rejects.toThrow(UnauthorizedException)
    expect(prismaMock.payoutWebhookEvent.create).not.toHaveBeenCalled()

    const signer = createSign("RSA-SHA256")
    signer.update(rawBody)
    const signature = signer.sign(privateKey, "base64")

    const result = await controller.handleWebhook(
      "wise",
      { "x-signature-sha256": signature },
      { rawBody } as any,
    )
    expect(result).toEqual({
      received: true,
      eventId: "event-1",
      duplicate: false,
    })
    expect(prismaMock.payoutWebhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider: "wise",
          providerExecutionId: "transfer-1",
        }),
      }),
    )
  })

  // ─── M-2: Wise stale-timestamp boundary tests ─────────────────────
  // Mirrors the Stripe replay-protection test above. Tolerance is 300s;
  // ageSeconds > 300 is rejected, ≤ 300 is accepted (past and future are
  // symmetric via Math.abs).

  it("accepts Wise webhook with timestamp just inside the 300s tolerance (299s past)", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    })
    process.env.WISE_WEBHOOK_PUBLIC_KEY = publicKey
      .export({ type: "spki", format: "pem" })
      .toString()

    const body = JSON.stringify({
      occurred_at: new Date(Date.now() - 299_000).toISOString(),
      data: { id: "transfer-299", status: "COMPLETED" },
      event: "transfer.state-change",
    })
    const raw = Buffer.from(body, "utf8")
    const signer = createSign("RSA-SHA256")
    signer.update(raw)
    const signature = signer.sign(privateKey, "base64")

    const result = await controller.handleWebhook(
      "wise",
      { "x-signature-sha256": signature },
      { rawBody: raw } as any,
    )
    expect(result).toEqual({
      received: true,
      eventId: "event-1",
      duplicate: false,
    })
    expect(prismaMock.payoutWebhookEvent.create).toHaveBeenCalled()
  })

  it("accepts Wise webhook at the exact 300s tolerance boundary", async () => {
    const now = new Date("2026-07-18T00:00:00.000Z")
    jest.useFakeTimers()
    jest.setSystemTime(now)

    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    })
    process.env.WISE_WEBHOOK_PUBLIC_KEY = publicKey
      .export({ type: "spki", format: "pem" })
      .toString()

    const body = JSON.stringify({
      occurred_at: new Date(now.getTime() - 300_000).toISOString(),
      data: { id: "transfer-300", status: "COMPLETED" },
      event: "transfer.state-change",
    })
    const raw = Buffer.from(body, "utf8")
    const signer = createSign("RSA-SHA256")
    signer.update(raw)
    const signature = signer.sign(privateKey, "base64")

    const result = await controller.handleWebhook(
      "wise",
      { "x-signature-sha256": signature },
      { rawBody: raw } as any,
    )
    expect(result).toEqual({
      received: true,
      eventId: "event-1",
      duplicate: false,
    })
  })

  it("rejects Wise webhook with timestamp just outside the 300s tolerance (301s past)", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    })
    process.env.WISE_WEBHOOK_PUBLIC_KEY = publicKey
      .export({ type: "spki", format: "pem" })
      .toString()

    const body = JSON.stringify({
      occurred_at: new Date(Date.now() - 301_000).toISOString(),
      data: { id: "transfer-301", status: "COMPLETED" },
      event: "transfer.state-change",
    })
    const raw = Buffer.from(body, "utf8")
    const signer = createSign("RSA-SHA256")
    signer.update(raw)
    const signature = signer.sign(privateKey, "base64")

    await expect(
      controller.handleWebhook("wise", { "x-signature-sha256": signature }, {
        rawBody: raw,
      } as any),
    ).rejects.toThrow(UnauthorizedException)
    expect(prismaMock.payoutWebhookEvent.create).not.toHaveBeenCalled()
  })

  it("rejects Wise webhook with a future timestamp outside tolerance (+301s)", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    })
    process.env.WISE_WEBHOOK_PUBLIC_KEY = publicKey
      .export({ type: "spki", format: "pem" })
      .toString()

    const body = JSON.stringify({
      occurred_at: new Date(Date.now() + 301_000).toISOString(),
      data: { id: "transfer-future", status: "COMPLETED" },
      event: "transfer.state-change",
    })
    const raw = Buffer.from(body, "utf8")
    const signer = createSign("RSA-SHA256")
    signer.update(raw)
    const signature = signer.sign(privateKey, "base64")

    await expect(
      controller.handleWebhook("wise", { "x-signature-sha256": signature }, {
        rawBody: raw,
      } as any),
    ).rejects.toThrow(UnauthorizedException)
    expect(prismaMock.payoutWebhookEvent.create).not.toHaveBeenCalled()
  })
})

describe("Provider adapters — idempotency and production safety", () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = "rk_test_adapter"
    process.env.STRIPE_LIVE_MODE_ENABLED = "false"
  })

  it("derives a deterministic UUID-shaped customerTransactionId from the idempotency key", () => {
    const a = idempotencyKeyToUuid("payout-wd-1-v3")
    const b = idempotencyKeyToUuid("payout-wd-1-v3")
    const c = idempotencyKeyToUuid("payout-wd-1-v4")
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it("Wise adapter sends customerTransactionId to the API", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 123, fee: { amount: 1 } }),
    })
    global.fetch = fetchMock as any

    const adapter = new WisePayoutAdapter()
    await adapter.createTransfer({
      amount: 100,
      currency: "usd",
      recipientDetails: { recipientId: "r-1" },
      providerConfig: { apiKey: "wise-key" },
      idempotencyKey: "payout-wd-1-v0",
      description: "test",
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.customerTransactionId).toBe(
      idempotencyKeyToUuid("payout-wd-1-v0"),
    )
    expect(body.idempotencyKey).toBeUndefined()
  })

  it("Stripe adapter sends the Idempotency-Key header, not a body field", async () => {
    const create = jest.fn().mockResolvedValue({
      id: "tr_1",
      amount: 10_000,
      currency: "usd",
      livemode: false,
      destination: "acct_1",
      metadata: { withdrawal_reference: "GP-WD-0001" },
    })
    jest.spyOn(stripeClient, "getStripeClient").mockReturnValue({
      transfers: { create },
    } as any)

    const adapter = new StripeConnectPayoutAdapter()
    await adapter.createTransfer({
      amount: 100,
      currency: "usd",
      recipientDetails: {
        connectedAccountId: "acct_1",
        publicReference: "GP-WD-0001",
      },
      providerConfig: { apiKey: "sk_test" },
      idempotencyKey: "payout-wd-1-v0",
      description: "test",
    })

    expect(create).toHaveBeenCalledWith(
      expect.not.objectContaining({ idempotency_key: expect.anything() }),
      { idempotencyKey: "payout-wd-1-v0" },
    )
  })

  it("rejects a Stripe Transfer response for a different connected account", async () => {
    const create = jest.fn().mockResolvedValue({
      id: "tr_1",
      livemode: false,
      amount: 10_000,
      currency: "usd",
      destination: "acct_wrong",
      metadata: { withdrawal_reference: "GP-WD-0001" },
    })
    jest.spyOn(stripeClient, "getStripeClient").mockReturnValue({
      transfers: { create },
    } as any)

    const adapter = new StripeConnectPayoutAdapter()
    let rejection: unknown
    try {
      await adapter.createTransfer({
        amount: 100,
        currency: "USD",
        recipientDetails: {
          connectedAccountId: "acct_1",
          publicReference: "GP-WD-0001",
        },
        providerConfig: { apiKey: "sk_test" },
        idempotencyKey: "payout-wd-1-v0",
        description: "test",
      })
    } catch (error) {
      rejection = error
    }
    expect(rejection).toBeInstanceOf(PayoutProviderResponseMismatchError)
    expect(rejection).toMatchObject({
      code: "PAYOUT_PROVIDER_RESPONSE_MISMATCH",
      responseKind: "STRIPE_TRANSFER",
    })
    expect(String((rejection as Error).message)).toMatch(
      /does not match the immutable payout command/i,
    )
  })

  it("keeps a Stripe Transfer processing and creates a distinct bank Payout", async () => {
    const createPayout = jest.fn().mockResolvedValue({
      id: "po_1",
      status: "pending",
      livemode: false,
      amount: 10_000,
      currency: "usd",
      metadata: { withdrawal_reference: "GP-WD-1234" },
      statement_descriptor: "GP1234",
      arrival_date: 1_800_000_000,
    })
    jest.spyOn(stripeClient, "getStripeClient").mockReturnValue({
      payouts: { create: createPayout },
    } as any)

    const adapter = new StripeConnectPayoutAdapter()
    await expect(adapter.checkTransferStatus("tr_1")).resolves.toMatchObject({
      status: "PROCESSING",
      metadata: { stage: "TRANSFER_CREATED" },
    })
    const result = await adapter.createBankPayout({
      amount: 100,
      currency: "USD",
      connectedAccountId: "acct_1",
      idempotencyKey: "payout-bank-wd-1-v1",
      description: "GuestPost payout GP-WD-1234",
      statementDescriptor: "GP1234",
      publicReference: "GP-WD-1234",
    })

    expect(result).toMatchObject({
      providerExecutionId: "po_1",
      providerPayoutId: "po_1",
      status: "PROCESSING",
    })
    expect(createPayout).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 10_000,
        currency: "usd",
        statement_descriptor: "GP1234",
      }),
      {
        stripeAccount: "acct_1",
        idempotencyKey: "payout-bank-wd-1-v1",
      },
    )
  })

  it("rejects a Stripe Payout response with mismatched immutable evidence", async () => {
    const createPayout = jest.fn().mockResolvedValue({
      id: "po_1",
      status: "pending",
      livemode: false,
      amount: 9_999,
      currency: "usd",
      metadata: { withdrawal_reference: "GP-WD-1234" },
      statement_descriptor: "GP1234",
    })
    jest.spyOn(stripeClient, "getStripeClient").mockReturnValue({
      payouts: { create: createPayout },
    } as any)

    const adapter = new StripeConnectPayoutAdapter()
    await expect(
      adapter.createBankPayout({
        amount: 100,
        currency: "USD",
        connectedAccountId: "acct_1",
        idempotencyKey: "payout-bank-wd-1-v1",
        description: "GuestPost payout GP-WD-1234",
        statementDescriptor: "GP1234",
        publicReference: "GP-WD-1234",
      }),
    ).rejects.toThrow(/does not match the immutable payout command/i)
  })

  it("requires an enabled, manually scheduled Stripe recipient", async () => {
    const adapter = new StripeConnectPayoutAdapter()
    await expect(
      adapter.validateRecipient({
        connectedAccountId: "acct_1",
        providerAccountStatus: "RESTRICTED",
        payoutScheduleConfigured: false,
      }),
    ).resolves.toMatchObject({ valid: false })
    await expect(
      adapter.validateRecipient({
        connectedAccountId: "acct_1",
        providerAccountStatus: "ENABLED",
        payoutScheduleConfigured: true,
      }),
    ).resolves.toEqual({ valid: true })
  })

  it("refuses mock transfers in production when API keys are missing", async () => {
    process.env.NODE_ENV = "production"
    delete process.env.WISE_API_KEY
    delete process.env.STRIPE_SECRET_KEY

    const wise = new WisePayoutAdapter()
    const stripe = new StripeConnectPayoutAdapter()
    const params = {
      amount: 100,
      currency: "usd",
      recipientDetails: {
        connectedAccountId: "acct_1",
        publicReference: "GP-WD-0001",
      },
      providerConfig: {},
      idempotencyKey: "k",
      description: "",
    }

    await expect(wise.createTransfer(params as any)).rejects.toThrow(
      /WISE_API_KEY/,
    )
    await expect(stripe.createTransfer(params as any)).rejects.toThrow(
      /disabled/,
    )
    await expect(wise.checkTransferStatus("t-1")).rejects.toThrow(
      /WISE_API_KEY/,
    )
    await expect(stripe.checkTransferStatus("tr_1")).resolves.toMatchObject({
      status: "PROCESSING",
    })
    await expect(wise.cancelTransfer("t-1", "test-key")).rejects.toThrow(
      /WISE_API_KEY/,
    )
    await expect(stripe.cancelTransfer("tr_1", "test-key")).rejects.toThrow(
      /required for recovery/,
    )
  })

  it("Stripe adapter sends the Idempotency-Key header on cancelTransfer", async () => {
    const createReversal = jest.fn().mockResolvedValue({
      id: "trr_1",
      object: "transfer_reversal",
      transfer: "tr_1",
      created: 1_700_000_000,
      amount: 10_000,
      currency: "usd",
      metadata: {
        withdrawal_reference: "GP-WD-0001",
        payout_execution_id: "exec-1",
      },
    })
    const retrieve = jest.fn().mockResolvedValue({
      id: "tr_1",
      amount: 10_000,
      currency: "usd",
      destination: "acct_1",
      metadata: { withdrawal_reference: "GP-WD-0001" },
      livemode: false,
      reversed: false,
      amount_reversed: 0,
    })
    jest.spyOn(stripeClient, "getStripeRecoveryClient").mockReturnValue({
      transfers: { retrieve, createReversal },
    } as any)

    const adapter = new StripeConnectPayoutAdapter()
    const result = await adapter.cancelTransfer(
      "tr_1",
      "payout-cancel-exec-1",
      {
        payoutExecutionId: "exec-1",
        connectedAccountId: "acct_1",
        providerTransferId: "tr_1",
        expectedAmountMinor: 10_000,
        expectedCurrency: "USD",
        expectedPublicReference: "GP-WD-0001",
      },
    )

    expect(result).toMatchObject({
      success: true,
      providerExecutionId: "tr_1",
      livemode: false,
      metadata: {
        reversalId: "trr_1",
        transferId: "tr_1",
        providerAmountMinor: 10_000,
        providerCurrency: "USD",
        livemode: false,
      },
    })

    expect(createReversal).toHaveBeenCalledWith(
      "tr_1",
      {
        amount: 10_000,
        metadata: {
          withdrawal_reference: "GP-WD-0001",
          payout_execution_id: "exec-1",
        },
      },
      {
        idempotencyKey: "payout-cancel-exec-1-transfer",
      },
    )
  })

  it("recovers an authenticated reversal after a crash without creating a second reversal", async () => {
    const recoveredReversal = {
      id: "trr_recovered",
      object: "transfer_reversal",
      transfer: "tr_1",
      created: 1_700_000_000,
      amount: 10_000,
      currency: "usd",
      metadata: {
        withdrawal_reference: "GP-WD-0001",
        payout_execution_id: "exec-1",
      },
    }
    const createReversal = jest.fn()
    const listReversals = jest.fn().mockResolvedValue({
      object: "list",
      data: [recoveredReversal],
      has_more: false,
      url: "/v1/transfers/tr_1/reversals",
    })
    jest.spyOn(stripeClient, "getStripeRecoveryClient").mockReturnValue({
      transfers: {
        retrieve: jest.fn().mockResolvedValue({
          id: "tr_1",
          amount: 10_000,
          currency: "usd",
          destination: "acct_1",
          metadata: { withdrawal_reference: "GP-WD-0001" },
          livemode: false,
          reversed: true,
          amount_reversed: 10_000,
        }),
        listReversals,
        createReversal,
      },
    } as any)

    const adapter = new StripeConnectPayoutAdapter()
    await expect(
      adapter.cancelTransfer("tr_1", "payout-cancel-exec-1", {
        payoutExecutionId: "exec-1",
        connectedAccountId: "acct_1",
        providerTransferId: "tr_1",
        expectedAmountMinor: 10_000,
        expectedCurrency: "USD",
        expectedPublicReference: "GP-WD-0001",
      }),
    ).resolves.toMatchObject({
      success: true,
      livemode: false,
      metadata: {
        reversalId: "trr_recovered",
        reversalRecovered: true,
        livemode: false,
      },
    })

    expect(listReversals).toHaveBeenCalledWith("tr_1", { limit: 100 })
    expect(createReversal).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: "partial reversal state",
      transfer: { reversed: false, amount_reversed: 5_000 },
      reversals: { data: [], has_more: false },
    },
    {
      name: "truncated reversal list",
      transfer: { reversed: true, amount_reversed: 10_000 },
      reversals: {
        data: [
          {
            id: "trr_1",
            object: "transfer_reversal",
            transfer: "tr_1",
            created: 1_700_000_000,
            amount: 10_000,
            currency: "usd",
            metadata: {
              withdrawal_reference: "GP-WD-0001",
              payout_execution_id: "exec-1",
            },
          },
        ],
        has_more: true,
      },
    },
    {
      name: "multiple reversals",
      transfer: { reversed: true, amount_reversed: 10_000 },
      reversals: {
        data: [
          {
            id: "trr_1",
            object: "transfer_reversal",
            transfer: "tr_1",
            created: 1_700_000_000,
            amount: 5_000,
            currency: "usd",
            metadata: {
              withdrawal_reference: "GP-WD-0001",
              payout_execution_id: "exec-1",
            },
          },
          {
            id: "trr_2",
            object: "transfer_reversal",
            transfer: "tr_1",
            created: 1_700_000_001,
            amount: 5_000,
            currency: "usd",
            metadata: {
              withdrawal_reference: "GP-WD-0001",
              payout_execution_id: "exec-1",
            },
          },
        ],
        has_more: false,
      },
    },
    {
      name: "mismatched reversal metadata",
      transfer: { reversed: true, amount_reversed: 10_000 },
      reversals: {
        data: [
          {
            id: "trr_1",
            object: "transfer_reversal",
            transfer: "tr_1",
            created: 1_700_000_000,
            amount: 10_000,
            currency: "usd",
            metadata: {
              withdrawal_reference: "GP-WD-WRONG",
              payout_execution_id: "exec-1",
            },
          },
        ],
        has_more: false,
      },
    },
  ])("fails closed for $name without creating another reversal", async (input) => {
    const createReversal = jest.fn()
    const listReversals = jest.fn().mockResolvedValue({
      object: "list",
      url: "/v1/transfers/tr_1/reversals",
      ...input.reversals,
    })
    jest.spyOn(stripeClient, "getStripeRecoveryClient").mockReturnValue({
      transfers: {
        retrieve: jest.fn().mockResolvedValue({
          id: "tr_1",
          amount: 10_000,
          currency: "usd",
          destination: "acct_1",
          metadata: { withdrawal_reference: "GP-WD-0001" },
          livemode: false,
          ...input.transfer,
        }),
        listReversals,
        createReversal,
      },
    } as any)

    const adapter = new StripeConnectPayoutAdapter()
    await expect(
      adapter.cancelTransfer("tr_1", "payout-cancel-exec-1", {
        payoutExecutionId: "exec-1",
        connectedAccountId: "acct_1",
        providerTransferId: "tr_1",
        expectedAmountMinor: 10_000,
        expectedCurrency: "USD",
        expectedPublicReference: "GP-WD-0001",
      }),
    ).rejects.toThrow(/reversal/i)

    expect(createReversal).not.toHaveBeenCalled()
  })

  it("performs no cancellation mutation when the retrieved Stripe Transfer mismatches the immutable route", async () => {
    const createReversal = jest.fn()
    const cancelPayout = jest.fn()
    jest.spyOn(stripeClient, "getStripeRecoveryClient").mockReturnValue({
      transfers: {
        retrieve: jest.fn().mockResolvedValue({
          id: "tr_1",
          amount: 10_000,
          currency: "usd",
          destination: "acct_attacker",
          metadata: { withdrawal_reference: "GP-WD-0001" },
          livemode: false,
        }),
        createReversal,
      },
      payouts: { cancel: cancelPayout },
    } as any)

    const adapter = new StripeConnectPayoutAdapter()
    await expect(
      adapter.cancelTransfer("tr_1", "payout-cancel-exec-1", {
        payoutExecutionId: "exec-1",
        connectedAccountId: "acct_1",
        providerTransferId: "tr_1",
        expectedAmountMinor: 10_000,
        expectedCurrency: "USD",
        expectedPublicReference: "GP-WD-0001",
      }),
    ).rejects.toThrow(/does not match the immutable payout command/i)

    expect(cancelPayout).not.toHaveBeenCalled()
    expect(createReversal).not.toHaveBeenCalled()
  })

  it("rejects a Stripe Transfer mode mismatch before creating a reversal", async () => {
    const createReversal = jest.fn()
    jest.spyOn(stripeClient, "getStripeRecoveryClient").mockReturnValue({
      transfers: {
        retrieve: jest.fn().mockResolvedValue({
          id: "tr_1",
          amount: 10_000,
          currency: "usd",
          destination: "acct_1",
          metadata: { withdrawal_reference: "GP-WD-0001" },
          livemode: true,
        }),
        createReversal,
      },
    } as any)

    const adapter = new StripeConnectPayoutAdapter()
    await expect(
      adapter.cancelTransfer("tr_1", "payout-cancel-exec-1", {
        payoutExecutionId: "exec-1",
        connectedAccountId: "acct_1",
        providerTransferId: "tr_1",
        expectedAmountMinor: 10_000,
        expectedCurrency: "USD",
        expectedPublicReference: "GP-WD-0001",
      }),
    ).rejects.toThrow(/mode does not match/i)

    expect(createReversal).not.toHaveBeenCalled()
  })

  it("rejects a Stripe Payout mode mismatch before any payout cancellation or transfer reversal", async () => {
    const createReversal = jest.fn()
    const cancelPayout = jest.fn()
    jest.spyOn(stripeClient, "getStripeRecoveryClient").mockReturnValue({
      transfers: {
        retrieve: jest.fn().mockResolvedValue({
          id: "tr_1",
          amount: 10_000,
          currency: "usd",
          destination: "acct_1",
          metadata: { withdrawal_reference: "GP-WD-0001" },
          livemode: false,
          reversed: false,
          amount_reversed: 0,
        }),
        createReversal,
      },
      payouts: {
        retrieve: jest.fn().mockResolvedValue({
          id: "po_1",
          amount: 10_000,
          currency: "usd",
          status: "pending",
          metadata: { withdrawal_reference: "GP-WD-0001" },
          livemode: true,
        }),
        cancel: cancelPayout,
      },
    } as any)

    const adapter = new StripeConnectPayoutAdapter()
    await expect(
      adapter.cancelTransfer("tr_1", "payout-cancel-exec-1", {
        payoutExecutionId: "exec-1",
        connectedAccountId: "acct_1",
        providerTransferId: "tr_1",
        providerPayoutId: "po_1",
        expectedAmountMinor: 10_000,
        expectedCurrency: "USD",
        expectedPublicReference: "GP-WD-0001",
      }),
    ).rejects.toThrow(/mode does not match/i)

    expect(cancelPayout).not.toHaveBeenCalled()
    expect(createReversal).not.toHaveBeenCalled()
  })

  it("rejects a mismatched canceled Payout response before creating a transfer reversal", async () => {
    const createReversal = jest.fn()
    const cancelPayout = jest.fn().mockResolvedValue({
      id: "po_1",
      amount: 10_000,
      currency: "usd",
      status: "canceled",
      metadata: { withdrawal_reference: "GP-WD-0001" },
      livemode: true,
    })
    jest.spyOn(stripeClient, "getStripeRecoveryClient").mockReturnValue({
      transfers: {
        retrieve: jest.fn().mockResolvedValue({
          id: "tr_1",
          amount: 10_000,
          currency: "usd",
          destination: "acct_1",
          metadata: { withdrawal_reference: "GP-WD-0001" },
          livemode: false,
          reversed: false,
          amount_reversed: 0,
        }),
        createReversal,
      },
      payouts: {
        retrieve: jest.fn().mockResolvedValue({
          id: "po_1",
          amount: 10_000,
          currency: "usd",
          status: "pending",
          metadata: { withdrawal_reference: "GP-WD-0001" },
          livemode: false,
        }),
        cancel: cancelPayout,
      },
    } as any)

    const adapter = new StripeConnectPayoutAdapter()
    await expect(
      adapter.cancelTransfer("tr_1", "payout-cancel-exec-1", {
        payoutExecutionId: "exec-1",
        connectedAccountId: "acct_1",
        providerTransferId: "tr_1",
        providerPayoutId: "po_1",
        expectedAmountMinor: 10_000,
        expectedCurrency: "USD",
        expectedPublicReference: "GP-WD-0001",
      }),
    ).rejects.toThrow(/mode does not match/i)

    expect(cancelPayout).toHaveBeenCalledTimes(1)
    expect(createReversal).not.toHaveBeenCalled()
  })

  it("performs no cancellation mutation when the retrieved Stripe Payout mismatches the immutable command", async () => {
    const createReversal = jest.fn()
    const cancelPayout = jest.fn()
    jest.spyOn(stripeClient, "getStripeRecoveryClient").mockReturnValue({
      transfers: {
        retrieve: jest.fn().mockResolvedValue({
          id: "tr_1",
          amount: 10_000,
          currency: "usd",
          destination: "acct_1",
          metadata: { withdrawal_reference: "GP-WD-0001" },
          livemode: false,
          reversed: false,
          amount_reversed: 0,
        }),
        createReversal,
      },
      payouts: {
        retrieve: jest.fn().mockResolvedValue({
          id: "po_1",
          amount: 9_999,
          currency: "usd",
          status: "pending",
          metadata: { withdrawal_reference: "GP-WD-0001" },
          livemode: false,
        }),
        cancel: cancelPayout,
      },
    } as any)

    const adapter = new StripeConnectPayoutAdapter()
    await expect(
      adapter.cancelTransfer("tr_1", "payout-cancel-exec-1", {
        payoutExecutionId: "exec-1",
        connectedAccountId: "acct_1",
        providerTransferId: "tr_1",
        providerPayoutId: "po_1",
        expectedAmountMinor: 10_000,
        expectedCurrency: "USD",
        expectedPublicReference: "GP-WD-0001",
      }),
    ).rejects.toThrow(/does not match the immutable payout command/i)

    expect(cancelPayout).not.toHaveBeenCalled()
    expect(createReversal).not.toHaveBeenCalled()
  })
})

describe("PayoutExecutionService.retryExecution — double-payment prevention", () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = "rk_test_retry_execution"
    process.env.STRIPE_LIVE_MODE_ENABLED = "false"
  })

  const failedExecution = {
    id: "exec-1",
    status: "FAILED",
    withdrawalId: "wd-1",
    providerExecutionId: "transfer-9",
    providerTransferId: null,
    providerPayoutId: null,
    stage: "PROVIDER_SENT",
    livemode: null,
    version: 1,
    amount: new Decimal(100),
    fee: new Decimal(0),
    sourceCurrency: "USD",
    destinationCurrency: "USD",
    destinationAmount: new Decimal(100),
    completionSource: null,
    completionEvidenceRef: null,
    completionEvidenceAt: null,
    completedAt: null,
    completionActorUserId: null,
    completionWebhookEventId: null,
    createdAt: new Date(),
    withdrawal: {
      id: "wd-1",
      status: "FAILED",
      version: 2,
      publisherId: "pub-1",
      publicReference: "GP-WD-0001",
      publisher: { organizationId: "org-1" },
      amount: new Decimal(100),
      netAmount: new Decimal(100),
      currency: "USD",
      allocations: [
        {
          amount: new Decimal(100),
          currency: "USD",
          releasedAt: null,
        },
      ],
    },
    provider: { id: "prov-1", name: "wise" },
  }

  function makeService(
    providerStatus: {
      status: string
      fee?: number
      providerAmountMinor?: number
      providerCurrency?: string
      livemode?: boolean
      metadata?: Record<string, unknown>
    },
    executionOverride: Record<string, unknown> = {},
  ) {
    const auditMock = { log: jest.fn().mockResolvedValue(undefined) }
    const prismaMock: any = {
      payoutExecution: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ ...failedExecution, ...executionOverride }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      withdrawal: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn(),
      },
      staffMembership: {
        findFirst: jest.fn().mockResolvedValue({ id: "staff-membership-1" }),
        findMany: jest.fn().mockResolvedValue([{ userId: "finance-2" }]),
      },
      notification: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      publisherBalance: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ publisherId: "pub-1", version: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      $queryRaw: jest
        .fn()
        .mockResolvedValue([{ publisherId: "pub-1", version: 1 }]),
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: "locked" }]),
      $transaction: jest
        .fn()
        .mockImplementation(async (cb: any) => cb(prismaMock)),
    }
    const adapterMock = {
      checkTransferStatus: jest.fn().mockResolvedValue(providerStatus),
      createTransfer: jest.fn(),
      cancelTransfer: jest.fn(),
      capabilities: { supportsCancellation: true },
    }
    const providerMock = {
      getAdapter: jest.fn().mockReturnValue(adapterMock),
      getActiveProvider: jest
        .fn()
        .mockResolvedValue({ id: "prov-1", name: "wise", decryptedConfig: {} }),
    }
    const encryptionMock = {
      decrypt: jest.fn(),
      redactSensitive: jest.fn((s: string) => s),
    }
    const service = new PayoutExecutionService(
      prismaMock,
      auditMock as any,
      encryptionMock as any,
      providerMock as any,
    )
    return { service, prismaMock, auditMock, adapterMock }
  }

  it("recovers a provider-completed transfer instead of paying again", async () => {
    const { service, prismaMock, auditMock, adapterMock } = makeService({
      status: "COMPLETED",
      fee: 1.5,
      providerAmountMinor: 10_000,
      providerCurrency: "USD",
    })

    const result = await service.retryExecution(
      "exec-1",
      "staff-1",
      "Reviewed provider recovery evidence",
    )

    expect(result).toMatchObject({
      status: "COMPLETED",
      recoveredFromProvider: true,
    })
    expect(adapterMock.createTransfer).not.toHaveBeenCalled()
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PAYOUT_RECOVERY_REQUESTED",
        entityType: "PayoutExecution",
        entityId: "exec-1",
        userId: "staff-1",
        metadata: expect.objectContaining({
          reason: "Reviewed provider recovery evidence",
          withdrawalId: "wd-1",
          provider: "wise",
          stage: "PROVIDER_SENT",
        }),
      }),
      prismaMock,
    )
    expect(prismaMock.publisherBalance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lifetimePaid: { increment: new Decimal(100) },
        }),
      }),
    )
    const audit = prismaMock.auditLog.create.mock.calls.find(
      (c: any[]) => c[0].data.action === "PAYOUT_EXECUTION_COMPLETED",
    )
    expect(audit).toBeDefined()
  })

  it("refuses retry while the provider transfer is still processing", async () => {
    const { service, adapterMock } = makeService({ status: "PROCESSING" })

    await expect(
      service.retryExecution(
        "exec-1",
        "staff-1",
        "Reviewed provider recovery evidence",
      ),
    ).rejects.toThrow(ConflictException)
    expect(adapterMock.createTransfer).not.toHaveBeenCalled()
  })

  it("fails closed when provider outcome is ambiguous and no transfer id was recorded", async () => {
    const { service, adapterMock } = makeService(
      { status: "FAILED" },
      { providerExecutionId: null },
    )

    await expect(
      service.retryExecution(
        "exec-1",
        "staff-1",
        "Reviewed provider recovery evidence",
      ),
    ).rejects.toThrow(/new send is forbidden/)
    expect(adapterMock.checkTransferStatus).not.toHaveBeenCalled()
    expect(adapterMock.createTransfer).not.toHaveBeenCalled()
  })

  it("recovers a processing Stripe bank payout from provider truth without creating another payout", async () => {
    const stripeExecution = {
      status: "PROCESSING",
      stage: "BANK_PAYOUT_RECOVERY_REQUIRED",
      providerExecutionId: "po_1",
      providerTransferId: "tr_1",
      providerPayoutId: "po_1",
      livemode: false,
      providerMetadata: {
        destinationSnapshot: {
          providerAccountExternalId: "acct_1",
        },
      },
      provider: { id: "prov-stripe", name: "stripe_connect" },
      withdrawal: {
        ...failedExecution.withdrawal,
        status: "PROCESSING",
        payoutMethod: {
          providerAccount: { providerAccountId: "acct_1" },
        },
      },
    }
    const { service, adapterMock } = makeService(
      {
        status: "COMPLETED",
        providerAmountMinor: 10_000,
        providerCurrency: "USD",
        livemode: false,
        metadata: { livemode: false },
      },
      stripeExecution,
    )

    await expect(
      service.retryExecution(
        "exec-1",
        "staff-1",
        "Reviewed provider recovery evidence",
      ),
    ).resolves.toMatchObject({
      status: "COMPLETED",
      recoveredFromProvider: true,
    })
    expect(adapterMock.checkTransferStatus).toHaveBeenCalledWith("po_1", {
      connectedAccountId: "acct_1",
      providerTransferId: "tr_1",
      providerPayoutId: "po_1",
      expectedAmountMinor: 10_000,
      expectedCurrency: "USD",
      expectedPublicReference: "GP-WD-0001",
    })
    expect(adapterMock.createTransfer).not.toHaveBeenCalled()
  })

  it("uses the locked safe-abort path for a stranded pre-provider execution", async () => {
    const { service, adapterMock } = makeService(
      { status: "PROCESSING" },
      {
        status: "PROCESSING",
        stage: "CREATED",
        providerExecutionId: null,
        withdrawal: {
          ...failedExecution.withdrawal,
          status: "PROCESSING",
        },
      },
    )
    const abort = jest
      .spyOn(service as any, "abortPreProviderExecution")
      .mockResolvedValue({
        executionId: "exec-1",
        status: "CANCELLED",
        preProviderAbort: true,
      })

    await expect(
      service.cancelExecution(
        "exec-1",
        "staff-1",
        "Reviewed provider cancellation evidence",
      ),
    ).resolves.toMatchObject({
      status: "CANCELLED",
      preProviderAbort: true,
    })
    expect(abort).toHaveBeenCalledWith(
      "exec-1",
      "wd-1",
      "staff-1",
      expect.stringMatching(/stranded execution/i),
    )
    expect(adapterMock.checkTransferStatus).not.toHaveBeenCalled()
  })

  it("rejects a pre-provider abort when the cancellation actor is no longer eligible", async () => {
    const { service, prismaMock, adapterMock } = makeService(
      { status: "PROCESSING" },
      {
        status: "PROCESSING",
        stage: "CREATED",
        providerExecutionId: null,
        withdrawal: {
          ...failedExecution.withdrawal,
          status: "PROCESSING",
        },
      },
    )
    prismaMock.staffMembership.findFirst.mockResolvedValue(null)

    await expect(
      service.cancelExecution(
        "exec-1",
        "staff-1",
        "Reviewed provider cancellation evidence",
      ),
    ).rejects.toThrow(/current unbanned Finance or Super Admin/i)
    expect(adapterMock.checkTransferStatus).not.toHaveBeenCalled()
  })

  it("blocks cancellation after a send claim when no provider outcome was recorded", async () => {
    const { service } = makeService(
      { status: "PROCESSING" },
      {
        status: "PROCESSING",
        stage: "PROVIDER_SEND_CLAIMED",
        providerExecutionId: null,
      },
    )

    await expect(
      service.cancelExecution(
        "exec-1",
        "staff-1",
        "Reviewed provider cancellation evidence",
      ),
    ).rejects.toThrow(/outcome is not yet recorded/i)
  })

  it("blocks Stripe cancellation during the active transfer-to-bank handoff", async () => {
    const { service } = makeService(
      { status: "PROCESSING" },
      {
        status: "PROCESSING",
        stage: "TRANSFER_CREATED",
        providerExecutionId: "tr_1",
        providerTransferId: "tr_1",
        provider: { id: "prov-stripe", name: "stripe_connect" },
      },
    )

    await expect(
      service.cancelExecution(
        "exec-1",
        "staff-1",
        "Reviewed provider cancellation evidence",
      ),
    ).rejects.toThrow(/provider-evidenced cancellable recovery stage/i)
  })

  it("rejects a concurrent cancellation while the first exact claim lease owns provider I/O", async () => {
    let state: any = {
      ...failedExecution,
      status: "PROCESSING",
      stage: "BANK_PAYOUT_RECOVERY_REQUIRED",
      providerExecutionId: "tr_1",
      providerTransferId: "tr_1",
      providerPayoutId: "po_1",
      livemode: false,
      updatedAt: new Date(),
      providerMetadata: {
        destinationSnapshot: {
          providerAccountExternalId: "acct_1",
        },
      },
      provider: { id: "prov-stripe", name: "stripe_connect" },
      withdrawal: {
        ...failedExecution.withdrawal,
        status: "PROCESSING",
        method: "stripe_connect",
        payoutMethodId: "pm-1",
        payoutMethod: {
          id: "pm-1",
          type: "stripe_connect",
          providerAccount: {
            id: "provider-account-1",
            providerAccountId: "acct_1",
          },
        },
      },
    }
    const { service, prismaMock, adapterMock } = makeService(
      { status: "PROCESSING" },
      state,
    )
    prismaMock.payoutExecution.findUnique.mockImplementation(async () => ({
      ...state,
    }))
    prismaMock.payoutExecution.updateMany.mockImplementation(
      async (request: any) => {
        if (
          request.where.version !== undefined &&
          request.where.version !== state.version
        ) {
          return { count: 0 }
        }
        if (
          typeof request.where.stage === "string" &&
          request.where.stage !== state.stage
        ) {
          return { count: 0 }
        }
        state = {
          ...state,
          ...(request.data.stage === undefined
            ? {}
            : { stage: request.data.stage }),
          ...(Object.hasOwn(request.data, "errorMessage")
            ? { errorMessage: request.data.errorMessage }
            : {}),
          version:
            request.data.version?.increment === 1
              ? state.version + 1
              : state.version,
          updatedAt: new Date(),
        }
        return { count: 1 }
      },
    )
    let providerStarted!: () => void
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve
    })
    let rejectProvider!: (error: Error) => void
    adapterMock.cancelTransfer.mockImplementation(
      () =>
        new Promise((_resolve: unknown, reject: (error: Error) => void) => {
          rejectProvider = reject
          providerStarted()
        }),
    )

    const first = service.cancelExecution(
      "exec-1",
      "staff-1",
      "Reviewed provider cancellation evidence",
    )
    await started
    await expect(
      service.cancelExecution(
        "exec-1",
        "staff-1",
        "Reviewed provider cancellation evidence",
      ),
    ).rejects.toThrow(/already in progress/i)
    expect(adapterMock.cancelTransfer).toHaveBeenCalledTimes(1)

    rejectProvider(new Error("simulated provider timeout"))
    await expect(first).rejects.toThrow(/funds remain reserved/i)
    expect(adapterMock.cancelTransfer).toHaveBeenCalledTimes(1)
    expect(state.stage).toBe("CANCEL_REQUESTED")
    expect(state.errorMessage).toMatch(/funds remain reserved/i)
  })

  it("quarantines post-provider cancellation evidence conflicts while keeping funds reserved", async () => {
    const stripeExecution = {
      status: "PROCESSING",
      stage: "BANK_PAYOUT_RECOVERY_REQUIRED",
      providerExecutionId: "tr_1",
      providerTransferId: "tr_1",
      providerPayoutId: "po_1",
      livemode: false,
      providerMetadata: {
        destinationSnapshot: {
          providerAccountExternalId: "acct_1",
        },
      },
      provider: { id: "prov-stripe", name: "stripe_connect" },
      withdrawal: {
        ...failedExecution.withdrawal,
        status: "PROCESSING",
        method: "stripe_connect",
        payoutMethodId: "pm-1",
        payoutMethod: {
          id: "pm-1",
          type: "stripe_connect",
          providerAccount: {
            id: "provider-account-1",
            providerAccountId: "acct_1",
          },
        },
      },
    }
    const { service, prismaMock, auditMock, adapterMock } = makeService(
      { status: "PROCESSING" },
      stripeExecution,
    )
    adapterMock.cancelTransfer.mockResolvedValue({
      success: true,
      providerExecutionId: "tr_1",
      livemode: true,
      metadata: {
        reversalId: "trr_1",
        transferId: "tr_1",
        payoutId: "po_1",
        payoutStatus: "canceled",
        connectedAccountId: "acct_1",
        providerAmountMinor: 10_000,
        providerCurrency: "USD",
        providerPublicReference: "GP-WD-0001",
        livemode: true,
      },
    })

    await expect(
      service.cancelExecution(
        "exec-1",
        "staff-1",
        "Reviewed provider cancellation evidence",
      ),
    ).rejects.toThrow(/funds remain reserved/i)

    expect(adapterMock.cancelTransfer).toHaveBeenCalledTimes(1)
    expect(prismaMock.withdrawal.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.publisherBalance.update).not.toHaveBeenCalled()
    expect(prismaMock.payoutExecution.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          stage: "CANCEL_REQUESTED",
          status: { in: ["PENDING", "PROCESSING"] },
        }),
        data: expect.objectContaining({
          errorMessage: expect.stringMatching(/funds remain reserved/i),
        }),
      }),
    )
    expect(prismaMock.notification.createMany).toHaveBeenCalled()
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PAYOUT_CANCELLATION_EVIDENCE_QUARANTINED",
      }),
      prismaMock,
    )
  })
})
